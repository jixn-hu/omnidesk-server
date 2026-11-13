package storage

import (
	"encoding/json"
	"omnidesk-monitor/protocol"
	"path/filepath"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Store, protocol.Node, time.Time) {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "monitor.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.DB.Close() })
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	n := protocol.Node{ID: "123456789012345678901234", Name: "fixture", Asset: protocol.Asset{Timezone: "Asia/Shanghai", ResetDay: 1, TrafficMode: "sum"}}
	if e = s.Create(n, "hash"); e != nil {
		t.Fatal(e)
	}
	return s, n, now
}
func report(now time.Time, seq, up, down uint64) protocol.Report {
	b, _ := json.Marshal(map[string]any{"timestamp": now.UnixMilli(), "system": map[string]any{"hostname": "fixture"}, "cpu": map[string]any{"usage": 12, "cores": 2, "loadAvg": []float64{0, 0, 0}, "perCore": []float64{0, 0}}, "memory": map[string]any{"usagePercent": 30}, "network": []any{}, "disks": []any{}})
	return protocol.Report{Epoch: "epoch-fixture", Sequence: seq, Timestamp: now.UnixMilli(), Upload: up, Download: down, Metrics: b}
}
func TestLedgerRetryPersistenceAndEpoch(t *testing.T) {
	s, n, now := fixture(t)
	r := report(now, 1, 100, 200)
	if e := s.Ingest(n.ID, r, now); e != nil {
		t.Fatal(e)
	}
	if e := s.Ingest(n.ID, r, now); e != nil {
		t.Fatal(e)
	}
	r = report(now.Add(time.Minute), 2, 150, 250)
	if e := s.Ingest(n.ID, r, now.Add(time.Minute)); e != nil {
		t.Fatal(e)
	}
	nodes, e := s.List(now)
	if e != nil {
		t.Fatal(e)
	}
	if nodes[0].Upload != 150 || nodes[0].PeriodDownload != 250 {
		t.Fatalf("duplicate counted: %+v", nodes[0])
	}
	points, e := s.History(n.ID, now.Add(-time.Hour).UnixMilli(), 10000)
	if e != nil || len(points) != 2 {
		t.Fatalf("history: %d %v", len(points), e)
	}
	// New ledger epochs add volume instead of replacing old streams.
	r = report(now.Add(2*time.Minute), 1, 10, 20)
	r.Epoch = "epoch-reinstall"
	if e = s.Ingest(n.ID, r, now); e != nil {
		t.Fatal(e)
	}
	nodes, e = s.List(now)
	if e != nil || nodes[0].Upload != 160 || nodes[0].Download != 270 {
		t.Fatalf("epoch totals: %+v %v", nodes, e)
	}
}
func TestReorderedGapAndRollback(t *testing.T) {
	s, n, now := fixture(t)
	if e := s.Ingest(n.ID, report(now, 1, 10, 10), now); e != nil {
		t.Fatal(e)
	}
	if e := s.Ingest(n.ID, report(now.Add(time.Minute), 3, 30, 40), now); e != nil {
		t.Fatal(e)
	}
	if e := s.Ingest(n.ID, report(now.Add(30*time.Second), 2, 20, 20), now); e != nil {
		t.Fatal(e)
	}
	if e := s.Ingest(n.ID, report(now.Add(2*time.Minute), 4, 1, 1), now); e == nil {
		t.Fatal("accepted backwards counters")
	}
	nodes, e := s.List(now)
	if e != nil || nodes[0].Upload != 30 || !nodes[0].Incomplete {
		t.Fatalf("bad gap or rollback: %+v %v", nodes, e)
	}
}
func TestCalendarPeriodAndOpeningBalance(t *testing.T) {
	a := protocol.Asset{Timezone: "Asia/Shanghai", ResetDay: 31}
	now := time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC)
	start, end := Period(now, a)
	if start.Format("2006-01-02") != "2026-02-28" || end.Format("2006-01-02") != "2026-03-31" {
		t.Fatalf("month end: %v %v", start, end)
	}
	a.Timezone = "America/New_York"
	a.ResetDay = 1
	start, end = Period(time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC), a)
	if end.Sub(start) != 31*24*time.Hour-time.Hour {
		t.Fatalf("DST period: %v", end.Sub(start))
	}
	s, n, now := fixture(t)
	n.Asset.InitialPeriod = "2026-11-01"
	n.Asset.InitialUpload = 500
	n.Asset.InitialDownload = 700
	if e := s.Update(n); e != nil {
		t.Fatal(e)
	}
	nodes, e := s.List(now)
	if e != nil || nodes[0].PeriodUpload != 500 || nodes[0].PeriodDownload != 700 {
		t.Fatalf("opening balance missing: %+v %v", nodes, e)
	}
	nodes, e = s.List(now.AddDate(0, 1, 0))
	if e != nil || nodes[0].PeriodUpload != 0 {
		t.Fatal("opening balance carried into next cycle")
	}
}
func TestAlertDedupSurvivesRestart(t *testing.T) {
	s, n, now := fixture(t)
	if e := s.AlertState(n.ID, "cpu", "high", true, 5*time.Minute, now); e != nil {
		t.Fatal(e)
	}
	events, _ := s.Alerts(false)
	if len(events) != 0 {
		t.Fatal("alert fired early")
	}
	if e := s.AlertState(n.ID, "cpu", "high", true, 5*time.Minute, now.Add(5*time.Minute)); e != nil {
		t.Fatal(e)
	}
	s.AlertState(n.ID, "cpu", "high", true, 5*time.Minute, now.Add(6*time.Minute))
	events, _ = s.Alerts(false)
	if len(events) != 1 {
		t.Fatalf("alert dedup: %d", len(events))
	}
	s.AlertState(n.ID, "cpu", "high", false, 0, now)
	s.AlertState(n.ID, "cpu", "high", true, 0, now)
	events, _ = s.Alerts(false)
	if len(events) != 2 {
		t.Fatal("new incident did not alert")
	}
}
func TestRejectInvalidReport(t *testing.T) {
	_, _, now := fixture(t)
	r := report(now, 1, 1, 1)
	r.Timestamp = now.Add(time.Hour).UnixMilli()
	if ValidateReport(r, now) == nil {
		t.Fatal("future timestamp accepted")
	}
	r = report(now, 1, 1, 1)
	r.Metrics = json.RawMessage(`{"timestamp":0,"system":{},"cpu":{"usage":101}}`)
	if ValidateReport(r, now) == nil {
		t.Fatal("invalid metrics accepted")
	}
}
func TestHistoryBucketPreservesTrafficAndLatest(t *testing.T) {
	s, n, now := fixture(t)
	base := now.Truncate(time.Minute)
	s.Ingest(n.ID, report(base, 1, 10, 20), now)
	s.Ingest(n.ID, report(base.Add(10*time.Second), 2, 30, 40), now)
	points, e := s.History(n.ID, base.UnixMilli(), 60000)
	if e != nil || len(points) != 1 || points[0].Upload != 30 || points[0].Timestamp != base.Add(10*time.Second).UnixMilli() {
		t.Fatalf("bucket: %+v %v", points, e)
	}
}

