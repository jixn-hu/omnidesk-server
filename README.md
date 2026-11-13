# OmniDesk 统一后端

OmniDesk 的 MIT 开源后端：账号登录、配置同步、共享服务器、浏览器管理后台，以及持续监控、流量统计和提醒。Node.js 提供统一入口，Go 模块负责监控；一个容器、一个对外地址。

| 项目 | 源码与使用 |
| --- | --- |
| PC 客户端 | [omnidesk 源码与 Windows 下载](https://github.com/jixn-hu/omnidesk) · [客户端指南](https://github.com/jixn-hu/omnidesk/blob/main/docs/USER-GUIDE.md) |
| 统一后端 | 本仓库 · [部署指南](docs/DEPLOYMENT.md) · [账号与管理后台](docs/ACCOUNT.md) · [监控说明](deploy/UNIFIED-CLOUD.md) |

PC 客户端可独立使用 SSH / RDP。需要账号、同步、共享或持续监控时再部署本后端。PC“设置 → 关于 / 软件更新”可直接查看两端源码。

## 快速部署

需要 Git、Docker 和 Docker Compose 插件。首次构建会下载 Node.js、Go 模块及镜像依赖。

```sh
git clone https://github.com/jixn-hu/omnidesk-server.git
cd omnidesk-server
cp .env.example .env
# 编辑 .env：配置 OFFICIAL_PUBLIC_URL 为最终 HTTPS 地址
docker compose up -d --build
docker compose exec cloud node tools/create-admin.mjs
```

默认仅监听主机 `127.0.0.1:47830`。配置 HTTPS 反向代理后，在 PC“账号”填写同一地址并登录。公开注册默认关闭，创建管理员时交互输入密码。

完整配置、数据备份、旧部署迁移和本地开发见 [部署指南](docs/DEPLOYMENT.md)。

## 目录

- 根目录 `*.mjs`、`shared/`：账号、同步、共享和监控网关。
- `public/`：浏览器管理后台 `/admin/`。
- `monitor/`：Go 监控服务、Linux / Windows 采集端、协议及测试。
- `assets/monitor-agent/`：统一后端内置的 Windows 安装模板。
- `Dockerfile`、`compose.yml`：统一构建和部署入口；无需客户端源码参与镜像构建。
- `deploy/`、`docs/`：部署与使用说明；`deploy/legacy-account/` 保留旧账号服务配置供迁移参考。

## 开发与验证

需要 Node.js 22.18+、Go 1.26+。

```sh
npm ci
npm test
cd monitor
go test ./...
go vet ./...
```

完整跨模块测试还需要构建监控服务与 Agent 并设置测试二进制路径，见 [部署指南](docs/DEPLOYMENT.md#开发与验证)。测试使用临时目录及合成账号。

若同时修改客户端采集端，两个仓库应并排放置，在客户端执行 `node tools/sync-monitor-agent.cjs`。Windows 安装模板也应同时更新两端的 `assets/monitor-agent/install-windows.ps1`。

## 许可与反馈

本项目以 [MIT](LICENSE) 发布。第三方组件保持各自许可，版本见 package-lock.json 与 monitor/go.mod；说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。反馈问题时请附版本和复现步骤，移除凭据、节点令牌、数据库及个人信息。
