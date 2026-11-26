# SilkWarp 桌面端远程体验全面升级 · 阶段 1 设计规格书

- **日期**：2026-11-27
- **状态**：待评审（阶段 1 / 共 3 阶段）
- **适用范围**：`apps/desktop/`（Electron 主进程、Preload 桥接与 React 渲染层）

---

## 一、背景与总体演进路线（方案 C）

### 1.1 用户目标与核心痛点
当前 SilkWarp 桌面端（`v2.0.2`）仅作为启动器调用内置 `Moonlight.exe`，存在以下影响日常主力远控的核心问题：
1. **只能全屏**：未配置窗口化显示模式，无法自由拖拽缩放窗口或放在副屏伴随办公。
2. **缺少会话内控制条**：连接后无法在远程窗口内切换全屏/窗口、实时调整分辨率/码率/刷新率/编码器、切换被控端静音、或一键切办公模式。
3. **鼠标手感“虚浮、发飘不跟手”**：经实机与源码排查，存在 4 个已验证根因（详见第二节）。
4. **缺少日常主力远控辅助能力**：如多屏识别切换、访问密码、隐私屏、快捷系统键与拖拽/快捷键文件传输等。

### 1.2 总体架构路线：方案 C（双引擎协同 + 伴侣服务，三阶段演进）
采用 **增强型 Apollo + Moonlight Portable `v6.2.0`**（作为高刷/高画质主力引擎，补齐窗口化、零延迟调优与仿 UU 远程顶部悬浮工具栏）**+ 自建 RustDesk 深度整合**（作为 0ms 本地硬件光标“办公模式”与 UAC/锁屏运维兜底），并分 3 个阶段推进：

| 阶段 | 核心能力与边界 | 涉及端侧 |
| :--- | :--- | :--- |
| **阶段 1（本设计书）** | 窗口化与可拖拽缩放、顶部透明悬浮工具栏（会话内动态调参、适应窗口分辨率、全屏/窗口/无边框切换、被控端静音、快捷热键、性能监控）、4 项鼠标零延迟调优、自建 RustDesk 0ms 办公模式一键切换 | 仅 `apps/desktop` 客户端（兼容现有控制中心 API） |
| **阶段 2（后续独立规格）** | 内嵌被控端 `Host Companion Agent`（仅监听 Mesh `10.144.0.x`）、多显示器自动枚举与悬浮条一键切屏、固定/临时访问密码、系统级被控静音与防窥隐私屏、`Ctrl+Alt+Del` / 锁屏 / 重启 | `apps/desktop` + `server/control-plane` |
| **阶段 3（后续独立规格）** | 基于 Mesh `Host Companion Agent` 的内网极速拖拽/快捷键文件传输、双向文件抽屉、`Ctrl+C`/`Ctrl+V` 文字/图片/文件剪贴板同步 | `apps/desktop` |

**阶段 1 边界承诺**：本阶段不修改 `server/control-plane/` 数据库表结构与既有 HTTP 协议，老版本控制中心与已配对主机无需迁移即可兼容工作。

---

## 二、根治“鼠标虚浮/飘”的 4+1 专项优化设计

### 2.1 已验证的 4 个物理根因
1. **虚拟网卡 MTU 分片抖动**：Windows 上 SilkWarp Wintun 网卡接口 `NlMtu` 为 **`1360`**，而 Moonlight 对私网/局域网目标（如 `10.144.0.x`）默认采用 **`1392` 字节**视频载荷（加 IP/UDP 头后达 `1420` 字节 `> 1360`），导致视频帧持续发生 IP 分片，放大中继与弱网抖动。
2. **默认开启 V-Sync 缓冲**：Moonlight `v6.2.0` 默认 `enableVsync = true`，当前启动参数未传 `--no-vsync --no-frame-pacing`，额外引入 1～2 帧（16～33ms+）显示排队缓冲。
3. **中继链路高码率与物理屏缩放发飘**：中继连接（`relay`）下硬推 `2560x1440 @ 120fps 35Mbps` 易造成中继排队延迟（bufferbloat）；且直连主机 `"Desktop"` 时若主控窗口尺寸/比例与主机物理显示器不一致，坐标缩放插值也会带来发飘感。
4. **视频流内软光标往返延迟**：Moonlight 在 `--absolute-mouse` 下仍调用 `SDL_ShowCursor(SDL_DISABLE)` 隐藏本地系统光标，眼睛看到的是经过编码、网络、解码后的远端软光标，物理上不如本地 0ms 硬件光标跟手。

