package storage

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestLegacyNodesMigrateWithoutImplicitOwnership(t *testing.T) {
	path := filepath.Join(t.TempDir(), "monitor.db")
	db, e := sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,grp TEXT NOT NULL,asset TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,last_seen INTEGER NOT NULL DEFAULT 0,metrics TEXT,coverage_start INTEGER NOT NULL DEFAULT 0);
 INSERT INTO nodes(id,name,grp,asset,token_hash) VALUES('123456789012345678901234','legacy','', '{}','original-token-hash');`)
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	store, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer store.DB.Close()
	nodes, e := store.List(time.Now())
	if e != nil || len(nodes) != 1 {
		t.Fatal(nodes, e)
	}
	if nodes[0].OwnerID != "" || nodes[0].IntervalSeconds != 0 {
		t.Fatal("legacy node was assigned or its reporting period overwritten")
	}
	if store.Owns(nodes[0].ID, "account-a") {
		t.Fatal("unclaimed node exposed")
	}
	if e = store.Claim(nodes[0].ID, "account-a"); e != nil {
		t.Fatal(e)
	}
	if !store.Owns(nodes[0].ID, "account-a") || store.Owns(nodes[0].ID, "account-b") {
		t.Fatal("ownership isolation failed")
	}
	id, e := store.NodeForToken("original-token-hash")
	if e != nil || id != nodes[0].ID {
		t.Fatal("claim invalidated the existing agent token", e)
	}
	if store.Claim(nodes[0].ID, "account-b") == nil {
		t.Fatal("node was reassigned implicitly")
	}
}
