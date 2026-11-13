package alerts

import (
	"encoding/json"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"path/filepath"
	"testing"
	"time"
)

func TestOfflineDeadlineFollowsRequestedAndReportedInterval(t *testing.T) {
	s, e := storage.Open(filepath.Join(t.TempDir(), "monitor.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	now := time.Now()
	n := protocol.Node{ID: "123456789012345678901234", Name: "slow node", IntervalSeconds: 600}
	if e = s.Create(n, "synthetic-token-hash"); e != nil {
		t.Fatal(e)
	}
	metrics, _ := json.Marshal(map[string]any{"timestamp": now.UnixMilli(), "intervalSeconds": 600})
	_, e = s.DB.Exec("UPDATE nodes SET last_seen=?,metrics=? WHERE id=?", now.UnixMilli(), string(metrics), n.ID)
	if e != nil {
		t.Fatal(e)
	}
	if e = Check(s, now.Add(2*time.Minute)); e != nil {
		t.Fatal(e)
	}
	events, _ := s.Alerts(false)
	for _, a := range events {
		if a.Kind == "offline" {
			t.Fatal("slow reporter was marked offline after 60 seconds")
		}
	}
	if e = Check(s, now.Add(31*time.Minute)); e != nil {
		t.Fatal(e)
	}
	events, _ = s.Alerts(false)
	found := false
	for _, a := range events {
		if a.Kind == "offline" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing offline event")
	}
}