### 2.2 阶段 1 落地的解决方案
1. **消除分片（自动 `--packet-size`）**：
   - `p2p` / `local` / 未知链路默认下发 `--packet-size 1200`；
   - `relay*` 中继链路默认下发 `--packet-size 1024`；
   - 允许用户在设置中显式覆盖具体数值（`packetSize: "auto" | number`）。
2. **砍掉本地显示缓冲（默认 `lowLatency: true`）**：
   - 启用低延迟开关时强制下发：`--no-vsync --no-frame-pacing --no-game-optimization --video-decoder hardware`；
   - 关闭时回退：`--vsync --frame-pacing --video-decoder auto`。
3. **中继自适应护栏（`adaptiveRelayCap: true`）+ 虚拟屏 1:1 匹配（默认 `streamApp: "Virtual Display"`）**：
   - `adaptiveRelayCap` 开启且链路为 `relay*` 时，计算有效参数 `effectivePreset`：帧率上限钳制在 `60` fps，码率上限钳制在 `15` Mbps（仅作用于本次命令行参数，不篡改用户保存的 P2P 预设）；一旦用户在悬浮条或预设栏主动调高参数，自动将 `adaptiveRelayCap` 设为 `false`，尊重用户显式选择。
   - 默认优先串流 Apollo 内置 **`"Virtual Display"`**（自动按主控端窗口/预设分辨率与帧率生成 1:1 虚拟屏，断开即销毁）；连接前通过 `/applist` 或 `Moonlight.exe list` 探测主机应用列表，若 `"Virtual Display"` 不存在则无感回退 `"Desktop"`。
4. **办公模式（0ms 本地硬件光标 · 自建 RustDesk 深度整合）**：
   - 高刷看视频/写设计用低延迟 Apollo 窗口；需要文字办公、精细点击、操作锁屏/UAC 弹窗时，在设备卡片或悬浮条一键点击 **「办公模式 (0ms 光标)」**，停止当前 Moonlight 会话并拉起已自动配置好团队自建中继/公钥的 RustDesk 客户端。

---

## 三、数据模型、参数生成与会话生命周期设计

### 3.1 扩展配置与会话状态类型（`apps/desktop/electron/types.ts`）

将原有 `StreamPreset` 扩展为完整向后兼容结构，所有新字段在 `StateStore` 读取旧 `silkwarp-state.json` 时自动补齐默认值：

```ts
export type DisplayMode = "windowed" | "borderless" | "fullscreen";
export type StreamAppTarget = "Virtual Display" | "Desktop";
export type SystemKeyCaptureMode = "always" | "fullscreen" | "never";

export interface StreamPreset {
  resolution: string; // e.g. "1920x1080", "2560x1440", "3840x2160", or custom "1720x980"
  fps: 30 | 60 | 120 | 144;
  bitrateMbps: number; // 4..100
  codec: "hevc" | "av1" | "h264";
  displayMode: DisplayMode; // default: "windowed"
  streamApp: StreamAppTarget; // default: "Virtual Display"
  muteHostAudio: boolean; // default: true -> --no-audio-on-host
  lowLatency: boolean; // default: true -> --no-vsync --no-frame-pacing --no-game-optimization --video-decoder hardware
  adaptiveRelayCap: boolean; // default: true
  absoluteMouse: boolean; // default: true -> --absolute-mouse
  showPerfOverlay: boolean; // default: false -> --performance-overlay
  captureSystemKeys: SystemKeyCaptureMode; // default: "fullscreen"
  packetSize: "auto" | number; // default: "auto"
}
```

