# OmniDesk Account Server

OmniDesk 的独立可选账号服务：账号登录、配置同步、服务器配置共享，以及浏览器管理后台。客户端源码在独立仓库 `jixn-hu/omnidesk`；本仓库不依赖客户端源码、Electron 或 TypeScript。

## 功能与默认行为

- **公开注册默认关闭**。初始管理员在服务端通过命令创建，不向互联网开放初始化入口。管理员可在网页中随时开启或关闭注册，已有用户仍可登录。
- `/admin/` 提供用户搜索与分页、创建账号、启用 / 停用、管理员角色、密码重置、撤销会话和确认删除；可查看用户登录、同步和共享数量，不显示密码、私钥、会话令牌或同步密钥。
- 管理台还可配置自建 GitLab 的 OAuth Application、Secret 与回调地址；关闭注册也阻止 GitLab 首次自动建号，不影响已绑定的启用用户。
- 客户端服务地址默认留空，由用户自行填写。没有账号不影响客户端 SSH、RDP、公共凭据、导入导出或 WebDAV。
- 共享只是下载配置副本：发布时需明确确认其他已登录用户可获得配置及凭据。下载后在本机连接、编辑，流量不经账号服务；按协议和实际入口去重，撤销不能收回已下载副本。

## 本机启动

需要 Node.js **22.18 或更高版本**（内置 SQLite）。

```sh
npm ci --omit=dev
npm run admin:create
npm start
```

初始化命令会询问账号与密码，密码不回显，也不会出现在命令行参数或日志里。账号为 3–32 位字母、数字、下划线，密码至少 10 个字符。数据库已有用户时命令拒绝覆盖。自动化初始化可使用 `node tools/create-admin.mjs --stdin-json`，从标准输入提供包含 `username` 和 `password` 的 JSON，不要把秘密写进命令行、仓库或 shell 历史。

默认监听 `127.0.0.1:47830`，访问 `/health` 检查服务，访问 `/admin/` 管理。数据在当前工作目录的 `official-data/`；运行初始化和启动服务时必须使用相同的 `OFFICIAL_DATA_DIR`。Node 22 的 SQLite 实验性提示不代表启动失败。

## Docker / HTTPS

```sh
cp .env.example .env
docker compose up -d --build
docker compose exec account npm run admin:create
```

编辑 `.env` 中的公共 HTTPS 地址等设置。默认只将内部 HTTP 端口映射至宿主机回环地址，不要直接暴露到公网。已有反向代理时将同一 HTTPS 站点的根路径转发至 `http://127.0.0.1:47830`，保留 `Host`、转发 `X-Forwarded-Proto`，兼容 WebSocket。

也可以使用附带的 Nginx HTTPS 配置：把证书链和私钥分别放入 `tls/server.crt`、`tls/server.key`，设置 `.env`：

```dotenv
OFFICIAL_PUBLIC_URL=https://account.example.com:47831
OFFICIAL_HTTPS_BIND=0.0.0.0
OFFICIAL_HTTPS_PORT=47831
OFFICIAL_TLS_DIR=./tls
OFFICIAL_REGISTRATION=false
```

```sh
docker compose -f compose.yml -f compose.https.yml up -d --build
docker compose exec account npm run admin:create
docker compose logs --tail=100 account
```

`account.example.com` 是占位符，替换成实际域名或 IP；证书 SAN 必须匹配。外部访问需要按实际网络设置防火墙，管理后台为同一地址下的 `/admin/`。浏览器需信任证书；桌面端对内网自签名证书提供单独的指纹确认，不会修改系统证书库。

**只有新数据库默认关闭注册**；已有数据库中的注册开关保留，重启或修改环境变量不会覆盖管理员保存的设置。迁移后如需关闭已有服务注册，请在后台保存关闭状态。

## 管理与 GitLab

