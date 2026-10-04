# DGX-3 / DGX-4 风扇硬件接口调查

> 归档状态（2026-10-05）：风扇工具因安全性评估未通过，已从项目中移除。下文仅保留历史调查与当时的验证记录，不代表当前支持的功能或后续执行建议。


> 后续决定（2026-10-05）：用户已排除自定义内核模块路线。下文保留原始调查与实验设计记录，不代表当前建议继续签名或加载。已转向[官方安全读取途径核查](./dgx-spark-safe-fan-vendor-research.md)，并实测现有 NVML、hwmon、ACPI 接口；当前仍没有可用 RPM。

调查日期：2026-10-05（Asia/Shanghai）。对象：GIGABYTE AI TOP ATOM / NVIDIA GB10；本次工作为资料研究和现有系统接口读取，没有向 EC 提交风扇请求、修改寄存器、安装或加载模块、刷写固件。

## 结论

**“普通监控工具读不到”不能推导为“没有硬件接口”。这两台机器已经向 Linux 枚举了一个与公开风扇读取实现完全相同 UUID 的 FF-A 固件服务，但没有驱动绑定它。** 这使“缺少把固件服务接到 Linux hwmon 的驱动”成为有实机证据支持的解释。现在已经找到了具体入口，尚未验证两台技嘉机器的服务应答和 RPM 字段含义。

公开源码存在经其他 GB10 机器验证的 EC 风扇遥测读取；因此，笼统宣称 GB10 的风扇数据不可能被操作系统读取是错误的。另一方面，不能仅凭社区把字段命名为 `fan*_input`，就宣称它一定是独立测速器测出的真实机械 RPM。这个区别仍需固件数据流或厂商说明验证。

## 本机证据

证据来自主调查进程于本次会话只读采集的 [dgx-3 inventory](/private/tmp/sparkdash-fan-research/dgx-3/inventory.json) 和 [dgx-4 inventory](/private/tmp/sparkdash-fan-research/dgx-4/inventory.json)。以下内容在两台上一致：

| 项目 | 实际读取结果 | 说明 |
| --- | --- | --- |
| DMI | `GIGABYTE` / `AI TOP ATOM` / board `P4242` | 与 NVIDIA 公版共用板号字符串不保证固件 ABI 一致 |
| BIOS | `5.36_0ACUM08` | 当前技嘉固件 |
| 内核 | `7.0.0-1019-nvidia` | NVIDIA 定制内核 |
| FF-A 风扇候选服务 | `arm-ffa-18`，UUID `78b04d80-d21d-4986-8acb-467b60247ac5`，partition `0x8003` | **已经枚举，无 driver 绑定** |
| FF-A OEM/eSPI 候选服务 | `arm-ffa-17`，UUID `884a63a0-3285-4120-83aa-eec008a0a546`，partition `0x8003` | 已经枚举，无 driver 绑定 |
| 现有 FF-A 驱动 | `nvidia-ffa-ec` 绑定 `arm-ffa-7` 至 `13` 及 `16`；`nvidia-ffa-notify` 绑定 `6` | 主机到 EC 的框架实际存在 |
| 内核配置 | `CONFIG_ARM_FFA_TRANSPORT=y`、`CONFIG_ARM_FFA_SMCCC=y`、`CONFIG_NVIDIA_FFA_EC=y` | 支持已编入内核，不能只用 `lsmod` 判断是否存在 |
| ACPI/EC 配置 | `CONFIG_ACPI_FAN=y`、`CONFIG_ACPI_EC=y`、`CONFIG_ACPI_EC_DEBUGFS=m` | 没有对应固件设备时，通用驱动不会凭空生成传感器 |
| ACPI 设备 | 没有枚举 `PNP0C0B` 风扇、`PNP0C09` 传统 EC；存在 `MSFT000C:00` / `\\_SB_.FFA0` | 不应继续假设传统 x86 EC I/O 端口路线 |
| hwmon | `acpitz`、`nvme`、`mlx5`、`mt7925_phy0`；无 `fan*_input` / PWM | 证明现有标准监控出口缺失，不证明底层功能缺失 |
| 其他遥测 | `NVDA8800:00` / `\\_SB_.MTEL` 未绑定 | 可研究功耗遥测，但不是已证实的风扇入口 |

`properties` 未在本机 FF-A sysfs 中暴露，不能把社区模块要求的 `0x0109` 当作已经在本机验证的值。枚举名称 `arm-ffa-18` 也不应作为跨机器稳定标识，应按 UUID 匹配。

