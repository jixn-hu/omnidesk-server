package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	_ "modernc.org/sqlite"
	"omnidesk-monitor/protocol"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

type Store struct{ DB *sql.DB }

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,grp TEXT NOT NULL,asset TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,last_seen INTEGER NOT NULL DEFAULT 0,metrics TEXT,coverage_start INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS streams(node_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,PRIMARY KEY(node_id,epoch));
 CREATE TABLE IF NOT EXISTS samples(node_id TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,ts INTEGER NOT NULL,metrics TEXT NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,incomplete INTEGER NOT NULL,PRIMARY KEY(node_id,epoch,seq));
 CREATE INDEX IF NOT EXISTS samples_time ON samples(node_id,ts);
 CREATE TABLE IF NOT EXISTS minute_samples(node_id TEXT NOT NULL,ts INTEGER NOT NULL,metrics TEXT NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,incomplete INTEGER NOT NULL,PRIMARY KEY(node_id,ts));
 CREATE TABLE IF NOT EXISTS daily(node_id TEXT NOT NULL,day INTEGER NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,incomplete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(node_id,day));
 CREATE TABLE IF NOT EXISTS alert_state(node_id TEXT NOT NULL,kind TEXT NOT NULL,since INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(node_id,kind));
 CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,node_id TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,ts INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS alerts_time ON alerts(ts);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	// Additive migrations preserve existing nodes, traffic and history.
	for _, column := range []struct{ name, definition string }{{"owner_id", "TEXT NOT NULL DEFAULT ''"}, {"interval_seconds", "INTEGER NOT NULL DEFAULT 0"}, {"probe_request_id", "TEXT NOT NULL DEFAULT ''"}} {
		rows, e := db.Query("PRAGMA table_info(nodes)")
		if e != nil {
			db.Close()
			return nil, e
		}
		found := false
		for rows.Next() {
			var cid, nn, pk int
			var name, typ string
			var def any
			if e = rows.Scan(&cid, &name, &typ, &nn, &def, &pk); e != nil {
				rows.Close()
				db.Close()
				return nil, e
			}
			if name == column.name {
				found = true
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			db.Close()
			return nil, e
		}
		if !found {
			if _, e = db.Exec("ALTER TABLE nodes ADD COLUMN " + column.name + " " + column.definition); e != nil {
				db.Close()
				return nil, e
			}
		}
	}
	if _, e := db.Exec("CREATE INDEX IF NOT EXISTS nodes_owner ON nodes(owner_id)"); e != nil {
		db.Close()
		return nil, e
	}
	return &Store{db}, nil
}
func ValidateAsset(a *protocol.Asset) error {
	if a.Timezone == "" {
		a.Timezone = "Asia/Shanghai"
	}
	if _, err := time.LoadLocation(a.Timezone); err != nil {
		return errors.New("无效时区")
	}
	if a.ExpiresAt != "" {
		if _, err := time.Parse("2006-01-02", a.ExpiresAt); err != nil {
			return errors.New("到期日期格式应为 YYYY-MM-DD")
		}
	}
	if a.ResetDay == 0 {
		a.ResetDay = 1
	}
	if a.ResetDay < 1 || a.ResetDay > 31 {
		return errors.New("重置日期须为 1 至 31")
	}
	if a.TrafficMode == "" {
		a.TrafficMode = "sum"
	}
	if !strings.Contains("|sum|up|down|max|min|", "|"+a.TrafficMode+"|") {
		return errors.New("无效流量计费方式")
	}
	if a.Price < 0 || math.IsNaN(a.Price) || math.IsInf(a.Price, 0) || a.TrafficLimit > 1<<53 || a.InitialUpload > 1<<53 || a.InitialDownload > 1<<53 {
		return errors.New("数值超出范围")
	}
	if len(a.Provider) > 256 || len(a.Region) > 256 || len(a.VendorURL) > 2048 || len(a.Currency) > 20 {
		return errors.New("资料过长")
	}
	if a.InitialPeriod != "" {
		if _, err := time.Parse("2006-01-02", a.InitialPeriod); err != nil {
			return errors.New("起始用量周期无效")
		}
	}
	return nil
}
func (s *Store) Create(n protocol.Node, hash string) error {
	if strings.TrimSpace(n.Name) == "" || utf8.RuneCountInString(n.Name) > 256 || utf8.RuneCountInString(n.Group) > 256 {
		return errors.New("服务器名称或分组无效")
	}
	if err := ValidateAsset(&n.Asset); err != nil {
		return err
	}
	if n.IntervalSeconds == 0 {
		n.IntervalSeconds = 60
	}
	if !ValidInterval(n.IntervalSeconds) {
		return errors.New("采集上报周期须为 5 至 86400 秒")
	}
	b, _ := json.Marshal(n.Asset)
	_, err := s.DB.Exec("INSERT INTO nodes(id,name,grp,asset,token_hash,owner_id,interval_seconds) VALUES(?,?,?,?,?,?,?)", n.ID, n.Name, n.Group, string(b), hash, n.OwnerID, n.IntervalSeconds)
	return err
}
func (s *Store) Update(n protocol.Node) error {
	if strings.TrimSpace(n.Name) == "" || utf8.RuneCountInString(n.Name) > 256 || utf8.RuneCountInString(n.Group) > 256 {
		return errors.New("服务器名称或分组无效")
	}
	if err := ValidateAsset(&n.Asset); err != nil {
		return err
	}
	if n.IntervalSeconds != 0 && !ValidInterval(n.IntervalSeconds) {
		return errors.New("采集上报周期须为 5 至 86400 秒")
	}
	b, _ := json.Marshal(n.Asset)
	result, err := s.DB.Exec("UPDATE nodes SET name=?,grp=?,asset=?,interval_seconds=CASE WHEN ?=0 THEN interval_seconds ELSE ? END WHERE id=?", n.Name, n.Group, string(b), n.IntervalSeconds, n.IntervalSeconds, n.ID)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// Delete removes the node and every dependent record atomically; retrying is safe.
func (s *Store) Delete(id string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"streams", "samples", "minute_samples", "daily", "alert_state", "alerts"} {
		if _, err = tx.Exec("DELETE FROM "+table+" WHERE node_id=?", id); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("DELETE FROM nodes WHERE id=?", id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) NodeForToken(hash string) (string, error) {
	var id string
	err := s.DB.QueryRow("SELECT id FROM nodes WHERE token_hash=?", hash).Scan(&id)
	return id, err
}
func (s *Store) Rotate(id, hash string) error {
	r, e := s.DB.Exec("UPDATE nodes SET token_hash=? WHERE id=?", hash, id)
	if e != nil {
		return e
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}
func ValidateReport(r protocol.Report, now time.Time) error {
	var shape map[string]json.RawMessage
	if json.Unmarshal(r.Metrics, &shape) != nil {
		return errors.New("无效指标对象")
	}
	for _, key := range []string{"system", "cpu", "memory"} {
		raw := shape[key]
		if len(raw) == 0 || raw[0] != '{' {
			return errors.New("缺少指标对象：" + key)
		}
	}
	for _, key := range []string{"disks", "network"} {
		raw := shape[key]
		if len(raw) == 0 || raw[0] != '[' {
			return errors.New("缺少指标数组：" + key)
		}
	}
	if raw := shape["intervalSeconds"]; raw != nil {
		var seconds int
		if json.Unmarshal(raw, &seconds) != nil || !ValidInterval(seconds) {
			return errors.New("无效采集上报周期")
		}
	}
	var c struct {
		Usage   *float64  `json:"usage"`
		Cores   int       `json:"cores"`
		LoadAvg []float64 `json:"loadAvg"`
		PerCore []float64 `json:"perCore"`
	}
	if json.Unmarshal(shape["cpu"], &c) != nil || c.Usage == nil || c.Cores < 1 || c.Cores > 65536 || len(c.LoadAvg) != 3 || c.PerCore == nil {
		return errors.New("无效 CPU 指标")
	}
	var memory struct {
		Usage *float64 `json:"usagePercent"`
	}
	if json.Unmarshal(shape["memory"], &memory) != nil || memory.Usage == nil {
		return errors.New("无效内存指标")
	}

	if len(r.Epoch) < 8 || len(r.Epoch) > 128 || r.Sequence == 0 || r.Sequence > 1<<53 || r.Upload > 1<<53 || r.Download > 1<<53 {
		return errors.New("无效上报序列或计数")
	}
	if r.Timestamp <= 0 || r.Timestamp > now.Add(5*time.Minute).UnixMilli() {
		return errors.New("无效采集时间")
	}
	var m struct {
		Timestamp int64 `json:"timestamp"`
		CPU       struct {
			Usage float64 `json:"usage"`
		} `json:"cpu"`
		Memory struct {
			UsagePercent float64 `json:"usagePercent"`
		} `json:"memory"`
		System  *json.RawMessage `json:"system"`
		Network []struct {
			RxBytes float64 `json:"rxBytes"`
			TxBytes float64 `json:"txBytes"`
		} `json:"network"`
	}
	if err := json.Unmarshal(r.Metrics, &m); err != nil || m.System == nil || m.Timestamp != r.Timestamp || m.CPU.Usage < 0 || m.CPU.Usage > 100 || m.Memory.UsagePercent < 0 || m.Memory.UsagePercent > 100 {
		return errors.New("无效指标")
	}
	for _, n := range m.Network {
		if n.RxBytes < 0 || n.TxBytes < 0 {
			return errors.New("无效网卡计数")
		}
	}
	return nil
}

// Ingest commits the ledger, history and latest snapshot together. Retries are idempotent.
func (s *Store) Ingest(id string, r protocol.Report, now time.Time) error {
	if err := ValidateReport(r, now); err != nil {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// A report authenticated immediately before deletion must not recreate orphan history.
	var present int
	if err = tx.QueryRow("SELECT 1 FROM nodes WHERE id=?", id).Scan(&present); err != nil {
		return err
	}
	var seq, up, down uint64
	err = tx.QueryRow("SELECT seq,up,down FROM streams WHERE node_id=? AND epoch=?", id, r.Epoch).Scan(&seq, &up, &down)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if r.Sequence <= seq {
		return nil
	}
	if r.Upload < up || r.Download < down {
		return errors.New("累计流量不能回退")
	}
	du, dd := r.Upload-up, r.Download-down
	incomplete := r.Incomplete || seq == 0 || (seq > 0 && r.Sequence > seq+1)
	_, err = tx.Exec("INSERT INTO streams VALUES(?,?,?,?,?) ON CONFLICT(node_id,epoch) DO UPDATE SET seq=excluded.seq,up=excluded.up,down=excluded.down", id, r.Epoch, r.Sequence, r.Upload, r.Download)
	if err != nil {
		return err
	}
	_, err = tx.Exec("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?)", id, r.Epoch, r.Sequence, r.Timestamp, string(r.Metrics), du, dd, incomplete)
	if err != nil {
		return err
	}
	day := time.UnixMilli(r.Timestamp).UTC().Truncate(24 * time.Hour).UnixMilli()
	_, err = tx.Exec("INSERT INTO daily VALUES(?,?,?,?,?) ON CONFLICT(node_id,day) DO UPDATE SET up=up+excluded.up,down=down+excluded.down,incomplete=max(incomplete,excluded.incomplete)", id, day, du, dd, incomplete)
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE nodes SET last_seen=?, metrics=CASE WHEN ? >= coalesce(json_extract(metrics,'$.timestamp'),0) THEN ? ELSE metrics END,coverage_start=CASE WHEN coverage_start=0 OR coverage_start>? THEN ? ELSE coverage_start END WHERE id=?", now.UnixMilli(), r.Timestamp, string(r.Metrics), r.Timestamp, r.Timestamp, id)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Period uses local calendar boundaries, including month end and DST.
func Period(now time.Time, a protocol.Asset) (time.Time, time.Time) {
	loc, err := time.LoadLocation(a.Timezone)
	if err != nil {
		loc = time.UTC
	}
	local := now.In(loc)
	day := a.ResetDay
	if day < 1 {
		day = 1
	}
	boundary := func(y int, m time.Month) time.Time {
		last := time.Date(y, m+1, 0, 0, 0, 0, 0, loc).Day()
		d := day
		if d > last {
			d = last
		}
		return time.Date(y, m, d, 0, 0, 0, 0, loc)
	}
	start := boundary(local.Year(), local.Month())
	if local.Before(start) {
		prev := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, loc).AddDate(0, -1, 0)
		start = boundary(prev.Year(), prev.Month())
	}
	next := time.Date(start.Year(), start.Month(), 1, 0, 0, 0, 0, loc).AddDate(0, 1, 0)
	return start, boundary(next.Year(), next.Month())
}
func (s *Store) List(now time.Time) ([]protocol.Node, error) { return s.ListFor(now, "") }
func (s *Store) ListFor(now time.Time, owner string) ([]protocol.Node, error) {
	query := "SELECT id,name,grp,asset,last_seen,metrics,coverage_start,owner_id,interval_seconds,probe_request_id FROM nodes"
	args := []any{}
	if owner != "" {
		query += " WHERE owner_id=?"
		args = append(args, owner)
	}
	query += " ORDER BY name,id"
	rows, err := s.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	out := []protocol.Node{}
	for rows.Next() {
		var n protocol.Node
		var a string
		var m sql.NullString
		if err = rows.Scan(&n.ID, &n.Name, &n.Group, &a, &n.LastSeen, &m, &n.CoverageStart, &n.OwnerID, &n.IntervalSeconds, &n.ProbeRequestID); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(a), &n.Asset); err != nil {
			rows.Close()
			return nil, err
		}
		if m.Valid {
			n.Metrics = json.RawMessage(m.String)
		}
		out = append(out, n)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range out {
		n := &out[i]
		start, end := Period(now, n.Asset)
		n.PeriodStart = start.UnixMilli()
		n.PeriodEnd = end.UnixMilli()
		if err = s.DB.QueryRow("SELECT coalesce(sum(up),0),coalesce(sum(down),0) FROM streams WHERE node_id=?", n.ID).Scan(&n.Upload, &n.Download); err != nil {
			return nil, err
		}
		var incomplete int
		if err = s.DB.QueryRow("SELECT coalesce(sum(up),0),coalesce(sum(down),0),coalesce(max(incomplete),0) FROM (SELECT ts,up,down,incomplete FROM samples WHERE node_id=? UNION ALL SELECT ts,up,down,incomplete FROM minute_samples WHERE node_id=?) WHERE ts>=? AND ts<?", n.ID, n.ID, n.PeriodStart, n.PeriodEnd).Scan(&n.PeriodUpload, &n.PeriodDownload, &incomplete); err != nil {
			return nil, err
		}
		if n.Asset.InitialPeriod == start.Format("2006-01-02") {
			n.PeriodUpload += n.Asset.InitialUpload
			n.PeriodDownload += n.Asset.InitialDownload
		}

		loc, _ := time.LoadLocation(n.Asset.Timezone)
		local := now.In(loc)
		today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
		if err = s.DB.QueryRow("SELECT coalesce(sum(up),0),coalesce(sum(down),0) FROM (SELECT ts,up,down FROM samples WHERE node_id=? UNION ALL SELECT ts,up,down FROM minute_samples WHERE node_id=?) WHERE ts>=? AND ts<?", n.ID, n.ID, today.UnixMilli(), today.AddDate(0, 0, 1).UnixMilli()).Scan(&n.TodayUpload, &n.TodayDownload); err != nil {
			return nil, err
		}
		n.Incomplete = incomplete != 0 || n.CoverageStart == 0 || n.CoverageStart > n.PeriodStart
	}
	return out, nil
}
func (s *Store) History(id string, from int64, step int64) ([]protocol.Point, error) {
	if step < 10000 {
		step = 10000
	}
	rows, err := s.DB.Query(`SELECT ts,metrics,up,down,incomplete FROM (SELECT ts,metrics,sum(up) OVER(PARTITION BY ts / ?) AS up,sum(down) OVER(PARTITION BY ts / ?) AS down,max(incomplete) OVER(PARTITION BY ts / ?) AS incomplete,row_number() OVER(PARTITION BY ts / ? ORDER BY ts DESC) AS rn FROM (SELECT ts,metrics,up,down,incomplete FROM samples WHERE node_id=? AND ts>=? UNION ALL SELECT ts,metrics,up,down,incomplete FROM minute_samples WHERE node_id=? AND ts>=?)) WHERE rn=1 ORDER BY ts LIMIT 2100`, step, step, step, step, id, from, id, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.Point{}
	for rows.Next() {
		var p protocol.Point
		var m string
		if err := rows.Scan(&p.Timestamp, &m, &p.Upload, &p.Download, &p.Incomplete); err != nil {
			return nil, err
		}
		p.Metrics = json.RawMessage(m)
		out = append(out, p)
	}
	return out, rows.Err()
}
func (s *Store) Prune(now time.Time) error {
	// Compact complete minute buckets after 24h. Resource metrics retain the latest
	// sample in a bucket; traffic always sums raw increments, never chart rates.
	cutoff := now.Add(-24*time.Hour).UnixMilli() / 60000 * 60000
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO minute_samples(node_id,ts,metrics,up,down,incomplete)
 SELECT node_id,bucket,metrics,up,down,incomplete FROM (
 SELECT node_id,ts/60000*60000 AS bucket,metrics,
 sum(up) OVER(PARTITION BY node_id,ts/60000) AS up,
 sum(down) OVER(PARTITION BY node_id,ts/60000) AS down,
 max(incomplete) OVER(PARTITION BY node_id,ts/60000) AS incomplete,
 row_number() OVER(PARTITION BY node_id,ts/60000 ORDER BY ts DESC) AS rn
 FROM samples WHERE ts<?) WHERE rn=1
 ON CONFLICT(node_id,ts) DO UPDATE SET
 metrics=CASE WHEN json_extract(excluded.metrics,'$.timestamp')>=json_extract(minute_samples.metrics,'$.timestamp') THEN excluded.metrics ELSE minute_samples.metrics END,
 up=minute_samples.up+excluded.up,down=minute_samples.down+excluded.down,incomplete=max(minute_samples.incomplete,excluded.incomplete)`, cutoff)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM samples WHERE ts<?", cutoff); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM minute_samples WHERE ts<?", now.AddDate(0, 0, -32).UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.Exec("DELETE FROM alerts WHERE ts<?", now.AddDate(0, 0, -90).UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func Used(a protocol.Asset, up, down uint64) uint64 {
	switch a.TrafficMode {
	case "up":
		return up
	case "down":
		return down
	case "max":
		return max(up, down)
	case "min":
		return min(up, down)
	default:
		return up + down
	}
}
func (s *Store) AlertState(id, kind, message string, condition bool, delay time.Duration, now time.Time) error {
	if !condition {
		_, err := s.DB.Exec("DELETE FROM alert_state WHERE node_id=? AND kind=?", id, kind)
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var present int
	if err := tx.QueryRow("SELECT 1 FROM nodes WHERE id=?", id).Scan(&present); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT OR IGNORE INTO alert_state VALUES(?,?,?,0)", id, kind, now.UnixMilli()); err != nil {
		return err
	}
	result, err := tx.Exec("UPDATE alert_state SET active=1 WHERE node_id=? AND kind=? AND active=0 AND since<=?", id, kind, now.Add(-delay).UnixMilli())
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count > 0 {
		_, err = tx.Exec("INSERT INTO alerts(node_id,kind,message,ts) VALUES(?,?,?,?)", id, kind, message, now.UnixMilli())
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) Alerts(pending bool) ([]protocol.Alert, error) { return s.AlertsFor(pending, "") }
func (s *Store) AlertsFor(pending bool, owner string) ([]protocol.Alert, error) {
	q := "SELECT id,node_id,kind,message,ts,delivered FROM alerts"
	if pending {
		q += " WHERE delivered=0"
	}
	args := []any{}
	if owner != "" {
		if pending {
			q += " AND "
		} else {
			q += " WHERE "
		}
		q += "node_id IN (SELECT id FROM nodes WHERE owner_id=?)"
		args = append(args, owner)
	}
	q += " ORDER BY id DESC LIMIT 200"
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.Alert{}
	for rows.Next() {
		var a protocol.Alert
		if err = rows.Scan(&a.ID, &a.NodeID, &a.Kind, &a.Message, &a.Timestamp, &a.Delivered); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
func (s *Store) MarkDelivered(id int64) error {
	_, err := s.DB.Exec("UPDATE alerts SET delivered=1 WHERE id=?", id)
	return err
}

// Backup uses SQLite's consistent snapshot operation, including committed WAL data.
// Never copy the live database file while collectors are writing to it.
func (s *Store) Backup() ([]byte, error) {
	directory, err := os.MkdirTemp("", "omnidesk-monitor-backup-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	name := filepath.Join(directory, "snapshot.db")
	if _, err = s.DB.Exec("VACUUM INTO ?", name); err != nil {
		return nil, err
	}
	snapshot, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer snapshot.Close()
	data, err := io.ReadAll(io.LimitReader(snapshot, 64*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 64*1024*1024 {
		return nil, errors.New("数据库备份超过 64MB，请在服务器上备份")
	}
	return data, nil
}

func ValidInterval(seconds int) bool { return seconds >= 5 && seconds <= 86400 }
func (s *Store) Owns(id, owner string) bool {
	var actual string
	return s.DB.QueryRow("SELECT owner_id FROM nodes WHERE id=?", id).Scan(&actual) == nil && (owner == "" || actual == owner)
}
func (s *Store) Claim(id, owner string) error {
	result, err := s.DB.Exec("UPDATE nodes SET owner_id=? WHERE id=? AND owner_id=''", owner, id)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return sql.ErrNoRows
	}
	return nil
}
func (s *Store) Interval(id string) int {
	var value int
	_ = s.DB.QueryRow("SELECT interval_seconds FROM nodes WHERE id=?", id).Scan(&value)
	return value
}

func (s *Store) RequestProbe(id, nonce string) error {
	result, e := s.DB.Exec("UPDATE nodes SET probe_request_id=? WHERE id=?", nonce, id)
	if e != nil {
		return e
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return sql.ErrNoRows
	}
	return nil
}
func (s *Store) ProbeID(id string) string {
	var nonce string
	_ = s.DB.QueryRow("SELECT probe_request_id FROM nodes WHERE id=?", id).Scan(&nonce)
	return nonce
}
