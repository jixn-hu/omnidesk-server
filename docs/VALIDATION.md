# 统一后端验证

2026-11-13，Windows 本地：

- monitor/ 下 go test ./... 和 go vet ./... 通过。
- 监控服务与 Windows Agent 编译通过。指定实际测试二进制后 npm test：47 项通过，0 失败，0 跳过。
- 跨模块测试覆盖统一启动器、Windows Agent 首次及后续指标、账号与节点隔离、管理后台、配置共享、导入、GitLab 登录与 Windows 安装命令。
- 安装模板由本仓库 assets/monitor-agent/ 提供，不依赖 PC 仓库。与 PC 内置采集端/模板的 14 个文件一致性检查通过。
- Docker 构建路径已收敛到本仓库，根目录 Compose 是统一部署入口；数据卷目录预设 node 用户权限。Linux 容器构建、首次管理员初始化、账号登录和 Go 网关检查由本仓库 Verify unified deployment 工作流验证，具体结果见 Actions。

当前机器没有 Docker daemon，本地没有声称完成容器测试。本次未更改或重新部署已有线上实例。

GitHub Actions 实际验证通过：[Verify unified deployment / 43351057679](https://github.com/jixn-hu/omnidesk-server/actions/runs/43351057679)。从公开仓库构建 Linux 镜像成功，使用全新命名卷启动，以非 root 用户完成初始化、登录及 Go 监控健康检查；测试结束后清理临时容器与卷。
