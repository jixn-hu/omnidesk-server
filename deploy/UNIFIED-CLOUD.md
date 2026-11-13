# OmniDesk 统一云端

一个部署包、一个对外地址，同时提供账号、配置同步、共享服务器及监控。容器内由 Node.js 负责账号及统一入口，Go 负责监控存储、Agent 上报、流量和提醒；Go 仅监听回环地址，不对外发布端口。

## 新部署

从仓库根目录配置 `.env`（可参考根目录的 `.env.example`），然后执行：

```sh
docker compose up -d --build
docker compose exec cloud node tools/create-admin.mjs
```

初始化命令交互读取账号和密码，不需要把密码放到命令行。已有用户时命令拒绝覆盖。公开注册默认关闭。统一容器已设置 `OFFICIAL_DATA_DIR=/data/account`，管理命令与账号服务使用同一个数据库。

对外 HTTPS 反向代理转发到主机 `127.0.0.1:47830`，保留原始路径，并配置 `OFFICIAL_PUBLIC_URL` 为最终公开来源。PC 端在“账号”只填写这个地址并登录，在“云端监控”启用即可；不填写内部端口或管理员令牌。

## 统一账号与备份

PC 只配置一个云端地址，在“账号”内登录、切换账号、同步配置及启用云端监控。最近使用的服务器地址保存在本机，最多 10 个。账号密码最低 6 位。

本地文件和 WebDAV 位于“设置 → 备份”。账号云端同步仍在“账号 → 配置同步”。监控关联和采集端令牌按账号隔离，恢复时需要登录备份对应的账号。

只支持统一账号监控接口 `/v1/monitor/...`。Agent 配置的 `serverUrl` 为 `https://你的云端域名/v1/monitor`，上报到 `/v1/monitor/reports`；不提供旧独立监控地址、管理员令牌配置或旧路径转发。现有数据库迁移须先创建一致性快照、保留原主密钥及节点令牌，再由运维将原节点归属到指定账号，并升级采集端的二进制及服务地址。

各账号只能查看和管理自己的监控节点、历史及提醒。整库快照接口不向账号开放；服务端管理员应分别备份账号目录、监控目录和内部令牌文件。不要把内部管理员令牌交给 PC 或 Agent。

## 周期与 Windows

新 Agent 默认每 60 秒采集并上报，用户可设置 5–86400 秒。全局默认用于新节点，每个节点可单独覆盖。周期变更在 Agent 下次成功上报后应用，详情中显示实际周期与待应用的期望周期。离线判定使用期望/实际周期中较长者的三个周期再加 15 秒。

Windows x64 可在 OmniDesk 标签页或窗口工具栏右键选择「安装监控…」，自动选择连接。默认生成一条安装命令，从当前账号的实例下载固定安装内容；15 分钟内可重复下载；重新生成命令会使旧命令失效，不包含账号会话或长期节点令牌，下载后验证 SHA-256。Docker 镜像内置 Windows Agent 与模板，模板以固定只读权限供非 root 后台进程读取。自定义启动账号服务时设置 `OMNIDESK_WINDOWS_AGENT_DIR` 指向这两个固定资源。

仍可「导出手动安装脚本」。仅有 RDP 时，两种方式首次都需要在目标机的管理员 PowerShell 运行。导出脚本执行方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\OmniDesk-Monitor-Install.ps1
```

安装为 `OmniDeskMonitor` 服务，以 LocalService 运行；配置及状态在 `%ProgramData%\OmniDeskMonitor`，目录限制为 SYSTEM、Administrators 和 LocalService。升级保留流量状态，遇到其他节点/云端的配置时拒绝覆盖。安装脚本含节点令牌，使用后删除；服务启动与收到首份指标分开显示，安装窗口只接受带本次唯一安装标记的上报。

资源指标随周期上报。公网 IPv4/IPv6 分开直连 HTTPS 探测，每 10 分钟尝试，保留各地址最后成功时间；失败标记与历史结果同时保留。在监控详情点击“重新查询公网 IP”后，任务在 Agent 下次成功上报时下发，探测完成立即补报；需要当前版本 Agent。归属信息沿用原识别缓存；`disableDiscovery` 同时关闭外部探测。Windows 不具备的 Linux 指标以“未提供”显示。

## 验证

桌面：`npm run typecheck`、`node tools/verify-cloud-accounts.cjs`、`node tools/verify-unified-cloud-ui.cjs`。UI 脚本需要 Playwright、构建后的桌面程序和 `OMNIDESK_MONITOR_TEST_BINARY` 指向测试用监控服务二进制。

监控：`go test ./...`、`go vet ./...`。

账号：为 `OMNIDESK_MONITOR_TEST_BINARY` 设置测试用二进制后，运行 `node --test test/unified-monitoring.test.mjs`。测试使用独立临时目录及合成账号。

## 多实例独立部署

多个部署实例各自拥有独立的账号数据库、主密钥、监控数据库和内部令牌，彼此不转发业务请求。每个地址对应一个完整实例，账号名相同也不会共享账号或会话。

客户端只需填写当前实例的账号服务地址。Windows 和 Linux 安装器都将当前地址（包括协议和端口）及 `/v1/monitor` 写入 Agent 配置。切换客户端账号不会改变已安装 Agent 的上报地址；目标实例不可达时，Agent 保持原配置并重试，不会转发到其他实例。

旧本机 Agent 绑定仅能迁移到 URL 匹配的当前实例，并要求该账号拥有节点。不能凭相同节点 ID 将其他实例的凭据迁入当前账号。
