# SilkWarp 阶段 1 实施计划：窗口化 / 悬浮控制条 / 低延迟鼠标调优 / 办公模式

- **依据规格**：[`docs/superpowers/specs/2026-11-27-silkwarp-stage1-ux-design.md`](../specs/2026-11-27-silkwarp-stage1-ux-design.md)
- **日期**：2026-11-27
- **范围**：仅 `apps/desktop/`（Electron 主进程、preload 桥接、React 渲染层），不触碰 `server/control-plane/` 协议与表结构。

## 目标

1. 默认以**可拖拽窗口**打开 Moonlight 会话，支持窗口 / 无边框 / 全屏三种显示模式。
2. 顶部**透明置顶悬浮控制条**：会话内实时调参（分辨率 / 帧率 / 码率 / 编码器 / 静音 / 低延迟）、适应窗口、秒切全屏、断开。
3. **4+1 鼠标手感调优**：自动 `--packet-size`（消除 Wintun MTU 分片）、`--no-vsync --no-frame-pacing`、中继自适应护栏（60fps / 15Mbps）、虚拟屏 1:1 匹配、办公模式（RustDesk 0ms 本地光标）。
4. 主界面（设备页 / 被控页）联动：显示模式快捷开关、中继保护徽章、办公模式按钮、RustDesk 极速光标通道卡片。

## 任务分解

| Task | 内容 | 涉及文件 |
| :--- | :--- | :--- |
| T0 | Apollo 权限修复独立提交（前置已完成项） | `electron/services/apolloPermissions.ts`、`hostManager.ts`、`streamLauncher.ts`、`main.ts`、`scripts/test_apollo_permissions.cjs` |
| T1 | 扩展类型：`DisplayMode`、`StreamAppTarget`、`SystemKeyCaptureMode`、`SessionHotkeyAction`、完整 `StreamPreset`、`WindowRect`、`ActiveSessionState` | `electron/types.ts` |
| T2 | 纯逻辑参数模块（零 electron 依赖，可被 `node --test` 直接加载） | `electron/services/streamOptions.ts` |
| T3 | 状态存储迁移：`load()` / `update()` 全部走 `normalizeStreamPreset` | `electron/services/store.ts` |
| T4 | 启动器扩展：`fetchAvailableApolloApps`、`spawnMoonlightStreamProcess`，保留 `launchMoonlightStream` 兼容入口 | `electron/services/streamLauncher.ts` |
| T5 | Win32 窗口追踪器（单常驻 PowerShell 辅助进程 + C# P/Invoke + 热键注入） | `electron/services/windowTracker.ts` |
| T6 | 顶部透明置顶悬浮条窗口（多 DPI 贴边、双态尺寸、锚点跟随） | `electron/services/floatingBarWindow.ts` |
| T7 | 会话协调器（启动 / 热重载 / 防抖串行锁 / 秒切全屏 / 遥测 / 办公模式 / 断开） | `electron/services/streamSessionManager.ts` |
| T8 | 主进程 / preload / bridge 对接全部 `session:*` IPC 与类型 | `electron/main.ts`、`electron/preload.ts`、`src/bridge.ts` |
| T9 | 渲染层：`#session-bar` 路由、`SessionBar.tsx`、`DevicesView.tsx`、`HostModeView.tsx` | `src/main.tsx`、`src/components/*` |
| T10 | 单元测试 | `scripts/test_stream_options.cjs` |
| T11 | 构建 + 全部测试 + 提交 | — |

## 核心接口

### `streamOptions.ts`（纯函数，无 Electron 依赖）

```ts
export const DEFAULT_STREAM_PRESET: StreamPreset;
export function normalizeStreamPreset(raw?: Partial<StreamPreset> | null): StreamPreset;
export function normalizeWindowResolution(width: number, height: number): string;
export function resolvePacketSize(preset: StreamPreset, routeType: string): number;
export function computeEffectivePreset(preset: StreamPreset, routeType: string): StreamPreset;
export function resolveStreamAppTarget(preferred: StreamAppTarget, availableApps: string[]): StreamAppTarget;
export function buildMoonlightStreamArgs(
  meshIp: string,
  preset: StreamPreset,
  routeType: string,
  resolvedApp: StreamAppTarget,
): string[];
```

关键约束：

- `resolution` 校验 `/^\d{3,4}x\d{3,4}$/`，非法回退 `"2560x1440"`；
- `fps` 仅允许 `30 | 60 | 120 | 144`；
- `bitrateMbps` 取整钳制 `[4, 100]`；
- `packetSize` 为 `"auto"` 或 `[512, 1320]` 整数；
- 中继护栏：`adaptiveRelayCap && routeType.startsWith("relay")` → `fps ≤ 60`、`bitrateMbps ≤ 15`（仅影响本次命令行，不改持久化预设）；
- 参数顺序：全部 `--option` 在前，末尾 `"stream", meshIp, resolvedApp`。