1. 使用初始管理员账号登录 `/admin/`。
2. 在「用户管理」新建成员或管理现有成员；停用、重置密码、修改角色都会撤销相应会话。
3. 当前管理员不能停用、降级或删除自己，系统至少保留一名启用管理员。
4. 在「登录与注册」设置公开注册、GitLab 服务地址、Application ID、Secret、回调地址。Secret 加密保存且不会回显；留空保留旧 Secret。
5. GitLab Application 使用 `openid profile` 权限，回调地址必须与后台设置完全一致，格式为 `https://实际账号服务/v1/auth/gitlab/callback`。浏览器授权、服务端网络和 HTTPS 证书均需可达且有效。

管理台采用 HttpOnly / SameSite Cookie，HTTPS 下加 Secure；会话有效期 12 小时。跨站请求被拒绝，修改操作检查管理员权限及自定义请求头，密码验证有速率与并发限制。无默认账号或默认密码。

## 数据持久化、备份与迁移

- Docker 默认使用命名卷 `omnidesk-account-data`，可通过 `OFFICIAL_DATA_VOLUME` 指定**现有**卷名。
- 数据目录包含 `official.sqlite`、SQLite WAL / SHM 和 `server-master.key`。主密钥用于解密同步密钥、共享凭据和 GitLab Secret，必须与数据库一起保存；已有数据库缺密钥时服务拒绝启动，不生成新密钥覆盖数据。
- 备份时先停止写入服务，再整体备份数据目录或 Docker 卷；不要只复制仍在写入的 SQLite 主文件。备份单独加密保管，不提交 GitHub。
- 从旧客户端仓库部署迁移时：先备份，核对原卷名和挂载目录，在 `.env` 指定原卷，再切换镜像与 Compose。不要先运行初始化命令，不要执行 `docker compose down -v`，不要用新空卷代替旧数据。
- 用户角色、停用状态和注册设置自动进行幂等迁移；旧账号和配置保留。角色系统升级时，历史最早账号迁移为管理员。
- 管理员不能读取用户登录密码。云端配置和共享凭据是服务端可解密的加密存储，不是零知识；删除云端数据不会删除用户本机或其他用户已下载的副本。

## 环境变量

| 变量 | 默认值 / 说明 |
| --- | --- |
| `OFFICIAL_HOST` | 本地 `127.0.0.1`；Docker 内 `0.0.0.0` |
| `OFFICIAL_PORT` | `47830` |
| `OFFICIAL_DATA_DIR` | 本地 `official-data`；Docker `/data` |
| `OFFICIAL_REGISTRATION` | `false`，仅初始化未保存的注册设置 |
| `OFFICIAL_PUBLIC_URL` | 可选，实际外部 HTTPS Origin，用于同源校验 |
| `OFFICIAL_DATA_VOLUME` | Compose 数据卷名，默认 `omnidesk-account-data` |
| `OFFICIAL_HTTPS_BIND` | 附带 HTTPS 代理默认 `127.0.0.1`，远程访问需显式设置 |
| `OFFICIAL_HTTPS_PORT` | `47831` |
| `OFFICIAL_TLS_DIR` | `./tls`，只读挂载证书与私钥 |
| `OFFICIAL_TARGET_CIDRS` | 仅旧版共享会话网关使用；当前配置上传 / 下载无需配置 |

旧版 guacd 共享会话兼容代码保留，默认不启动 guacd；确需兼容才启用 `legacy-gateway` profile 并最小化授权目标 CIDR。当前配置共享不探测目标、不需要开放云端到服务器的内网访问。

## 验证

```sh
npm test
```

接口测试使用临时目录和合成凭据，覆盖默认关闭注册、初始化管理员、网页认证与权限、用户管理、会话撤销、数据保留与幂等迁移，不访问生产数据。

可选浏览器回归（需单独安装 Playwright 和 Chromium，仅用于开发）：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tools/verify-admin-ui.mjs
```

可用 `OMNIDESK_QA_BROWSER` 指定本机浏览器可执行文件。脚本只启动回环测试实例，验证登录保持、用户增删改、密码重置、注册开关、退出与窄屏布局，截图写入系统临时目录。
