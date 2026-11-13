package agent

import (
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"omnidesk-monitor/protocol"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type CPU struct {
	Usage   float64    `json:"usage"`
	Cores   int        `json:"cores"`
	Model   string     `json:"model"`
	PerCore []float64  `json:"perCore"`
	LoadAvg [3]float64 `json:"loadAvg"`
	Steal   float64    `json:"steal"`
	IOWait  float64    `json:"iowait"`
}
type Memory struct {
	Total        uint64  `json:"total"`
	Used         uint64  `json:"used"`
	Free         uint64  `json:"free"`
	Available    uint64  `json:"available"`
	Buffers      uint64  `json:"buffers"`
	Cached       uint64  `json:"cached"`
	SwapTotal    uint64  `json:"swapTotal"`
	SwapUsed     uint64  `json:"swapUsed"`
	UsagePercent float64 `json:"usagePercent"`
}
type Disk struct {
	Device            string  `json:"device"`
	Mount             string  `json:"mount"`
	FsType            string  `json:"fsType"`
	Total             uint64  `json:"total"`
	Used              uint64  `json:"used"`
	Available         uint64  `json:"available"`
	UsagePercent      float64 `json:"usagePercent"`
	InodeUsagePercent float64 `json:"inodeUsagePercent"`
}
type Network struct {
	Name    string  `json:"name"`
	RxBytes uint64  `json:"rxBytes"`
	TxBytes uint64  `json:"txBytes"`
	RxRate  float64 `json:"rxRate"`
	TxRate  float64 `json:"txRate"`
}
type DiskIO struct {
	ReadRate  float64 `json:"readRate"`
	WriteRate float64 `json:"writeRate"`
}
type System struct {
	Hostname       string `json:"hostname"`
	OS             string `json:"os"`
	Kernel         string `json:"kernel"`
	Arch           string `json:"arch"`
	Uptime         uint64 `json:"uptime"`
	Virtualization string `json:"virtualization"`
}
type Metrics struct {
	InstallationID    string              `json:"installationId,omitempty"`
	DiscoveryDisabled bool                `json:"discoveryDisabled,omitempty"`
	PublicIP          *PublicIP           `json:"publicIP,omitempty"`
	Unavailable       []string            `json:"unavailable,omitempty"`
	IntervalSeconds   int                 `json:"intervalSeconds"`
	Discovered        *protocol.Discovery `json:"discovered,omitempty"`
	ConnectionID      string              `json:"connectionId"`
	Timestamp         int64               `json:"timestamp"`
	DurationMs        int64               `json:"durationMs"`
	System            System              `json:"system"`
	CPU               CPU                 `json:"cpu"`
	Memory            Memory              `json:"memory"`
	Disks             []Disk              `json:"disks"`
	Network           []Network           `json:"network"`
	DiskIO            DiskIO              `json:"diskIO"`
}
type Collector struct {
	lastCPU []cpu.TimesStat
	lastNet map[string]Counter
	lastIO  map[string]disk.IOCountersStat
	lastAt  time.Time
}

func usage(cur, prev cpu.TimesStat) (float64, float64, float64) {
	total := func(t cpu.TimesStat) float64 {
		return t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq + t.Softirq + t.Steal
	}
	delta := total(cur) - total(prev)
	if delta <= 0 {
		return 0, 0, 0
	}
	idle := cur.Idle - prev.Idle
	return min(100, max(0, (delta-idle)/delta*100)), max(0, (cur.Steal-prev.Steal)/delta*100), max(0, (cur.Iowait-prev.Iowait)/delta*100)
}
func (c *Collector) Collect(include []string) (Metrics, map[string]Counter, uint64, error) {
	start := time.Now()
	var m Metrics
	m.Timestamp = start.UnixMilli()
	if runtime.GOOS == "windows" {
		m.Unavailable = []string{"cpu.loadAvg", "cpu.steal", "cpu.iowait", "disk.inodes"}
	}
	m.Disks = []Disk{}
	m.Network = []Network{}
	m.CPU.PerCore = []float64{}
	h, err := host.Info()
	if err != nil {
		return m, nil, 0, err
	}
	m.System = System{h.Hostname, strings.TrimSpace(h.Platform + " " + h.PlatformVersion), h.KernelVersion, h.KernelArch, h.Uptime, h.VirtualizationSystem}
	if m.System.Hostname == "" {
		m.System.Hostname, _ = os.Hostname()
	}
	times, err := cpu.Times(true)
	if err != nil {
		return m, nil, 0, err
	}
	m.CPU.Cores = len(times)
	info, _ := cpu.Info()
	if len(info) > 0 {
		m.CPU.Model = info[0].ModelName
	}
	if len(times) != len(c.lastCPU) {
		m.Unavailable = append(m.Unavailable, "cpu.usage")
	}
	if len(times) == len(c.lastCPU) {
		for i, t := range times {
			u, s, w := usage(t, c.lastCPU[i])
			m.CPU.PerCore = append(m.CPU.PerCore, u)
			m.CPU.Usage += u
			m.CPU.Steal += s
			m.CPU.IOWait += w
		}
		if len(times) > 0 {
			d := float64(len(times))
			m.CPU.Usage /= d
			m.CPU.Steal /= d
			m.CPU.IOWait /= d
		}
	}
	if avg, e := load.Avg(); e == nil {
		m.CPU.LoadAvg = [3]float64{avg.Load1, avg.Load5, avg.Load15}
	}
	vm, err := mem.VirtualMemory()
	if err != nil {
		return m, nil, 0, err
	}
	swap, _ := mem.SwapMemory()
	m.Memory = Memory{Total: vm.Total, Used: vm.Total - min(vm.Total, vm.Available), Free: vm.Free, Available: vm.Available, Buffers: vm.Buffers, Cached: vm.Cached}
	if vm.Total > 0 {
		m.Memory.UsagePercent = float64(m.Memory.Used) / float64(vm.Total) * 100
	}
	if swap != nil {
		m.Memory.SwapTotal = swap.Total
		m.Memory.SwapUsed = swap.Used
	}
	parts, err := disk.Partitions(false)
	if err != nil {
		return m, nil, 0, err
	}
	seen := map[string]bool{}
	devices := map[string]bool{}
	for _, p := range parts {
		if seen[p.Mountpoint] {
			continue
		}
		seen[p.Mountpoint] = true
		device := p.Device
		if resolved, e := filepath.EvalSymlinks(device); e == nil {
			device = resolved
		}
		devices[strings.TrimRight(filepath.Base(device), `\/`)] = true
		u, e := disk.Usage(p.Mountpoint)
		if e != nil || u.Total == 0 {
			continue
		}
		m.Disks = append(m.Disks, Disk{p.Device, p.Mountpoint, p.Fstype, u.Total, u.Used, u.Free, u.UsedPercent, u.InodesUsedPercent})
	}
	ios, err := net.IOCounters(true)
	if err != nil {
		ios = nil
	}
	counters := map[string]Counter{}
	elapsed := start.Sub(c.lastAt).Seconds()
	for _, n := range ios {
		if !Allowed(n.Name, include) {
			continue
		}
		cur := Counter{n.BytesSent, n.BytesRecv}
		counters[n.Name] = cur
		row := Network{Name: n.Name, RxBytes: n.BytesRecv, TxBytes: n.BytesSent}
		if prev, ok := c.lastNet[n.Name]; ok && elapsed > 0 {
			if cur.Down >= prev.Down {
				row.RxRate = float64(cur.Down-prev.Down) / elapsed
			}
			if cur.Up >= prev.Up {
				row.TxRate = float64(cur.Up-prev.Up) / elapsed
			}
		}
		m.Network = append(m.Network, row)
	}
	if len(counters) == 0 {
		m.Unavailable = append(m.Unavailable, "network")
	}
	diskIO, diskErr := disk.IOCounters()
	if diskErr != nil || len(diskIO) == 0 {
		m.Unavailable = append(m.Unavailable, "diskIO")
	}
	for name, cur := range diskIO {
		if !devices[strings.TrimRight(name, `\/`)] {
			continue
		}
		if prev, ok := c.lastIO[name]; ok && elapsed > 0 {
			if cur.ReadBytes >= prev.ReadBytes {
				m.DiskIO.ReadRate += float64(cur.ReadBytes-prev.ReadBytes) / elapsed
			}
			if cur.WriteBytes >= prev.WriteBytes {
				m.DiskIO.WriteRate += float64(cur.WriteBytes-prev.WriteBytes) / elapsed
			}
		}
	}
	c.lastCPU = times
	c.lastNet = counters
	c.lastIO = diskIO
	c.lastAt = start
	m.DurationMs = time.Since(start).Milliseconds()
	return m, counters, h.BootTime, nil
}