### `windowTracker.ts`

```ts
export class WindowTracker {
  constructor(targetPid: number, callbacks: { onRect: (rect: WindowRect) => void; onExit: () => void });
  sendHotkey(action: SessionHotkeyAction): void;  // FULLSCREEN / PERF / MOUSE
  focusTarget(): void;
  stop(): void;
}
```

单常驻 `powershell.exe`（`-NoProfile -ExecutionPolicy Bypass -EncodedCommand`，UTF-16LE base64），脚本内 `Add-Type` 编译 C# P/Invoke；每 150ms 轮询窗口矩形，仅在变化时输出 JSON 单行；非 Windows 平台安全降级为空操作。

### `floatingBarWindow.ts`

```ts
export class FloatingBarWindow {
  updateAnchor(winRect: WindowRect | null): void;
  setExpanded(expanded: boolean): void;
  nudgeOffset(deltaX: number): void;
  sendSessionState(state: ActiveSessionState | null): void;
  destroy(): void;
}
```

尺寸：收起 `290x38`，展开 `580x470`；`transparent + frame:false + alwaysOnTop("screen-saver")`；`screen.screenToDipRect` 处理多 DPI；水平居中 + `offsetX` 后钳制进 `workArea`。

### `streamSessionManager.ts`

```ts
export class StreamSessionManager {
  constructor(store: StateStore, onStateChange: (state: ActiveSessionState | null) => void);
  getState(): ActiveSessionState | null;
  startSession(device: DeviceInfo, routeType: string, latencyMs: number | null): Promise<ActiveSessionState>;
  updateOptions(patch: Partial<StreamPreset>): Promise<ActiveSessionState | null>;
  fitToWindow(): Promise<ActiveSessionState | null>;
  toggleFullscreen(): Promise<ActiveSessionState | null>;
  sendHotkey(action: SessionHotkeyAction): void;
  focusRemoteWindow(): void;
  updateTelemetry(peers: PeerStatus[]): void;
  switchToOfficeMode(bootstrap: BootstrapConfig): Promise<void>;
  disconnect(): Promise<void>;
}
```

热重载策略：

- `windowed ↔ fullscreen` 且已有 `WindowTracker`：发送 `HOTKEY:FULLSCREEN` 秒切（0ms，不重连）；
- 其余参数变化：`250ms` 防抖 + 串行锁，置 `reconnecting = true` → 广播 → 终止旧 `Moonlight.exe`（等待 ≤2000ms）→ 重新探测应用 → 新进程 → 重新绑定 tracker → 广播；
- 用户显式调高 `fps > 60` 或 `bitrateMbps > 15` 且未显式传 `adaptiveRelayCap` 时，自动关闭 `adaptiveRelayCap`。

### IPC 清单（`main.ts` ↔ `preload.ts` ↔ `bridge.ts`）

| 通道 | 方向 | 说明 |
| :--- | :--- | :--- |
| `session:getState` | invoke | 返回 `ActiveSessionState \| null` |
| `session:updateOptions` | invoke | 更新部分预设并热重载 / 秒切 |
| `session:fitWindow` | invoke | 按当前远程窗口客户区对齐远端分辨率 |
| `session:toggleFullscreen` | invoke | 窗口 / 全屏快速切换 |
| `session:sendHotkey` | invoke | `"fullscreen" \| "perf" \| "mouse"` |
| `session:focusRemote` | invoke | 将远程窗口置前 |
| `session:switchOfficeMode` | invoke | 断开 Moonlight 并拉起 RustDesk |
| `session:disconnect` | invoke | 结束会话 |
| `session:setBarExpanded` | invoke | 悬浮条展开 / 收起 |
| `session:setBarOffset` | invoke | 悬浮条水平偏移 |
| `session:stateChanged` | send | 主进程 → 主窗口 / 悬浮条 |

## 验证命令

```powershell
# apps/desktop
npm run build
node --test scripts/test_apollo_permissions.cjs
node --test scripts/test_stream_options.cjs

# 仓库根目录
python -m unittest discover -s server/control-plane/tests -v
```

## 边界与风险

- 老 `silkwarp-state.json` 仅含 4 字段预设：由 `normalizeStreamPreset` 无缝补齐。
- `WindowTracker` 拿不到 HWND（独占全屏 / 高权限窗口）：悬浮条降级停靠主屏顶部居中。
- 目标主机无 `"Virtual Display"` 应用：`resolveStreamAppTarget` 自动回退 `"Desktop"`，不阻断连接。
- 热重载并发点击：防抖 + 串行锁 + 旧进程退出等待，避免多窗口。
- `before-quit` / `app:relaunchAdmin` 前强制 `sessionManager.disconnect()`，避免僵尸 `Moonlight.exe` 与 PowerShell 辅助进程。
