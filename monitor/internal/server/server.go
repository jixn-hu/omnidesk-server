package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"omnidesk-monitor/internal/storage"
	"omnidesk-monitor/protocol"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	Store     *storage.Store
	AdminHash string
	Now       func() time.Time
}

func Hash(token string) string { h := sha256.Sum256([]byte(token)); return hex.EncodeToString(h[:]) }
func Secret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func New(s *storage.Store, token string) *Server { return &Server{s, Hash(token), time.Now} }
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("只允许一个 JSON 对象")
	}
	return nil
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		reply(w, 200, map[string]any{"service": "omnidesk-monitor", "protocol": 1})
	})
	mux.HandleFunc("POST /v1/reports", s.report)
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		h := Hash(token)
		if token == "" || subtle.ConstantTimeCompare([]byte(h), []byte(s.AdminHash)) != 1 {
			fail(w, 401, "认证失败")
			return
		}
		// These headers are accepted only after the internal admin token was verified.
		owner := r.Header.Get("X-OmniDesk-User")
		path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/"), "/")
		parts := strings.Split(path, "/")
		if path == "backup" && r.Method == "GET" {
			if owner != "" {
				fail(w, 403, "整库备份仅允许服务端管理员操作")
				return
			}
			data, err := s.Store.Backup()
			if err != nil {
				fail(w, 500, "创建监控数据库快照失败，请在服务器检查日志或使用服务器备份")
				return
			}
			reply(w, 200, map[string]any{"format": "omnidesk-monitor-database", "version": 1, "createdAt": s.Now().UnixMilli(), "database": base64.StdEncoding.EncodeToString(data)})
			return
		}
		if path == "alerts" && r.Method == "GET" {
			data, err := s.Store.AlertsFor(false, owner)
			if err != nil {
				fail(w, 500, "读取提醒失败")
				return
			}
			if owner != "" {
				filtered := data[:0]
				for _, item := range data {
					if s.Store.Owns(item.NodeID, owner) {
						filtered = append(filtered, item)
					}
				}
				data = filtered
			}
			reply(w, 200, data)
			return
		}
		if path == "unclaimed" && r.Method == "GET" && owner != "" && r.Header.Get("X-OmniDesk-Admin") == "true" {
			nodes, err := s.Store.List(s.Now())
			if err != nil {
				fail(w, 500, "读取节点失败")
				return
			}
			result := []protocol.Node{}
			for _, n := range nodes {
				if n.OwnerID == "" {
					result = append(result, n)
				}
			}
			reply(w, 200, result)
			return
		}
		if path == "nodes" {
			if r.Method == "GET" {
				nodes, err := s.Store.ListFor(s.Now(), owner)
				if err != nil {
					fail(w, 500, "读取服务器失败")
					return
				}
				if owner != "" {
					filtered := nodes[:0]
					for _, n := range nodes {
						if n.OwnerID == owner {
							filtered = append(filtered, n)
						}
					}
					nodes = filtered
				}
				reply(w, 200, nodes)
				return
			}
			if r.Method == "POST" {
				var n protocol.Node
				if decode(w, r, &n) != nil {
					fail(w, 400, "无效请求")
					return
				}
				n.OwnerID = owner
				if n.IntervalSeconds == 0 {
					n.IntervalSeconds = 60
				}
				n.ID = Secret()[:24]
				token := Secret()
				if err := s.Store.Create(n, Hash(token)); err != nil {
					fail(w, 400, err.Error())
					return
				}
				reply(w, 201, map[string]any{"node": n, "token": token})
				return
			}
		}
		if len(parts) >= 2 && parts[0] == "nodes" && len(parts[1]) == 24 {
			id := parts[1]
			if len(parts) == 3 && parts[2] == "claim" && r.Method == "POST" && owner != "" && r.Header.Get("X-OmniDesk-Admin") == "true" {
				if s.Store.Claim(id, owner) != nil {
					fail(w, 404, "未找到可接管的旧节点")
					return
				}
				reply(w, 200, map[string]bool{"ok": true})
				return
			}
			if owner != "" && !s.Store.Owns(id, owner) {
				fail(w, 404, "服务器不存在")
				return
			}
			if len(parts) == 3 && parts[2] == "installation-check" && r.Method == "POST" {
				var input struct {
					Token string `json:"token"`
				}
				if decode(w, r, &input) != nil || len(input.Token) > 128 {
					fail(w, 400, "无效安装参数")
					return
				}
				tokenNode, err := s.Store.NodeForToken(Hash(input.Token))
				if err != nil || tokenNode != id {
					fail(w, 403, "节点令牌已失效，请重新生成安装命令")
					return
				}
				reply(w, 200, map[string]bool{"ok": true})
				return
			}
			if len(parts) == 3 && parts[2] == "probe" && r.Method == "POST" {
				nonce := Secret()[:24]
				if s.Store.RequestProbe(id, nonce) != nil {
					fail(w, 404, "服务器不存在")
					return
				}
				reply(w, 200, map[string]string{"requestId": nonce})
				return
			}
			if len(parts) == 2 && r.Method == "DELETE" {
				if err := s.Store.Delete(id); err != nil {
					fail(w, 500, "删除节点失败")
					return
				}
				reply(w, 200, map[string]bool{"ok": true})
				return
			}
			if len(parts) == 2 && r.Method == "PUT" {
				var n protocol.Node
				if decode(w, r, &n) != nil {
					fail(w, 400, "无效请求")
					return
				}
				n.ID = id
				if err := s.Store.Update(n); err != nil {
					status := 400
					if errors.Is(err, sql.ErrNoRows) {
						status = 404
					}
					fail(w, status, "资料保存失败："+err.Error())
					return
				}
				reply(w, 200, map[string]bool{"ok": true})
				return
			}
			if len(parts) == 3 && parts[2] == "token" && r.Method == "POST" {
				token := Secret()
				if err := s.Store.Rotate(id, Hash(token)); err != nil {
					fail(w, 404, "服务器不存在")
					return
				}
				reply(w, 200, map[string]string{"token": token})
				return
			}
			if len(parts) == 3 && parts[2] == "history" && r.Method == "GET" {
				hours, err := strconv.Atoi(r.URL.Query().Get("hours"))
				if err != nil || hours < 1 || hours > 744 {
					fail(w, 400, "时间范围须为 1 至 744 小时")
					return
				}
				step := int64(10000)
				if hours > 1 {
					step = 60000
				}
				if hours > 24 {
					step = 3600000
				}
				points, err := s.Store.History(id, s.Now().Add(-time.Duration(hours)*time.Hour).UnixMilli(), step)
				if err != nil {
					fail(w, 500, "读取历史失败")
					return
				}
				reply(w, 200, points)
				return
			}
		}
		fail(w, 404, "接口不存在")
	})
	return mux
}
func (s *Server) report(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		fail(w, 401, "认证失败")
		return
	}
	id, err := s.Store.NodeForToken(Hash(token))
	if err != nil {
		fail(w, 401, "认证失败")
		return
	}
	var p protocol.Report
	if decode(w, r, &p) != nil {
		fail(w, 400, "无效上报")
		return
	}
	if err = s.Store.Ingest(id, p, s.Now()); err != nil {
		fail(w, 400, "上报失败："+err.Error())
		return
	}
	reply(w, 200, map[string]any{"ack": p.Sequence, "intervalSeconds": s.Store.Interval(id), "refreshId": s.Store.ProbeID(id)})
}