func TestCompactionPreservesPeriodTrafficAndLateBackfill(t *testing.T) {
	s, n, now := fixture(t)
	old := now.Add(-48 * time.Hour).Truncate(time.Minute)
	if e := s.Ingest(n.ID, report(old, 1, 100, 200), now); e != nil {
		t.Fatal(e)
	}
	if e := s.Ingest(n.ID, report(old.Add(10*time.Second), 2, 150, 250), now); e != nil {
		t.Fatal(e)
	}
	before, e := s.List(now)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Prune(now); e != nil {
		t.Fatal(e)
	}
	if e = s.Prune(now); e != nil {
		t.Fatal(e)
	}
	after, e := s.List(now)
	if e != nil || after[0].PeriodUpload != before[0].PeriodUpload || after[0].PeriodDownload != 250 {
		t.Fatalf("compaction lost volume: %+v %v", after, e)
	}
	var raw int
	s.DB.QueryRow("SELECT count(*) FROM samples").Scan(&raw)
	if raw != 0 {
		t.Fatal("raw history was not compacted")
	}
	// An offline Agent can backfill into an already compacted minute.
	if e = s.Ingest(n.ID, report(old.Add(20*time.Second), 3, 170, 280), now); e != nil {
		t.Fatal(e)
	}
	if e = s.Prune(now); e != nil {
		t.Fatal(e)
	}
	points, e := s.History(n.ID, old.Add(-time.Minute).UnixMilli(), 60000)
	if e != nil || len(points) != 1 || points[0].Upload != 170 || points[0].Download != 280 {
		t.Fatalf("late merge: %+v %v", points, e)
	}
	after, e = s.List(now)
	if e != nil || after[0].PeriodUpload != 170 {
		t.Fatal("period did not include compacted data")
	}
}

func TestDeleteNodeCleansHistoryAndRejectsLateReports(t *testing.T) {
	s, n, now := fixture(t)
	other := protocol.Node{ID: "abcdefabcdefabcdefabcdef", Name: "keep", Asset: n.Asset}
	if err := s.Create(other, "other-hash"); err != nil {
		t.Fatal(err)
	}
	r := report(now, 1, 100, 200)
	for _, id := range []string{n.ID, other.ID} {
		if err := s.Ingest(id, r, now); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec("INSERT INTO minute_samples VALUES(?,?,?,?,?,?)", id, now.UnixMilli(), string(r.Metrics), 1, 2, 0); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec("INSERT INTO alert_state VALUES(?,?,?,?)", id, "expiry", now.UnixMilli(), 1); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec("INSERT INTO alerts(node_id,kind,message,ts) VALUES(?,?,?,?)", id, "expiry", "fixture", now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	// A failure half way through the transaction must preserve the node and every record.
	if _, err := s.DB.Exec("CREATE TRIGGER reject_delete BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT, 'fixture'); END"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(n.ID); err == nil {
		t.Fatal("expected rollback")
	}
	var count int
	if err := s.DB.QueryRow("SELECT count(*) FROM samples WHERE node_id=?", n.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("delete did not roll back", err)
	}
	if _, err := s.DB.Exec("DROP TRIGGER reject_delete"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(n.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(n.ID); err != nil {
		t.Fatal("retry", err)
	}
	if _, err := s.NodeForToken("hash"); err == nil {
		t.Fatal("deleted token accepted")
	}
	if err := s.Ingest(n.ID, report(now, 2, 110, 210), now); err == nil {
		t.Fatal("late report recreated history")
	}
	if err := s.AlertState(n.ID, "expiry", "late check", true, 0, now); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"streams", "samples", "minute_samples", "daily", "alert_state", "alerts"} {
		if err := s.DB.QueryRow("SELECT count(*) FROM "+table+" WHERE node_id=?", n.ID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s orphan: %d %v", table, count, err)
		}
		if err := s.DB.QueryRow("SELECT count(*) FROM "+table+" WHERE node_id=?", other.ID).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s unrelated loss: %d %v", table, count, err)
		}
	}
}
