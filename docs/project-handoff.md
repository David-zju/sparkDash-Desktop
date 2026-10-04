# sparkDash Desktop 项目交接

更新日期：2026年10月4日，Asia/Shanghai。本项目把 MiaAI-Lab/sparkDash 的完整功能迁移为优先支持 Mac 的桌面应用。本次接手完成的是需求归档、上游静态核查和实施计划，尚未实现或实测桌面应用。

## 已明确的产品目标

- 界面和采集后台一起在用户的 Mac 上运行，日常双击 App 即可使用，无需另开终端运行 Node 或 Docker。
- 通过 SSH，以及必要的 HTTP 或 SSH 隧道连接四台 DGX Spark / GB10 设备；远端尽量复用已有命令和服务，不新增每节点常驻采集 agent。
- 以完整 sparkDash 桌面化为方向。多机监控、LLM、基准测试、Prompt Showcase、ComfyUI、Hermes 和设备操作都进入迁移范围，不能把最终产品擅自缩成四个 GPU 卡片。
- Mac 是第一平台，其他桌面平台暂不作首阶段交付承诺。Electron 是优先评估方案，尚不是已落地的技术决策。
- 应用名暂用 sparkDash Desktop，仓库名建议 `sparkdash-desktop`。未来 README 需说明这是独立维护的上游衍生项目，保留上游许可证和归属。

## 接手时的项目状态

`/Users/david/Dev/sparkDash Desktop` 初始为空目录，不是 Git 仓库。检查了项目目录以及 `/`、`/Users`、`/Users/david`、`/Users/david/Dev` 的 `AGENTS.md` 路径，未发现适用于本项目的指令文件。原运维项目的 `AGENTS.md` 不属于本目录的祖先指令。

本次只在新项目创建文档，上游源码下载到临时目录供阅读。成功取得的研究副本位于 `/private/tmp/sparkdash-source-only-a02e-20261004`，固定提交为 `b4228a330a7877dcb5a30516500d57e26affa45a`，采用排除大型图片/视频资源的稀疏检出；README 和 package 均为 `1.8.9`。临时副本不是正式开发仓库，后续以文档中的提交永久链接追溯。

未创建 GitHub 仓库或 PR，未导入桌面工程，未安装依赖或候选 App，未运行上游后台、连接 Spark 或执行远端命令。原运维项目的两份资料只读读取，没有修改。

## 完整迁移范围

| 能力组 | 应保留的能力和边界 |
| --- | --- |
| 多机与配置 | Overview、单机详情、动态增删改与排序、Head / Worker / Standalone 角色、隐藏 Worker；保留普通 Linux NVIDIA 主机及多 GPU 的现有功能。角色表达显示和监控关系，不自动搭建或修改推理集群。 |
| 系统指标 | GPU、CPU、统一内存或独立 RAM/VRAM、磁盘、网络、温度、功耗、进程、uptime、在线状态和历史曲线。未知、过期和真实零值应可区分。 |
| LLM 监控 | 多端口、后端自动识别、decode/prefill tok/s、日峰值及后端实际提供的健康指标。指标支持按后端能力判断，不保证所有后端提供所有字段。 |
| 基准测试 | Decode 的并发和提示类型；Prefill 的上下文长度、prefill tok/s、TTFT；直连/SSH 隧道、临时目标、进度、取消、已有结果保存与分享。结果的实际保留数量以源码核查为准。 |
| Prompt Showcase | 最多 32 个提示的并发流式展示，以及对应进度、取消和复制能力。它会向推理服务发送实际请求。 |
| ComfyUI | 可选监控队列、任务进度、模型/LoRA 清单、取消任务和打开原网页。当前范围没有在 sparkDash 内直接输入提示词并提交生图工作流；不新增这一面板。 |
| Hermes | 已有 Hermes Agent 的状态、检查更新、单机/批量更新。检查和更新不等于安装 Hermes。 |
| 设备与网络 | 连接测试、正常关机、Wake-on-LAN、批量操作、Tailnet 状态。能耗功能保留估算标识及适用条件。 |

每一组的当前代码证据、适配点和验证方法详见 [上游功能矩阵](upstream-feature-matrix.md)。矩阵标注的是实现路径的静态核查，不能视为上述功能已在用户设备通过测试。

## 本次源码核查补充的边界

- 基准测试的 SSH 隧道不会自动覆盖日常 LLM、Showcase 和 ComfyUI 连接；需要统一适配。临时测试目标还受白名单限制。
- 短期曲线、LLM 日统计、基准测试结果和 Showcase 各有不同的保存方式，不能合称为完整持久化时序历史。
- Hermes 的原样检查流程包含 Git 信息拉取和锁文件删除；即使入口称为“检查”或“连接测试”，也不能视为纯只读。
- 当前鉴权源码与 README 的部分默认安全描述不一致；桌面本地接口需要独立验证，不能只设置监听地址就宣布完成。
- 能耗为条件受限的估算，增删节点后的聚合还可能要求重启；普通多 GPU 主机不能直接套用 Spark 的功耗估算。

