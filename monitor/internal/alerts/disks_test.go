package alerts

import (
	"encoding/json"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestResourceFilesystemAlerts(t *testing.T) {
	disk := func(kind, mount string, usage, inode float64) map[string]any {
		return map[string]any{"fsType": kind, "mount": mount, "total": 1000, "usagePercent": usage, "inodeUsagePercent": inode}
	}
	cases := []struct {
		name        string
		disks       []map[string]any
		cpu         float64
		unavailable []string
		want        []string
	}{
		{name: "root with four full snap images", disks: []map[string]any{disk("ext4", "/", 28.4, 4.2), disk("squashfs", "/snap/core20/2922", 100, 100), disk("squashfs", "/snap/snapd/28254", 100, 100), disk("squashfs", "/snap/core22/2987", 100, 100), disk("squashfs", "/snap/lxd/41283", 100, 100)}},
		{name: "real capacity pressure", disks: []map[string]any{disk("ext4", "/data", 95, 4)}, want: []string{"disk"}},
		{name: "real inode pressure", disks: []map[string]any{disk("xfs", "/data", 20, 95)}, want: []string{"inode"}},
		{name: "writable loop retained", disks: []map[string]any{disk("ext4", "/mnt/loop", 95, 95)}, want: []string{"disk", "inode"}},
		{name: "missing inode unsupported", disks: []map[string]any{disk("ntfs", "C:", 20, 100)}, unavailable: []string{"disk.inodes"}},
		{name: "virtual memory mounts excluded", disks: []map[string]any{disk("tmpfs", "/run", 100, 100)}},
		{name: "legacy snap without fs type", disks: []map[string]any{disk("", "/snap/core22/1", 100, 100)}},
		{name: "container root retained", disks: []map[string]any{disk("overlay", "/", 95, 20)}, want: []string{"disk"}},
		{name: "cpu unavailable", cpu: 100, unavailable: []string{"cpu.usage"}},
		{name: "real sustained cpu", cpu: 95, want: []string{"cpu"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, err := storage.Open(filepath.Join(t.TempDir(), "monitor.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer s.DB.Close()
			now := time.Now()
			n := protocol.Node{ID: "123456789012345678901234", Name: "synthetic", IntervalSeconds: 600}
			if err = s.Create(n, "synthetic-hash"); err != nil {
				t.Fatal(err)
			}
			metrics, _ := json.Marshal(map[string]any{"timestamp": now.UnixMilli(), "cpu": map[string]any{"usage": c.cpu}, "disks": c.disks, "unavailable": c.unavailable})
			if _, err = s.DB.Exec("UPDATE nodes SET last_seen=?,metrics=? WHERE id=?", now.UnixMilli(), string(metrics), n.ID); err != nil {
				t.Fatal(err)
			}
			if err = Check(s, now); err != nil {
				t.Fatal(err)
			}
			if err = Check(s, now.Add(6*time.Minute)); err != nil {
				t.Fatal(err)
			}
			events, err := s.Alerts(false)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, event := range events {
				got = append(got, event.Kind)
			}
			slices.Sort(got)
			slices.Sort(c.want)
			if !slices.Equal(got, c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}
func TestImageOnlyDiskAlarmClearsWithoutDeletingHistory(t *testing.T) {
	s, err := storage.Open(filepath.Join(t.TempDir(), "monitor.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	now := time.Now()
	n := protocol.Node{ID: "123456789012345678901234", Name: "synthetic", IntervalSeconds: 60}
	if err = s.Create(n, "synthetic-hash"); err != nil {
		t.Fatal(err)
	}
	if err = s.AlertState(n.ID, "disk", "old alarm", true, 0, now); err != nil {
		t.Fatal(err)
	}
	metrics, _ := json.Marshal(map[string]any{"timestamp": now.UnixMilli(), "disks": []map[string]any{{"fsType": "squashfs", "mount": "/snap/test/1", "total": 100, "usagePercent": 100, "inodeUsagePercent": 100}}})
	if _, err = s.DB.Exec("UPDATE nodes SET last_seen=?,metrics=? WHERE id=?", now.UnixMilli(), string(metrics), n.ID); err != nil {
		t.Fatal(err)
	}
	if err = Check(s, now); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.DB.QueryRow("SELECT COUNT(*) FROM alert_state WHERE node_id=? AND kind='disk'", n.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("old false positive still active")
	}
	events, err := s.Alerts(false)
	if err != nil || len(events) != 1 {
		t.Fatalf("history changed: %v %v", events, err)
	}
}
