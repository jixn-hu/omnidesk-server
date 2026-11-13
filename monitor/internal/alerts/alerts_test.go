package alerts

import (
	"context"
	"net/http"
	"net/http/httptest"
	"omnidesk-monitor/internal/server"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"path/filepath"
	"testing"
	"time"
)

func TestExpiryWithoutAgentAndWebhookRetry(t *testing.T) {
	s, e := storage.Open(filepath.Join(t.TempDir(), "db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	n := protocol.Node{ID: "123456789012345678901234", Name: "expiry fixture", Asset: protocol.Asset{ExpiresAt: "2026-11-05", Timezone: "Asia/Shanghai", TrafficLimit: 1000, TrafficMode: "up", InitialPeriod: "2026-11-01", InitialUpload: 950}}
	if e = s.Create(n, server.Hash("fixture")); e != nil {
		t.Fatal(e)
	}
	if e = Check(s, now); e != nil {
		t.Fatal(e)
	}
	if e = Check(s, now.Add(time.Minute)); e != nil {
		t.Fatal(e)
	}
	events, e := s.Alerts(false)
	if e != nil || len(events) != 2 {
		t.Fatalf("expiry/traffic dedup: %d %v", len(events), e)
	}
	attempt := 0
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt++
		if attempt == 1 {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(204)
	}))
	defer receiver.Close()
	if Deliver(context.Background(), s, receiver.URL) == nil {
		t.Fatal("failed webhook treated as delivered")
	}
	pending, _ := s.Alerts(true)
	if len(pending) != 2 {
		t.Fatal("lost pending alerts")
	}
	if e = Deliver(context.Background(), s, receiver.URL); e != nil {
		t.Fatal(e)
	}
	pending, _ = s.Alerts(true)
	if len(pending) != 0 {
		t.Fatal("delivery not marked")
	}
}
