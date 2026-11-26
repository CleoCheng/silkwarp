# SilkWarp 阶段 2 实施计划：被控端伴侣代理（Host Companion Agent）

- **依据规格**：[`docs/superpowers/specs/2026-11-27-silkwarp-stage2-host-agent-design.md`](../specs/2026-11-27-silkwarp-stage2-host-agent-design.md)
- **日期**：2026-11-27
- **范围**：`server/control-plane/`（设备元数据）与 `apps/desktop/`（Agent 服务、主机控制、隐私幕布、主进程接线）
- **拆分**：Part A（已完成并测试）→ Part B1（已完成：主机控制与隐私幕布底层）→ Part B2（主进程接线与渲染层 UI）

## 目标

1. 被控端内嵌 Host Companion Agent，监听 `0.0.0.0:19580`，仅服务 Mesh 网段。
2. Mesh CIDR 守卫 + Bearer Token + 5 次失败/60 秒限速 + 同账号免密 + 永久/6 位临时密码。
3. 主机侧能力：多显示器枚举与 Apollo `output_name` 切换、Core Audio 主静音、防窥幕布、六类系统动作、断开自动锁屏。
4. 控制平面新增 `has_access_password` / `agent_port`，老库幂等迁移，老客户端缺省回退 `19580`。

## 任务分解

| Task | 内容 | 涉及文件 | 状态 |
| :--- | :--- | :--- | :--- |
| A1 | 设备表新增 `has_access_password` / `agent_port`，老库 `ALTER TABLE` 幂等迁移，心跳缺省保留语义 | `server/control-plane/db.py` | ✅ 已完成 |
| A2 | 控制平面回归测试：默认值、心跳往返/保留、非法端口忽略、老库迁移 | `server/control-plane/tests/test_control_plane.py` | ✅ 已完成 |
| A3 | 认证原语：IP 归一化、CIDR、PBKDF2 永久密码、6 位临时密码、同账号绕过、5 次/60 秒限速、8 小时令牌 | `electron/services/hostAgentAuth.ts` | ✅ 已完成 |
| A4 | Agent HTTP 服务：Mesh 守卫、公开 info/auth、Bearer 保护路由、64 KiB 请求体限制、可扩展路由钩子 | `electron/services/hostAgentServer.ts` | ✅ 已完成 |
| A5 | 主控端类型化客户端：info/auth/displays/audio/privacy/system/session | `electron/services/hostAgentClient.ts` | ✅ 已完成 |
| A6 | Agent 单元 + 集成测试（真实 HTTP 回环） | `scripts/test_host_agent.cjs` | ✅ 已完成 |
| B1.1 | 主机系统控制：显示器枚举/解析、虚拟屏识别、主静音 COM、六类系统动作、`runEncodedPowerShell` | `electron/services/hostSystemControl.ts` | ✅ 已完成 |
| B1.2 | 隐私幕布：多屏黑窗 + `setContentProtection` + `Ctrl+Alt+Shift+P` 本机救援 + 显示器热插拔跟随 | `electron/services/privacyScreenManager.ts` | ✅ 已完成 |
| B1.3 | 防火墙新增 `SilkWarp-Agent-TCP` 19580，`checkFirewallConfigured` 双规则校验；Apollo `output_name` 读取/整份写回 | `electron/services/hostManager.ts` | ✅ 已完成 |
| B1.4 | 主机控制测试：解析/识别/动作脚本 + Windows 只读实机枚举与静音读取 | `scripts/test_host_system_control.cjs` | ✅ 已完成 |
| B2.1 | 主进程生命周期：按配置启停 `HostAgentServer`、`AgentAuthManager`、`PrivacyScreenManager`，实现全部 handlers | `electron/main.ts`、`electron/types.ts`、`electron/services/store.ts` | 待办 |
| B2.2 | 主机端设置持久化：永久密码哈希、临时密码与过期时间、同账号免密开关、自动锁屏开关 | `electron/services/store.ts`、`electron/types.ts` | 待办 |
| B2.3 | 心跳上报 `has_access_password` / `agent_port`，bootstrap 读取并回退 `19580` | `electron/services/controlClient.ts`、`electron/main.ts` | 待办 |
| B2.4 | IPC + preload + bridge + 渲染层：主机控制面板（密码、显示器、静音、隐私、系统动作）与会话内入口 | `electron/main.ts`、`electron/preload.ts`、`src/bridge.ts`、`src/components/*` | 待办 |
| B2.5 | 全量验证 + 实机验收 + 提交 | — | 待办 |

