# SilkWarp 阶段 3 设计规格书：Mesh 直连文件传输与双向剪贴板

- **日期**：2026-11-27
- **状态**：Part A + Part B 已落地（阶段 3 / 共 3 阶段）
- **适用范围**：`apps/desktop/`（Electron 主进程、Host Companion Agent 扩展、渲染层桥接）
- **依赖前置**：阶段 2 的 `HostAgentServer` / `HostAgentClient` / Bearer 鉴权 / `onExtraRoute` 扩展钩子

---

## 一、背景与目标

阶段 2 已经让被控端具备主机侧控制面（显示器、静音、隐私幕布、系统动作），但主控端与被控端之间仍然无法交换**文件**与**剪贴板**——这正是日常远程办公里使用频率最高的两项操作。传统的 Moonlight 串流链路只承载视频/音频/输入，不提供文件通道；RustDesk 的文件传输又绑定在它自己的会话里，无法与 Apollo 高刷串流并存。

阶段 3 在阶段 2 的 Host Companion Agent 之上增加一条**与串流链路完全解耦的 Mesh 直连数据面**：主控端通过 `10.144.0.x` 内网 HTTP 直接与被控端 Agent 交换原始二进制与剪贴板载荷，不经过 Apollo、不占用视频带宽、不要求建立新的会话。

### 1.1 阶段目标

1. **Mesh 直连原始二进制流式传输**：上传/下载都以 `stream` 方式在 socket 与磁盘之间搬运，2 GiB 文件不进入 Node 堆内存。
2. **零额外部署**：复用阶段 2 已在 `0.0.0.0:19580` 监听的 `HostAgentServer`，通过 `onExtraRoute` 钩子挂载新路由，不新增端口、不新增服务。
3. **安全边界延续**：所有新路由天然继承 Mesh CIDR 守卫与 Bearer Token 鉴权；路径穿越在服务端做规范化与根目录约束。
4. **可靠落盘**：上传先写 `.silkwarp.part` 再原子 `rename`；重名自动改名为 `file (1).ext`，绝不覆盖既有文件；任何失败路径都清理临时文件。
5. **双向剪贴板**：文本 / PNG 图片 / 文件列表三种载荷双向同步，用 SHA-256 指纹抑制两端互相回写造成的回环风暴。
6. **可测试性**：所有核心逻辑零 `electron` 依赖，`node --test` 可直接加载编译产物做单元 + 真实 HTTP 集成测试。

### 1.2 非目标

- 不做公网暴露、NAT 穿透或中继；文件通道只服务 Mesh 网段。
- 不做断点续传、分片并发、多文件打包；单请求单文件。
- 不做文件系统实时监听（inotify/`ReadDirectoryChangesW`）；列表按需拉取。
- 不在本阶段接入渲染层 UI（文件抽屉/拖拽面板属于 Part B）。
- 不改变阶段 1/2 既有 API、端口、鉴权语义与数据库表结构。

---

## 二、总体架构

