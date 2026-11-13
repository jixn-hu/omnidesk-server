package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"omnidesk-monitor/internal/agent"
	"os"
	"os/signal"
	"syscall"
)

func runConfig(path string, ctx context.Context) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var c agent.Config
	if err = json.Unmarshal(b, &c); err != nil {
		return err
	}
	return agent.Run(ctx, c)
}
func main() {
	path := flag.String("config", "./agent.local.json", "采集端配置文件")
	flag.Parse()
	if handled, err := runService(*path); handled {
		if err != nil {
			log.Fatal("监控服务运行失败")
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runConfig(*path, ctx); err != nil {
		log.Fatal(err)
	}
}
