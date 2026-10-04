# sparkDash Desktop

**简体中文** | [English](README.md)

![sparkDash Desktop 监控总览示意图](assets/readme/hero.svg)

<p align="center">
  <img alt="macOS 13+" src="https://img.shields.io/badge/macOS-13%2B-182638?style=flat-square&amp;logo=apple&amp;logoColor=white">
  <img alt="Apple Silicon" src="https://img.shields.io/badge/Apple_Silicon-ARM64-68cba6?style=flat-square">
  <img alt="Electron" src="https://img.shields.io/badge/Desktop-Electron-89b4fa?style=flat-square&amp;logo=electron&amp;logoColor=white">
  <img alt="English and Simplified Chinese" src="https://img.shields.io/badge/Language-EN_%2F_简体中文-89b4fa?style=flat-square">
  <a href="LICENSE"><img alt="App license MIT" src="https://img.shields.io/badge/App_License-MIT-68cba6?style=flat-square"></a>
</p>

sparkDash Desktop 是一款通过 SSH 监控远程设备的桌面应用，支持 NVIDIA DGX Spark 和配备 NVIDIA GPU 的 Linux 主机。项目基于 [Mia’a AI Lab 的 sparkDash](https://github.com/MiaAI-Lab/sparkDash) 开发，使用 Electron 打包为桌面应用，支持导入本机 SSH 配置、加密保存凭据，以及中英文界面切换。

## 功能

| 功能 | 说明 |
| --- | --- |
| 多机监控 | 查看各台设备的 GPU、CPU、内存、存储、网络和运行时间；分别显示 DGX 共享内存与独立显卡的显存 |
| LLM 服务 | 同时监控多个端口上的服务，识别 llama.cpp、vLLM、SGLang、ds4-server、EXL3、q27 和 TensorFold；查看 Token 用量及服务提供的推理指标 |
| 压测与演示 | 运行 Decode / Prefill 压测，测量首 Token 延迟，保存结果并以文字或图片分享；通过 Prompt Showcase 查看多路流式输出 |
| 可选服务 | 查看 ComfyUI 队列和任务进度、Hermes 与 Tailscale 状态；手动发起 Hermes 更新 |
| 桌面集成 | 使用原生菜单、切换四种主题和中英文界面；导入 SSH 别名，通过密钥或密码连接；支持 SSH 服务隧道和休眠后恢复监控 |
| 集群总览 | 按 Head/Worker 角色分组展示设备，检测 2–12 台已添加 Spark 之间的直连 200G 网络 |
| 设备操作 | 手动发起关机或网络唤醒（Wake-on-LAN）；需要远端辅助程序和网络环境支持 |

监控界面、采集器、服务集成和压测功能来自上游 sparkDash。本版本在此基础上增加了 Electron 进程隔离和本机接口认证，接入 macOS 钥匙串与系统 SSH，并提供双语界面和集群分组配置。详见[功能矩阵](docs/upstream-feature-matrix.md)和[致谢与来源](ACKNOWLEDGEMENTS.md)。

## 安装与连接

1. 使用内部提供的 ARM64 压缩包，或按下文自行构建。解压后将 `sparkDash.app` 拖入“应用程序”。
2. 启动应用并添加设备。从本机 SSH 配置导入别名，或手动输入地址。用户名、端口、私钥留空即可沿用 SSH 配置，支持 `Include` 引入的配置。
3. 点击 **测试 SSH 连接 / Test SSH connection**；密钥认证失败时可选择 **改用密码 / Use password instead**。测试时不会保存设备或密码，只有点击 **保存 / Save** 后才会写入配置。
4. 填写设备上已有服务的实际端口，或关闭不用的服务监控。LLM 默认 `8888`，ComfyUI 默认 `8188`。
5. 在原生菜单 **语言 / Language → 简体中文 / English** 或设置中切换语言。切换后立即生效，重启应用后仍会使用所选语言。首次启动时默认使用英文。

## 集群检测与使用限制

在总览中选择 **检测 200G / 创建集群**，应用会通过 SSH 检测已添加的设备。根据检测结果选择成员并指定 Head，即可保存分组，之后也可以修改或解散。这里的分组和角色仅用于监控展示，不会在设备上部署推理集群。

检测结果为绿色，表示直连网口的协商速率达到 200 Gb/s，且双方均能通过 IPv4 探测到对方。这项检测不测量实际吞吐量，也不验证 RDMA、NCCL 或张量并行推理。连接需要经过路由、缺少 IP 地址或探测失败时，结果会标为“未验证”。网络配置可参考 [NVIDIA 集群指南](https://docs.nvidia.com/dgx/dgx-spark/spark-clustering.html)。

启用监控不会自动安装 LLM、ComfyUI 或 Hermes 服务。压测、Showcase、取消任务、更新和电源操作都需要用户在界面中手动发起。能耗及部分内存用量是估算值；缺少读数时，不应将其理解为零。部分 LLM 后端不提供实时 Token 计数。

## 数据、凭据与更新

应用数据保存在 `~/Library/Application Support/sparkDash`，可通过 **监控 → 打开数据目录** 查看。如果只使用 SSH 别名和密钥连接，应用不会访问钥匙串。只有保存密码或 API Key，或读取已保存的加密凭据时，才会请求访问 **sparkDash Safe Storage**。如果系统弹窗要求输入登录钥匙串密码，请只在该弹窗中输入，应用本身不会收到这个密码。保存的凭据使用 AES-GCM 加密，加密密钥由 macOS 钥匙串保护。

更新前，先退出应用，备份整个数据目录并保留旧版 `.app`，再替换为新版。如果需要回退，请同时恢复旧版应用和对应的数据备份。换一台 Mac 或换一个用户账户后，原有加密数据可能无法解密；请保留与这些数据配套的 `secrets-key.encrypted` 文件。

关闭最后一个窗口后，应用会退出并停止采样。电脑休眠时暂停监控，唤醒后重新连接并计算速率。短期曲线只保存在窗口内存中，长期统计和任务结果会写入磁盘；停止采样期间的数据不会补录。如果凭据解锁失败，请保留原文件，通过 **监控 → 重新连接后台** 重试。添加或移除设备后，也可能需要重新连接后台，才能按新的设备列表统计能耗。

## 开发与构建

目前的桌面运行和打包流程使用 macOS，需要先安装 Node.js **24.19+** 和 **pnpm 11.25.0**，然后在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm desktop
```

`pnpm desktop` 加载已构建的前端，因此修改前端后需重新构建。如果要在浏览器中调试，可以运行 `pnpm dev`，同时启动前端和后台。Vite 默认使用 `5173` 端口，后台默认使用 `5555` 端口。部分原生桌面功能需要在 Electron 中调试。

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | 后端、前端、桌面集成测试 |
| `pnpm test:server` / `pnpm test:frontend` / `pnpm test:desktop` | 单独运行一个测试套件 |
| `pnpm build` | 将前端构建到 `dist/` |
| `pnpm package:mac` | 构建前端并打包、签名 ARM64 应用 |
| `pnpm test:packaged` | 使用本机模拟服务和独立测试数据，验证打包后的应用 |

打包完成后，应用位于 `release/sparkDash-darwin-arm64/sparkDash.app`，脚本会校验其 ad-hoc 签名。该流程不会自动生成 ZIP 压缩包或执行 Apple 公证。打包测试的数据单独保存在 `.desktop-test/` 中。实机检查脚本及运行条件见[文档索引](docs/README.md)。

## 项目结构

```text
src/          React + TypeScript 界面、API 客户端、共享类型与国际化
server/       Express / WebSocket 后台、采集器、设备注册与统计
desktop/      Electron 主进程/preload、后台生命周期、SSH 与凭据桥接
scripts/      打包、本机及实机验收脚本
config/       浏览器/服务端模式的默认配置与辅助脚本
assets/       应用资源
docs/         架构、功能矩阵、验收与研究记录
```

`node_modules/`、`.pnpm-store/`、`dist/`、`release/` 和 `.desktop-test/` 为本地生成目录，已由 Git 忽略。运行时产生的配置和凭据不提交到仓库，默认设置 `config/settings.json` 则纳入版本管理。安装依赖时使用 pnpm 锁文件，确保依赖版本一致。

## 文档与验收

其他文档见[文档索引](docs/README.md)。[验收记录](docs/verification.md)列出了源码测试、本机模拟服务测试、打包检查和实机测试的结果。最近一次完整源码测试中，后端 396 项、前端 81 项、桌面端 28 项均通过。具体测试了哪些设备和操作、哪些尚未验证，也在记录中注明。

## 许可与上游致谢

桌面应用使用 MIT 许可，原始 [LICENSE](LICENSE) 保持不变。本项目基于 **MiaAI-Lab/sparkDash 1.8.9**，对应的上游提交为 [`b4228a330a7877dcb5a30516500d57e26affa45a`](https://github.com/MiaAI-Lab/sparkDash/tree/b4228a330a7877dcb5a30516500d57e26affa45a)。感谢 **Mia’a AI Lab 及上游贡献者**开源原项目的界面、采集器和监控功能。

各项依赖仍适用各自的许可证。项目来源和许可说明见 [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)。这是独立维护的衍生版本，不代表 Mia’a AI Lab 或 NVIDIA，文中引用也不表示获得其官方认可或推荐。