## Part A 实现摘要（已完成）

### A1/A2 控制平面

- `devices` 建表新增：
  - `has_access_password INTEGER NOT NULL DEFAULT 0`
  - `agent_port INTEGER NOT NULL DEFAULT 19580`
- `_migrate_device_columns()` 在每次打开数据库时检查 `PRAGMA table_info(devices)`，缺失列才 `ALTER TABLE`，重复执行幂等。
- `heartbeat_device()`：
  - `has_access_password` 缺省保留旧值，显式传值按布尔写入；
  - `agent_port` 仅接受 `1024..65535` 的整数（`bool` 排除），非法值保留旧值。
- 测试覆盖：bootstrap 默认值、心跳往返、缺省保留、`agent_port=80` 被忽略、设备列表透出、老库两次打开迁移幂等。

### A3 认证

- `DEFAULT_AGENT_PORT = 19580`。
- `normalizeIpAddress()`：zone id、IPv4-mapped、`::1`。
- `isIpInCidr()`：纯 IPv4 位运算，非法输入返回 `false`。
- `hashAccessPassword()` / `verifyAccessPassword()`：`pbkdf2_sha512$120000$salt$hash`，16 字节盐 / 32 字节密钥 / 120000 次迭代。
- `generateTempAccessPassword()`：`crypto.randomInt(100000, 1000000)`。
- `AgentAuthManager`：可注入时钟；滚动 60 秒窗口；5 次失败锁定 60 秒；成功清空失败记录；令牌 TTL 8 小时；`revokeAllTokens()`。

### A4 服务

- `HostAgentServer.start(host, port)` 幂等；`stop()` 幂等并释放端口。
- 路由：`GET /api/agent/info`、`POST /api/agent/auth` 公开（仍受 Mesh 守卫）；其余 `/api/agent/*` 需要 Bearer。
- 请求体上限 64 KiB；超限 `413`；非对象 JSON `400`。
- `onExtraRoute` 钩子允许阶段 3 直接接管流式上传，不破坏内置路由。

### A5 客户端

- `HostAgentClient` 统一把非 2xx / 传输错误包装为 `AgentClientError`（`statusCode`、`code`、`retryAfterSec`）。
- `probeInfo` 默认 2.5 秒超时，其余请求 5 秒。

### A6 测试

- `scripts/test_host_agent.cjs` 覆盖 CIDR、哈希、限速、令牌过期、真实 HTTP 回环全链路、错误体校验、流式 `onExtraRoute`。
- Windows 回环偶发 SYN 丢失通过测试内重试规避（生产代码不加重试）。

## Part B1 实施细节（已完成）

### B1.1 `hostSystemControl.ts`

纯函数（可被 Node 直接测试）：

```ts
export function isVirtualMonitorDescriptor(
  friendlyName: string,
  deviceId: string,
  driverString?: string,
): boolean;

export function parseMonitorLines(raw: string): DisplayMonitorInfo[];

export function buildSystemActionScript(action: SystemActionType): {
  powershell?: string;
  exe?: string;
  args?: string[];
  directUnsupportedMessage?: string;
};

export function runEncodedPowerShell(script: string, timeoutMs?: number): Promise<string>;
```

异步主机操作：

