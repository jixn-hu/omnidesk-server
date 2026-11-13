package agent_test

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"omnidesk-monitor/internal/agent"
	"omnidesk-monitor/internal/server"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRealAgentBackfillAndServiceRestart(t *testing.T) {
	directory := t.TempDir()
	dbPath := filepath.Join(directory, "monitor.db")
	store, err := storage.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { store.DB.Close() }()
	nodeID := "123456789012345678901234"
	token := "synthetic-node-token-at-least-24-characters"
	if err = store.Create(protocol.Node{ID: nodeID, Name: "real collector fixture", IntervalSeconds: 5, Asset: protocol.Asset{Provider: "Manual Seller", Region: "Manual Region"}}, server.Hash(token)); err != nil {
		t.Fatal(err)
	}
	var available atomic.Bool
	api := server.New(store, "synthetic-admin-token-at-least-24")
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !available.Load() {
			w.WriteHeader(503)
			return
		}
		r.URL.Path = strings.Replace(r.URL.Path, "/v1/monitor/", "/v1/", 1)
		api.Handler().ServeHTTP(w, r)
	})
	testServer := httptest.NewServer(handler)
	defer func() { testServer.Close() }()
	address := testServer.Listener.Addr().String()
	statePath := filepath.Join(directory, "agent-state.json")
	initial, err := agent.LoadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	initial.Discovered = &protocol.Discovery{IP: "8.8.8.8", Provider: "Synthetic Cloud", Region: "Japan / Tokyo", Timezone: "Asia/Tokyo", Source: "ipwho.is", DetectedAt: time.Now().UnixMilli()}
	if err = agent.SaveState(statePath, initial); err != nil {
		t.Fatal(err)
	}
	c := agent.Config{InstallationID: "synthetic-installation-marker", DisableDiscovery: true, ServerURL: testServer.URL + "/v1/monitor", Token: token, StatePath: statePath, IntervalSeconds: 5}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- agent.Run(ctx, c) }()
	state := func() *agent.State {
		b, e := os.ReadFile(statePath)
		if e != nil {
			return nil
		}
		var s agent.State
		if json.Unmarshal(b, &s) != nil {
			return nil
		}
		return &s
	}
	await := func(label string, predicate func() bool) {
		t.Helper()
		deadline := time.Now().Add(25 * time.Second)
		for time.Now().Before(deadline) {
			select {
			case e := <-done:
				t.Fatalf("Agent stopped during %s: %v", label, e)
			default:
			}
			if predicate() {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("timeout: " + label)
	}
	await("offline queue", func() bool { s := state(); return s != nil && len(s.Queue) > 0 })
	available.Store(true)
	await("backfill", func() bool { s := state(); return s != nil && s.Sequence >= 2 && len(s.Queue) == 0 })
	before := state()
	nodes, err := store.List(time.Now())
	if err != nil || len(nodes) != 1 || nodes[0].Metrics == nil {
		t.Fatalf("real metrics: %v %v", nodes, err)
	}
	var metrics struct {
		InstallationID string `json:"installationId"`
	}
	if err := json.Unmarshal(nodes[0].Metrics, &metrics); err != nil || metrics.InstallationID != c.InstallationID {
		t.Fatalf("installation receipt missing: %v", err)
	}
	// Interrupt service while Agent keeps collecting into its durable queue.
	testServer.Close()
	store.DB.Close()
	await("service outage queue", func() bool { s := state(); return s != nil && len(s.Queue) > 0 })
	store, err = storage.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	api = server.New(store, "synthetic-admin-token-at-least-24")
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	testServer = httptest.NewUnstartedServer(handler)
	testServer.Listener = listener
	testServer.Start()
	await("service restart backfill", func() bool { s := state(); return s != nil && s.Sequence > before.Sequence && len(s.Queue) == 0 })
	cancel()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	after := state()
	if after.Epoch != before.Epoch || after.Upload < before.Upload || after.Download < before.Download {
		t.Fatal("flow ledger lost during outage")
	}
	// Restart Agent from disk; the same epoch and counters must continue.
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	done2 := make(chan error, 1)
	go func() { done2 <- agent.Run(ctx2, c) }()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		s := state()
		if s != nil && s.Sequence > after.Sequence && len(s.Queue) == 0 {
			cancel2()
			if err = <-done2; err != nil {
				t.Fatal(err)
			}
			nodes, listErr := store.List(time.Now())
			if listErr != nil || len(nodes) != 1 {
				t.Fatal("node discovery list failed", listErr)
			}
			var metrics agent.Metrics
			if err = json.Unmarshal(nodes[0].Metrics, &metrics); err != nil || metrics.Discovered == nil || metrics.Discovered.Provider != "Synthetic Cloud" {
				t.Fatal("Agent discovery was not retained by service", err)
			}
			if nodes[0].Asset.Provider != "Manual Seller" || nodes[0].Asset.Region != "Manual Region" {
				t.Fatal("discovery overwrote manual node assets")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("Agent did not resume persistent ledger")
}

func TestAgentReportsWithoutMatchingNetwork(t *testing.T) {
	reports := make(chan agent.Metrics, 1)
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var report protocol.Report
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		var metrics agent.Metrics
		if err := json.Unmarshal(report.Metrics, &metrics); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if !report.Incomplete {
			t.Error("unavailable network must mark traffic incomplete")
		}
		json.NewEncoder(w).Encode(map[string]any{"ack": report.Sequence})
		select {
		case reports <- metrics:
		default:
		}
	}))
	defer receiver.Close()
	statePath := filepath.Join(t.TempDir(), "state.json")
	previous, err := agent.LoadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	previous.Advance(100, map[string]agent.Counter{"previous-adapter": {Up: 100, Down: 200}})
	if err := agent.SaveState(statePath, previous); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- agent.Run(ctx, agent.Config{DisableDiscovery: true, ServerURL: receiver.URL + "/v1/monitor", Token: "synthetic-no-network-node-token", StatePath: statePath, IntervalSeconds: 5, IncludeNics: []string{"__omnidesk_no_such_adapter__*"}})
	}()
	select {
	case err := <-done:
		t.Fatalf("Agent stopped instead of reporting remaining metrics: %v", err)
	case <-ctx.Done():
		t.Fatal("no metrics report without matching network")
	case metrics := <-reports:
		networkUnavailable := false
		for _, field := range metrics.Unavailable {
			if field == "network" {
				networkUnavailable = true
			}
		}
		if !networkUnavailable || len(metrics.Network) != 0 || metrics.CPU.Cores == 0 || metrics.Memory.Total == 0 || len(metrics.Disks) == 0 {
			t.Errorf("remaining metrics or unavailable marker missing: %+v", metrics)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	saved, err := agent.LoadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Epoch != previous.Epoch || saved.Previous["previous-adapter"].Up != 100 {
		t.Fatal("network outage replaced the durable baseline")
	}
}
