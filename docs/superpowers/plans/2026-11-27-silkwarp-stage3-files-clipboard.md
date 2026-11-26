# SilkWarp 阶段 3 实施计划：Mesh 直连文件传输与双向剪贴板

- **依据规格**：[`docs/superpowers/specs/2026-11-27-silkwarp-stage3-files-clipboard-design.md`](../specs/2026-11-27-silkwarp-stage3-files-clipboard-design.md)
- **日期**：2026-11-27
- **范围**：`apps/desktop/electron/services/`（校验层、传输路由、客户端扩展）与 `apps/desktop/scripts/`
- **拆分**：Part A（本计划，纯服务端 + 客户端核心）→ Part B（主进程接线、渲染层文件抽屉/拖拽、实机验收）

## 目标

1. 在既有 `HostAgentServer`（`0.0.0.0:19580`）上通过 `onExtraRoute` 挂载五条传输路由，不新增端口。
2. 上传/下载全程流式，2 GiB 文件不占 Node 堆内存；`.silkwarp.part` → 原子 `rename`。
3. 路径穿越净化、重名自动改名 `file (1).ext`、上传上限 2 GiB、剪贴板图片上限 10 MiB。
4. 双向剪贴板 `text` / `image` / `files`，SHA-256 指纹抑制回环。
5. 全部核心逻辑零 `electron` 依赖，`node --test` 直接加载 `dist-electron` 验证。

## 任务分解

| Task | 内容 | 涉及文件 | 状态 |
| :--- | :--- | :--- | :--- |
| A1 | 阶段 3 规格书：架构、API、路径安全、剪贴板协议、客户端设计 | `docs/superpowers/specs/2026-11-27-silkwarp-stage3-files-clipboard-design.md` | ✅ 已完成 |
| A2 | 阶段 3 实施计划（本文） | `docs/superpowers/plans/2026-11-27-silkwarp-stage3-files-clipboard.md` | ✅ 已完成 |
| A3 | 纯校验层：上限常量、剪贴板/文件类型、文件名净化、唯一路径、目录约束、SHA-256 指纹 | `electron/services/transferValidation.ts` | ✅ 已完成 |
| A4 | 传输路由：list / upload / download / clipboard GET+POST，流式落盘与 `.part` 生命周期 | `electron/services/hostTransferService.ts` | ✅ 已完成 |
| A5 | 客户端扩展：`listRemoteFiles` / `uploadFileStream` / `downloadFileStream` / `getRemoteClipboard` / `setRemoteClipboard` | `electron/services/hostAgentClient.ts` | ✅ 已完成 |
| A6 | 测试：单元 + 真实 HTTP 回环集成（鉴权、2 MB 上传、重名、下载、413、剪贴板、中断清理） | `scripts/test_stage3_transfer.cjs` | ✅ 已完成 |
| B1 | 主进程接线：`main.ts` 构造 `createHostTransferExtraRoute`，注入 Electron `clipboard` 适配器与接收目录 | `electron/main.ts`、`electron/services/clipboardSyncManager.ts` | ✅ 已完成 |
| B2 | 剪贴板轮询与回环抑制：主控端 `setInterval` 读本机剪贴板 → 指纹比对 → `setRemoteClipboard`；反向同理 | `electron/services/clipboardSyncManager.ts`、`electron/services/streamSessionManager.ts` | ✅ 已完成 |
| B3 | IPC / preload / bridge：`session:*` / `transfer:*` 通道、`webUtils.getPathForFile` 拖拽桥 | `electron/preload.ts`、`src/bridge.ts`、`electron/types.ts` | ✅ 已完成 |
| B4 | 渲染层：远端文件抽屉（roots 快捷入口、面包屑、上传/下载进度）、拖拽投放区、剪贴板开关 | `src/components/SessionBar.tsx`、`src/components/DevicesView.tsx` | ✅ 已完成 |
| B5 | 实机验收 + 全量回归 + 提交 | — | ✅ 自动化回归已完成 |

## Part A 实现摘要

### A3 `transferValidation.ts`

导出：

```ts
export const MAX_UPLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILENAME_LENGTH = 180;

export type ClipboardKind = "empty" | "text" | "image" | "files";
export interface ClipboardPayload { kind; text?; imageBase64?; files?; updatedAt }
export interface RemoteFileEntry { name; path; isDirectory; size; modifiedAt }
export interface RemoteRootDir { label; path }

export function sanitizeUploadFilename(raw: string): string;
export function resolveUniqueFilePath(dir, filename, existsFn?): string;
export function normalizeTargetDir(rawPath, defaultDir, allowedRoots?): string;
export function isSafeReadableSubpath(candidatePath, allowedRoots?): boolean;
export function isPathWithinRoot(candidate, root): boolean;
export function computeClipboardFingerprint(payload): string;
```

