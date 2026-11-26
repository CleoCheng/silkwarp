# SilkWarp 阶段 2 设计规格书：被控端伴侣代理（Host Companion Agent）

- **日期**：2026-11-27
- **状态**：Part A / Part B1 已落地，Part B2 待集成（阶段 2 / 共 3 阶段）
- **适用范围**：`apps/desktop/`（Electron 主进程）与 `server/control-plane/`（设备元数据）

---

## 一、背景与目标

阶段 1 只改造了主控端（`apps/desktop` 客户端），被控端仍然只是 Apollo + Moonlight 的被动串流目标。阶段 2 在**被控端 SilkWarp 桌面端进程内**内嵌一个轻量的 **Host Companion Agent**，让同一团队 Mesh 内的已配对客户端可以通过局域网直连完成主机侧控制，而不依赖 Apollo 自带的 Web 控制台，也不需要额外安装 Windows 服务。

### 1.1 阶段目标

1. **零额外部署**：Agent 随被控端 SilkWarp 桌面端启动，监听 `0.0.0.0:19580`，不引入独立守护进程或 MSI。
2. **Mesh 内网安全边界**：所有请求先经过 Mesh CIDR 校验，再做 Bearer Token 鉴权；密码错误按 IP 限速。
3. **访问密码体系**：支持永久访问密码（PBKDF2-SHA512 哈希存储）与 6 位临时密码（过期自动失效），同一账号客户端可配置免密直连。
4. **主机侧控制能力**：
   - 多显示器枚举与 Apollo `output_name` 切换；
   - Core Audio COM 主静音 / 恢复；
   - `WDA_EXCLUDEFROMCAPTURE` 防窥隐私幕布 + 本机物理快捷键救援退出；
   - 锁屏、任务管理器、显示桌面、`Ctrl+Alt+Del`、重启、关机六类系统动作；
   - 会话断开时自动锁屏、恢复静音与隐私状态。
5. **控制平面向后兼容**：老版本控制中心与老客户端无需迁移即可继续工作；新字段缺省时客户端自动回退到端口 `19580` 与“无访问密码”语义。

### 1.2 非目标

- 不做公网暴露、端口映射或穿透；Agent 只服务 Mesh 网段。
- 不做文件传输、剪贴板同步与拖拽（阶段 3）。
- 不替代 Apollo 的视频编码与串流链路；Agent 只负责主机侧控制面。
- 不在阶段 2 改造 Apollo 本身的认证数据库格式。

---

## 二、总体架构