新增运行时窗口坐标与活跃会话状态类型：

```ts
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  visible: boolean;
  minimized: boolean;
  foreground: boolean;
}

export interface ActiveSessionState {
  sessionId: string;
  device: DeviceInfo;
  preset: StreamPreset;
  effectivePreset: StreamPreset;
  routeType: string;
  latencyMs: number | null;
  resolvedApp: StreamAppTarget;
  availableApps: string[];
  windowRect: WindowRect | null;
  reconnecting: boolean;
  startedAt: number;
}
```

### 3.2 纯逻辑参数模块（`apps/desktop/electron/services/streamOptions.ts`）
该模块**禁止引入 `electron` 与原生 UI 依赖**，以便通过 Node 直接执行单元测试：

1. `DEFAULT_STREAM_PRESET`：
   - `resolution: "2560x1440"`，`fps: 120`，`bitrateMbps: 35`，`codec: "hevc"`，`displayMode: "windowed"`，`streamApp: "Virtual Display"`，`muteHostAudio: true`，`lowLatency: true`，`adaptiveRelayCap: true`，`absoluteMouse: true`，`showPerfOverlay: false`，`captureSystemKeys: "fullscreen"`，`packetSize: "auto"`。
2. `normalizeStreamPreset(raw?: Partial<StreamPreset> | null): StreamPreset`：
   - 将旧版仅含 4 个字段的预设平滑补齐为完整 `StreamPreset`；对 `resolution` 校验 `\d+x\d+`（非法回退 `"2560x1440"`），对 `fps` 校验枚举值，对 `bitrateMbps` 钳制在 `4..100` 区间。
3. `normalizeWindowResolution(width: number, height: number): string`：
   - 钳制宽 `[800, 3840]`、高 `[600, 2160]`，并用 `& ~1` 向下对齐为偶数像素（满足硬件编码器 YUV420 偶数对齐要求），返回 `"<w>x<h>"`。
4. `resolvePacketSize(preset: StreamPreset, routeType: string): number`：
   - 若 `typeof preset.packetSize === "number"`，钳制在 `[512, 1320]` 返回；
   - 否则若 `routeType.toLowerCase().startsWith("relay")` 返回 `1024`，其余返回 `1200`。
5. `computeEffectivePreset(preset: StreamPreset, routeType: string): StreamPreset`：
   - 若 `preset.adaptiveRelayCap && routeType.toLowerCase().startsWith("relay")`，返回将 `fps` 限制为 `<= 60`（`120/144 -> 60`，`30/60` 保持不变）、`bitrateMbps` 限制为 `<= 15` 后的新对象；否则原样返回克隆。
6. `buildMoonlightStreamArgs(meshIp: string, preset: StreamPreset, routeType: string, resolvedApp: StreamAppTarget): string[]`：
   - 根据 `computeEffectivePreset(preset, routeType)` 组装完整 CLI 参数（先放所有 `--option`，最后放 `"stream"`, `meshIp`, `resolvedApp`）：
     - `--resolution <effective.resolution>`
     - `--fps <effective.fps>`
     - `--bitrate <effective.bitrateMbps * 1000>`
     - `--video-codec <HEVC|AV1|H.264>`
     - `--packet-size <resolvePacketSize(...)>`
     - `--display-mode <effective.displayMode>`
     - `--capture-system-keys <effective.captureSystemKeys>`
     - `effective.absoluteMouse ? "--absolute-mouse" : "--no-absolute-mouse"`
     - `effective.muteHostAudio ? "--no-audio-on-host" : "--audio-on-host"`
     - `effective.showPerfOverlay ? "--performance-overlay" : "--no-performance-overlay"`
     - `effective.lowLatency` 为 `true` 时附加 `["--no-vsync", "--no-frame-pacing", "--no-game-optimization", "--video-decoder", "hardware"]`；为 `false` 时附加 `["--vsync", "--frame-pacing", "--video-decoder", "auto"]`。