关键实现约束：

- `sanitizeUploadFilename`：百分号解码（失败原样保留）→ `trim` → 去 NUL → **`posix.basename` + `win32.basename` 双重剥离** → 控制字符 → `[<>:"/\\|?*]` 替换 `_` → 去尾部点/空格 → 空/`.`/`..` 回退 `unnamed.bin` → 180 字符截断且保留扩展名（含 `.tar.gz` 等复合扩展名）。
- `resolveUniqueFilePath`：原名优先，冲突后 `stem (1..9999).ext`；复合扩展名不被拆散。
- `normalizeTargetDir`：空回退默认目录；去 NUL；`path.resolve`；`allowedRoots` 存在时做**带分隔符**的前缀比较（`C:\recv-evil` 不得匹配 `C:\recv`），Windows 大小写不敏感，越界抛 `path_outside_allowed_roots`。
- `computeClipboardFingerprint`：`empty` 返回常量摘要；否则 `SHA-256(kind ‖ 0x00 ‖ 归一化内容)`；text CRLF→LF + trim，image 去空白，files trim/去空/排序。

### A4 `hostTransferService.ts`

```ts
export interface ClipboardAdapter {
  read: () => Promise<ClipboardPayload>;
  write: (payload: ClipboardPayload) => Promise<{ ok: boolean; kind: ClipboardKind; message?: string }>;
}

export interface HostTransferOptions {
  defaultReceiveDir?: string;   // 默认 ~/Desktop/SilkWarpRecv
  roots?: RemoteRootDir[];      // 默认 SilkWarpRecv + Desktop/Downloads/Documents（存在者）
  restrictToRoots?: boolean;    // 默认 false
  maxUploadBytes?: number;      // 默认 MAX_UPLOAD_FILE_BYTES
  clipboard: ClipboardAdapter;
  onFileReceived?: (info) => void;
  onRemoteClipboardUpdated?: (payload) => void;
}

export function createHostTransferExtraRoute(options: HostTransferOptions): NonNullable<HostAgentHandlers["onExtraRoute"]>;
```

路由行为：

- **list**：确保默认目录存在 → `normalizeTargetDir` → `readdir(withFileTypes)` + 逐项 `stat`（单条失败跳过）→ 目录优先 + 名称排序 → 截断 500 → 返回 `currentPath` / `parentPath` / `roots` / `entries`。
- **upload**：读 `x-silkwarp-filename`（缺失回退 query）与 `x-silkwarp-target-dir` → 解析并创建目标目录 → 声明 `Content-Length` 超限直接 `413` → `resolveUniqueFilePath` → 写 `<final>.silkwarp.part` → 逐块计数（超限则 `destroy` + `unlink` + 继续 drain）→ `end`/`finish` 后 `rename` → 回调 → `200`。所有失败路径清理 `.part`，Windows 上先等 `close` 再删。
- **download**：`isSafeReadableSubpath` → `stat`（404 / 非文件 400）→ 设置 `Content-Type` / `Content-Length` / RFC 5987 `Content-Disposition` → `createReadStream().pipe(res)`。
- **clipboard GET**：`clipboard.read()` → `200 { ok, payload }`。
- **clipboard POST**：`readJsonBody(16 MiB)` → `kind` 白名单 → image 必填且解码后 ≤ 10 MiB → `clipboard.write` → 回调 → `200 { ok, kind, message, fingerprint }`。

### A5 `hostAgentClient.ts`

新增（既有方法不变）：

```ts
listRemoteFiles(host, port, token, dirPath?)
uploadFileStream(host, port, token, localFilePath, { targetDir?, onProgress?, timeoutMs? })
downloadFileStream(host, port, token, remoteFilePath, localSavePath, { onProgress?, timeoutMs? })
getRemoteClipboard(host, port, token)
setRemoteClipboard(host, port, token, payload)
```

关键约束：

- 传输超时是 **socket 空闲超时**（默认 120 秒），不是整体时限；大文件持续传输不会误杀。
- 上传：`stat.size` 作为 `Content-Length` 与进度总数；`encodeURIComponent` 文件名/目标目录写入自定义头；`createReadStream().pipe(req)`；进度回调抛错时中止并包装为 `progress_callback_error`。
- 下载：先建目录，写 `<localSavePath>.part`，`finish` 后 `rename`；失败先等 write stream `close` 再 `unlink` `.part`。
- 非 2xx 统一解析错误体并抛 `AgentClientError`（`statusCode` / `code` / `retryAfterSec`）。

### A6 `test_stage3_transfer.cjs`

