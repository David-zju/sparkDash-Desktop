# DGX-3 / DGX-4 更安全的风扇读取途径：官方资料核查

> 归档状态（2026-10-05）：风扇工具因安全性评估未通过，已从项目中移除。下文仅保留历史调查与当时的验证记录，不代表当前支持的功能或后续执行建议。


调查日期：2026-10-05（Asia/Shanghai）。对象：GIGABYTE AI TOP ATOM / GB10 / P4242，EC 3.5.11、内核 7.0.0-1019-nvidia。官方资料由研究子任务核查；主调查进程补充了两台机器的普通用户只读实测，调用已安装 NVIDIA 驱动的公开查询 API。没有 sudo、软件安装、自定义模块加载、原始 EC/FF-A 请求、证书注册或重启。用户已排除自定义内核探针路线。

## 结论与优先级

**目前没有找到技嘉公开确认、适用于这两台 ATOM 的现成风扇 RPM 软件读取方案。** 这表示公开支持证据不足，不表示硬件缺少测速能力，也不表示操作系统绝对无法读取。

已核对 NVIDIA 已安装驱动提供的标准 NVML RPM 查询，以及已有 hwmon/ACPI 接口；两台当前均未得到风扇转速。该结果针对现有型号、驱动和固件组合，不是对未来厂商版本的永久断言。

如果现有标准接口不支持，下一项最有价值的行动是向 GIGABYTE 确认 ATOM 专用、受支持的只读遥测接口或诊断工具及其版本条件。AI TOP Utility ATOM 可以作为具体询问对象，但现有官方资料不足以承诺它显示风扇 RPM。不能把重启进 BIOS、安装 IPMI 工具或换一个图形监控程序描述为已经确认有效的办法。

## 普通用户只读实测结果

两台均以 uid 1000 调用系统已有 `libnvidia-ml.so.1`，初始化及取得 GPU 句柄成功；驱动均为 580.178.04。

| 检查 | dgx-3 | dgx-4 | 含义 |
| --- | --- | --- | --- |
| `nvmlDeviceGetNumFans` | Success，0 | Success，0 | NVML 没有暴露风扇通道，不表示机器没有物理风扇 |
| `nvmlDeviceGetFanSpeed` | Not Supported (3) | Not Supported (3) | 百分比接口不可用 |
| `nvmlDeviceGetFanSpeedRPM`，索引 0/1 | Invalid Argument (2) | Invalid Argument (2) | 未得到有效 RPM；结合通道数为 0，符合没有可用风扇索引的情况 |
| `nvidia-smi fan.speed` | N/A | N/A | 与上述结果一致 |
| hwmon `fan*_input` / ACPI `fan_speed_rpm` | 无节点 | 无节点 | 现有标准内核接口没有 RPM 出口 |
| IPMI 设备节点/类 | 未发现 | 未发现 | `ipmitool` 虽已安装，但软件安装不等于具备本机 IPMI 通道 |
| 自定义 `spark_fan_probe` 模块 | 未加载 | 未加载 | 没有进入此前的实验 EC 路线 |
| `dgx-dashboard` | 0.29.2-2 | 0.29.2-2 | 已安装官方监控服务；版本本身不证明支持 RPM |