7. `resolveStreamAppTarget(preferred: StreamAppTarget, availableApps: string[]): StreamAppTarget`：
   - 若 `preferred === "Desktop"`，直接返回 `"Desktop"`；
   - 若 `preferred === "Virtual Display"` 且 `availableApps` 中包含 `"Virtual Display"`（忽略大小写）则返回 `"Virtual Display"`；
   - 若 `availableApps` 为空（探查超时/失败）或不包含 `"Virtual Display"`（主机未装虚拟屏应用），统一保守回退为 `"Desktop"`，确保连接不被未知应用名阻断。

---

## 四、窗口追踪、热重载会话与顶部悬浮控制条设计

### 4.1 窗口位置与客户区追踪器（`apps/desktop/electron/services/windowTracker.ts`）
不引入原生 C++ 编译依赖（无需 `node-gyp` / Visual Studio Build Tools），每个活跃会话只常驻 **1 个** 隐藏的 PowerShell Win32 辅助进程（零每帧创建子进程开销）：

1. **启动机制**：`spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", trackerScript], { windowsHide: true })`，传入目标 `Moonlight.exe` PID。
2. **Win32 API（`Add-Type` 一次性编译驻留内存）**：
   - `GetWindowRect`：获取窗口外框屏幕物理像素坐标 `(left, top, right, bottom)`。
   - `GetClientRect`：获取客户区物理宽高 `(clientWidth, clientHeight)`，用于「适应窗口大小」。
   - `IsWindowVisible`、`IsIconic`、`GetForegroundWindow`：判断窗口是否可见、是否最小化、是否处于焦点。
3. **心跳与事件流**：每 `150ms` 检测目标主窗口句柄（`MainWindowHandle != 0` 且标题/尺寸有效），仅当坐标或状态发生变化时向 stdout 输出一行 JSON（减少 IPC 抖动）；若 PID 已退出，自动退出辅助进程。
4. **热键注入通道（stdin 指令）**：
   - 主进程向辅助进程 stdin 写入 `HOTKEY:FULLSCREEN`（`Ctrl+Alt+Shift+X`）、`HOTKEY:PERF`（`Ctrl+Alt+Shift+S`）或 `HOTKEY:MOUSE`（`Ctrl+Alt+Shift+Z`）。
   - 辅助进程先将 `Moonlight` 主窗口前置聚焦（`SetForegroundWindow`），再通过 `keybd_event` / `SendInput` 精确发送按下与抬起序列（使用扫描码 + `KEYEVENTF_KEYUP` 保证 SDL/Qt 可靠识别）。

### 4.2 会话生命周期与热重载管理（`apps/desktop/electron/services/streamSessionManager.ts`）
`StreamSessionManager` 为单例会话协调器（位于 Electron 主进程）：

1. **会话启动 `startSession(device, initialRouteType, latencyMs)`**：
   - 若已有其他设备活跃会话，先优雅关闭旧会话（停止旧 Moonlight 与 `WindowTracker`，保留或重建悬浮条）。
   - 查询 `fetchAvailableApolloApps(device.mesh_ip)`（优先复用 `probeRemoteApolloPermission` 使用的客户端证书请求 `/applist`，超时 2000ms，失败则返回 `[]`）。
   - 解析 `resolvedApp`，根据当前 `store.get().preset` 与 `routeType` 启动 `Moonlight.exe`（保留 `ChildProcess` 引用以便生命周期跟踪与热重载退出，不设 `detached: true`）。
   - 创建/显示 `FloatingBarWindow`（初始位置停靠在主屏顶部居中，待 `WindowTracker` 捕获到 `Moonlight` HWND 后立即平滑贴合至远程窗口顶部居中）。
