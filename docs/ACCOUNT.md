# 账号、共享与管理后台

统一服务的部署、管理员创建和数据备份以 [部署指南](DEPLOYMENT.md) 为准。配套客户端：[omnidesk](https://github.com/jixn-hu/omnidesk)。

## 账号与管理

- 公开注册默认关闭。首次管理员通过 `docker compose exec cloud node tools/create-admin.mjs` 交互创建，不开放网络初始化入口。
- 浏览器管理后台为 `/admin/`。管理员可管理用户、公开注册、共享服务器和可选 GitLab 登录配置。
- 管理后台使用浏览器专用会话。PC 账号登录用于配置同步、共享和监控，主密钥与会话信息不要发给其他人。
- PC 的 SSH / RDP 从本机直连目标服务器。配置共享不要求在云端开放目标内网访问。
- 管理员可在共享目录维护团队服务器配置。用户只能访问其权限允许的配置；删除维护账号时需处理共享归属。

## 导入共享服务器

浏览器共享管理页支持 RDO、XTerminal 的 local-store.db、JSON / CSV。先预览、补全必要的账号凭据并勾选需要的条目，再确认写入。相同协议和实际连接入口的重复项跳过，避免覆盖已有共享。

RDO 支持标准 RD Workspaces v3、RD Workbook v3 及紧凑格式的常见 SSH / RDP 字段。加密文件需先在原软件解密再导出。XTerminal 配置应先在原软件解锁保存并退出，再上传配置目录 sqlite 下的 local-store.db；浏览器无法自动扫描本机文件。

上传内容仅在临时目录中解析，不执行 .NET 对象反序列化。无法解析或缺少必要字段的条目会提示核对。不要把生产导出文件提交到 Git。

## 开发同步

服务端使用仓库内的 `shared/desktop-import.mjs`，运行及镜像构建不依赖客户端目录。修改客户端 RDO / XTerminal 解析器后，把两个仓库并排放置，在后端执行 `node tools/sync-desktop-import.mjs` 更新生成文件；使用 `--check` 验证一致性。