```ts
export function listHostDisplays(): Promise<DisplayMonitorInfo[]>;
export function getHostMasterMute(): Promise<boolean>;
export function setHostMasterMute(muted: boolean): Promise<boolean>;
export function runHostSystemAction(
  action: SystemActionType,
): Promise<{ ok: boolean; message: string }>;
```

关键约束：

- 零 `electron` 依赖；仅 `node:child_process` 与 `./hostAgentServer` 类型。
- PowerShell 统一走 `runEncodedPowerShell`：`-NoProfile -NonInteractive -EncodedCommand`（UTF-16LE base64），前置 `$ProgressPreference='SilentlyContinue'` 与 UTF-8 输出编码。
- 显示器枚举使用 C# `EnumDisplayMonitors` + `EnumDisplayDevices` + `GetMonitorInfo`，输出 `<<<SILKWARP_MONITORS>>> ... <<<SILKWARP_END>>>`。
- 主静音 C# COM vtable 槽位严格按 `IAudioEndpointVolume` 顺序声明，`finally` 中释放全部 COM 对象，输出 `<<<SILKWARP_MUTE:true|false>>>`。
- `sas` 先检查 `SoftwareSASGeneration` 策略，再调用 `sas.dll!SendSAS`，输出 `<<<SILKWARP_SAS:OK|DENIED>>>`，被拒绝时返回可读中文建议。
- `taskmgr` 直接 `taskmgr.exe`；`reboot` / `shutdown` 使用 `shutdown.exe` 带 2 秒延迟与中文注释。
- 非 Windows：`listHostDisplays()` 返回 `[]`，静音读写返回 `false`，动作返回“仅支持 Windows 被控端”。

### B1.2 `privacyScreenManager.ts`

```ts
export class PrivacyScreenManager {
  active: boolean;
  windows: BrowserWindow[];
  onLocalEscape?: () => void;
  isSupported(): boolean;
  isActive(): boolean;
  enable(onLocalEscape?: () => void): { active: boolean; supported: boolean; message?: string };
  disable(): { active: boolean; supported: boolean };
  dispose(): void;
}
```

关键约束：

- 仅 Windows 支持；非 Windows 返回 `supported: false`。
- 每个显示器一个黑窗，`setContentProtection(true)`（`WDA_EXCLUDEFROMCAPTURE`）、`setAlwaysOnTop(true, "screen-saver")`、`setIgnoreMouseEvents(true)`、`focusable: false`、`skipTaskbar: true`。
- 主屏底部居中暗灰提示文案：`隐私保护防窥幕布已开启 · 本机按 Ctrl+Alt+Shift+P 可随时恢复显示`。
- 全局快捷键 `CommandOrControl+Alt+Shift+P` 注册失败不阻断幕布，只在 `message` 中说明。
- 监听 `display-added` / `display-removed` / `display-metrics-changed` 重建幕布。
- `disable()` 幂等：注销快捷键、移除监听、销毁全部窗口。

### B1.3 `hostManager.ts`

- `checkFirewallConfigured()`：`SilkWarp-Apollo-TCP` 与 `SilkWarp-Agent-TCP` 两条 `netsh` 查询都成功才返回 `true`。
- `configureWindowsFirewall()`：清理并重建四条规则，新增：
  `SilkWarp-Agent-TCP -Direction Inbound -Protocol TCP -LocalPort 19580 -RemoteAddress '<cidr>' -Action Allow`。
- `getApolloOutputName(user, pass, port = 47990)`：`GET /api/config` → `String(json.output_name || "")`。
- `setApolloOutputName(outputName, user, pass, port = 47990)`：
  1. `GET /api/config`，校验对象；
  2. 克隆并删除 `status`、`status_code`、`version`、`platform`、`has_session`、`login_pin`；
  3. `output_name = outputName`；
  4. `POST /api/config` 整份提交；
  5. 返回 `{ ok, message }`。

### B1.4 `test_host_system_control.cjs`