2. **无重启秒切 vs 参数热重载**：
   - **0ms 无重连切换**：从 `windowed` ↔ `fullscreen` 切换时，先通过 `WindowTracker` 发送 `HOTKEY:FULLSCREEN`（`Ctrl+Alt+Shift+X`），同步更新 `preset.displayMode`；`performance-overlay` 与鼠标锁定同理优先提供快捷键入口。
   - **无缝参数热重载（1～2 秒）**：当修改 `resolution`、`fps`、`bitrateMbps`、`codec`、`streamApp`、`muteHostAudio`、`lowLatency`、`absoluteMouse`、`captureSystemKeys` 或切换至 `borderless` 时：
     - 标记 `reconnecting = true` 并广播状态到悬浮条（界面呈现“正在应用新参数并重连...”微提示，**悬浮条不关闭**）；
     - 优雅终止当前 `Moonlight.exe`（`child.kill()` 并等待退出，最长 2000ms 超时强杀）；
     - 以新 `StreamPreset` 重新拉起 `Moonlight.exe` 并重新绑定 `WindowTracker` 到新 PID；
     - 同步通过 `store.update({ preset })` 持久化最新用户选择。
   - **一键「适应窗口大小」**：读取当前 `windowRect.clientWidth` 和 `windowRect.clientHeight`，经 `normalizeWindowResolution` 计算偶数分辨率，更新 `preset.resolution` 并强制 `streamApp = "Virtual Display"`（若主机支持），触发热重载使远端虚拟屏分辨率与当前本地窗口 1:1 像素对齐。
3. **自动跟随节点刷新**：主进程 `syncAll()` 每次刷新 EasyTier `peers` 延迟与路由类型（`p2p` / `relay`）时，同步更新 `StreamSessionManager` 中的 `routeType` 与 `latencyMs` 供悬浮条实时展示。
4. **干净退出**：用户点击 Moonlight 窗口右上角 `×` 退出，或点击悬浮条「断开」，或主应用退出时，立即终止 `WindowTracker`、关闭 `FloatingBarWindow`、清理所有定时器。

### 4.3 顶部悬浮工具栏窗口与交互（`floatingBarWindow.ts` + `SessionBar.tsx`）
1. **无边框透明置顶窗体（`floatingBarWindow.ts`）**：
   - `frame: false`、`transparent: true`、`resizable: false`、`skipTaskbar: true`、`focusable: true`（收起态点击后不抢占必要操作时迅速交互，展开调节完可一键焦点回归远程窗口）、`alwaysOnTop` 设 `"screen-saver"` 级别（保证在无边框全屏或窗口模式下稳定浮在 Moonlight 之上）。
   - **多 DPI 精准贴边计算**：使用 Electron `screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })` 将 Win32 物理像素坐标转为 DIP 逻辑坐标，将悬浮条水平居中（加上用户拖动的 `offsetX`）贴在远程窗口顶部边缘下方 `4px` 处，并钳制在对应显示器的 `workArea` 范围内。
   - 当 Moonlight 最小化（`minimized: true`）时隐藏悬浮条；恢复时重新显示。当 `WindowTracker` 连续 3 秒未找到窗口或处于独占全屏兼容兜底时，悬浮条停靠于主显示器顶部居中。
