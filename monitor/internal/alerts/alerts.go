package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"slices"
	"time"
)

func Check(s *storage.Store, now time.Time) error {
	nodes, err := s.List(now)
	if err != nil {
		return err
	}
	for _, n := range nodes {
		var m struct {
			Timestamp   int64    `json:"timestamp"`
			Unavailable []string `json:"unavailable"`
			CPU         struct {
				Usage float64 `json:"usage"`
			} `json:"cpu"`
			Memory struct {
				UsagePercent float64 `json:"usagePercent"`
			} `json:"memory"`
			Disks []struct {
				Mount             string  `json:"mount"`
				FsType            string  `json:"fsType"`
				Total             *uint64 `json:"total"`
				UsagePercent      float64 `json:"usagePercent"`
				InodeUsagePercent float64 `json:"inodeUsagePercent"`
			} `json:"disks"`
		}
		_ = json.Unmarshal(n.Metrics, &m)
		interval := n.IntervalSeconds
		var timing struct {
			IntervalSeconds int `json:"intervalSeconds"`
		}
		_ = json.Unmarshal(n.Metrics, &timing)
		if timing.IntervalSeconds > interval {
			interval = timing.IntervalSeconds
		}
		// Old agents without interval metadata retain the existing 60-second deadline.
		deadline := int64(60000)
		if interval > 0 {
			deadline = int64(interval*3+15) * 1000
		}
		stale := n.LastSeen > 0 && (now.UnixMilli()-n.LastSeen > deadline || now.UnixMilli()-m.Timestamp > deadline)
		check := func(kind, msg string, c bool, delay time.Duration) error {
			return s.AlertState(n.ID, kind, n.Name+"："+msg, c, delay, now)
		}
		if err = check("offline", fmt.Sprintf("超过 %d 秒未收到新采样", deadline/1000), stale, 0); err != nil {
			return err
		}
		fresh := n.LastSeen > 0 && !stale
		if err = check("cpu", "CPU 持续高于 90%", fresh && !slices.Contains(m.Unavailable, "cpu.usage") && m.CPU.Usage >= 90, 5*time.Minute); err != nil {
			return err
		}
		if err = check("memory", "内存持续高于 90%", fresh && !slices.Contains(m.Unavailable, "memory.usagePercent") && m.Memory.UsagePercent >= 90, 5*time.Minute); err != nil {
			return err
		}
		disk, inode := false, false
		for _, d := range m.Disks {
			if !protocol.MonitorFilesystem(d.FsType, d.Mount) || d.Total != nil && *d.Total == 0 {
				continue
			}
			disk = disk || d.UsagePercent >= 90
			inode = inode || d.InodeUsagePercent >= 90
		}
		if err = check("inode", "磁盘 inode 使用率达到 90%", fresh && !slices.Contains(m.Unavailable, "disk.inodes") && inode, 0); err != nil {
			return err
		}
		if err = check("disk", "磁盘使用率达到 90%", fresh && disk, 0); err != nil {
			return err
		}
		if n.Asset.ExpiresAt != "" {
			loc, _ := time.LoadLocation(n.Asset.Timezone)
			expiry, e := time.ParseInLocation("2006-01-02", n.Asset.ExpiresAt, loc)
			if e == nil {
				local := now.In(loc)
				today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
				days := int(time.Date(expiry.Year(), expiry.Month(), expiry.Day(), 0, 0, 0, 0, time.UTC).Sub(time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)).Hours() / 24)
				tier := 8
				switch {
				case days <= 0:
					tier = 0
				case days <= 1:
					tier = 1
				case days <= 3:
					tier = 3
				case days <= 7:
					tier = 7
				}
				for _, threshold := range []int{7, 3, 1, 0} {
					if err = check(fmt.Sprintf("expiry:%s:%d", n.Asset.ExpiresAt, threshold), fmt.Sprintf("到期日期 %s，剩余 %d 天", n.Asset.ExpiresAt, days), tier == threshold, 0); err != nil {
						return err
					}
				}
			}
		}
		if n.Asset.TrafficLimit > 0 {
			used := storage.Used(n.Asset, n.PeriodUpload, n.PeriodDownload)
			pct := float64(used) / float64(n.Asset.TrafficLimit) * 100
			tier := uint64(0)
			switch {
			case pct >= 100:
				tier = 100
			case pct >= 90:
				tier = 90
			case pct >= 80:
				tier = 80
			}
			for _, threshold := range []uint64{80, 90, 100} {
				if err = check(fmt.Sprintf("traffic:%d:%d", n.PeriodStart, threshold), fmt.Sprintf("周期流量达到 %d%%（监测值）", threshold), tier == threshold, 0); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
func Deliver(ctx context.Context, s *storage.Store, url string) error {
	if url == "" {
		return nil
	}
	items, err := s.Alerts(true)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for i := len(items) - 1; i >= 0; i-- {
		a := items[i]
		b, _ := json.Marshal(a)
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("提醒发送失败")
		}
		io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return fmt.Errorf("提醒接收端返回 HTTP %d", res.StatusCode)
		}
		if err = s.MarkDelivered(a.ID); err != nil {
			return err
		}
	}
	return nil
}