- 30 个用例，覆盖 4 组单元（净化/唯一/约束/指纹）+ 11 组 HTTP 集成（鉴权、上传、列表、下载、受限目录、超限、声明超限、中断清理、文件名来源、并发同名、剪贴板三态）。
- Windows 回环 SYN 丢失沿用阶段 2 的"换端口重试启动"规避；临时目录 `mkdtemp` 并 `test.after` 清理。

## Part B 实现摘要（已完成）

1. **`electron/services/clipboardSyncManager.ts`**（零顶层 `electron` import）
   - `MAX_CLIPBOARD_AUTO_FILES_BYTES = 50 MiB`；`createElectronClipboardAdapter(deps?)` 缺省时惰性 `require("electron")`；
   - Windows `CF_HDROP` 走 `powershell.exe -STA -NoProfile -NonInteractive -EncodedCommand`，脚本内 `Add-Type -AssemblyName System.Windows.Forms;`，JSON 行以 `<<<SILKWARP_CFILES>>>` / `<<<SILKWARP_END>>>` 分帧，超时 3000 ms；
   - `read()` 优先级：文件 → PNG 图片（≤10 MiB）→ 文本 → `empty`；
   - `ClipboardSyncManager`：`enabled` / `lastLocalFp` / `lastRemoteFp` / `lastKind` / `lastSyncedAt` / `lastError` / `inFlight`，`start()` 900 ms 轮询，`syncOnce()` 单飞，文件自动镜像受 50 MiB 约束，反向文件下载到 `~/Desktop/SilkWarpRecv` 并写回本地 `CF_HDROP`。
2. **`electron/services/streamSessionManager.ts`**：会话内持有 `ClipboardSyncManager` 与最近 12 条 `TransferTaskItem`；新增 `listRemoteFiles` / `uploadFiles` / `downloadRemoteFile` / `setClipboardSync` / `syncClipboardNow`，进度以 ~10 Hz 节流广播。
3. **`electron/main.ts`**：`onExtraRoute` 注入 `createHostTransferExtraRoute`，能力声明追加 `files` / `clipboard`；新增 `session:*` 与 `device:prepareAgent` / `transfer:*` IPC（无需视频会话即可传文件）。
4. **`preload.ts` / `src/bridge.ts`**：暴露 `webUtils.getPathForFile` 与全部 Stage 3 方法，预览模式提供完整内存态 mock。
5. **渲染层**：`SessionBar` 折叠/展开双形态拖放、剪贴板开关 + 立即同步 + 状态徽标、传输进度条、可折叠远程文件浏览器；`DevicesView` 新增「传文件」与 Mesh 文件快传模态框（复用访问密码弹窗）。
6. **测试**：`test_stage3_transfer.cjs` 增加 11 个剪贴板用例（文本/图片/文件双向回环抑制、50 MiB 跳过、反向下载、单飞锁、适配器优先级与超限拒绝）。

## 验证命令

```powershell
# apps/desktop
npx tsc -p tsconfig.node.json
node --test scripts/test_apollo_permissions.cjs scripts/test_stream_options.cjs scripts/test_host_agent.cjs scripts/test_host_system_control.cjs scripts/test_stage3_transfer.cjs

# 仓库根目录
python -m unittest discover -s server/control-plane/tests -v
```

## 边界与风险

- **磁盘写满**：`createWriteStream` 的 `error` 会走 `upload_failed` 并删 `.part`；但磁盘剩余空间无法预检，2 GiB 上限下需要主机至少同等空闲空间。
- **Windows 文件锁**：`.part` 的 `unlink` 必须等 write stream `close`；杀毒软件实时扫描也可能短暂占用，因此清理一律 `catch` 后继续，不因删除失败而改变响应。
- **受限模式的 `roots` 语义**：`roots` 同时用于 UI 快捷入口与 `restrictToRoots` 的边界；Part B 若允许用户自定义接收目录，需要同步更新 `roots`，否则受限模式下新目录会被拒绝。
- **剪贴板轮询成本**：800 ms 一次 `readText` 在 Windows 上开销可接受，但 `readImage` 对大图会做 PNG 编码；建议先读 `clipboard.availableFormats()` 判断是否含图片再编码。
- **指纹碰撞**：SHA-256 碰撞概率可忽略；真正的风险是"用户在两秒内复制了完全相同的内容"被误判为回环——这是可接受的取舍，避免为区分而引入时间戳（会让指纹失去确定性）。
- **`FileNameW` 解析**：Windows 文件列表是 UTF-16LE、`\0` 分隔、双 `\0` 结尾的缓冲区，Part B 需严格按此解析，并过滤不存在/无权限的路径。
- **进度粒度**：`data` 事件粒度取决于 socket 高水位（约 64 KiB），千兆链路上约每 0.5 ms 一次；渲染层需节流到 ~10 Hz，否则 IPC 会被进度消息淹没。