RPM 调用采用官方 `nvmlFanSpeedInfo_v1_t`：三个 unsigned int 字段 version/fan/speed，version 为 `sizeof(struct) | (1 << 24)`。已用 dgx-3 安装的 `/usr/local/cuda-13.0/targets/sbsa-linux/include/nvml.h` 核对字段与版本宏，避免把结构版本错误误判为硬件不支持。调用前后没有任何 `nvmlDeviceSet*` 操作。官方对该 RPM API 的定义仍是预期转速，不保证物理受阻时等于实际机械转速。[NVML Device Queries](https://docs.nvidia.com/deploy/nvml-api/latest/api/group__nvmlDeviceQueries.html)、[结构定义](https://docs.nvidia.com/deploy/nvml-api/latest/api/structnvmlFanSpeedInfo__v1__t.html)

证据：[dgx-3 查询返回](/private/tmp/sparkdash-fan-research/dgx-3/safe-interfaces.json)、[dgx-4 查询返回](/private/tmp/sparkdash-fan-research/dgx-4/safe-interfaces.json)、[dgx-3 官方头文件与 Dashboard 元数据](/private/tmp/sparkdash-fan-research/dgx-3/safe-interface-details.json)。

dgx-3 官方 Dashboard 的 localhost:11000 首页可读，程序包含 GPU 遥测相关符号。读取了前端资源索引和部分资源，未完成完整遥测 API 响应核查；因此这里只报告“没有找到可用 RPM 证据”，不声称穷尽所有内部接口。技嘉 AI TOP Utility 未在本轮检查的软件包与 `/opt` 顶层目录中出现，也未为此安装它。

## AI TOP Utility：有 ATOM / Linux 版本，未证实有 RPM

GIGABYTE 官方 AI TOP 页面明确区分 Standard Version（x86_64）和 AI TOP ATOM Version（arm）。其 Visual Dashboard 说明列出 CPU、GPU、VRAM、DRAM、SSD 资源监控；未列风扇 RPM。此为功能说明中的缺项，不能据此断言所有版本都没有未列出的功能。[官方 AI TOP 页面](https://www.gigabyte.com/consumer/ai-top/)

官方 ATOM 产品页确认可使用 AI TOP Utility，当前能力列表聚焦模型下载、推理、RAG、Machine Learning，没有公开风扇遥测 API。[ATOM 产品页](https://www.gigabyte.com/AI-TOP-PC/GIGABYTE-AI-TOP-ATOM)

官方软件下载列表的检索内容提供更具体的版本证据：

- ATOM 4.2.0（2025-11-26）：Linux；更新说明中新增 CPU 温度、SSD 使用量。
- ATOM 4.2.1（2026-03-03）：Linux；说明支持 Ubuntu 24.04.4 / Linux 6.17-1008-nvidia。
- Utility Lite - ATOM 26.0702.01（2026-07-02）：列出 ATOM 型号和 UI、工作流、微调基准等更新，未提风扇 RPM。

动态下载页在直接打开时部分内容未完整呈现；上述版本来自官方页面的搜索索引。尤其 Lite 条目带有 x64 OS 标签，而另一个官方入口又明确 ATOM 为 arm，因此必须按具体包架构核验，不能照标签直接安装。现有 kernel 7.0.0-1019-nvidia 也不在 4.2.1 描述给出的组合中。[GIGABYTE 官方下载列表](https://www.gigabyte.com/de/Support/Utility/Desktops)

GIGABYTE Control Center、Smart Fan 6、System Information Viewer 的资料主要针对别的主板/Windows 产品。它们的风扇功能不是 ATOM ARM Linux 兼容性证据。本轮未找到 ATOM 对应的官方“System Monitor 可读 RPM”说明，故不建议为了验证风扇而盲装整个 AI 工具链。

## DGX Dashboard：现有监控入口值得检查，但没有公开 RPM 合同

NVIDIA 官方说明 DGX Dashboard 是 Spark 自带的运行指标、更新和 JupyterLab 入口，支持通过 SSH 隧道访问 localhost:11000。本次查阅的 Dashboard 页面没有列出风扇指标、RPM API 或风扇传感器字段。[DGX Dashboard 文档](https://docs.nvidia.com/dgx/dgx-spark/dgx-dashboard.html)

主调查进程已只读检查 dgx-3 安装版本和首页资源，见实测章节。不能把“带监控页面”推导成“背后一定有另一个可读风扇 RPM 的接口”。网页说明不足以证明 API 不存在，仍需厂商说明或完整接口证据补足。[官方 Dashboard 使用说明](https://build.nvidia.com/spark/dgx-dashboard/instructions)

## BIOS / UEFI：没有找到 ATOM 风扇显示菜单的官方证据

NVIDIA 的 Spark UEFI 手册（2026-09-10）列出 Advanced 菜单，包含固件版本、TPM、网络、NVMe 等；没有记录 Hardware Monitor、Smart Fan 或 RPM 页。固件版本页面显示 EC/PD/Retimer 的版本，并非转速。该文档也不能完全代表技嘉固件。[Spark UEFI Advanced 页](https://docs.nvidia.com/dgx/dgx-spark-uefi/advanced-tab.html)

GIGABYTE ATOM 公开硬件用户手册的可检索目录覆盖硬件连接、开机、初始设置、保修与法规，没有 BIOS Hardware Monitor 章节。下载 PDF 本次浏览工具取回失败，因此本报告不声称完整核查了 PDF 的所有内容。[GIGABYTE ATOM 用户手册](https://download.gigabyte.com/FileList/Manual/ai_top_pc_ai-top-atom_1001_e.pdf?v=9368874928b25e73b8e1f9e7c74f8f17)

仅在下次已经计划好的维护重启中查看 BIOS 是否确有只读传感器页，才是成本较低的补充验证；不值得仅为一个未经证实的菜单现在重启。即使 BIOS 能显示 RPM，也无法自动变成 Linux 运行时 TUI 的数据源。

## BMC / IPMI / Redfish：不能套用大型 DGX 的文档

本轮没有在 GIGABYTE ATOM 产品页、用户手册目录或 Spark 管理文档中找到该型号搭载 BMC、开放 IPMI/Redfish 传感器的官方确认。缺少专用管理口并不独立证明没有共享网口 BMC；结论应停留在“本机路线未获证实”。[ATOM 官方产品页](https://www.gigabyte.com/AI-TOP-PC/GIGABYTE-AI-TOP-ATOM)

搜索可找到 `nvsm show fans` 和 BMC Sensor 页的官方说明，但它明确属于 DGX H100/H200。这些大型服务器的风扇读取方案不能直接搬到 GB10 ATOM。[DGX H100/H200 风扇服务文档](https://docs.nvidia.com/dgx/dgxh100-service-manual/front-fan-replacement.html)

论坛中“DGX Spark has no BMC”的文字出自问题发帖者，不是单凭 NVIDIA 域名就可视为厂商规格声明。本报告不把它升级为官方结论。[相关原始论坛帖](https://forums.developer.nvidia.com/t/help-needed-how-to-enable-grace-cpu-power-telemetry-on-dgx-spark-gb10/360631)

## NVML、DCGM、sensors、ACPI 的区别

| 路径 | 官方接口语义 | 对本机的判断 |
| --- | --- | --- |
| NVML `nvmlDeviceGetFanSpeedRPM` | 当前官方 NVML 文档提供按风扇索引查询预期 RPM 的接口 | 本次已实测；两台通道数为 0，没有有效读数 |
| NVML `nvmlDeviceGetFanSpeed` / `_v2` | 旧接口返回百分比；文档描述为预期转速，并不保证等于机械测速 | 百分比不可凭未知最大转速换算成实测 RPM |
| DCGM `DCGM_FI_DEV_FAN_SPEED` | 官方定义是百分比 0–100 | 本次未找到 ATOM 的独立 EC RPM 支持证据；仅安装 exporter 不会保证获得 RPM |
| lm-sensors / libsensors | 从内核提供的标准 sysfs 获取数据 | 现有内核没有风扇属性时，换一个前端不会生成它 |
| ACPI 风扇 sysfs | 依赖固件提供的风扇设备/方法；性能档位和当前速度要区分 | 可以读取已有节点；缺失时不应强行调用未知 AML 或套用 Jetson 路径 |

依据：[NVML 官方参考](https://docs.nvidia.com/deploy/pdf/NVML_API_Reference_Guide.pdf)、[DCGM 字段定义](https://docs.nvidia.com/datacenter/dcgm/latest/dcgm-api/dcgm-api-field-ids.html)、[Linux hwmon 文档](https://docs.kernel.org/hwmon/sysfs-interface.html)、[Linux ACPI 风扇文档](https://docs.kernel.org/admin-guide/acpi/fan_performance_states.html)。

前序本机记录与本次复查均无 hwmon `fan*_input` 或 ACPI 风扇出口，详见[原始接口调查](./dgx-spark-fan-interface-research.md)和上方实测证据。

## 官方 Field Diagnostic 也不是轻量监控替代品

NVIDIA 官方支持页把 Field Diagnostic 定位为硬件健康/RMA 诊断，包含压力测试；当前运行说明要求关闭 Secure Boot、以 root 执行，约需 30 分钟，结束后再恢复 Secure Boot。本次没有找到它提供持续只读风扇 RPM 查询的说明，因此不能仅凭“官方诊断”就把它推荐为本任务的低干扰方案。[官方 Field Diagnostic 说明](https://docs.nvidia.com/dgx/dgx-spark/support.html#field-diagnostic-software)

## 可交给厂商的精确问题

建议给 GIGABYTE 的问题聚焦：AI TOP ATOM / P4242、EC 3.5.11、BIOS 5.36_0ACUM08、Linux 7.0.0-1019-nvidia 是否有受支持的只读风扇 RPM 查询工具、API 或已签名驱动；两个风扇通道的字段是否来自 TACH 测速；AI TOP Utility 哪个 ARM 版本支持这些指标；若本版没有出口，计划在哪个正式版本提供。可以要求同时说明兼容版本和是否需要重启。[GIGABYTE 官方支持入口](https://esupport.gigabyte.com/)

本调查没有向厂商发送消息。也没有将另一个 raw EC/FF-A 逆向工具、风扇强制控制工具或底层总线扫描包装成更安全的替代方案。