```
┌──────────────────────────── 被控端 Windows ────────────────────────────┐
│  SilkWarp Electron 主进程                                               │
│  ┌──────────────────┐   ┌──────────────────┐   ┌────────────────────┐  │
│  │ HostAgentServer  │──▶│ AgentAuthManager │   │ PrivacyScreenMgr   │  │
│  │ 0.0.0.0:19580    │   │ 密码/令牌/限速    │   │ WDA 防窥幕布        │  │
│  └────────┬─────────┘   └──────────────────┘   └────────────────────┘  │
│           │ handlers                                                    │
│  ┌────────▼─────────┐   ┌──────────────────┐   ┌────────────────────┐  │
│  │ hostSystemControl│   │ hostManager      │   │ Apollo / 音频 COM  │  │
│  │ 显示器/静音/动作  │   │ output_name/防火墙│   │ Core Audio         │  │
│  └──────────────────┘   └──────────────────┘   └────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
              ▲ Mesh 10.144.0.0/24 内 HTTP + Bearer Token
┌─────────────┴──────────────────────────── 主控端 ──────────────────────┐
│  HostAgentClient  ──▶  probeInfo / authenticate / displays / audio /    │
│                        privacy / system action / session end            │
│  控制中心元数据：has_access_password、agent_port（缺省 19580）           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 模块边界

| 模块 | 职责 | 是否依赖 Electron |
| :--- | :--- | :--- |
| `electron/services/hostAgentAuth.ts` | IP 归一化、CIDR 判断、密码哈希、临时密码、失败限速、令牌签发 | 否（仅 Node `crypto`） |
| `electron/services/hostAgentServer.ts` | HTTP 路由、Mesh 守卫、Bearer 校验、请求体解析 | 否（仅 Node `http`） |
| `electron/services/hostAgentClient.ts` | 主控端类型化 HTTP 客户端 | 否（仅 Node `http`） |
| `electron/services/hostSystemControl.ts` | 显示器枚举、主静音、系统动作（PowerShell / Win32） | 否（仅 Node 子进程） |
| `electron/services/privacyScreenManager.ts` | 多屏黑色防窥幕布、`setContentProtection`、救援快捷键 | 是（`BrowserWindow` / `screen` / `globalShortcut`） |
| `electron/services/hostManager.ts` | 防火墙规则、Apollo `output_name` 读写 | 是（既有模块） |

前四个模块刻意不引入 `electron`，以便 `node --test` 直接加载 `dist-electron` 下的 CommonJS 产物做单元测试。

---

## 三、安全模型

### 3.1 Mesh CIDR 守卫

1. 每次请求先读取 `req.socket.remoteAddress`，经 `normalizeIpAddress()` 处理：
   - 去掉 IPv6 zone id（`fe80::1%12`）；
   - 展开 IPv4-mapped IPv6（`::ffff:10.144.0.12` → `10.144.0.12`）；
   - `::1` 归一化为 `127.0.0.1`。
2. 用 `isIpInCidr(remoteIp, meshCidr)` 判断是否落在当前 Mesh 网段（默认 `10.144.0.0/24`，由控制中心 bootstrap 下发）。
3. 非 Mesh 请求立即返回 `403 {"error":"mesh_only"}`，不进入任何业务路由。
4. 回环地址仅在显式开启 `allowLoopback` 时放行，用于本机自检与单元测试；生产接线默认关闭。

### 3.2 Bearer Token

- 认证成功生成 32 字节随机令牌（64 位小写 hex），默认 TTL 8 小时。
- 令牌只保存在主进程内存 `Map<token, expiresAt>`，进程重启即失效。
- 除 `GET /api/agent/info` 与 `POST /api/agent/auth` 外，所有 `/api/agent/*` 路由都要求 `Authorization: Bearer <token>`。
- 提供 `revokeAllTokens()` 供“关闭访问密码 / 主机重置”时一键踢出所有客户端。

### 3.3 失败限速

- 按归一化后的 IP 记录滚动 60 秒失败窗口。
- 同一 IP 在窗口内累计 **5 次**失败后锁定 **60 秒**，返回 `429` 与 `Retry-After`。
- 锁定期间即使密码正确也拒绝；锁定期满自动恢复。
- 认证成功立即清空该 IP 的失败记录；其他 IP 不受影响。

### 3.4 访问密码

| 类型 | 生成方式 | 存储 | 有效期 |
| :--- | :--- | :--- | :--- |
| 永久密码 | 用户设置 | `pbkdf2_sha512$120000$<saltHex>$<hashHex>`（16 字节随机盐、32 字节密钥、120000 次迭代） | 长期，直至修改/清除 |
| 临时密码 | `crypto.randomInt(100000, 1000000)` | 明文仅保存在被控端内存配置中，展示给主控端输入 | 由主机 UI 设置过期时间（默认建议 10 分钟），过期即拒绝 |

- 比较临时密码时使用常量时间字符串比较（对两侧 SHA-256 摘要做 `timingSafeEqual`）。
- 永久密码只存哈希，任何日志、心跳、API 响应都不回传明文或哈希。
- 同一账号免密：当 `allowSameAccountBypass = true` 且请求携带的 `clientUserId` 等于主机所有者 `hostOwnerUserId` 时直接放行。该开关默认开启，可在主机端关闭。

### 3.5 认证接口

`POST /api/agent/auth` 请求体：

```json
{ "password": "123456", "clientUserId": "user-...", "deviceId": "device-..." }
```

成功：`200 { "ok": true, "token": "...", "expiresAt": 1760000000000 }`
失败：`401 { "ok": false, "error": "访问密码错误" }`
锁定：`429 { "ok": false, "error": "密码错误次数过多，请稍后再试", "retryAfterSec": 60 }`

---

## 四、控制平面元数据兼容

### 4.1 新增设备字段

`server/control-plane/db.py` 的 `devices` 表新增：

| 字段 | 类型 | 默认值 | 含义 |
| :--- | :--- | :--- | :--- |
| `has_access_password` | INTEGER (0/1) | `0` | 主机是否启用了访问密码，客户端据此决定是否弹密码框 |
| `agent_port` | INTEGER | `19580` | Host Agent TCP 端口，允许用户自定义 |

### 4.2 迁移策略

- 新建数据库直接在建表语句中包含两列。
- 已存在的数据库在 `Database.__init__` 后执行 `_migrate_device_columns()`：通过 `PRAGMA table_info(devices)` 检查列，缺失时 `ALTER TABLE ... ADD COLUMN ... DEFAULT ...`，重复打开幂等。
- `device_to_dict()` 对缺失列做防御性回退（`has_access_password=false`、`agent_port=19580`），兼容极老的只读快照。

### 4.3 心跳合并语义

`heartbeat_device()` 遵循“缺省保留、显式覆盖”：

- 请求体不含 `has_access_password` → 保留数据库旧值；
- 含该字段 → 按布尔语义写入；
- `agent_port` 仅接受 `1024..65535` 的整数（排除 bool），非法值忽略并保留旧值；
- `GET /api/bootstrap/config`、`POST /api/devices/heartbeat`、`GET /api/devices` 均返回这两个字段。

### 4.4 客户端回退

- 老控制中心不返回 `agent_port` 时，客户端使用常量 `DEFAULT_AGENT_PORT = 19580`。
- 老控制中心不返回 `has_access_password` 时，客户端按 `false` 处理，但仍允许手动输入密码重试，避免误判导致无法连接。

---

## 五、音频主静音（Core Audio COM）

`hostSystemControl.ts` 通过一次性 `Add-Type` 编译 C# COM 互操作代码，直接调用 Windows Core Audio：

- CLSID `MMDeviceEnumerator`：`BCDE0395-E52F-467C-8E3D-C4579291692E`
- IID `IMMDevice`：`D666063F-1587-4E43-81F1-B948E807363F`
- IID `IAudioEndpointVolume`：`5CDF2C82-841E-4546-9722-0CF74078229A`

`IAudioEndpointVolume` 的方法槽位必须与 C++ vtable 完全一致，否则会调用到错误函数甚至崩溃：

1. `RegisterControlChangeNotify`
2. `UnregisterControlChangeNotify`
3. `GetChannelCount`
4. `SetMasterVolumeLevel`
5. `SetMasterVolumeLevelScalar`
6. `GetMasterVolumeLevel`
7. `GetMasterVolumeLevelScalar`
8. `SetChannelVolumeLevel`
9. `SetChannelVolumeLevelScalar`
10. `GetChannelVolumeLevel`
11. `GetChannelVolumeLevelScalar`
12. `SetMute`
13. `GetMute`

实现约束：

- 使用默认渲染端点（`eRender = 0`，`eMultimedia = 1`）；
- 每个 `IMMDeviceEnumerator` / `IMMDevice` / `IAudioEndpointVolume` 都在 `finally` 中 `Marshal.ReleaseComObject`；
- 输出统一标记 `<<<SILKWARP_MUTE:true|false>>>`；
- 主机无音频端点或 COM 激活失败时返回 `false`，不抛出未捕获异常；
- 阶段 2 的会话结束时由 Agent 恢复进入会话前的静音状态（`muteRestored`）。

---

## 六、隐私防窥幕布

### 6.1 显示层

- 为每个 `screen.getAllDisplays()` 创建一个无边框、不可缩放、不可移动、无阴影、跳过任务栏的纯黑 `BrowserWindow`，尺寸严格覆盖 `display.bounds`。
- `win.setContentProtection(true)` 对应 Win32 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`：**桌面采集（Apollo/Moonlight/录屏）看到的是真实应用画面，而物理显示器上只看到黑屏**。
- `win.setAlwaysOnTop(true, "screen-saver")`、`win.setIgnoreMouseEvents(true)`、`focusable: false`，保证幕布不抢焦点、不挡远程鼠标事件。
- 主显示器底部居中显示暗灰色（`#475569`）提示：`隐私保护防窥幕布已开启 · 本机按 Ctrl+Alt+Shift+P 可随时恢复显示`。

### 6.2 本机救援退出

- 幕布开启时注册全局快捷键 `CommandOrControl+Alt+Shift+P`。
- 按下后立即销毁全部幕布、注销快捷键，并回调 `onLocalEscape` 通知 Agent 广播 `privacyActive=false`。
- 快捷键注册失败（被其他程序占用）不影响幕布开启，但会在返回结果中给出提示，客户端仍可远程关闭。
- 监听 `screen` 的 `display-added` / `display-removed` / `display-metrics-changed`，在幕布开启期间自动重建覆盖层，避免插拔显示器后出现漏屏。

### 6.3 平台边界

- 仅 Windows 支持；非 Windows 返回 `{ active: false, supported: false, message }`。
- 进程退出、会话结束、远程关闭都必须走 `disable()` 清理窗口、快捷键与屏幕监听，避免残留置顶黑窗。

---

## 七、多显示器与 Apollo 输出切换

### 7.1 显示器枚举

`listHostDisplays()` 通过单次 PowerShell `Add-Type` 编译 C# P/Invoke，**不使用 WinForms**：

- `EnumDisplayMonitors`：取得每个显示器的 `HMONITOR` 与 `MONITORINFOEX`（设备名、`rcMonitor`、主屏标志）；
- `EnumDisplayDevices`：取得显示器友好名称与硬件 ID，并匹配适配器驱动名；
- `GetMonitorInfo`：读取 `rcMonitor` 与 `MONITORINFOF_PRIMARY`。

输出格式：`<<<SILKWARP_MONITORS>>>` 与 `<<<SILKWARP_END>>>` 之间每行一个压缩 JSON 对象：

```json
{"index":0,"id":"\\\\.\\DISPLAY1","deviceName":"\\\\.\\DISPLAY1","friendlyName":"DELL U2720Q","deviceId":"MONITOR\\DEL41A5","driver":"NVIDIA GeForce RTX 4070 Ti","width":3840,"height":2160,"x":0,"y":0,"isPrimary":true,"isVirtual":false,"active":true}
```

`parseMonitorLines()` 负责：

- 只解析两个标记之间的 JSON 行，忽略 `Add-Type` 噪音与尾部输出；
- 尺寸做非负取整（负数/非数字 → `0`），坐标允许负数（副屏可在主屏左侧）；
- 保留输入顺序与合法 `index`；
- 虚拟屏识别关键词：`Virtual`、`SudoMaker`、`Apollo`、`Indirect Display`、`USB Mobile Monitor`、`IddSample`（大小写不敏感，匹配友好名/硬件 ID/驱动名）；
- 空输入、缺标记、坏 JSON 全部安全跳过。

### 7.2 Apollo `output_name` 切换

Apollo / Sunshine 的 `POST /api/config` 是**整份配置重写**，不是局部 PATCH。因此切换输出显示器必须：

1. `GET /api/config` 读取当前完整配置；
2. 校验响应 JSON 为对象；
3. 深拷贝并删除只读状态字段：`status`、`status_code`、`version`、`platform`、`has_session`、`login_pin`；
4. 设置 `output_name = <目标显示器友好名>`；
5. `POST /api/config` 提交整份克隆对象；
6. 以 HTTP 2xx 判定成功，失败时返回 Apollo 状态码与响应片段。

读取接口 `getApolloOutputName()` 返回 `String(config.output_name || "")`，供客户端展示当前输出目标。

---

## 八、系统动作

`buildSystemActionScript(action)` 是纯函数，返回以下执行描述之一：

| 动作 | 实现 | 成功标记 | 中文提示 |
| :--- | :--- | :--- | :--- |
| `lock` | Win32 `[SilkWarpLock]::LockWorkStation()` | `<<<SILKWARP_ACTION:OK>>>` | 已锁定被控端 |
| `show_desktop` | `(New-Object -ComObject Shell.Application).MinimizeAll()` | `<<<SILKWARP_ACTION:OK>>>` | 已显示被控端桌面 |
| `taskmgr` | `taskmgr.exe`（独立进程，立即返回） | 进程启动成功 | 已在被控端打开任务管理器 |
| `sas` | `sas.dll` 的 `SendSAS(false)` | `<<<SILKWARP_SAS:OK>>>` | 已向被控端发送 Ctrl+Alt+Del |
| `reboot` | `shutdown.exe /r /t 2 /c "SilkWarp 远程重启"` | 退出码 0 | 已下发重启指令，被控端将在 2 秒后重启 |
| `shutdown` | `shutdown.exe /s /t 2 /c "SilkWarp 远程关机"` | 退出码 0 | 已下发关机指令，被控端将在 2 秒后关机 |

`SendSAS` 特殊处理：

- 先读取 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration`；缺失或 `<= 0` 时直接输出 `<<<SILKWARP_SAS:DENIED>>>`（默认策略即禁用软件生成 SAS）。
- 允许时再 `Add-Type` 调用 `sas.dll`；捕获 `EntryPointNotFoundException`、`DllNotFoundException`、策略拒绝等所有异常并输出 `DENIED`。
- 被拒绝时 `runHostSystemAction` 返回：
  `SendSAS 被系统策略拦截（需系统服务权限或启用 SoftwareSASGeneration），建议改用【锁定】或【任务管理器】`

### 8.1 会话结束联动

`POST /api/agent/session/end` 接收 `{ autoLock?: boolean }`：

- 若 `autoLock === true`，执行 `lock`；
- 恢复会话开始前记录的主静音状态；
- 关闭隐私幕布（若开启）；
- 返回 `{ locked, muteRestored, privacyRestored }` 供客户端展示。

---

## 九、HTTP API 一览

| 方法 | 路径 | 鉴权 | 说明 |
| :--- | :--- | :--- | :--- |
| GET | `/api/agent/info` | Mesh only | 版本、主机名、是否需要密码、隐私/静音状态、Apollo 状态、能力列表 |
| POST | `/api/agent/auth` | Mesh only | 密码/同账号换 Bearer Token |
| GET | `/api/agent/displays` | Bearer | 枚举显示器 |
| POST | `/api/agent/displays/select` | Bearer | 切换 Apollo `output_name` |
| GET | `/api/agent/audio/mute` | Bearer | 读取主静音 |
| POST | `/api/agent/audio/mute` | Bearer | 设置主静音（`{ muted: boolean }`） |
| GET | `/api/agent/privacy` | Bearer | 读取幕布状态 |
| POST | `/api/agent/privacy` | Bearer | 开关幕布（`{ active: boolean }`） |
| POST | `/api/agent/system/action` | Bearer | 六类系统动作 |
| POST | `/api/agent/session/end` | Bearer | 断开联动：锁屏/恢复静音/关闭幕布 |

请求体上限 64 KiB；非 JSON / 超大请求分别返回 `400` / `413`。

---

## 十、错误处理与边界

1. **非 Windows**：`listHostDisplays()` 返回 `[]`，静音读写返回 `false`，系统动作返回“仅支持 Windows 被控端”。
2. **PowerShell 超时**：统一 10 秒（枚举显示器 15 秒），超时后杀进程并返回空结果/失败消息，不阻塞 Agent 主循环。
3. **COM 不可用**：无音频设备、驱动异常、`Add-Type` 编译失败时静音接口返回 `false`，不抛出未捕获异常。
4. **隐私幕布**：快捷键冲突只降级提示；显示器热插拔自动重建；进程退出必须清理。
5. **Apollo 不可达**：`statusCode === 0` 视为离线；`307/302` 视为未初始化；`401/403` 视为凭据错误，均返回可读中文消息。
6. **防火墙**：`checkFirewallConfigured()` 必须同时存在 `SilkWarp-Apollo-TCP` 与 `SilkWarp-Agent-TCP` 才返回 `true`；配置时同时创建/更新四条规则（Apollo TCP、Apollo UDP、Mesh ICMP、Agent TCP 19580）。
7. **向后兼容**：阶段 2 不改变既有 `/api/bootstrap/config`、`/api/devices`、`/api/devices/heartbeat` 的必填字段；新增字段全部有默认值。

---

## 十一、测试与验收

### 11.1 自动化

- `apps/desktop/scripts/test_host_agent.cjs`：CIDR、密码哈希、临时密码、同账号绕过、5 次失败/60 秒锁定、令牌过期、HTTP 服务与客户端全链路。
- `apps/desktop/scripts/test_host_system_control.cjs`：显示器 JSON 解析、虚拟屏识别、六类动作脚本、Windows 实机只读枚举与静音读取。
- `server/control-plane/tests/test_control_plane.py`：新字段默认值、心跳往返与保留语义、非法端口忽略、老库幂等迁移。
- 构建：`npx tsc -p tsconfig.node.json` 零错误。

### 11.2 实机验收（Mobar ↔ Think）

1. 主控端在设备列表看到 `agent_port=19580` 且 `has_access_password` 正确。
2. 首次连接弹出密码框；错误 5 次后提示 60 秒后再试；正确密码/临时密码可进入。
3. 多显示器列表顺序与 Windows 显示设置一致，可识别 Apollo/SudoMaker 虚拟屏；切换输出后 Apollo 重启串流使用新显示器。
4. 远程静音后主机扬声器无声，断开后自动恢复原状态。
5. 开启防窥后主机物理屏全黑，主控端串流仍可见真实桌面；在主机按 `Ctrl+Alt+Shift+P` 立即恢复。
6. 锁屏、任务管理器、显示桌面、重启、关机均生效；`Ctrl+Alt+Del` 被策略拦截时给出可读提示。
7. 断开会话且开启“自动锁屏”时，主机立即锁屏。
