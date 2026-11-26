# SilkWarp

面向自建服务器与高带宽中继的轻量级低延迟远程桌面与串流方案，致力于提供类网易 UU 远程的零配置开箱体验：登录后自动组网、后台静默部署硬件编码串流引擎，以及跨设备一键直连桌面。

## 核心架构

SilkWarp 采用三层混合架构（设计细节见 [架构设计与网络规划](docs/architecture.md)）：

1. **Tier 1 · 固定 IP 控制与信令面**：
   - 运行 **SilkWarp Control Plane**（零依赖 Python + SQLite WAL HTTP 服务与 Web 伴侣端）、**EasyTier**（`no_tun = true` 纯 RPC 协调节点）以及 **RustDesk `hbbs` + `rustdesk-api`**。
2. **Tier 2 · 高带宽中继与 WOL 网关**：
   - 运行 **EasyTier 私有中继枢纽**、**RustDesk `hbbr`** 与仅监听 Mesh 内网的 **SilkWarp WOL 网关**（`services/wol-helper/silkwarp_wol.py`），负责 P2P 受限时的加密流量中继与局域网远程唤醒。
3. **Tier 3 · 多端一体桌面客户端与独显被控端**：
   - 基于 **Electron + React + TypeScript + Tailwind CSS** 构建 Windows 客户端，内置 **EasyTier + Moonlight Portable**，支持管理员提权、一键后台静默安装 **Apollo (`v0.4.6`)** 与虚拟显示器、Cookie 会话免 PIN 自动配对与 **RustDesk** 运维兜底。

## 目录结构

```text
silkwarp/
├── apps/
│   └── desktop/                           # SilkWarp Electron + React 桌面客户端源码
├── configs/
│   ├── README.md                          # 多端接入说明与参数模板
│   ├── easytier-coord-aliyun.toml.example # 纯 RPC 协调节点配置模板
│   ├── easytier-relay-r720.toml.example   # 私有中继枢纽配置模板
│   └── easytier-node.toml.example         # 被控端 / 主控端节点配置模板
├── docs/
│   └── architecture.md                    # 三层混合架构拓扑、端口与安全边界说明
├── scripts/
│   ├── deploy-signaling-aliyun.sh         # Tier 1 信令节点部署脚本
│   ├── deploy-control-plane-aliyun.sh     # 控制中心与 Nginx 片段部署脚本
│   ├── deploy-rustdesk-api-aliyun.sh      # RustDesk API + Nginx HTTPS 部署脚本
│   ├── deploy-relay-r720.sh               # Tier 2 中继枢纽 + WOL 网关部署脚本
│   ├── prepare-desktop-assets.ps1         # 下载/准备桌面端内置第三方运行时资源
│   ├── push-r720-relay.ps1                # 推送环境配置与密钥并远程部署中继节点
│   ├── setup-windows-host.ps1             # Windows 被控端命令行初始化脚本
│   ├── setup-windows-client.ps1           # Windows 主控端命令行配置生成脚本
│   └── verify-silkwarp.ps1                # DNS、端口连通性与本地 Mesh 路由检查
├── server/
│   └── control-plane/                     # 控制中心后端 API、Web UI 与单元测试
├── services/
│   └── wol-helper/
│       └── silkwarp_wol.py                # Wake-on-LAN 内网唤醒网关
├── .env.example                           # 服务端环境变量配置模板
└── silkwarp.config.example.json           # 客户端 / 开发环境外部配置模板
```

## 快速开始（换机调试 / 开箱即用）

本仓库源码不包含任何个人域名、IP、端口、密钥或安装包。在另一台开发机拉取代码后，按以下步骤即可直接恢复本地环境：

1. **克隆代码仓库**
   ```bash
   git clone https://github.com/CleoCheng/silkwarp.git
   cd silkwarp
   ```

2. **恢复本地配置文件（git-ignored）**
   - 从你的旧电脑复制仓库根目录的 **`silkwarp.config.json`** 到新电脑仓库根目录（或复制模板后填入你的服务器地址）：
     ```bash
     cp silkwarp.config.example.json silkwarp.config.json
     ```
   - 桌面端启动时会按顺序自动读取：`SILKWARP_CONFIG_PATH`、`%APPDATA%/<app>/silkwarp.config.json`、`SilkWarp.exe` 同级目录或仓库根目录下的 `silkwarp.config.json`（也可通过环境变量 `SILKWARP_API_URL` 覆盖，或在登录界面直接手动填写）。
   - 如需在新电脑执行服务端部署或连通性测试，可一并复制本地 **`secrets/silkwarp.env`**（由 `.env.example` 填写生成，已被 `.gitignore` 忽略）。

3. **准备桌面端运行时资源（EasyTier / Moonlight / Apollo）**
   ```powershell
   .\scripts\prepare-desktop-assets.ps1
   ```

4. **安装依赖、构建与本地测试**
   - 后端单元测试（仓库根目录）：
     ```bash
     python -m unittest discover -s server/control-plane/tests -v
     ```
   - 桌面客户端构建与打包：
     ```powershell
     cd apps\desktop
     npm install
     npm run build
     # 如需生成 Windows NSIS 安装包：
     npm run pack:win
     ```

## 服务端部署参数配置

服务端所有部署脚本统一从环境变量或 `/opt/silkwarp/silkwarp.env`（控制中心对应 `/opt/silkwarp/control-plane/control.env`）读取配置：

1. 参考 [`.env.example`](.env.example) 创建 `secrets/silkwarp.env` 并填入实际域名（`SILKWARP_DOMAIN`、`SILKWARP_API_URL`、`SILKWARP_SIGNALING_HOST`、`SILKWARP_RELAY_HOST` 等）、端口、SSL 证书路径与随机密钥。
2. 控制中心后端 `server/control-plane/app.py` 优先读取环境变量，未设置时自动回退读取 `silkwarp.config.json`（或 `SILKWARP_CONFIG_FILE`）。
3. 常用验证：
   ```powershell
   .\scripts\verify-silkwarp.ps1
   ```
