package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"os"
	"path/filepath"
	"testing"
)

func TestBackupAuthenticationAndConsistentDatabase(t *testing.T) {
	dir := t.TempDir()
	store, err := storage.Open(filepath.Join(dir, "live.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	node := protocol.Node{ID: "1234567890abcdef12345678", Name: "fixture"}
	if err := store.Create(node, Hash("synthetic-agent-token")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB.Exec("INSERT INTO daily(node_id,day,up,down,incomplete) VALUES(?,1,123,456,0)", node.ID); err != nil {
		t.Fatal(err)
	}
	handler := New(store, "synthetic-admin-token").Handler()
	get := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/v1/backup", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out
	}
	for _, token := range []string{"", "synthetic-agent-token", "wrong"} {
		out := get(token)
		if out.Code != 401 || bytes.Contains(out.Body.Bytes(), []byte("database")) {
			t.Fatalf("unauthorized snapshot: %d", out.Code)
		}
	}
	out := get("synthetic-admin-token")
	if out.Code != 200 || out.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("snapshot failed: %d %s", out.Code, out.Body.String())
	}
	var snapshot struct {
		Format   string `json:"format"`
		Version  int    `json:"version"`
		Database string `json:"database"`
	}
	if err := json.Unmarshal(out.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Format != "omnidesk-monitor-database" || snapshot.Version != 1 {
		t.Fatal("invalid snapshot metadata")
	}
	data, err := base64.StdEncoding.DecodeString(snapshot.Database)
	if err != nil || !bytes.HasPrefix(data, []byte("SQLite format 3")) {
		t.Fatal("invalid SQLite snapshot")
	}
	if bytes.Contains(data, []byte("synthetic-admin-token")) || bytes.Contains(data, []byte("synthetic-agent-token")) {
		t.Fatal("snapshot contains plaintext token")
	}
	restoredPath := filepath.Join(dir, "restored.db")
	if err := os.WriteFile(restoredPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	restored, err := storage.Open(restoredPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.DB.Close()
	var integrity string
	if err := restored.DB.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatal("snapshot failed integrity check", err)
	}
	var up, down int
	if err := restored.DB.QueryRow("SELECT up,down FROM daily WHERE node_id=?", node.ID).Scan(&up, &down); err != nil || up != 123 || down != 456 {
		t.Fatal("committed WAL data missing", err)
	}
	var hash string
	if err := restored.DB.QueryRow("SELECT token_hash FROM nodes WHERE id=?", node.ID).Scan(&hash); err != nil || hash != Hash("synthetic-agent-token") {
		t.Fatal("collector identity not preserved", err)
	}
	var count int
	if err := store.DB.QueryRow("SELECT count(*) FROM nodes").Scan(&count); err != nil || count != 1 {
		t.Fatal("live database modified")
	}
}
