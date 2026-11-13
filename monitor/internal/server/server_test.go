package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"path/filepath"
	"testing"
	"time"
)

func TestAuthenticatedProvisionIngestAndQuery(t *testing.T) {
	s, e := storage.Open(filepath.Join(t.TempDir(), "db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	api := New(s, "admin-fixture-token-at-least-24")
	handler := api.Handler()
	request := func(method, path, token string, body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(b))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/v1/nodes", "", nil); w.Code != 401 {
		t.Fatal("anonymous access")
	}
	w := request("POST", "/v1/nodes", "admin-fixture-token-at-least-24", protocol.Node{Name: "test"})
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Node  protocol.Node `json:"node"`
		Token string        `json:"token"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	if w := request("GET", "/v1/nodes", created.Token, nil); w.Code != 401 {
		t.Fatal("agent obtained admin access")
	}
	now := time.Now().UnixMilli()
	m, _ := json.Marshal(map[string]any{"timestamp": now, "system": map[string]any{}, "cpu": map[string]any{"usage": 1, "cores": 2, "loadAvg": []float64{0, 0, 0}, "perCore": []float64{0, 0}}, "memory": map[string]any{"usagePercent": 1}, "network": []any{}, "disks": []any{}})
	report := protocol.Report{Epoch: "fixture-epoch", Sequence: 1, Timestamp: now, Upload: 123, Download: 456, Metrics: m}
	for range 2 {
		if w = request("POST", "/v1/reports", created.Token, report); w.Code != http.StatusOK {
			t.Fatalf("ingest: %s", w.Body.String())
		}
	}
	w = request("GET", "/v1/nodes", "admin-fixture-token-at-least-24", nil)
	var nodes []protocol.Node
	if json.Unmarshal(w.Body.Bytes(), &nodes) != nil || len(nodes) != 1 || nodes[0].Upload != 123 {
		t.Fatalf("query/dedup: %s", w.Body.String())
	}
	if bytes.Contains(w.Body.Bytes(), []byte(created.Token)) {
		t.Fatal("token leaked")
	}
	w = request("POST", "/v1/nodes/"+created.Node.ID+"/token", "admin-fixture-token-at-least-24", nil)
	if w.Code != 200 {
		t.Fatal("rotate")
	}
	if w = request("POST", "/v1/reports", created.Token, report); w.Code != 401 {
		t.Fatal("old token remains valid")
	}
}

func TestDeleteRequiresAdminAndInvalidatesCollector(t *testing.T) {
	store, err := storage.Open(filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	id := "123456789012345678901234"
	if err := store.Create(protocol.Node{ID: id, Name: "delete fixture"}, Hash("collector-fixture")); err != nil {
		t.Fatal(err)
	}
	handler := New(store, "admin-fixture").Handler()
	request := func(method, path, token string) int {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	for _, token := range []string{"", "collector-fixture"} {
		if got := request("DELETE", "/v1/nodes/"+id, token); got != 401 {
			t.Fatalf("unauthorized delete: %d", got)
		}
	}
	for range 2 {
		if got := request("DELETE", "/v1/nodes/"+id, "admin-fixture"); got != 200 {
			t.Fatalf("delete/retry: %d", got)
		}
	}
	if got := request("POST", "/v1/reports", "collector-fixture"); got != 401 {
		t.Fatalf("old token: %d", got)
	}
}
