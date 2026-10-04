# sparkDash Desktop

将 [MiaAI-Lab/sparkDash](https://github.com/MiaAI-Lab/sparkDash) 的完整功能迁移为优先支持 Mac 的独立桌面应用。界面与采集后台在本机运行，通过 SSH、HTTP 和必要的隧道管理四台 DGX Spark / GB10，尽量复用远端已有命令与服务。

项目当前处于开发准备阶段：已导入固定提交的上游 `src`、`server`、配置、测试与构建文件，保留 MIT LICENSE，并将上游 README 保存到 `docs/upstream/README.md`。尚无可运行的桌面 App，未安装依赖、运行测试或发布安装包。Git 初始化受当前目录权限限制尚未完成。

开始实施前的评估：没有需要用户先决定的阻塞性产品问题。首版采用 Electron 方案验证，目标为当前 Mac ARM64；保留完整上游功能，关闭最后一个窗口时退出并停止采样。上述可调整的工程选择先按实施计划推进。真实设备连接信息和远程操作授权留到实机验收阶段，本地开发不以此为前提。

- [项目交接与已知边界](docs/project-handoff.md)
- [上游功能与桌面适配矩阵](docs/upstream-feature-matrix.md)
- [桌面实施计划与分阶段验收](docs/desktop-implementation-plan.md)

本次核查上游提交为 `b4228a330a7877dcb5a30516500d57e26affa45a`，README 和 package 版本均为 `1.8.9`。源码实现路径已作静态核查，尚未安装运行或在用户设备验证。

计划作为独立维护的桌面衍生项目，不代表上游或 NVIDIA。上游采用 [MIT License](https://github.com/MiaAI-Lab/sparkDash/blob/b4228a330a7877dcb5a30516500d57e26affa45a/LICENSE)；后续正式引入代码时保留原许可证及归属。
