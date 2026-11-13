package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"omnidesk-monitor/protocol"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Config struct {
	InstallationID   string   `json:"installationId,omitempty"`
	DisableDiscovery bool     `json:"disableDiscovery,omitempty"`
	ServerURL        string   `json:"serverUrl"`
	Token            string   `json:"token"`
	StatePath        string   `json:"statePath"`
	IntervalSeconds  int      `json:"intervalSeconds"`
	IncludeNics      []string `json:"includeNics"`
	AllowInsecure    bool     `json:"allowInsecure"`
}
type Counter struct {
	Up   uint64 `json:"up"`
	Down uint64 `json:"down"`
}
type State struct {
	PublicIP           *PublicIP           `json:"publicIP,omitempty"`
	Discovered         *protocol.Discovery `json:"discovered,omitempty"`
	DiscoveryAttemptAt int64               `json:"discoveryAttemptAt,omitempty"`
	Epoch              string              `json:"epoch"`
	Sequence           uint64              `json:"sequence"`
	Boot               uint64              `json:"boot"`
	Upload             uint64              `json:"upload"`
	Download           uint64              `json:"download"`
	Previous           map[string]Counter  `json:"previous"`
	Queue              []protocol.Report   `json:"queue"`
}

func ValidateConfig(c *Config) error {
	u, err := url.Parse(c.ServerURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimRight(u.Path, "/") != "/v1/monitor" {
		return errors.New("服务地址须使用统一云端的 /v1/monitor 路径，不含凭据或参数")
	}
	local := u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && (local || c.AllowInsecure)) {
		return errors.New("服务地址需要 HTTPS；私网 HTTP 须显式设置 allowInsecure")
	}
	c.ServerURL = strings.TrimRight(c.ServerURL, "/")
	if len(c.Token) < 24 {
		return errors.New("无效 Agent 令牌")
	}
	if c.IntervalSeconds == 0 {
		c.IntervalSeconds = 60
	}
	if c.IntervalSeconds < 5 || c.IntervalSeconds > 86400 {
		return errors.New("采集间隔须为 5 至 86400 秒")
	}
	if c.StatePath == "" {
		c.StatePath = "./agent-state.json"
	}
	return nil
}
func LoadState(path string) (*State, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		epoch := make([]byte, 16)
		if _, err = rand.Read(epoch); err != nil {
			return nil, err
		}
		return &State{Epoch: hex.EncodeToString(epoch), Previous: map[string]Counter{}, Queue: []protocol.Report{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err = json.Unmarshal(b, &s); err != nil || s.Epoch == "" || s.Previous == nil {
		return nil, errors.New("流量状态文件损坏，请从备份恢复；未自动清零")
	}
	return &s, nil
}
func SaveState(path string, s *State) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path+".tmp", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(path+".tmp", path)
}

// Advance records raw byte deltas; lifetime counters survive agent and VPS restarts.
func (s *State) Advance(boot uint64, counters map[string]Counter) (uint64, uint64, bool) {
	// A missing network sample must not discard the last valid traffic baseline.
	if len(counters) == 0 {
		s.Sequence++
		return 0, 0, true
	}
	var up, down uint64
	gap := false
	for name, cur := range counters {
		prev, ok := s.Previous[name]
		if !ok {
			if s.Sequence > 0 {
				gap = true
			}
			continue
		}
		if boot != s.Boot || cur.Up < prev.Up || cur.Down < prev.Down {
			up += cur.Up
			down += cur.Down
			gap = true
		} else {
			up += cur.Up - prev.Up
			down += cur.Down - prev.Down
		}
	}
	for name := range s.Previous {
		if _, ok := counters[name]; !ok {
			gap = true
		}
	}
	s.Boot = boot
	s.Previous = counters
	s.Upload += up
	s.Download += down
	s.Sequence++
	return up, down, gap
}
func Allowed(name string, include []string) bool {
	return allowedOnOS(name, include, runtime.GOOS)
}
func allowedOnOS(name string, include []string, platform string) bool {
	if len(include) > 0 {
		for _, pattern := range include {
			ok, _ := filepath.Match(pattern, name)
			if ok {
				return true
			}
		}
		return false
	}
	prefixes := []string{"lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "podman", "tun", "tap", "wg"}
	if platform == "windows" {
		// TAP/TUN adapters may be the primary connection on Windows. Linux tunnel
		// prefixes must not be applied after the Windows defaults.
		name = strings.ToLower(name)
		prefixes = []string{"loopback", "isatap", "teredo", "vethernet", "vbox", "vmware"}
	}
	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}

func Run(ctx context.Context, c Config) error {
	if err := ValidateConfig(&c); err != nil {
		return err
	}
	s, err := LoadState(c.StatePath)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	// Discovery runs independently; geolocation failures never delay metrics or reporting.
	discoveryTransport := http.DefaultTransport.(*http.Transport).Clone()
	discoveryTransport.Proxy = nil
	defer discoveryTransport.CloseIdleConnections()
	discoveryClient := &http.Client{Timeout: 5 * time.Second, Transport: discoveryTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	discoveries := make(chan *protocol.Discovery, 1)
	discovering := false
	collector := Collector{}
	publicResults := make(chan *PublicIP, 1)
	publicPending := false
	resuming := s.Sequence > 0
	ticker := time.NewTicker(time.Duration(c.IntervalSeconds) * time.Second)
	defer ticker.Stop()
	for {
		metrics, counters, boot, err := collector.Collect(c.IncludeNics)
		if err != nil {
			return fmt.Errorf("采集失败：%w", err)
		}
		select {
		case discovered := <-discoveries:
			discovering = false
			if discovered != nil {
				s.Discovered = discovered
			}
		default:
		}
		now := time.Now().UnixMilli()
		if !c.DisableDiscovery && !discovering && now-s.DiscoveryAttemptAt >= 3600000 && (s.Discovered == nil || now-s.Discovered.DetectedAt >= 86400000) {
			s.DiscoveryAttemptAt = now
			discovering = true
			go func() { discovered, _ := lookupDiscovery(ctx, discoveryClient); discoveries <- discovered }()
		}
		select {
		case result := <-publicResults:
			if s.PublicIP == nil || result.AttemptedAt >= s.PublicIP.AttemptedAt {
				s.PublicIP = result
			}
			publicPending = false
		default:
		}
		if !c.DisableDiscovery && !publicPending && (s.PublicIP == nil || now-s.PublicIP.AttemptedAt >= 600000) {
			publicPending = true
			previous := s.PublicIP
			go func() { publicResults <- lookupPublicIPs(ctx, previous) }()
		}
		metrics.PublicIP = s.PublicIP
		metrics.DiscoveryDisabled = c.DisableDiscovery
		metrics.Discovered = s.Discovered
		metrics.IntervalSeconds = c.IntervalSeconds
		metrics.InstallationID = c.InstallationID
		_, _, gap := s.Advance(boot, counters)
		gap = gap || resuming
		resuming = false
		b, err := json.Marshal(metrics)
		if err != nil {
			return err
		}
		s.Queue = append(s.Queue, protocol.Report{Epoch: s.Epoch, Sequence: s.Sequence, Timestamp: metrics.Timestamp, Upload: s.Upload, Download: s.Download, Incomplete: gap, Metrics: b})
		// At most ~24 hours at 10s. Cumulative counters preserve volume after overflow;
		// the server flags the skipped sequence as an incomplete timeline.
		// Bound both queue age and count; cumulative counters survive trimmed gaps.
		first := 0
		for first < len(s.Queue)-1 && s.Queue[first].Timestamp < now-86400000 {
			first++
		}
		if first > 0 {
			s.Queue = s.Queue[first:]
			s.Queue[0].Incomplete = true
		}
		if len(s.Queue) > 8640 {
			s.Queue = s.Queue[len(s.Queue)-8640:]
			s.Queue[0].Incomplete = true
		}
		if err = SaveState(c.StatePath, s); err != nil {
			return fmt.Errorf("保存流量状态失败：%w", err)
		}
		sent := 0
		freshProbe := false
		for _, report := range s.Queue {
			if sent >= 200 || ctx.Err() != nil {
				break
			}
			payload, _ := json.Marshal(report)
			req, err := http.NewRequestWithContext(ctx, "POST", c.ServerURL+"/reports", bytes.NewReader(payload))
			if err != nil {
				return err
			}
			req.Header.Set("Authorization", "Bearer "+c.Token)
			req.Header.Set("Content-Type", "application/json")
			res, err := client.Do(req)
			if err != nil {
				break
			}
			var ack struct {
				Ack             uint64 `json:"ack"`
				IntervalSeconds int    `json:"intervalSeconds"`
				RefreshID       string `json:"refreshId"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&ack)
			res.Body.Close()
			if res.StatusCode != 200 || decodeErr != nil || ack.Ack != report.Sequence {
				break
			}
			if ack.RefreshID != "" && !c.DisableDiscovery && (s.PublicIP == nil || s.PublicIP.RefreshID != ack.RefreshID) {
				s.PublicIP = lookupPublicIPs(ctx, s.PublicIP)
				s.PublicIP.RefreshID = ack.RefreshID
				freshProbe = true
			}
			if storageInterval := ack.IntervalSeconds; storageInterval >= 5 && storageInterval <= 86400 && storageInterval != c.IntervalSeconds {
				c.IntervalSeconds = storageInterval
				ticker.Reset(time.Duration(c.IntervalSeconds) * time.Second)
			}
			sent++
		}
		if sent > 0 {
			s.Queue = s.Queue[sent:]
			if err = SaveState(c.StatePath, s); err != nil {
				return err
			}
		}
		if freshProbe {
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
