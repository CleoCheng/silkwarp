# SilkWarp 客户端与被控端接入指南

> 全部团队成员均通过 **EasyTier 私有 Mesh（默认网段 `10.144.0.0/24`）+ Moonlight/Artemis + RustDesk** 接入，避免暴露任何明文远控端口到公网。

---

## 一、快速接入参数（统一模板）

实际域名、端口、密钥与 `RUSTDESK_PUBLIC_KEY` 请从团队管理员或本地 `silkwarp.config.json` / `secrets/silkwarp.env` 获取：

| 服务 | 配置项 | 参数值 |
| :--- | :--- | :--- |
| **EasyTier** | 网络名称 (`network_name`) | `<SILKWARP_NETWORK_NAME>`（默认 `silkwarp-team`） |
| EasyTier | 网络密钥 (`network_secret`) | 见 `secrets/silkwarp.env` -> `SILKWARP_NETWORK_SECRET` |
| EasyTier | 节点列表 (`peer`) | `udp://<RELAY_HOST>:<RELAY_PORT>`、`tcp://<RELAY_HOST>:<RELAY_PORT>`、`udp://<SIGNALING_HOST>:<COORD_PORT>`、`tcp://<SIGNALING_HOST>:<COORD_PORT>` |
| EasyTier | 建议选项 | 开启 `latency_first`（延迟优先）、`multi_thread`、`enable_ipv6` |
| **RustDesk** | ID 服务器 (`hbbs`) | `<SIGNALING_HOST>`（默认端口 `21116`） |
| RustDesk | 中继服务器 (`hbbr`) | 留空即可（由 `hbbs` 自动下发 `<RELAY_HOST>:<HBBR_PORT>`） |
| RustDesk | Key（公钥） | 见 `secrets/silkwarp.env` -> `RUSTDESK_PUBLIC_KEY` |
| **Moonlight / Artemis** | 主机地址 | 目标主机的 Mesh 虚拟 IP（例如 `10.144.0.10`） |

---

## 二、被控端（Windows 独显主力机）部署

> 推荐直接使用一体化的 **SilkWarp 桌面客户端**（登录后全自动下发配置与静默部署）；如需命令行手动部署，可按下列步骤执行：

1. 以**管理员权限**打开 PowerShell，在项目根目录运行：
   ```powershell
   .\scripts\setup-windows-host.ps1 -HostName "pc-main-gpu" -MeshIP "10.144.0.10/24" -InstallApollo
   ```
   脚本会自动完成：
   - 下载 EasyTier `v2.6.4` 至 `C:\ProgramData\SilkWarp\easytier\`
   - 生成配置并注册开机即运行（无需登录桌面）的 `SilkWarp-EasyTier` 系统计划任务
   - 创建仅允许 Mesh 网段访问 Apollo/Sunshine 的 Windows 防火墙规则
   - 下载 `Apollo-0.4.6.exe` 至 `C:\ProgramData\SilkWarp\installers\`
2. 安装 **Apollo** 后进入本机 Web 控制台（`https://localhost:47990`）：
   - 开启 **虚拟显示器（SudoVDA / Virtual Display）**，推荐将“自动切换虚拟屏并关闭物理屏”作为隐私屏模式。
   - 编码器保持硬件加速（NVIDIA NVENC / AMD AMF / Intel QSV）。
3. 安装 **RustDesk** 客户端并设置“网络 -> ID/中继服务器”：
   - **ID 服务器**：`<SIGNALING_HOST>`
   - **Key**：填入 `RUSTDESK_PUBLIC_KEY`
   - 设置固定无人值守访问密码，并安装系统服务以支持锁屏与 UAC 操作。
4. （可选）若需要远程开机（WOL），在主板 BIOS 开启 `Wake on PCI-E / PME`，在网卡高级属性开启 `Wake on Magic Packet`，并将主机 MAC 登记到中继节点的 `/opt/silkwarp/wol/devices.json`。

---

## 三、主控端各平台接入方式

### 1. Windows 主控端
- 安装并登录 **SilkWarp Windows 桌面端**，首次接入可读取同目录 `silkwarp.config.json` 或在登录界面展开填入控制中心 URL。
- 如使用命令行生成独立配置：
  ```powershell
  .\scripts\setup-windows-client.ps1 -ClientName "laptop-win" -DownloadApps
  ```
- 打开 **Moonlight**（或使用 SilkWarp 内置一键连接）连接目标主机 Mesh IP。
- **推荐串流参数**：
  - 编码：`HEVC (H.265)` 或 `AV1`
  - 码率：同城 P2P 可设 `30~60 Mbps`，走中继建议 `15~30 Mbps`
  - 帧率与分辨率：按本机屏幕原生规格（如 1080p/2K 60/120fps）

### 2. macOS 主控端
- 安装 **EasyTier GUI**（对应架构版本），使用 `configs/easytier-node.toml.example` 同款参数（启用 DHCP 或分配同网段静态 IP）。
- 安装 **Moonlight for macOS** 与 **RustDesk for macOS**，连接方式同上。

### 3. Android / iOS 移动主控端
- **EasyTier App**：从控制中心 Web 伴侣页复制网络名/密钥与 Peer 地址并导入。
- **串流端**：Android 推荐 **Artemis**（Apollo 配套客户端，支持更佳的虚拟屏/触控交互）或 **Moonlight**；iOS 使用 **Moonlight**。
- **辅助端**：安装 **RustDesk**，填入 `<SIGNALING_HOST>` 与 `RUSTDESK_PUBLIC_KEY`。

---

## 四、远程开机（WOL）使用

当 EasyTier 连接成功且中继网关在线时，可从任意已入网主控端访问：
- 浏览器访问：`http://<RELAY_MESH_IP>:<WOL_PORT>/`（输入 `SILKWARP_WOL_TOKEN`）
- 或命令行触发唤醒：
  ```bash
  curl -X POST -H "X-SilkWarp-Token: <SILKWARP_WOL_TOKEN>" http://<RELAY_MESH_IP>:<WOL_PORT>/api/wake/pc-main
  ```
