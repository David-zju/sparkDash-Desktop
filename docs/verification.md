# 桌面验收记录

更新：2026年10月5日（Asia/Shanghai）。当前内部 ARM64 应用已完成源码回归、打包交互与四机只读验收；实际覆盖和未执行的实机操作边界如下。

## 已完成的实现

### 集群带宽与 RDMA 检测（2026-10-05）

- 集群卡片新增“带宽 / RDMA 检测”：选择同组两台设备和一条直连路径，手动运行 TCP 或 RDMA Write 测试，分别显示两个方向的 Gb/s。结果保存在后台内存，关闭弹窗后可重新查看，下一次测试或后台重启时替换。
- TCP 使用 `iperf3`，绑定所选 IPv4，4 路并发、每方向 10 秒，取接收端吞吐量。RDMA 使用 `ib_write_bw`，匹配所选网口/IP 的活动 RoCE v2 GID，64 KiB 消息、每方向 10 秒，取平均写入带宽。测试使用主机内存，不验证 GPU Direct、NCCL 或推理集群，也不合计不同网口带宽。
- 后台重新发现路径并校验集群成员，不接受浏览器指定任意主机或命令。启动前检查两端工具及 RDMA 条件；缺工具、版本不匹配或缺 GID 会显示无法测试。全局最多一个测试任务，不自动安装工具、提权或修改网络配置。
- 服务端只在确认本次测试进程已监听后才启动客户端，不用试连接消耗一次性测试服务。停止操作仅定位当前运行标识下的 Python 包装进程，由包装进程回收其子进程组；无按名称批量杀进程。远端设 40 秒超时，后台退出时请求停止当前测试。
- 完整源码测试通过：后端 403、前端 85、桌面 29 项；类型检查和生产构建通过。Vite 仍有主 JS 包超过 500 KB 的体积提示。另有 4 项 Python 本机测试通过，覆盖命令绑定、GID 匹配、按运行标识取消，以及真实子进程中断回收。
- `node scripts/test-cluster-benchmark-ui.mjs` 使用隔离配置、真实 HTTP 和后台任务管理器，以及明确标为模拟值的工具输出，验证显式开始、双向结果、关闭再打开、工具缺失不启动流量及 390px 窄窗口。截图位于 `.desktop-test/cluster-bandwidth-fixture-*.png`，数值不可作为实机性能证据。
- Python 测试命令：`python3 -B -m unittest discover -s server/collectors/__tests__ -p 'fabric_benchmark_test.py' -v`。Node 和界面测试已纳入现有测试套件；Python 检查单独运行。
- 已重新生成 `release/sparkDash-darwin-arm64/sparkDash.app` 并通过严格 ad-hoc 签名校验。使用临时数据目录和两个 loopback 测试节点打开实际应用，确认中文入口、初始禁用的开始按钮、鉴权 API 返回空任务，以及打包 Python 脚本与当前源码逐字节一致；未发起网络测试。截图 `.desktop-test/cluster-bandwidth-packaged-entry.png`。
- 本轮没有在真实设备上运行带宽或 RDMA 压测；真实工具版本、驱动、权限和网口环境仍需通过用户手动测试确认。
- 命令参数依据：[iperf3 官方文档](https://software.es.net/iperf/invoking.html)、[perftest README](https://github.com/linux-rdma/perftest/blob/master/README)及[参数实现](https://github.com/linux-rdma/perftest/blob/master/src/perftest_parameters.c)。

### 集群配置与 200G 检测（2026-10-05）

- 总览新增三步集群向导：网络检测、Head/Worker 分配、确认保存。同一 Head 的成员在一个大卡片内显示，兼容已有角色配置与隐藏/搜索筛选；支持换 Head、移出成员、解散分组。角色更新一次原子落盘，失败不留下部分成员变更。
- 检测从已保存 SSH 目标读取 NVIDIA/Mellanox 网口、速率、IPv4 和 RoCE 设备名；绑定网口逐对双向 ping，检查直连输出路由。只验证 IP 连通和协商速率，不运行吞吐压测、RDMA/NCCL 或推理任务，不改远端配置。
- 本次完整源码回归：后端 396、前端 81、桌面端 28 项全部通过；`tsc --noEmit` 和 Vite 生产构建通过。新增测试覆盖双向/单向/未知网络状态、速率降级、原子持久化失败、换 Head、解散及向导提交流程。
- `scripts/test-clusters-ui.mjs` 使用隔离 fixture 后端和实际 HTTP/WS/磁盘持久化，验证中文界面创建两个集群、刷新保留、换 Head、解散、390px 移动布局；截图 `.desktop-test/cluster-*-zh.png` 已人工查看，无溢出。
- `scripts/test-clusters-live.mjs` 在四台真实设备上只读运行，识别 DGX 1 ↔ DGX 2、DGX 3 ↔ DGX 4 两组；每组两条逻辑接口路径均为 200000 Mb/s 且双向 IP 可达。跨组未发现直接相连的 IPv4 子网，保留未验证。报告 `.desktop-test/cluster-live-report.json` 不提交个人网络数据；没有替用户选择 Head 或保存真实集群分组。
- 最新 `.app` 已重新打包并通过严格 ad-hoc 签名校验。`scripts/test-clusters-packaged.mjs` 在原生应用中完成四机真实网络检测、临时目录内创建分组、实时指标与大卡片显示验收，退出码 0；测试没有初始化 Keychain，也没有修改日常配置。截图 `.desktop-test/cluster-packaged-live-network.png`、`.desktop-test/cluster-packaged-live-overview.png`。

### 桌面基础功能

- 从固定上游 1.8.9 提交导入完整 React / Node 功能，Git 基线为 `1b088b3`；保留 MIT 归属。
- Electron 主进程、sandbox/contextIsolation 窗口和独立 utilityProcess 后台；随机 loopback 端口，API、静态资源、WebSocket 校验会话令牌和 Host/Origin。令牌由主进程添加，不交给 renderer 或写入 URL。
- 所有后台持久文件迁移到用户数据目录；safeStorage 保护 AES 密钥，禁止明文密钥回退；偏好跨端口与启动保存。纯 SSH 别名/密钥配置不访问 Keychain，首次保存密码/API Key 或读取已有凭据时才申请授权；拒绝保存授权不影响普通监控。
- 系统 `/usr/bin/ssh`、本机别名、可选用户/端口/私钥；密码使用随包 askpass。服务连接层复用直连/SSH 隧道，覆盖常规探测、压测、Showcase 和 ComfyUI HTTP/WS/取消/打开。
- 新增设备提供本机 SSH 别名下拉导入与刷新，解析用户/系统配置及带空格、通配符和嵌套的 `Include`；仅列出具体主机别名，不读取私钥或执行 `Match exec`。使用别名连接，保留 OpenSSH 对用户、端口、密钥和跳板机的解析。独立 SSH 验证禁用连接复用，支持认证失败后改用密码重试；测试不访问 Keychain、不保存密码、不改变设备列表。
- 后台可显式停止，关闭流、监控、隧道与 SSH 复用连接；关闭窗口退出，休眠/唤醒重建后台。后台意外停止显示恢复入口，不自动重做远程动作。
- 桌面拒绝 Linux 本地节点；未知/失效的 CPU/GPU 不再展示为有效零值。远程统一内存带宽缺测为 null，内存分拆为估算。
- 日常 Hermes 查询与联网更新检查分开；移除自动删 Git 锁和修复所有权。
- macOS 标题栏使用页面主题背景，保留原生红黄绿按钮和拖动区域；四种主题同时更新原生深浅外观，启动/恢复页面也读取已保存的主题。
- 桌面主内容铺满窗口，移除网页外层的 1440px 宽度上限、居中留白、圆角及阴影。标题栏和内容区共享同一底色，总览使用按可用宽度自动排列的卡片网格；网页模式保留上游布局。

## 已通过的验证

| 验证 | 结果与范围 |
| --- | --- |
| 类型与构建 | `pnpm typecheck`、`pnpm build` 通过；Vite 提示主 JS 包约 500 KB，非构建错误。 |
| 已添加 SSH 别名标记 | 2026年10月5日通过类型检查、77 项前端测试和 ARM64 重新打包；实际 App 下拉菜单中 dgx-1 至 dgx-4 均显示 Already added 且禁用，未添加的别名仍可选。判断使用完整设备列表中的实际 SSH 目标（兼容旧记录的 LAN 地址），不依赖设备显示名称或在线状态；每次打开表单或刷新都会重新读取设备列表。中文标签为“已添加”。 |
| 中英文切换 | 2026年10月5日通过类型检查、77 项前端测试、28 项桌面测试及 ARM64 打包/严格签名检查。`node scripts/test-language.mjs` 在隔离数据的实际打包 App 中通过 5 项检查：原生菜单与表单实时切换且不刷新、不新建 WebSocket；保留未提交字段及原始设备名/SSH 配置值；设置与原生菜单双向同步并保留未保存设置；休眠状态页切换及恢复；中文与英文分别经过完整重启仍保留。已查看新增设备、详情与设置的中文截图并补齐面板操作按钮。报告和截图位于 `.desktop-test/language-*`，未操作用户的真实设备或配置。此项未重复此前完整后台及四机验收。 |
| SSH 配置导入与独立验证 | 2026年10月5日通过类型检查、ARM64 打包、73 项前端、25 项桌面集成、13 项 SSH 命令回归。新增覆盖 Include/循环/大小限制、别名继承、密钥失败后密码重试、切换目标清空密码、关闭后忽略旧结果、读取失败后手动填写；接口验证临时密码不触发凭据访问或持久化。打包 App 实际下拉列出 dgx-1 至 dgx-4，导入 dgx-1 后 SSH 验证成功并自动滚动显示结果，四台设备仍在线，没有保存重复设备或请求 Keychain。此次只执行上述相关回归，后续表格中的完整功能验收为此前记录。 |
| 桌面自适应布局复验 | 2026年10月5日通过类型检查、ARM64 重新打包和严格签名检查；实际窗口在默认大小、系统半屏和填充屏幕之间切换，总览由两列变为四列，设备详情面板跟随窗口宽度，无网页外层接缝或宽度上限。保留当前白色主题，四台设备在线；此次仅做布局复验，未重复此前完整功能测试。 |
| 标题栏主题修复复验 | 2026年10月5日重新通过类型检查、68 项前端测试、ARM64 打包和严格签名检查；在实际 App 中查看 dark/oled/white/light 四种主题，确认顶部同步；标题栏双击缩放/恢复、原生关闭后重新打开并保留暖色主题通过。结束时恢复深色和 DGX 4 页面，四台设备恢复在线。以下完整回归和打包功能矩阵为此次外观修复前的验收记录。 |
| 完整源码回归 | 389 项 Node 后台测试、68 项前端测试、21 项桌面集成测试通过，共 478 项。类型检查通过。固定了一个混用 2026年8月样本与真实当前时间的测试时钟；Docker 部署文件测试由实际桌面监听约束测试替代。 |
| 桌面集成 | 覆盖真实 HTTP/WS 鉴权、错误 Host/Origin、令牌不经 query、配置/密文、停服、Keychain 拒绝及重试、稳定偏好、连接复用/并发/晚到结果清理、SSH 别名/带空格私钥/askpass、Hermes 只读命令、采样质量、坏文件保留、保存失败回滚、旧明文凭据加密迁移。 |
| 系统 SSH 传输 | 新增本机 SSH 服务 fixture，实际运行 `/usr/bin/ssh`：密码成功/错误密码拒绝、私钥路径含空格、非默认端口、已知主机密钥变更拒绝、HTTP 和 WebSocket 端口转发、引用计数复用、退出清理均通过。fixture 仅监听 loopback，使用临时 SSH 配置与 known_hosts，没有改用户 SSH 文件或真实设备。`ssh2` 仅为开发依赖，未打入应用。 |
| 本地服务完整流程 | 使用本机 fixture 的认证 OpenAI SSE 服务，通过 Decode 并发、Prefill、Showcase 完成/取消/历史，以及 ComfyUI 探测与指定任务取消；未向真实设备发送推理或取消请求。 |
| 四机只读验证 | `scripts/test-live-readonly.mjs` 经用户提供的 `dgx-1`–`dgx-4` SSH 别名运行。四台均在线，GB10 GPU 温度/功率、CPU、约 124544 MB 系统内存、网络接口及存储均成功采集，经实际 WebSocket 推送；结束后停止监控。原始报告在 `.desktop-test/live-report.json`（不提交个人环境数据）。 |
| GPU 历史故障复查 | 四台此次均返回 GB10、驱动 580.178.04；`dgx-2` 的本次只读查询正常。没有修改驱动或系统。 |
| ARM64 应用与签名 | Electron 44.5.1 运行时下载完成并通过官方校验值检查；`.app` 已生成，内部 ad-hoc 签名通过 `codesign --verify --deep --strict`。 |
| 打包应用完整本机流程 | 最新 `scripts/test-packaged.mjs` 全部 14 项检查通过，退出码 0：无外部 Node 启动、renderer 隔离、API/WS 鉴权、配置增改/角色/排序/删除、Decode 与历史和实际剪贴板文字/PNG、Prefill 与 32 路 Showcase、重复启动、后台 SIGKILL 与菜单恢复、最新任务中断显示、设置/主题、模拟休眠/唤醒、退出停服、跨启动保存配置。纯 SSH 密钥配置不创建安全存储；即使留有无法解密的闲置旧密钥，仍可正常重启。报告 `.desktop-test/packaged-report.json`，测试时间 2026-10-05 01:21（Asia/Shanghai）。 |
| WOL 模拟传输 | `wol.test.js` 使用真实 loopback UDP 接收器检查 102 字节魔术包、16 次 MAC 重复、配置覆盖和广播地址选择；没有向 DGX 或局域网广播。 |
| 四机打包回归 | 最新按需 Keychain 构建的 `scripts/test-packaged.mjs --live` 完成 10 项检查，退出码 0；确认四台实时 GPU/CPU、界面 `4/4 online`、单机采样来源、CPU 功耗估算与 GPU 内存归因说明，以及设置更新、模拟休眠唤醒和重启恢复。报告 `.desktop-test/packaged-live-report.json`，详情截图 `.desktop-test/packaged-live-detail.png` 已查看确认布局。随后在日常配置中通过实际界面添加用户提供的四个 SSH 别名，留空用户名/身份沿用 SSH 配置，原生界面确认 4/4 在线、共享内存整机使用约 3.5–4.4 GB，未请求 Keychain。 |

### 本轮修复的打包问题

- 首次应用入口使用顶层 `await app.whenReady()`，与 Electron 等待 ESM 入口加载完成的顺序互相等待，造成启动测试 30 秒超时。改为注册就绪回调后，原打包回归用例通过。
- ad-hoc 签名被误当作证书名称查询，首次打包只有警告、没有完成有效的应用签名。显式配置 ad-hoc identity，并增加打包后的严格签名校验，避免将警告当作交付成功。
- 设置窗口测试误查不存在的 dialog role，已改为验证现有 Settings 标题；不是界面打不开。
- 四机休眠测试发现，后台停止后旧页面的偏好保存被误判为不可信请求。将页面偏好权限与后台端口生命周期分开，仍限定本窗口主 frame 与应用创建的页面来源；增加 unload 保存回归，并通过基础打包测试。
- 用户确认出现系统「sparkDash Safe Storage」钥匙串密码授权。启动现在先显示用途说明，拒绝后保留文件并提供菜单重试。反复重新签名的内部测试包可能触发重复授权；测试中的部分启动等待可能受此影响，不能一概归因于调试工具。密码由系统接收，不应输入聊天或测试脚本。
- 实际 SSH 转发测试发现 `stderr.setEncoding("text")` 会抛错，已改为 `utf8`；同时修复同一探测器重叠请求可能丢失 lease 引用的问题。
- ComfyUI 旧接口取消改为查询队列后选择 pending 删除或 running 中断，避免取消等待任务时中断其他运行任务；授权/网络失败不重复发送其他操作，失败通过 API 和界面显示。对应用例已通过。
- Hermes 使用远端实际 `$HOME` 定位安装，兼容 SSH 别名留空用户名与非标准 home；日常状态查询不执行更新。
- CPU 首次计数基线与缺失温度显示不可用，CPU 功耗标为估算；资源详情增加采样时间/来源/未知或过期状态。TensorFold 缺计数时标为不支持实时速率，不向速率历史写入假零值。普通 GPU 主机不再参与 DGX Spark 专用能耗模型。
- 总览的 GB10 内存改用整机共享池的实际已用量，GPU 详情标为进程归因估算和共享总量；普通独显保留 VRAM。前端回归覆盖两种硬件及未知共享内存，分享卡 PNG 已实际读取并查看。
- Keychain 从无条件启动初始化改为按需访问：无凭据的 SSH 别名配置不触发系统授权；已有加密凭据仍要求原密钥。保存凭据的授权失败先返回错误，不改配置、不写明文、不停止监控；五个保存入口与重试/解密已通过集成测试。
- 崩溃恢复测试发现 Decode/Prefill 的 `getLast()` 优先选择有结果的旧任务，掩盖最新中断或失败。现在按时间选择当前端口最新任务，不回退到其他端口；回归测试先复现失败后通过，打包界面也已显示真实的中断结果。

## 交付

- 应用：`release/sparkDash-darwin-arm64/sparkDash.app`；Electron 44.5.1，自带 Node 运行时，最低 macOS 13.0，Apple Silicon ARM64。
- 压缩包：`release/sparkDash-1.8.9-desktop.1-mac-arm64.zip`；SHA-256 见同目录 `SHA256SUMS.txt`。
- 最新包含中英文切换和 SSH 别名“已添加”标记的压缩包大小 128675364 字节，SHA-256 `1cfef8c2a52fec206918e51678284d22fa20219db17cae9d03b1976fe08bf53c`。重新解压后通过 `codesign --verify --deep --strict`，`app.asar` 与实际界面复验的应用逐字节相同。原生菜单与页面双向切换、表单保留、休眠恢复和重启记忆的验收记录见上表。
- 汉化交付副本另存于 `release/sparkDash-bilingual/sparkDash.app` 和 `release/sparkDash-1.8.9-desktop.1-bilingual-mac-arm64.zip`；独立副本同样通过 5 项实际语言验收，标准压缩包与此副本压缩包完全相同。
- `pnpm install --frozen-lockfile --offline` 已通过，确认清单和锁文件一致；没有在运行应用时下载依赖。
- 应用界面已打开，日常配置包含用户提供的四台 SSH 别名；内部验收的模拟任务与配置隔离在 `.desktop-test/`。
- 安装、更新、数据备份与回退说明见主 README。

## 功能范围与现有验收依据

| 能力 | 直接证据 | 环境边界 |
| --- | --- | --- |
| 配置、角色、隐藏/排序、增删改 | 打包 UI 增改/Worker 切换/删除、重启后顺序；SparkTabs、角色归一化、Worker 派生标签、Registry 持久性测试 | 打包使用隔离配置；不更改实机角色或部署 |
| 系统指标、GB10 与普通多 GPU | 四机采集和打包详情；SystemCollector multiGpu/cpuTemp/hostNet/nvErr、采样质量、metricsStore/useSnapshot、共享内存前端回归 | 普通独显与多卡使用固定命令输出；四台实机均为 GB10 |
| LLM 七种后端、多端口与 API key | LlmProbe 的 vLLM/llama.cpp、sglang、ds4、exl3、q27、tensorfold、histogram/posture 测试；Registry 端口密钥隔离及桌面 SSE fixture | 未部署的真实 LLM 服务不算实机通过 |
| 日峰值、累计 tokens、历史曲线 | LlmDaily、LlmTokenLedger、ringBuffer、metricsStore 与图表测试 | 短曲线为窗口内存；日统计和任务历史落盘 |
| Decode/Prefill、临时目标、分享 | 打包真实 SSE、并发/上下文、持久历史与原生文字/PNG；输入目标、预算、提示词、流式 tokens、隧道和恢复回归 | 临时目标由已认证窗口明确输入并做地址校验，无需环境白名单；没有跑实机压测 |
| Showcase | 打包 32 路 SSE 完成；桌面接口完成、取消与历史测试；提示词库测试 | 模拟服务，不消耗远端推理 |
| ComfyUI | ComfyProbe 队列/模型/LoRA/进度归约；桌面真实 HTTP fixture；新旧取消接口失败及精确目标测试；实际系统 SSH 的 HTTP/WS 转发 | 不提交工作流，不取消用户真实任务 |
| Hermes | 安装/版本/更新检查失败/缺失 launcher/显式修复与更新命令测试；桌面测试断言被动查询不 fetch/删锁/更新 | 模拟 SSH 命令结果，没有执行实机更新 |
| 连接、Tailnet、关机、WOL | 实际 SSH 密钥/密码/端口/known_hosts 变化/HTTP/WS；connectivity、TailscaleProbe、shutdown 命令授权分支；loopback UDP 包 | 实机关机/唤醒和网络可达性需按现场条件确认 |
| 能耗估算 | 已知序列积分、缺口/过期、成员变更与普通主机排除；FleetEnergyCard 前端状态 | 非电表实测；成员变更提示重新连接后台 |
| 桌面运行、安全与存储 | 14 项打包流程、HTTP/WS 来源/令牌、Keychain 按需/拒绝、损坏文件保留/写失败回滚、旧密码迁移 | ARM64、最低 macOS 13.0；内部 ad-hoc 签名，未公证 |

## 验证边界

未在真实设备执行 Decode/Prefill、Showcase、ComfyUI 取消、Hermes 更新、关机、WOL 或驱动操作。已有这类功能代码与本地测试，不等于获得任意实机操作授权。无需为验证桌面移植而启动新的远端推理服务。

能耗沿用上游条件受限的估算：拓扑变更暂时使聚合失效，需要从“监控 → 重新连接后台”重新建立采样组。资源短曲线仍是内存数据；长期 LLM 统计与任务结果是持久文件。内部 ad-hoc 签名构建不等于 Apple 公证发布版。