前序只读检查中，`fwupdmgr` 将 `0x0300050b` 标为 `Embedded Controller`，将 `0x02009b0e` 和 `0x00000516` 两项均标为 `UEFI Device Firmware`。这里保留工具返回的设备名称，不仅凭版本号认定后两项的具体组件。本次没有升级这些固件。

ACPI 二进制表读取因权限被拒，`sudo -n` 需要密码；因此没有完成 DSDT/SSDT 反编译。不能据此声称 AML 中绝对没有 `_FST`、厂商方法或其他风扇对象。本次没有找到可直接调用该 FF-A 服务的现成用户态字符设备。

## 具体可追踪的接口

### 1. NVIDIA 的 EC 桥确实采用 Arm FF-A

NVIDIA 自己的内核变更说明明确解释 GB10 的 EC 服务通过 FF-A 桥访问，并区分 `MSFT000C` 与较新的 `ARML0002` 固件接口。它还说明 ACPI FFH 请求依赖此桥。这是架构层的厂商证据，而不是论坛用户对“没有接口”的猜测。该 PR 讨论的是 EC 桥和兼容性，**不是公开保证风扇 ABI 或本机 RPM 可以直接读取**。[NVIDIA NV-Kernels #575](https://github.com/NVIDIA/NV-Kernels/pull/575)

结合本机设备枚举，最有依据的研究路径是：

```text
用户态监控
  → 专门的 Linux 只读适配驱动 / hwmon
  → Arm FF-A direct message v2
  → NVIDIA 安全分区中的 EC packet relay
  → EC 温控/风扇遥测
```

### 2. 现成项目确实实现了两个 RPM 字段的读取

Christopher Owen 的实现把 `78b04d80-d21d-4986-8acb-467b60247ac5` 识别为 EC packet 服务。其协议记录中，操作 1 读取 10 字节能力响应；操作 7 读取 64 字节遥测；RPM 模式为 0，遥测 payload 的偏移 4、6 分别按 little-endian `u16` 解码。项目使用 FF-A 1.2、partition `0x8003`，并要求属性 `0x0109`。这些是作者逆向得到的约定，不是 NVIDIA 发布的稳定 ABI。[协议说明](https://github.com/christopherowen/dgx-spark-fan-control/blob/main/docs/protocol.md)

源码的 `dgx_ec_refresh()` 实际解码两个字段，`dgx_ec_hwmon_read()` 返回它们，`HWMON_CHANNEL_INFO(fan, ...)` 注册两个只读传感器。它同时包含风扇下限设置功能和退出、挂起、重启时的恢复逻辑，因此**整份控制模块并不等于仅做读取的探针**。源码只允许 DMI 为 NVIDIA / NVIDIA_DGX_Spark / P4242，并校验能力范围；技嘉机器即使 board_name 相同也会被拒绝，不能直接移除检查就视作验证通过。[内核源码](https://github.com/christopherowen/dgx-spark-fan-control/blob/main/kernel/dgx_ec_fan_control.c)

项目的直接实验记录包括公版 P4242、EC 3.5.8 上两分钟 120 次读取，以及不同风扇下限下的读数。此为项目作者的一手验证记录，但本次没有复现，也不能将 EC 3.5.8 的结果无条件外推到技嘉 `0x0300050b`。[验证记录](https://github.com/christopherowen/dgx-spark-fan-control/blob/main/docs/validation.md)

### 3. 另一个实现走 raw eSPI/OEM 服务

原始研究把 EC 风扇控制映射到 `PWM0/TACH0`、`PWM1/TACH1`，并给出 EC family 7 的能力、上下限和遥测命令。其 raw eSPI 路径经 UUID `884a63a0-3285-4120-83aa-eec008a0a546` 的 OEM command 17、共享内存和 EC mailbox。地址和通道映射来自作者对某版固件的逆向，**不是经验证的技嘉原理图或可通用套用的寄存器规范**。[原始逆向项目](https://github.com/Z841973620/dgx-spark-fan-override)

Mathieu Lacage 的后续提交实际加入 `fan_caps`、`fan_telemetry`、`fan_rpm` 只读 sysfs 属性，用 EC 操作 1、7 取得数据。这是第二条公开的可检查实现，但其整体仓库仍提供写风扇功能；“遥测命令不改转速”与“安装整个驱动完全无副作用”不是同一保证。[读取功能提交 9fa5e9f](https://github.com/mathieu-lacage/dgx-spark-fan-override/commit/9fa5e9f)

Lenovo 项目在 Christopher Owen 驱动基础上做了 ThinkStation PGX 适配，其 README 说明两个副本功能相同，差异主要是平台匹配和说明；这说明 OEM 适配已有先例，但不是技嘉兼容性证据。[Lenovo 驱动来源](https://github.com/djmad/Spark_Energy_Management/blob/main/drivers/README.md)

## “RPM”是否等于真实机械转速

目前能确认的是：公开实现读取**固件提供的两个 RPM 字段**，不是从 GPU 利用率猜测风扇。尚不能独立确认的是：字段底层究竟来自 TACH 脉冲测量，还是固件将当前 PWM/目标状态换算成 RPM。

原因是公开 Linux 模块只负责搬运和解码，没有展示 EC 内部生成该字段的完整数据流。作者验证中出现 2700/4050、4500/4455 等非常整齐的值，与其额定上限的百分比吻合；这构成应进一步核对的线索，**不能仅凭整齐数值判定其必然是估算值**。本次没有找到技嘉官方说明或测速器对照记录来消除该歧义。

在核实之前，应称它们为“EC 报告的风扇 RPM”或“固件转速遥测”，不要写成“已测得 dgx-3/4 的真实转速”。本次尚未在这两台上发出遥测请求，更没有得出具体 RPM。

## 其他路线的意义与限制

| 路线 | 资料与实机结果 | 判断 |
| --- | --- | --- |
| ACPI `_FST` | Linux 官方文档说明支持时可通过 `fan_speed_rpm` 读当前转速；`_FPS` 是性能档位表，不能混同实时读数 | 本机无枚举风扇，且 AML 未反编译；当前没有现成出口 |
| hwmon `fan*_input` | 标准的风扇监控出口与 `fan*_target`、PWM 控制是不同属性 | 缺少出口只说明驱动没有提供数据 |
| SPBM / `NVDA8800` | `antheas/spark_hwmon` 使用 `_DSM` 定位共享内存，源码提供功耗、能量、温度和功耗限制 | 可以改善功耗监控，不会据现有源码新增风扇 RPM |
| 通用 I²C/传统 EC | 本机已有明确 FF-A 服务；没有传统 EC 设备 | 无需为找风扇盲扫总线、任意读写 EC 地址 |
| 技嘉官方软件 | 支持页有独立 EC 固件和 AI TOP Utility；本次未找到公开的风扇遥测 API | “本次未找到文档”不能写成“厂商绝不提供接口” |

依据：[Linux ACPI 风扇文档](https://docs.kernel.org/admin-guide/acpi/fan_performance_states.html)、[Linux hwmon 属性文档](https://docs.kernel.org/hwmon/sysfs-interface.html)、[SPBM 实现源码](https://github.com/antheas/spark_hwmon/blob/master/spbm.c)、[GIGABYTE 官方下载说明](https://www.gigabyte.com/us/Support/Utility/Desktops)。

## 后续验证范围

下一步若要真正取得两台机器的数值，需要一个针对当前技嘉环境审核过的**最小只读内核适配模块**，先验证传输能力，再有限次数读取能力与遥测响应。应保留 UUID、平台和响应格式检查；只实现能力、遥测读取，避免把风扇设值、自动恢复写入或任意 OEM 内存访问一起引入；发生忙或超时即返回错误。读取命令本身需要构造并提交固件消息，所以“只读遥测”不等于完全被动观察内存。

模块编译、签名、加载需要目标系统管理权限，Secure Boot 的签名要求也需核对。研究阶段没有执行这些步骤，也没有为了读取而解绑系统 EC 服务。固件 RPM 成功读出后，还应核对其测量语义、两通道对应关系和不同自然负载下的变化，再接入 sparkDash。

本调查也没有证明此前突然风扇加速是 EC 固件故障：应先得到可信转速与温度/负载的同期记录，再区分正常策略、滞回、传感器异常或控制状态问题。

## 后续 TUI 验证工具

2026-10-05 曾实现独立 TUI 与只读内核探针（现已移除）。TUI 已用 dgx-3/4 的真实 SSH 数据运行；探针已在 dgx-3 的 `7.0.0-1019-nvidia` 上编译成功。当前结果仍为 `NEEDS_DRIVER`：Secure Boot 开启，标准 shim/DKMS 位置没有签名证书，加载流程返回 `SIGNING_KEY_REQUIRED`。尚未加载模块或发送 EC 遥测请求，当时未验证 RPM 是否可读；该路线现因安全性评估未通过而停止，不再推进签名注册或加载。