2. **双态尺寸与 UI（`apps/desktop/src/components/SessionBar.tsx`）**：
   - 渲染路由：`src/main.tsx` 检查 `window.location.hash === "#session-bar"`，若匹配则移除深色不透明背景（设置透明根背景）并直接渲染 `<SessionBar />`，否则渲染主窗口 `<App />`。
   - **收起态胶囊（`250 x 36` DIP，半透明磨砂暗色）**：
     - 拖拽把手（支持按住左右拖动 `offsetX`，避免挡住远程浏览器标签栏）；
     - 绿色状态点 + 设备名 + 链路延迟标签（如 `Think · 中继 34ms`）；
     - 快捷图标：展开面板 / 一键窗口↔全屏 / 断开会话。
   - **展开态控制面板（`560 x 450` DIP）**：
     - **区块 1 · 窗口与显示**：显示模式三选一（窗口 / 无边框 / 全屏）、串流源（虚拟屏 / 桌面）、「适应窗口分辨率」按钮、分辨率快捷档位（`720P` / `1080P` / `2K` / `4K` / 当前窗口尺寸）、刷新率（`30` / `60` / `120` / `144`）、码率滑块（`4～80 Mbps`）、编码器（`H.265` / `H.264` / `AV1`）。
     - **区块 2 · 手感、音频与办公模式**：
       - 「低延迟零缓冲」开关（去 V-Sync + 抗分片）；
       - 「被控端静音」开关（仅本地出声，远程不外放）；
       - 「鼠标模式」（绝对桌面 / 相对游戏）+ 「系统快捷键穿透」切换；
       - 「性能监控浮层」开关；
       - **「切换办公模式（0ms 本地光标）」** 高亮按钮（一键切至自建 RustDesk）。
     - **区块 3 · 常用操作与后续能力入口**：
       - 立即生效快捷操作：释放/切换鼠标锁定、性能监控、断开连接、关闭悬浮条（保留连接）；
       - 明确标注并预留阶段 2/3 入口位置（多屏切换、访问密码锁、防窥隐私屏、拖拽/快捷键传文件，置灰提示“即将支持”，确保 UI 结构一次定型）。

---

## 五、主界面联动改造（`DevicesView` & `HostModeView` & `preload/bridge`）

1. **`DevicesView.tsx`**：
   - 顶部控制栏保留 3 个快捷画质档位，并新增：
     - **显示模式切换**（默认高亮 `窗口模式`，支持直接选 `窗口` / `无边框` / `全屏`）；
     - **串流画面源切换**（`虚拟屏(推荐)` / `物理桌面`）；
     - **被控端静音** & **低延迟抗分片** 状态小开关。
   - 设备卡片：
     - 当目标设备为 `relay` 中继且预设码率 > 15 Mbps 或帧率 > 60 时，在卡片上展示温和提示标签（如“中继链路已启用 60Hz 低延迟保护”）；
     - 若设备已绑定 `rustdesk_id`，操作区提供清晰的 **「办公模式 (0ms光标)」** 按钮（替换原先隐晦的“运维/文件”文案，同时保留运维说明）。
2. **`HostModeView.tsx`**：
   - 在主卡片与高级设置间新增独立卡片 **「办公极速光标通道（自建 RustDesk）」**：
     - 展示是否已安装 RustDesk、当前读取到的 `RustDesk ID`、以及是否已同步自建中继/公钥；
     - 未安装时提供「一键安装并接入团队中继」；已安装时提供「一键同步自建配置」提示与说明，让用户只需点击一次即可打通 `rustdesk_id` 上报，供其他设备随时切入 0ms 光标办公模式。
3. **IPC 通道扩展（`electron/main.ts` & `electron/preload.ts` & `src/bridge.ts`）**：
   - 新增会话相关 IPC：
     - `session:getState` -> `ActiveSessionState | null`
     - `session:updateOptions` -> 更新部分 `StreamPreset` 并触发热重载或秒切
     - `session:fitWindow` -> 按当前远程窗口尺寸对齐远端分辨率
     - `session:toggleFullscreen` -> 窗口/全屏快速切换
     - `session:sendHotkey` -> `"fullscreen" | "perf" | "mouse"`
     - `session:switchOfficeMode` -> 关闭当前 Moonlight 会话并启动 RustDesk 直连目标设备
     - `session:disconnect` -> 断开当前会话
     - `session:setBarExpanded` / `session:setBarOffset` -> 控制悬浮条尺寸与水平偏移
     - `session:stateChanged` -> 主进程主动推送给主窗口与悬浮条的会话状态事件。
   - `src/bridge.ts` 同步更新 `previewState` 与 `previewFallback`，确保 `npm run build` 在纯浏览器预览模式与 Electron 环境下均通过严格 TypeScript 检查。

