# Acknowledgements and license scope / 致谢与许可范围

## Mia’a AI Lab — sparkDash

sparkDash Desktop builds on the substantial work of **Mia’a AI Lab and the sparkDash contributors**. The original dashboard, React UI, Node backend, hardware collectors, multi-host model, LLM integrations, benchmarks and service panels form the foundation of this project.

sparkDash Desktop 基于 **Mia’a AI Lab 及 sparkDash 贡献者**的工作。原项目的仪表盘、React 界面、Node 后台、硬件采集、多机模型、LLM 集成、压测和服务面板构成了本项目的基础。感谢上游作者将这些工作开源。

- Repository / 仓库: [MiaAI-Lab/sparkDash](https://github.com/MiaAI-Lab/sparkDash)
- Baseline / 基线: 1.8.9, commit [`b4228a330a7877dcb5a30516500d57e26affa45a`](https://github.com/MiaAI-Lab/sparkDash/tree/b4228a330a7877dcb5a30516500d57e26affa45a)
- Original license / 原始许可: [MIT at the pinned commit](https://github.com/MiaAI-Lab/sparkDash/blob/b4228a330a7877dcb5a30516500d57e26affa45a/LICENSE)
- Upstream author / 上游作者: [Mia’a AI Lab](https://x.com/MiaAI_lab) (package metadata spells the name `Mia'a AI Lab`)
- Preserved documentation / 保留文档: [imported README](docs/upstream/README.md), [upstream changelog](CHANGELOG.md)

On 2026-10-05 (Asia/Shanghai), the LICENSE fetched from that exact commit was compared byte-for-byte with the root [LICENSE](LICENSE): they match. SHA-256: `1126322e2cc8d165adc4c792eeb195717de2bcc7b39be1ce77959d78e87ef685`. Its copyright line is exactly `Copyright (c) 2026`; author attribution is recorded here without rewriting the upstream license.

2026年10月5日（Asia/Shanghai）已下载固定提交的 LICENSE，与根目录许可证逐字节比较一致。原文版权行仅为 `Copyright (c) 2026`；作者归属在本文及 README 中补充，不改写原始许可证。

MIT permits use, modification and redistribution, including commercial use, provided its copyright and permission notices accompany copies or substantial portions. The software is provided without warranty. Keep the complete LICENSE when distributing the application or source; the packaging script also carries this acknowledgement file. This summary does not replace the license text.

MIT 允许使用、修改及再分发（包括商业使用），条件是在软件副本或实质部分中保留版权和许可声明；软件按现状提供，不附带担保。分发源码或应用时保留完整 LICENSE；打包脚本同时携带本文。此摘要不替代许可证原文。

Desktop adaptations include Electron lifecycle and isolation, authenticated loopback APIs, macOS credential storage, native SSH configuration, bilingual UI and cluster grouping. This derivative is independently maintained; no affiliation or endorsement by Mia’a AI Lab or NVIDIA is implied.

桌面适配包括 Electron 生命周期与隔离、本机接口认证、macOS 凭据存储、系统 SSH 配置、双语界面和集群分组。本衍生项目独立维护，不暗示与 Mia’a AI Lab 或 NVIDIA 的隶属关系或背书。

## Dependencies and artwork / 依赖与图片

Electron, React, Vite, Express and other dependencies retain their own licenses. This document records project provenance, not an exhaustive dependency license inventory. The packager retains copied runtime dependencies’ license files and Electron distribution notices.

Electron、React、Vite、Express 等依赖各自保留原许可。本文用于说明项目来源，不是完整依赖许可证清单；打包过程保留所复制运行依赖的许可证和 Electron 发行声明。

The README banner in `assets/readme/hero.svg` was created for this derivative. It is an illustrative dashboard with demonstration data, not a screenshot or benchmark result; it is covered by the root MIT license.

README 横幅为本衍生项目原创 SVG 示意图，展示演示数据，不是实机截图或压测结果，适用根目录 MIT 许可。
