package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"omnidesk-monitor/internal/alerts"
	"omnidesk-monitor/internal/server"
	"omnidesk-monitor/internal/storage"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:18088", "监听地址")
	data := flag.String("data", "./data/monitor.db", "数据库文件")
	flag.Parse()
	token := os.Getenv("OMNIDESK_ADMIN_TOKEN")
	if path := os.Getenv("OMNIDESK_ADMIN_TOKEN_FILE"); path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			log.Fatal("无法读取管理员令牌文件")
		}
		token = strings.TrimSpace(string(b))
	}
	if len(token) < 24 {
		log.Fatal("请通过 OMNIDESK_ADMIN_TOKEN_FILE 或 OMNIDESK_ADMIN_TOKEN 配置至少 24 字符的管理员令牌")
	}
	store, err := storage.Open(*data)
	if err != nil {
		log.Fatal(err)
	}
	defer store.DB.Close()
	api := server.New(store, token)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{Addr: *listen, Handler: api.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		lastPrune := time.Time{}
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				if err := alerts.Check(store, now); err != nil {
					log.Print("提醒检查失败")
				}
				if err := alerts.Deliver(ctx, store, os.Getenv("OMNIDESK_WEBHOOK_URL")); err != nil {
					log.Print(err)
				}
				if now.Sub(lastPrune) > time.Hour {
					if err := store.Prune(now); err != nil {
						log.Print("历史清理失败")
					} else {
						lastPrune = now
					}
				}
			}
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Printf("OmniDesk monitor listening on %s", *listen)
	if err = srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
