# 部署 OmniDesk 统一后端

配套 PC 客户端与 Windows 安装包：[jixn-hu/omnidesk](https://github.com/jixn-hu/omnidesk)。本指南对应 [统一后端源码](https://github.com/jixn-hu/omnidesk-server)。

## 新部署

1. 安装 Docker 与 Compose 插件，克隆本仓库并进入目录。
2. `cp .env.example .env`，设置 `OFFICIAL_PUBLIC_URL=https://cloud.example.com`；替换为自己的 HTTPS 域名，端口也须与外部访问地址一致。
3. `docker compose up -d --build`。Dockerfile 从本仓库的 `monitor/` 编译监控服务与 Windows Agent，从 `assets/monitor-agent/` 读取安装模板，不依赖相邻 PC 目录。
4. `docker compose exec cloud node tools/create-admin.mjs`，交互创建管理员。公开注册默认关闭；创建命令不会覆盖已有账号。
5. 配置反向代理到 `http://127.0.0.1:47830`，保留原请求路径并启用 HTTPS。管理入口为 `/admin/`。
6. PC 的“账号”填写最终 HTTPS 地址并登录，按需启用云端监控。Agent 通过同一来源的 `/v1/monitor` 上报。

示例 Nginx 位置配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:47830;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

HTTPS 证书和主机名由自己的反向代理管理。Compose 默认只绑定本机回环地址。无 TLS 的本地测试仅用于受控环境。

## 数据与备份

默认保留三个命名数据卷，名称可通过 `.env` 指定：

| 数据卷 | 容器位置 | 内容 |
| --- | --- | --- |
| `omnidesk-cloud-data` | `/data` | 统一入口的内部令牌 |
| `omnidesk-account-data` | `/data/account` | 账号数据库与主密钥 |
| `omnidesk-monitor-data` | `/data/monitor` | 监控数据库 |

内部管理令牌仅在 Node 与 Go 之间使用，不应交给 PC 或采集端。各账号与各部署实例的数据独立。

升级前备份 Compose、环境配置、三个数据卷及原主密钥。需要一致性备份时，停止 `cloud` 服务后复制完整数据卷，再启动服务；在线数据库备份应通过 SQLite 的一致性备份方式完成。不要直接复制正在写入的单个 SQLite 主文件。

升级使用 `docker compose up -d --build`。保留数据卷；`docker compose down` 可停止并移除容器，带 `-v` 的命令会删除卷，请勿将其用于保留数据的升级。

## 从原目录迁移

原账号源码、监控源码和统一部署配置已经收拢为本仓库。镜像中的 `/app` 布局、`/data` 布局、对外端口和 API 路径保持一致。

迁移前核对正在运行容器的实际挂载与卷名，将对应名称填写到 `.env`。已有实例如使用主机目录挂载，应继续使用原挂载位置。保持原账号主密钥、内部令牌、节点令牌和数据库，完成备份后再构建替换镜像。旧版独立账号服务只包含账号数据，迁移时将其原数据挂载到 `/data/account`；旧独立监控的数据与账号归属需单独核对，详见 [监控说明](../deploy/UNIFIED-CLOUD.md)。

本次仓库整理不自动修改或重新部署任何已有服务器。不要把旧服务与新服务同时连接到同一 SQLite 数据目录。

## 开发与验证

Node.js 22.18+、Go 1.26+。先运行 `npm ci`。Go 测试与构建从 `monitor/` 执行：

```sh
cd monitor
go test ./...
go vet ./...
go build -trimpath -o ../tmp/monitor-server ./cmd/server
go build -trimpath -o ../tmp/monitor-agent ./cmd/agent
cd ..
OMNIDESK_MONITOR_TEST_BINARY="$PWD/tmp/monitor-server" OMNIDESK_AGENT_TEST_BINARY="$PWD/tmp/monitor-agent" npm test
```

Windows 二进制使用 `.exe` 扩展名，在 PowerShell 用 `$env:OMNIDESK_MONITOR_TEST_BINARY` 和 `$env:OMNIDESK_AGENT_TEST_BINARY` 设置对应绝对路径。测试目录与账号均为临时合成数据。

本地统一服务通过 `npm start` 启动。需要设置可写的 `OMNIDESK_CLOUD_DATA`、`OMNIDESK_MONITOR_BINARY`、`OMNIDESK_WINDOWS_AGENT_DIR`（内含 Windows Agent 和安装模板），按需设置 `OFFICIAL_HOST`、`OFFICIAL_PORT` 和 `OFFICIAL_PUBLIC_URL`。创建管理员时，`OFFICIAL_DATA_DIR` 应指向同一数据根目录下的 `account`。

旧独立账号启动方式为 `npm run start:account`，其部署配置在 `deploy/legacy-account/`。新部署使用根目录统一 Compose。

客户端和后端联调时，把 [omnidesk](https://github.com/jixn-hu/omnidesk) 与本仓库放在同一父目录。客户端内置采集端源码可通过 `node tools/sync-monitor-agent.cjs` 从本仓库同步，`--check` 只检查差异。