以上细节的固定提交证据见 [功能矩阵](upstream-feature-matrix.md) 与 [实施计划](desktop-implementation-plan.md)，均尚未在实机运行验证。

## 采集与数据解释的边界

GB10 使用 CPU/GPU 共享的 LPDDR5X 内存。上游通过 `/proc/meminfo` 的 `MemTotal` 和 `MemAvailable` 计算整机已用量；整卡 GPU 内存字段不可用时，通过 `nvidia-smi --query-compute-apps` 的进程用量补充 GPU 估计。CPU 部分按 `max(0, 整机已用 - GPU进程合计)` 推算，不是独立精确测量。来源与源码细节见功能矩阵。

NVIDIA 官方确认，iGPU 上整卡 `Memory-Usage` 可以不受支持，同时每进程 GPU 内存仍可报告。因此，整卡字段不可用不能直接解释为 GPU 没有占用内存，也不能只靠它判断 GPU 是否故障。[NVIDIA 已知问题](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html#nvidia-smi-reports-memory-usage-not-supported)

桌面适配必须保留指标来源、采样时间和质量状态。采集失败、不支持或驱动不可用不能转成真实的 0；最后一次有效值可以保留查看，但必须显示过期。统一内存图不能把推算的 CPU/GPU 拆分描述成精确硬件计量，也不能把 GB10 内存称为 HBM。

应用退出或 Mac 休眠期间没有本地采样，不能宣称连续监控；重新唤醒后重建连接、重置速率基线，历史曲线留下实际缺口。关闭窗口与退出 App 的具体行为要在第一阶段确定并显示清楚。

## 连接与操作边界

- 四台设备的完整地址、SSH 用户、认证方式、服务端口和网络可达性尚未交接，不假设已有访问权限或可用连接。
- Mac 上所有被监控设备都走远程路径。不能把 Mac 当成本地 Linux Spark，执行依赖 `/proc`、sysfs 或 `nsenter` 的本机采集。
- SSH 系统命令路径、密钥、agent、加密私钥、密码、known_hosts 和非默认端口都需适配。Mac 从 Finder 启动的环境不能假定与终端一致。
- SSH 可达不代表远端 HTTP 可达；基准测试、日常 LLM 监控、ComfyUI HTTP/WS、取消任务、外部网页分别检查路由与隧道生命周期。
- WOL 是否可用取决于设备能力、固件/网卡设置、供电和网络广播路由；不能保证跨网段或 Tailnet 自动唤醒。
- 本次规划不授权远端升级驱动/固件、关机、压测、生图、ComfyUI 取消任务或 Hermes 更新。后续实机验证先做只读采集；会改变设备状态或产生负载的测试，在用户指定目标与操作后执行。

## 已知设备故障

以下是原运维会话交接的历史状态，本会话未复核，也没有收到恢复结果：`aitopatom-008c` 的 GPU 在 PCI 上可见，NVIDIA 驱动 `580.178.04` 已加载，内核为 `7.0.0-1019-nvidia`；日志出现 SEC2/GSP 固件启动超时和 `RmInitAdapter (0x62:0x65:2028)`，`nvidia-smi` 返回 `No devices were found`。

原会话建议过正常关机后完整断电冷启动。该故障由原运维项目处理，桌面应用不能绕过；应用可以显示 SSH 在线但 GPU 不可用，并保留错误原因。不要把这台设备的恢复作为本地壳层或模拟测试的前置条件，也不要代替原会话执行修复。

## 证据级别

| 标记 | 含义 |
| --- | --- |
| 本地已检查 | 本次工具直接检查的项目目录、文件和 Git 状态。 |
| 交接事实 | 原会话提供的信息，本次未连接设备重新确认。 |
| 源码静态确认 | 在功能矩阵记录的固定上游提交中读到具体实现；没有据此宣称运行通过。 |
| 官方文档事实 | 来自项目维护者或厂商资料，链接就近给出；不代表用户当前环境已满足条件。 |
| 实施提案 | 本项目推荐的改造方案，尚未实现或选型定案。 |
| 待实机验证 | 需要真实 Mac 安装包和/或指定设备、服务才能确认。 |

## 原始交接资料

- [原运维项目的 Sync 与 Dashboard 调研](/Users/david/Dev/dgxspark/docs/sync-dashboard-project-research.md)
- [原运维项目的 Mac 多机应用调研](/Users/david/Dev/dgxspark/docs/local-multi-spark-desktop-research.md)
- [sparkDash 上游仓库](https://github.com/MiaAI-Lab/sparkDash)
- [桌面实施计划](desktop-implementation-plan.md)

早期调研中的“轻量四机查看器”是另一条候选路线，不是本项目的最终范围。GPU Pulse、NVBeacon、DGXPulse 和 PulseBar 仅作为特定连接或界面的参考，不替代完整 sparkDash 桌面化。
