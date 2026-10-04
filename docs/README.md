# Documentation / 文档导航

## Start here / 从这里开始

- [English README](../README.md) · [中文 README](../README.zh-CN.md): installation, features, data and development / 安装、功能、数据与开发。
- [Acknowledgements / 致谢与许可](../ACKNOWLEDGEMENTS.md): upstream commit and MIT verification / 上游提交与 MIT 核对。
- [Verification / 验收记录](verification.md): dated evidence and hardware coverage limits / 按日期记录的证据与实机覆盖边界。

## Architecture and planning / 架构与计划

- [Project handoff / 项目交接](project-handoff.md): requirements and operating boundaries.
- [Desktop implementation plan / 桌面实施计划](desktop-implementation-plan.md): migration plan and rationale; use verification for completed status.
- [Upstream feature matrix / 上游功能矩阵](upstream-feature-matrix.md): inherited capabilities and desktop adaptation.

## Upstream archive / 上游归档

- [Imported upstream README](upstream/README.md): historical reference. Its Docker instructions and relative asset links describe the upstream repository, not this desktop distribution. For a complete rendering, use the [pinned upstream README](https://github.com/MiaAI-Lab/sparkDash/blob/b4228a330a7877dcb5a30516500d57e26affa45a/README.md).
- [Upstream changelog](../CHANGELOG.md): preserved imported history; desktop changes are recorded in verification.

上游 README 和变更历史保留为来源资料；其中 Docker 部署步骤及相对资源链接属于原仓库。当前桌面安装和开发方式以根目录中英文 README 为准。

## Archived research / 研究归档

- [Fan interface research / 风扇接口调查](dgx-spark-fan-interface-research.md)
- [Vendor and safety research / 厂商接口调查](dgx-spark-safe-fan-vendor-research.md)

风扇实验工具已于 2026-10-05 因安全性评估未通过移除；以上文档仅保留历史研究，不作为实施或加载驱动的指引。

The experimental fan tool was removed on 2026-10-05 because it did not pass the safety assessment. These documents preserve historical research, not instructions to implement or load a driver.

## Acceptance scripts / 验收脚本

Run commands from the repository root after installing dependencies. Scripts are development checks, not application startup requirements. See each script for fixture setup and output paths.

| Command | Scope / 范围 | Prerequisites / 前提 |
| --- | --- | --- |
| `pnpm test` | Source and integration / 源码与集成 | Installed dependencies / 已安装依赖 |
| `pnpm test:packaged` | Local packaged fixtures / 本机打包模拟服务 | Built macOS app / 已打包应用 |
| `node scripts/test-language.mjs` | Packaged bilingual UI / 打包双语界面 | Built app / 已打包应用 |
| `node scripts/test-cluster-benchmark-ui.mjs` | TCP / RDMA UI with simulated results / 带宽检测界面，模拟结果 | Built frontend and Chrome / 已构建前端与 Chrome |
| `node scripts/test-clusters-ui.mjs` | Browser cluster fixtures / 浏览器集群模拟 | Built frontend and Playwright browser / 已构建前端与 Playwright 浏览器 |
| `node scripts/test-live-readonly.mjs` | Real-host read-only telemetry / 实机只读采集 | Configured SSH aliases `dgx-1`–`dgx-4` |
| `node scripts/test-clusters-live.mjs` | Real network discovery / 实机网络发现 | Same four SSH targets / 同上 |
| `node scripts/test-clusters-packaged.mjs` | Packaged real discovery, isolated groups / 打包实机检测、隔离分组 | Built app and same four targets / 已打包应用及同上目标 |
| `pnpm test:packaged --live` | Packaged real telemetry / 打包实机采集 | Built app and same four targets / 已打包应用及同上目标 |

Hardware checks depend on the original acceptance environment; adapt the target setup before using them elsewhere. Reports and screenshots under `.desktop-test/` remain local and may contain environment details.

实机脚本依赖原验收环境，换环境应先检查脚本中的目标配置。`.desktop-test/` 内的报告与截图保留在本机，可能包含环境信息。