```
┌──────────────────────────── 被控端 Windows ────────────────────────────┐
│  SilkWarp Electron 主进程                                               │
│  ┌────────────────────────┐   ┌──────────────────────────────────────┐ │
│  │ HostAgentServer        │──▶│ hostTransferService                  │ │
│  │ 0.0.0.0:19580          │   │  files/list · upload · download      │ │
│  │ Mesh 守卫 + Bearer     │   │  clipboard GET/POST                  │ │
│  │ onExtraRoute ──────────┼──▶│  transferValidation（纯函数）         │ │
│  └────────────────────────┘   └───────────────┬──────────────────────┘ │
│                                               │ fs.createWriteStream    │
│                                    SilkWarpRecv/xxx.silkwarp.part       │
│                                               │ rename                  │
│                                    SilkWarpRecv/xxx.bin                 │
└─────────────────────────────────────────────────────────────────────────┘
              ▲ Mesh 10.144.0.0/24 · HTTP/1.1 · Bearer Token
┌─────────────┴──────────────────────────── 主控端 ──────────────────────┐
│  HostAgentClient                                                         │
│   listRemoteFiles / uploadFileStream / downloadFileStream                │
│   getRemoteClipboard / setRemoteClipboard                                │
│   渲染层：webUtils.getPathForFile 拖拽桥 + 剪贴板指纹去重                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 模块边界

| 模块 | 职责 | 是否依赖 Electron |
| :--- | :--- | :--- |
| `electron/services/transferValidation.ts` | 文件名净化、唯一路径分配、根目录约束、剪贴板指纹 | 否（Node `path` / `fs` / `crypto`） |
| `electron/services/hostTransferService.ts` | 五条路由的流式实现、`.part` 生命周期、剪贴板读写适配 | 否（Node `fs` / `os` / `path`） |
| `electron/services/hostAgentServer.ts` | 既有 Mesh 守卫 + Bearer 鉴权 + `onExtraRoute` 分发 | 否 |
| `electron/services/hostAgentClient.ts` | 主控端类型化客户端，新增四个传输方法 | 否 |
| `electron/preload.ts` / `src/bridge.ts` | 渲染层拖拽路径桥（`webUtils.getPathForFile`） | 是（`webUtils`） |

前四个模块刻意不引入 `electron`，编译产物可直接被 `node --test` 加载。

---

## 三、HTTP API 设计

所有路由都位于 `HostAgentServer` 已鉴权的 `/api/agent/*` 命名空间下，由 `onExtraRoute` 在 Bearer 校验**之后**接管；未匹配的路由返回 `false`，交回内置路由处理。

### 3.1 `GET /api/agent/files/list`

| 参数 | 位置 | 说明 |
| :--- | :--- | :--- |
| `path` | query | 目标目录绝对路径；缺省为 `defaultReceiveDir` |

响应 `200`：

```json
{
  "ok": true,
  "currentPath": "C:\\Users\\Roger\\Desktop\\SilkWarpRecv",
  "parentPath": "C:\\Users\\Roger\\Desktop",
  "roots": [
    { "label": "接收文件夹", "path": "C:\\Users\\Roger\\Desktop\\SilkWarpRecv" },
    { "label": "桌面", "path": "C:\\Users\\Roger\\Desktop" }
  ],
  "entries": [
    { "name": "sub", "path": "...\\sub", "isDirectory": true, "size": 0, "modifiedAt": 1764200000000 },
    { "name": "report.pdf", "path": "...\\report.pdf", "isDirectory": false, "size": 524288, "modifiedAt": 1764200000000 }
  ]
}
```

实现约束：

1. 首次调用先 `fs.mkdirSync(defaultReceiveDir, { recursive: true })`，保证空机器上也有可浏览目录。
2. `readdir(..., { withFileTypes: true })` 后逐项 `stat`，**单条 `stat` 失败（Windows 系统文件、权限拒绝、瞬时删除）只跳过该项**，不让整份列表失败。
3. 排序：目录优先，其次按名称小写字母序（同名再按原串），保证跨平台稳定。
4. 单次最多返回 **500** 条，超出截断。
5. `parentPath` 在受限模式下若父目录越出允许根目录，则返回 `null`。

### 3.2 `POST /api/agent/files/upload`

| 请求头 | 必填 | 说明 |
| :--- | :--- | :--- |
| `x-silkwarp-filename` | 否 | URL 编码 UTF-8 文件名；缺失时回退 query `filename`，再缺失用 `unnamed.bin` |
| `x-silkwarp-target-dir` | 否 | URL 编码目标目录；缺省 `defaultReceiveDir` |
| `Content-Length` | 否 | 若声明且超过上限，**在读取正文前**直接 `413` |

请求体：原始二进制（`application/octet-stream`），不要求 multipart。

成功 `200`：

```json
{ "ok": true, "filename": "report.pdf", "path": "C:\\...\\SilkWarpRecv\\report.pdf", "size": 524288 }
```

失败：

| 状态 | `error` | 触发条件 |
| :--- | :--- | :--- |
| `403` | `path_outside_allowed_roots` | 受限模式下目标目录越界 |
| `413` | `file_too_large` | 声明或实际字节数超过 `maxUploadBytes` |
| `400` | `upload_failed` | 客户端中断、磁盘写入失败、rename 失败 |

**流式落盘协议**（核心）：

```
req stream ──chunk──▶ 累计字节数
                        │ > maxUploadBytes ?
                        │   是 → destroy writeStream + unlink .part + 继续 drain 剩余请求体
                        ▼
                fs.createWriteStream("<final>.silkwarp.part")
                        │ 背压 write() === false
                        ▼
                   await drain
                        │ req 'end'
                        ▼
             writeStream.end() → await 'finish'
                        ▼
          fs.promises.rename(".part", final)  ← 原子替换
                        ▼
        onFileReceived({ filename, path, size }) → 200 JSON
```

关键点：

- **内存占用恒定**：不 `Buffer.concat` 请求体，内存只与 socket 高水位有关。
- **不覆盖**：目标名先经 `resolveUniqueFilePath` 分配，重名落到 `stem (n).ext`。
- **失败即清理**：`aborted` / `error` / 超限 / rename 失败全部 `destroy` 后 `unlink` `.part`；Windows 上必须等 write stream `close` 再 `unlink`，否则文件仍被句柄占用。
- **超限仍 drain**：检测到超限后继续消费剩余请求体，让客户端能把请求写完并收到 `413`，避免连接被 RST 导致客户端只看到网络错误。
- **原子可见性**：下载端永远不会读到半截文件，因为最终名只在 `rename` 之后出现。

### 3.3 `GET /api/agent/files/download`

| 参数 | 位置 | 说明 |
| :--- | :--- | :--- |
| `path` | query | 必填，远端文件绝对路径 |

响应：

- `Content-Type: application/octet-stream`
- `Content-Length: <stat.size>`
- `Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent(basename)>`（RFC 5987，中文名不乱码）
- 正文：`fs.createReadStream(resolved).pipe(res)`

错误：`400 path_required` / `403 path_outside_allowed_roots` / `404 file_not_found` / `400 not_a_file`（目录）。

### 3.4 `GET /api/agent/clipboard`

响应 `200 { ok: true, payload: ClipboardPayload }`；适配器异常返回 `500 clipboard_read_failed`。

### 3.5 `POST /api/agent/clipboard`

请求体（JSON，上限 16 MiB，为 10 MiB 图片的 base64 膨胀留余量）：

```json
{ "kind": "text" | "image" | "files", "text": "...", "imageBase64": "...", "files": ["C:\\a.txt"] }
```

校验顺序：

1. `kind` 必须是 `text` / `image` / `files`（`empty` 是只读状态，客户端不可写入）→ 否则 `400 invalid_clipboard_kind`。
2. `kind === "image"` 时 `imageBase64` 必填 → 否则 `400 image_required`。
3. 解码后的图片字节数 `> MAX_CLIPBOARD_IMAGE_BYTES` → `413 clipboard_image_too_large`。
4. 调用 `clipboard.write(payload)`；适配器异常 → `500 clipboard_write_failed`。

响应 `200 { ok, kind, message?, fingerprint }`，`fingerprint` 由服务端计算后回传，客户端用它做回环抑制。

---

## 四、路径安全

### 4.1 文件名净化 `sanitizeUploadFilename`

按顺序执行：

1. 非字符串 → `unnamed.bin`。
2. 若包含 `%` 尝试 `decodeURIComponent`，**失败则原样保留**（`50% off.txt` 不应报错）。
3. `trim()`，去掉 NUL。
4. **双 basename**：先 `path.posix.basename` 再 `path.win32.basename`——前者剥 `/`，后者剥 `\`，缺一不可（只做一次会漏掉另一种分隔符）。
5. 删除控制字符 `\x00-\x1f`。
6. 将 `[<>:"/\\|?*]` 替换为 `_`。
7. 删除结尾的 `.` 与空格（Windows 上 `report.` 无法创建）。
8. 空 / `.` / `..` → `unnamed.bin`。
9. 长度上限 **180** 字符：优先保留扩展名（含 `.tar.gz` 等复合扩展名），截断主名后再去尾部点/空格。

示例：

| 输入 | 输出 |
| :--- | :--- |
| `..\..\evil:file?.txt` | `evil_file_.txt` |
| `../../../../etc/passwd` | `passwd` |
| `测试报告 (终版).pdf` | `测试报告 (终版).pdf`（原样保留） |
| `report...   ` | `report` |

### 4.2 唯一路径 `resolveUniqueFilePath`

先试原名；被占用则依次尝试 `stem (1).ext` … `stem (9999).ext`。`existsFn` 可注入，单测无需真实磁盘。复合扩展名（`.tar.gz`）保持完整：`archive (1).tar.gz`。

### 4.3 目录约束 `normalizeTargetDir`

1. 去 NUL、`trim`；空则用 `defaultDir`。
2. `path.resolve` 得到绝对路径。
3. 若提供 `allowedRoots`：解析后的路径必须**等于**某根目录或**严格位于其下**（`root + sep` 前缀比较，Windows 大小写不敏感），否则抛 `Error("path_outside_allowed_roots")`。

前缀比较必须带分隔符，否则 `C:\recv-evil` 会被误判为 `C:\recv` 的子路径。

### 4.4 `restrictToRoots` 的默认值

**默认 `false`**。SilkWarp 的定位是"团队 Mesh 内的可信远程控制"，远程用户本来就能通过桌面看到并操作全部磁盘；把文件通道限制在几个目录内会直接废掉"把文件传到 `D:\项目`"这类核心用法。

- 生产（被控端桌面端）：`restrictToRoots: false`，`roots` 仅作为 UI 快捷入口展示。
- 单元测试 / 受控部署：`restrictToRoots: true`，越界一律 `403`。

真正的安全边界是 **Mesh CIDR + Bearer Token**，路径约束是纵深防御而非主防线。

---

## 五、剪贴板协议

### 5.1 载荷格式

```ts
export type ClipboardKind = "empty" | "text" | "image" | "files";

export interface ClipboardPayload {
  kind: ClipboardKind;
  text?: string;          // kind === "text"
  imageBase64?: string;   // kind === "image"，PNG 原始字节的 base64
  files?: string[];       // kind === "files"，绝对路径列表
  updatedAt: number;      // epoch ms
}
```

| kind | 语义 | 备注 |
| :--- | :--- | :--- |
| `empty` | 剪贴板为空或不可读 | 只由 `read()` 产生，客户端不可 `POST` |
| `text` | 纯文本 | 保留换行；指纹计算时 CRLF 归一为 LF |
| `image` | PNG 图片 | 上限 10 MiB（解码后），避免 4K 截图把内存打满 |
| `files` | 文件路径列表 | 只传路径，不传内容；实际传输走 `files/upload` |

### 5.2 SHA-256 指纹与回环抑制

双向剪贴板最典型的事故是**回环风暴**：

```
主控端写入 → 主机剪贴板变化 → 主机上报 → 主控端应用 → 主控端剪贴板变化 → 主控端上报 → ...
```

抑制机制：

1. 任一端应用远端载荷前，先算 `computeClipboardFingerprint(payload)`。
2. 与"最近一次由本端写入的指纹"比较；相同则丢弃，不再回写。
3. 服务端在 `POST /api/agent/clipboard` 的响应里回传同一指纹，客户端以此为准记录，避免两端各自实现导致的不一致。

指纹定义：

```
kind === "empty"  → SHA-256("silkwarp:clipboard:empty")   （常量）
否则              → SHA-256( kind ‖ 0x00 ‖ 归一化内容 )
  text  ：CRLF/CR → LF，trim
  image ：去掉所有空白字符后的 base64
  files ：逐项 trim、去空、排序后用 0x00 连接
```

性质：

- **确定性**：同样的逻辑内容永远得到同样的 64 位小写 hex。
- **种类隔离**：`kind` 参与摘要，文本 `"abc"` 与文件名列表 `["abc"]` 不会碰撞。
- **顺序无关**：文件列表顺序不同、base64 换行不同都视为相同。
- **空态常量**：`empty` 恒为同一指纹，便于客户端初始化。

### 5.3 Electron 35 拖拽桥

Electron 32 起，`File.path` 被移除；Electron 35 必须使用 `webUtils.getPathForFile(file)`：

```ts
// preload.ts
import { contextBridge, webUtils } from "electron";

contextBridge.exposeInMainWorld("silkwarpDrop", {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
});
```

渲染层在 `drop` / 文件选择后调用该桥取得绝对路径，再交给主进程 `uploadFileStream`。**绝不在渲染层读取文件内容**——`File` 对象经 IPC 传输会被整体序列化，大文件直接 OOM；只传路径，由主进程用 `fs.createReadStream` 流式读取。

---

## 六、客户端设计（`hostAgentClient.ts`）

### 6.1 新增方法

```ts
listRemoteFiles(host, port, token, dirPath?): Promise<{
  currentPath: string;
  parentPath: string | null;
  roots: RemoteRootDir[];
  entries: RemoteFileEntry[];
}>;

uploadFileStream(host, port, token, localFilePath, opts?: {
  targetDir?: string;
  onProgress?: (p: { transferred: number; total: number }) => void;
  timeoutMs?: number;
}): Promise<{ ok: boolean; filename: string; path: string; size: number }>;

downloadFileStream(host, port, token, remoteFilePath, localSavePath, opts?: {
  onProgress?: (p: { transferred: number; total: number }) => void;
  timeoutMs?: number;
}): Promise<{ ok: boolean; path: string; size: number }>;

getRemoteClipboard(host, port, token): Promise<{ ok: boolean; payload: ClipboardPayload }>;

setRemoteClipboard(host, port, token, payload): Promise<{
  ok: boolean; kind: ClipboardKind; message?: string; fingerprint?: string;
}>;
```

### 6.2 上传实现要点

- `fs.promises.stat` 取 `size` 作为 `Content-Length` 与进度总数；非普通文件直接拒绝。
- `x-silkwarp-filename: encodeURIComponent(path.basename(...))`；`targetDir` 存在时同法编码进 `x-silkwarp-target-dir`。
- `fs.createReadStream(localFilePath).pipe(req)`，在 `data` 事件累计 `transferred` 并回调 `onProgress`。
- **不设整体超时**：2 GiB 在千兆 Mesh 上需要 ~20 秒到数分钟，`timeoutMs` 是 **socket 空闲超时**（默认 120 秒），只要还在传就不会触发。
- 错误统一包装为 `AgentClientError`（`statusCode` / `code` / `retryAfterSec`），与阶段 2 保持一致。

### 6.3 下载实现要点

- 先 `mkdir -p` 目标目录，写入 `<localSavePath>.part`。
- 非 2xx：读完错误体后解析 JSON 错误码，**不创建 `.part`**。
- 成功：`res.pipe(writeStream)`，`finish` 后 `rename` 到最终路径；进度总数取 `Content-Length`（缺失时为 `0`，表示未知）。
- 失败（响应中断 / 写盘失败 / 进度回调抛错）：先等 write stream `close` 再 `unlink` `.part`，Windows 上否则删不掉。

---

## 七、错误处理与边界

| 场景 | 行为 |
| :--- | :--- |
| 请求体超 16 MiB（剪贴板） | `HostAgentServer.readJsonBody` 抛 `request_body_too_large` → `413 body_too_large` |
| 上传超限 | `413 file_too_large`，`.part` 必删，连接正常关闭 |
| 客户端中断上传 | `aborted` / `error` → 删除 `.part`，不写最终文件 |
| 目标目录无权限 | `ensureDirectory` 抛错 → `400`，不创建 `.part` |
| 列表遇到系统文件 | 单条 `stat` 失败静默跳过，其余正常返回 |
| 下载目录/不存在 | `400 not_a_file` / `404 file_not_found` |
| 文件名含 NUL / 穿越 | 净化或拒绝，永不落到根目录之外 |
| 剪贴板适配器异常 | `500 clipboard_read_failed` / `clipboard_write_failed` |
| 回调抛错 | `onFileReceived` / `onRemoteClipboardUpdated` 的异常被吞掉，不影响已完成的传输 |

---

## 八、测试与验收

### 8.1 自动化（`apps/desktop/scripts/test_stage3_transfer.cjs`）

**单元测试（`transferValidation`）**

1. 文件名净化：穿越、盘符冒号、非法字符、UTF-8 中文、百分号解码、空/点/点点、180 字符上限、复合扩展名。
2. 唯一路径：`report (1).txt` / `report (2).txt`、无扩展名、`.tar.gz`、可注入 `existsFn`。
3. 目录约束：空值回退、根内接受、越界抛错、兄弟前缀不误判、NUL 剥离。
4. 指纹：稳定性（trim/CRLF）、种类区分、文件排序无关、空态常量。

**HTTP 集成（真实回环 + `HostAgentClient`）**

1. 未鉴权访问 list / upload / download / clipboard → 全部 `401`。
2. 2 MB 随机二进制 + 中文文件名上传 → 磁盘 SHA-256 完全一致、进度回调触发、重复上传自动 ` (1)` / ` (2)` 且不覆盖。
3. `listRemoteFiles` 名称/大小/目录优先排序/`roots` 准确。
4. `downloadFileStream` 下载回新路径 → SHA-256 字节级一致、进度触发、`.part` 已消失。
5. 超限上传 → `413` 且接收目录为空（无孤儿 `.part`）；恰好等于上限仍成功。
6. 声明 `Content-Length` 超限 → 读体前 `413`。
7. 剪贴板 text / image（1×1 PNG base64）/ files 往返；超 10 MiB 图片 `413`；非法 `kind` `400`；指纹与服务端一致。
8. 中断上传 → 无残留 `.part`。
9. 文件名来源兼容：query `filename`（含 `%`）与未编码自定义头（`50% off.txt`）都不得被二次解码。
10. 5 个同名文件并发上传 → 各自落到 `same-name (n).bin`，无覆盖、无 `.part` 残留。

### 8.2 验证命令

```powershell
# apps/desktop
npx tsc -p tsconfig.node.json
node --test scripts/test_apollo_permissions.cjs scripts/test_stream_options.cjs `
  scripts/test_host_agent.cjs scripts/test_host_system_control.cjs `
  scripts/test_stage3_transfer.cjs

# 仓库根目录
python -m unittest discover -s server/control-plane/tests -v
```

### 8.3 实机验收（Part B 后）

1. 主控端拖入 1 GB ISO，进度条平滑推进，主机 `SilkWarpRecv` 出现文件且可正常打开。
2. 同名文件再次拖入，生成 `xxx (1).iso`，原文件未被覆盖。
3. 传输中断网，主机侧无 `.part` 残留。
4. 主控端 `Ctrl+C` 一段中文文本，主机剪贴板可粘贴；主机复制图片，主控端可粘贴且无回环抖动。
5. 拖拽 5 个文件，主机收到 5 个独立文件与剪贴板文件列表。