---

## 六、边界与错误处理策略

1. **老配置兼容**：`StateStore.load()` 对缺失新字段的旧 `silkwarp-state.json` 调用 `normalizeStreamPreset()`，保证升级覆盖安装后原登录态、设备 ID、已配对表与旧预设无缝保留。
2. **热重载防重入与防僵尸进程**：`StreamSessionManager` 内对连续快速点击修改参数做 `300ms` 节流防抖与互斥锁保护，确保前一次 `Moonlight.exe` 彻底退出后再拉起新实例，避免同时出现多个重连窗口；`app.on("before-quit")` 强制销毁 `WindowTracker` 与 `FloatingBarWindow`。
3. **Win32 追踪兜底**：若目标主机系统或高权限全屏窗口导致 `WindowTracker` 暂时无法获取 `Moonlight.exe` 窗口句柄，`FloatingBarWindow` 自动降级停靠到主显示器顶部居中，用户依然可正常展开并断开或切换模式。
4. **办公模式前置校验**：点击「办公模式」前检查目标设备 `rustdesk_id` 是否存在，若目标主机尚未启用 RustDesk 则弹出清晰提示，引导在被控端「本机受控」页一键安装同步，不抛未捕获异常。

---

## 七、测试与验收方案

1. **自动化单元测试**：
   - 新增 `apps/desktop/scripts/test_stream_options.cjs`（使用 `node:test`）：
     - 覆盖 `normalizeStreamPreset`（旧版 4 字段迁移、非法值兜底）；
     - 覆盖 `normalizeWindowResolution`（边界钳制、奇数转偶数对齐）；
     - 覆盖 `resolvePacketSize`（`p2p` 1200、`relay(2)` 1024、自定义数值钳制）；
     - 覆盖 `computeEffectivePreset`（中继默认钳制 60fps / 15Mbps、`adaptiveRelayCap: false` 后解除钳制）；
     - 覆盖 `buildMoonlightStreamArgs`（验证 `--display-mode windowed`、`--no-vsync`、`--no-frame-pacing`、`--no-audio-on-host`、`--packet-size`、`--absolute-mouse`、`--performance-overlay` 与目标应用顺序）；
     - 覆盖 `resolveStreamAppTarget`（有 `Virtual Display` 优先选用、缺失时安全回退 `Desktop`）。
   - 回归既有测试：`node --test scripts/test_apollo_permissions.cjs` 与 `python -m unittest discover -s server/control-plane/tests -v`。
2. **构建与打包验证**：
   - `npm run build`（`tsc -p tsconfig.node.json && tsc --noEmit && vite build`）零错误零警告通过；
   - `npm run pack:win` 成功生成新版 `SilkWarp-Setup-2.0.2.exe`。
3. **实机验收标准（`Mobar` ↔ `Think`）**：
   - 点击连接默认以**可拖拽窗口**打开，自由拖动边框与最大化后画面比例正常；
   - 顶部悬浮条默认收起为半透明小胶囊并自动跟随窗口顶部移动，拖动胶囊可调整横向位置；
   - 在悬浮条内点击「适应窗口」、调整码率/帧率/编码器、切换被控端静音与性能监控，1～2 秒内完成重连生效；
   - 点击「全屏 / 窗口」切换快捷键生效顺畅；
   - 在中继环境下实测鼠标拖动、点击与文本选区跟手度相比旧版显著改善，且点击「办公模式」可一键拉起自建 RustDesk 实现 0ms 本地硬件光标操作。