- `parseMonitorLines`：多显示器合法载荷、物理/虚拟识别、空/坏标记/坏 JSON。
- `isVirtualMonitorDescriptor`：六个关键词 + 大小写 + 三字段来源。
- `buildSystemActionScript`：六个动作逐一断言 powershell/exe/args/标记。
- Windows 实机：`listHostDisplays()` 至少 1 个宽高 > 0 的显示器；`getHostMasterMute()` 返回布尔（只读，不调用 `setHostMasterMute`）。

## Part B2 实施步骤（待办）

1. **类型与存储**（`electron/types.ts`、`electron/services/store.ts`）：
   - `HostAgentSettings`：`enabled`、`requireAccessPassword`、`permanentPasswordHash`、`tempPassword`、`tempPasswordExpiresAt`、`allowSameAccountBypass`、`autoLockOnDisconnect`、`agentPort`；
   - `normalizeHostAgentSettings()` 兼容旧 `silkwarp-state.json`，默认 `enabled: true`、`agentPort: 19580`、`autoLockOnDisconnect: true`。
2. **主进程生命周期**（`electron/main.ts`）：
   - 启动时创建 `AgentAuthManager` + `HostAgentServer`，Mesh CIDR 来自 bootstrap；`allowLoopback` 生产为 `false`；
   - handlers 绑定 `listHostDisplays` / `getHostMasterMute` / `setHostMasterMute` / `PrivacyScreenManager` / `runHostSystemAction`；
   - `selectDisplay`：调用 `setApolloOutputName(display.friendlyName, ...)`，返回 `restartRecommended`；
   - `onSessionEnded`：按 `autoLockOnDisconnect` 执行锁屏，恢复静音与幕布；
   - 退出前 `server.stop()`、`privacy.dispose()`、`auth.revokeAllTokens()`。
3. **控制平面上报**（`electron/services/controlClient.ts`、`electron/main.ts`）：
   - 心跳附带 `has_access_password` 与 `agent_port`；
   - bootstrap 读取 `device.agent_port ?? 19580`、`device.has_access_password ?? false`。
4. **IPC / preload / bridge / UI**：
   - `hostAgent:getState` / `hostAgent:setPassword` / `hostAgent:generateTempPassword` / `hostAgent:listDisplays` / `hostAgent:selectDisplay` / `hostAgent:setMute` / `hostAgent:setPrivacy` / `hostAgent:runAction`；
   - 主机控制卡片：密码开关、临时密码倒计时、显示器列表、静音/防窥开关、六个系统动作按钮（重启/关机二次确认）。
5. **验证**：`npx tsc -p tsconfig.node.json`、全部 `node --test`、`python -m unittest discover -s server/control-plane/tests -v`、实机验收。

## 验证命令

```powershell
# apps/desktop
npx tsc -p tsconfig.node.json
node --test scripts/test_apollo_permissions.cjs scripts/test_stream_options.cjs scripts/test_host_agent.cjs scripts/test_host_system_control.cjs

# 仓库根目录
python -m unittest discover -s server/control-plane/tests -v
```

## 边界与风险

- **PowerShell 启动成本**：显示器枚举与静音每次约 0.5～2 秒，Agent 路由应避免高频轮询；UI 侧做缓存与手动刷新。
- **COM vtable 脆弱性**：`IAudioEndpointVolume` 槽位顺序一旦写错会调用到错误方法，测试只做只读校验，写静音需实机验证。
- **防窥幕布与独占全屏**：`WDA_EXCLUDEFROMCAPTURE` 在部分老显卡/远程协议下可能退化为 `WDA_MONITOR`，实机验收需确认采集侧看到真实画面。
- **Apollo 整份配置写回**：若 Apollo 版本新增只读字段，需同步扩充剥离列表，否则可能 400。
- **防火墙提权**：非管理员时仍走 `Start-Process -Verb RunAs`，用户取消 UAC 会抛错，UI 需提示。
- **端口冲突**：19580 被占用时 Agent 启动失败，应降级为“本机控制不可用”并提示修改 `agentPort`。
