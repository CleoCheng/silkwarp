import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  AudioLines,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ClipboardCheck,
  ClipboardCopy,
  Crosshair,
  File as FileIcon,
  Folder,
  FolderOpen,
  Gauge,
  Keyboard,
  Layers,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Monitor,
  MonitorOff,
  MousePointer2,
  Power,
  Radio,
  RefreshCw,
  Unplug,
  Upload,
  Wifi,
  Zap,
} from "lucide-react";
import { getBridge } from "../bridge";
import type {
  ActiveSessionState,
  ClipboardKind,
  DisplayMode,
  RemoteFileListing,
  ResolutionMode,
  StreamAppTarget,
  StreamPreset,
  SystemActionType,
  SystemKeyCaptureMode,
  TransferTaskItem,
} from "../../electron/types";

const RESOLUTION_PRESETS: Array<{ label: string; value: string }> = [
  { label: "720P", value: "1280x720" },
  { label: "1080P", value: "1920x1080" },
  { label: "2K", value: "2560x1440" },
  { label: "4K", value: "3840x2160" },
];

const FPS_PRESETS: Array<StreamPreset["fps"]> = [30, 60, 120, 144];

function resolutionBadgeLabel(preset: StreamPreset): string {
  if (preset.resolutionMode === "follow_client") return "跟随主控端";
  if (preset.resolutionMode === "follow_host") return "跟随被控端";
  if (preset.resolutionMode === "fit_window") return "适应窗口";
  const matched = RESOLUTION_PRESETS.find((r) => r.value === preset.resolution);
  return matched ? matched.label : preset.resolution.replace("x", "×");
}

function routeLabel(routeType: string): string {
  const r = routeType.toLowerCase();
  if (r.startsWith("relay")) return "私有中继";
  if (r === "p2p") return "极速直连";
  if (r === "local") return "局域网";
  return routeType || "连接中";
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-white/10 bg-black/25 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
            value === opt.value ? "bg-sky-400/90 text-slate-950" : "text-slate-300 hover:text-white"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span>
        <span className="block text-[11px] font-semibold text-slate-200">{label}</span>
        {hint && <span className="block text-[10px] text-slate-500">{hint}</span>}
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
          checked ? "bg-sky-400" : "bg-slate-600"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
      {icon}
      {children}
    </div>
  );
}

const SYSTEM_ACTION_LABELS: Record<SystemActionType, string> = {
  lock: "锁屏",
  show_desktop: "显示桌面",
  taskmgr: "任务管理器",
  sas: "Ctrl+Alt+Del",
  repair_ime: "修复输入法",
  reboot: "重启",
  shutdown: "关机",
};

const SYSTEM_ACTION_ORDER: SystemActionType[] = [
  "lock",
  "show_desktop",
  "taskmgr",
  "sas",
  "reboot",
  "shutdown",
];

const CONFIRM_TIMEOUT_MS = 4000;

const CLIPBOARD_KIND_LABELS: Record<ClipboardKind, string> = {
  empty: "空",
  text: "文本",
  image: "图片",
  files: "文件",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Resolves an OS path for a dropped `File`, falling back to the legacy `.path`. */
function resolveDroppedPath(bridge: ReturnType<typeof getBridge>, file: File): string {
  try {
    const resolved = bridge.getPathForFile(file);
    if (resolved) return resolved;
  } catch {
    // webUtils is unavailable outside Electron; fall through to `.path`.
  }
  return (file as { path?: string }).path || "";
}

function collectDroppedPaths(bridge: ReturnType<typeof getBridge>, data: DataTransfer | null): string[] {
  if (!data) return [];
  const paths: string[] = [];
  for (const file of Array.from(data.files)) {
    const resolved = resolveDroppedPath(bridge, file);
    if (resolved) paths.push(resolved);
  }
  return paths;
}

/**
 * `dragenter`/`dragover` expose the payload only through `types`; `files` is
 * empty until `drop`, and some sources omit the `Files` entry entirely, so both
 * are accepted.
 */
function isFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (data.files.length > 0) return true;
  return Array.from(data.types).includes("Files");
}

function TransferRow({ task }: { task: TransferTaskItem }) {
  const percent =
    task.total > 0 ? Math.min(100, Math.round((task.transferred / task.total) * 100)) : task.status === "done" ? 100 : 0;
  const statusClass =
    task.status === "done"
      ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
      : task.status === "error"
        ? "border-red-400/30 bg-red-500/10 text-red-200"
        : "border-sky-400/30 bg-sky-500/10 text-sky-200";
  const statusLabel = task.status === "done" ? "完成" : task.status === "error" ? "失败" : `${percent}%`;

  return (
    <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {task.direction === "upload" ? (
          <ArrowUpFromLine className="h-3 w-3 shrink-0 text-sky-300" />
        ) : (
          <ArrowDownToLine className="h-3 w-3 shrink-0 text-emerald-300" />
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-slate-200" title={task.filename}>
          {task.filename}
        </span>
        <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${statusClass}`}>
          {task.status === "running" && <Loader2 className="mr-0.5 inline h-2 w-2 animate-spin" />}
          {statusLabel}
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-all ${
            task.status === "error" ? "bg-red-400" : task.status === "done" ? "bg-emerald-400" : "bg-sky-400"
          }`}
          style={{ width: `${task.status === "error" ? 100 : percent}%` }}
        />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-[9px] text-slate-500">
        <span>
          {formatBytes(task.transferred)} / {task.total > 0 ? formatBytes(task.total) : "未知大小"}
        </span>
        {task.message && <span className="max-w-[60%] truncate text-red-300">{task.message}</span>}
      </div>
    </div>
  );
}

function FileBrowser({
  bridge,
  notifyError,
}: {
  bridge: ReturnType<typeof getBridge>;
  notifyError: (message: string) => void;
}) {
  const [listing, setListing] = useState<RemoteFileListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function load(dirPath?: string) {
    setLoading(true);
    try {
      setListing(await bridge.listSessionFiles(dirPath));
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpload() {
    if (uploading) return;
    setUploading(true);
    try {
      await bridge.pickAndUploadSessionFiles(listing?.currentPath);
      await load(listing?.currentPath);
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {listing?.roots.map((root) => (
          <button
            key={root.path}
            type="button"
            onClick={() => void load(root.path)}
            className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold ${
              listing.currentPath === root.path
                ? "border-sky-400/60 bg-sky-400/15 text-sky-100"
                : "border-white/10 bg-black/20 text-slate-300 hover:text-white"
            }`}
          >
            {root.label}
          </button>
        ))}
        <button
          type="button"
          disabled={uploading}
          onClick={() => void handleUpload()}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-sky-400/40 bg-sky-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-200 hover:bg-sky-400/20 disabled:opacity-40"
        >
          {uploading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Upload className="h-2.5 w-2.5" />}
          选择文件上传
        </button>
      </div>

      <div className="flex items-center gap-1 text-[9px] text-slate-500">
        <button
          type="button"
          disabled={loading || !listing?.parentPath}
          onClick={() => listing?.parentPath && void load(listing.parentPath)}
          className="inline-flex items-center gap-0.5 rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-slate-300 hover:text-white disabled:opacity-30"
        >
          <ChevronLeft className="h-2.5 w-2.5" /> 上级目录
        </button>
        <span className="min-w-0 flex-1 truncate font-mono" title={listing?.currentPath}>
          {listing?.currentPath || "加载中…"}
        </span>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(listing?.currentPath)}
          className="rounded border border-white/10 bg-black/20 p-0.5 text-slate-300 hover:text-white disabled:opacity-40"
        >
          <RefreshCw className={`h-2.5 w-2.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-1">
        {!listing || listing.entries.length === 0 ? (
          <div className="px-2 py-2 text-center text-[9px] text-slate-500">
            {loading ? "正在读取远端目录…" : "此目录为空"}
          </div>
        ) : (
          listing.entries.map((entry) => (
            <div
              key={entry.path}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-white/5"
            >
              {entry.isDirectory ? (
                <Folder className="h-3 w-3 shrink-0 text-amber-300" />
              ) : (
                <FileIcon className="h-3 w-3 shrink-0 text-slate-400" />
              )}
              {entry.isDirectory ? (
                <button
                  type="button"
                  onClick={() => void load(entry.path)}
                  className="min-w-0 flex-1 truncate text-left text-[10px] text-slate-200 hover:text-sky-200"
                  title={entry.path}
                >
                  {entry.name}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[10px] text-slate-300" title={entry.path}>
                  {entry.name}
                </span>
              )}
              {!entry.isDirectory && (
                <>
                  <span className="shrink-0 text-[9px] text-slate-500">{formatBytes(entry.size)}</span>
                  <button
                    type="button"
                    onClick={() =>
                      void bridge
                        .downloadSessionFile(entry.path, entry.name)
                        .catch((err) => notifyError(err instanceof Error ? err.message : String(err)))
                    }
                    className="shrink-0 rounded border border-emerald-400/30 bg-emerald-500/10 px-1 py-0.5 text-[9px] font-semibold text-emerald-200 hover:bg-emerald-500/20"
                  >
                    下载到本地
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function SessionBar() {
  const bridge = useMemo(() => getBridge(), []);
  const [state, setState] = useState<ActiveSessionState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [draftBitrate, setDraftBitrate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<SystemActionType | null>(null);
  const [actionBanner, setActionBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);
  const [clipboardBusy, setClipboardBusy] = useState(false);
  const dragRef = useRef<{ lastX: number; moved: boolean } | null>(null);
  const dragDepthRef = useRef(0);
  const confirmTimerRef = useRef<number | null>(null);
  const bannerTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void bridge.getSessionState().then(setState);
    return bridge.onSessionChanged(setState);
  }, [bridge]);

  useEffect(() => {
    if (!state?.reconnecting) return;
    const timer = setInterval(() => setPulse((v) => !v), 600);
    return () => clearInterval(timer);
  }, [state?.reconnecting]);

  useEffect(() => {
    setDraftBitrate(null);
  }, [state?.preset.bitrateMbps]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
      if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    };
  }, []);

  function patchOptions(patch: Partial<StreamPreset>) {
    void bridge.updateSessionOptions(patch).then((next) => {
      if (next) setState(next);
    });
  }

  function applySession(next: ActiveSessionState | null) {
    if (next) setState(next);
  }

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    void bridge.setSessionBarExpanded(next);
  }

  function showBanner(ok: boolean, text: string) {
    setActionBanner({ ok, text });
    if (bannerTimerRef.current !== null) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => setActionBanner(null), 4000);
  }

  async function handleHostMute(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      applySession(await bridge.setSessionHostMute(next));
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePrivacy(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      applySession(await bridge.setSessionPrivacy(next));
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleAutoLock(next: boolean) {
    try {
      applySession(await bridge.setSessionAutoLock(next));
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRefreshDisplays() {
    if (busy) return;
    setBusy(true);
    try {
      applySession(await bridge.refreshSessionDisplays());
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectDisplay(displayId: string) {
    if (busy || displayId === state?.selectedDisplayId) return;
    setBusy(true);
    try {
      applySession(await bridge.selectSessionDisplay(displayId));
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSystemAction(action: SystemActionType) {
    if (busy) return;
    const guarded = action === "reboot" || action === "shutdown";
    if (guarded && pendingConfirm !== action) {
      setPendingConfirm(action);
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => setPendingConfirm(null), CONFIRM_TIMEOUT_MS);
      return;
    }
    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setPendingConfirm(null);
    setBusy(true);
    try {
      const res = await bridge.runSessionSystemAction(action);
      showBanner(res.ok, res.message);
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function startDrag(e: React.PointerEvent) {
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    e.preventDefault();
    dragRef.current = { lastX: e.screenX, moved: false };

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = ev.screenX - drag.lastX;
      if (Math.abs(dx) < 1) return;
      drag.lastX = ev.screenX;
      drag.moved = true;
      void bridge.nudgeSessionBarOffset(dx);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // --- Stage 3: OS drag-and-drop file transfer ---

  function handleDragEnter(e: React.DragEvent) {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!isFileDrag(e.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const paths = collectDroppedPaths(bridge, e.dataTransfer);
    if (paths.length === 0) {
      showBanner(false, "未能解析拖入文件的本地路径");
      return;
    }
    try {
      const tasks = await bridge.uploadSessionFiles(paths);
      const failed = tasks.filter((task) => task.status === "error");
      if (failed.length > 0) {
        showBanner(false, `${failed.length} 个文件上传失败：${failed[0].message || failed[0].filename}`);
      } else {
        showBanner(true, `已上传 ${tasks.length} 个文件到主机 SilkWarpRecv`);
      }
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    }
  }

  // --- Stage 3: clipboard sync controls ---

  async function handleClipboardToggle(next: boolean) {
    if (clipboardBusy) return;
    setClipboardBusy(true);
    try {
      applySession(await bridge.setSessionClipboardSync(next));
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setClipboardBusy(false);
    }
  }

  async function handleClipboardSyncNow() {
    if (clipboardBusy) return;
    setClipboardBusy(true);
    try {
      applySession(await bridge.syncSessionClipboardNow());
    } catch (err) {
      showBanner(false, err instanceof Error ? err.message : String(err));
    } finally {
      setClipboardBusy(false);
    }
  }

  function clipboardStatusBadge(state: ActiveSessionState): { text: string; className: string } {
    if (!state.clipboardSyncEnabled) {
      return { text: "已暂停", className: "border-white/10 bg-black/20 text-slate-400" };
    }
    if (state.clipboardError) {
      return {
        text: state.clipboardError.slice(0, 24),
        className: "border-red-400/30 bg-red-500/10 text-red-200",
      };
    }
    if (state.clipboardLastSyncAt) {
      return {
        text: `已同步 ${CLIPBOARD_KIND_LABELS[state.clipboardLastKind] ?? state.clipboardLastKind}`,
        className: "border-emerald-400/30 bg-emerald-500/10 text-emerald-200",
      };
    }
    return { text: "待同步", className: "border-white/10 bg-black/20 text-slate-400" };
  }

  const dragProps = {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: (e: React.DragEvent) => void handleDrop(e),
  };

  if (!state) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <div className="rounded-full border border-white/10 bg-[#101522]/90 px-4 py-1.5 text-[11px] text-slate-400 backdrop-blur-xl">
          正在连接远程桌面…
        </div>
      </div>
    );
  }

  const preset = state.preset;
  const route = routeLabel(state.routeType);
  const latency = state.latencyMs != null ? `${Math.round(state.latencyMs)}ms` : "--";
  const isFullscreen = preset.displayMode === "fullscreen";
  const cappedByRelay =
    preset.adaptiveRelayCap &&
    state.routeType.toLowerCase().startsWith("relay") &&
    (preset.fps > 60 || preset.bitrateMbps > 15);

  const statusDot = state.reconnecting ? (
    <span className={`h-2 w-2 rounded-full ${pulse ? "bg-amber-300" : "bg-amber-500/40"} transition-colors`} />
  ) : (
    <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
  );

  if (!expanded) {
    return (
      <div className="flex h-full w-full items-center bg-transparent px-1 py-1" {...dragProps}>
        <div
          className={`relative flex h-full w-full items-center gap-2 rounded-full border px-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-colors ${
            dragActive
              ? "border-sky-400/80 bg-sky-500/25 ring-2 ring-sky-400/60"
              : "border-white/10 bg-[#0d1220]/85"
          }`}
        >
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-1.5 rounded-full bg-[#0b1220]/95 text-[11px] font-bold text-sky-200">
              <Upload className="h-3.5 w-3.5" /> 拖放文件即发送到对方电脑
            </div>
          )}
          <button
            type="button"
            aria-label="拖动悬浮条"
            onPointerDown={startDrag}
            className="cursor-grab touch-none rounded px-0.5 text-slate-500 hover:text-slate-200 active:cursor-grabbing"
          >
            <span className="block h-3 w-1 rounded-full bg-current" />
          </button>

          {statusDot}

          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-100">
            {state.device.name}
            <span className="ml-1.5 font-normal text-slate-400">
              · {state.reconnecting ? "重连中" : route} {latency}
            </span>
          </span>

          <button
            type="button"
            onClick={toggleExpanded}
            title="点击展开调整分辨率、画面与键鼠设置"
            className="shrink-0 rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-medium text-slate-300 hover:border-sky-400/50 hover:text-sky-200"
          >
            {resolutionBadgeLabel(preset)}
          </button>

          {cappedByRelay && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-200">
              中继保护
            </span>
          )}

          <button
            type="button"
            aria-label={state.clipboardSyncEnabled ? "暂停双向剪贴板同步" : "开启双向剪贴板同步"}
            title={state.clipboardSyncEnabled ? "双向剪贴板同步已开启（点击暂停）" : "双向剪贴板同步已暂停（点击开启）"}
            onClick={() => void handleClipboardToggle(!state.clipboardSyncEnabled)}
            disabled={clipboardBusy || !state.agentConnected}
            className={`rounded-full p-1 disabled:opacity-40 ${
              state.clipboardSyncEnabled
                ? "bg-sky-400/20 text-sky-200 hover:bg-sky-400/30"
                : "text-slate-500 hover:bg-white/10 hover:text-slate-200"
            }`}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            aria-label={isFullscreen ? "退出全屏" : "进入全屏"}
            title={isFullscreen ? "退出全屏 (Ctrl+Alt+F)" : "进入全屏 (Ctrl+Alt+F)"}
            onClick={() => void bridge.toggleSessionFullscreen().then(applySession)}
            className="rounded-full p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>

          <button
            type="button"
            aria-label="展开设置"
            title="展开设置"
            onClick={toggleExpanded}
            className="rounded-full p-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            aria-label="断开连接"
            title="断开连接"
            onClick={() => void bridge.disconnectSession()}
            className="rounded-full p-1 text-slate-400 hover:bg-red-500/20 hover:text-red-300"
          >
            <Unplug className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full justify-center bg-transparent p-1" {...dragProps}>
      <div
        className={`relative flex h-full w-full max-w-[610px] flex-col overflow-hidden rounded-2xl border shadow-[0_16px_50px_rgba(0,0,0,0.6)] backdrop-blur-2xl transition-colors ${
          dragActive ? "border-sky-400/80 bg-[#0d1220]/98 ring-2 ring-sky-400/50" : "border-white/10 bg-[#0d1220]/92"
        }`}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-sky-400/70 bg-[#0b1220]/92 text-center">
            <Upload className="h-8 w-8 text-sky-300" />
            <div className="text-sm font-bold text-sky-100">拖放文件即发送到对方电脑</div>
            <div className="text-[10px] text-slate-400">松开鼠标后立即高速直连上传</div>
          </div>
        )}
        {/* Title bar */}
        <div
          onPointerDown={startDrag}
          className="flex cursor-grab items-center gap-2 border-b border-white/10 px-3 py-2 active:cursor-grabbing"
        >
          {statusDot}
          <span className="text-[11px] font-bold text-slate-100">{state.device.name}</span>
          <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-300">
            {route} {latency}
          </span>
          {state.reconnecting && (
            <span className="flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-200">
              <RefreshCw className="h-2.5 w-2.5 animate-spin" /> 正在切换画面设置…
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => void bridge.focusSessionRemote()}
              className="rounded-md px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 hover:text-white"
            >
              回到远程窗口
            </button>
            <button
              type="button"
              aria-label="收起设置"
              title="收起设置"
              onClick={toggleExpanded}
              className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {actionBanner && (
          <div className="px-3 pt-2">
            <div
              className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-medium ${
                actionBanner.ok
                  ? "border-emerald-400/35 bg-emerald-500/15 text-emerald-100"
                  : "border-red-400/35 bg-red-500/15 text-red-100"
              }`}
            >
              {actionBanner.text}
            </div>
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-2.5 text-slate-200">
          {/* Section 1: display */}
          <div className="space-y-1.5">
            <SectionTitle icon={<Monitor className="h-3 w-3 text-sky-400" />}>画面与窗口</SectionTitle>

            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <div className="mb-0.5 flex items-center justify-between text-[9px] text-slate-500">
                  <span>显示模式</span>
                  <kbd
                    title="全屏切换快捷键：Ctrl+Alt+F 或 Ctrl+Alt+Enter"
                    className="rounded border border-white/15 bg-black/30 px-1 font-mono text-[8px] text-slate-400"
                  >
                    Ctrl+Alt+F
                  </kbd>
                </div>
                <Segmented<DisplayMode>
                  value={preset.displayMode}
                  options={[
                    { value: "windowed", label: "窗口" },
                    { value: "borderless", label: "无边框" },
                    { value: "fullscreen", label: "全屏" },
                  ]}
                  onChange={(displayMode) => {
                    if (displayMode === preset.displayMode) return;
                    if (displayMode !== "borderless" && preset.displayMode !== "borderless") {
                      void bridge.toggleSessionFullscreen().then(applySession);
                    } else {
                      patchOptions({ displayMode });
                    }
                  }}
                />
              </div>
              <div>
                <div className="mb-0.5 text-[9px] text-slate-500">屏幕模式</div>
                <Segmented<StreamAppTarget>
                  value={preset.streamApp}
                  options={[
                    { value: "Virtual Display", label: "扩展虚拟屏" },
                    { value: "Desktop", label: "物理桌面" },
                  ]}
                  onChange={(streamApp) => patchOptions({ streamApp })}
                />
              </div>
            </div>

            <div>
              <div className="mb-0.5 flex items-center justify-between text-[9px] text-slate-500">
                <span>分辨率策略</span>
                <span className="font-mono text-slate-400">
                  当前 {preset.resolution.replace("x", "×")}
                  {preset.resolutionMode === "follow_client" && state.clientDisplayResolution
                    ? ` · 本机 ${state.clientDisplayResolution.replace("x", "×")}`
                    : preset.resolutionMode === "follow_host" && state.hostDisplayResolution
                      ? ` · 对方 ${state.hostDisplayResolution.replace("x", "×")}`
                      : ""}
                </span>
              </div>
              <Segmented<ResolutionMode>
                value={preset.resolutionMode}
                options={[
                  { value: "follow_client", label: "跟随主控端" },
                  { value: "follow_host", label: "跟随被控端" },
                  { value: "fit_window", label: "适应窗口" },
                  { value: "fixed", label: "固定" },
                ]}
                onChange={(mode) => void bridge.setSessionResolutionMode(mode).then(applySession)}
              />
            </div>

            <div>
              <div className="mb-0.5 flex items-center justify-between text-[9px] text-slate-500">
                <span>固定分辨率快速选择</span>
                <button
                  type="button"
                  onClick={() => void bridge.fitSessionWindow().then(applySession)}
                  className="rounded border border-sky-400/40 bg-sky-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-200 hover:bg-sky-400/20"
                >
                  自适应当前窗口
                </button>
              </div>
              <div className="flex gap-1">
                {RESOLUTION_PRESETS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => void bridge.setSessionResolutionMode("fixed", r.value).then(applySession)}
                    className={`flex-1 rounded-md border px-1 py-1 text-[10px] font-semibold ${
                      preset.resolutionMode === "fixed" && preset.resolution === r.value
                        ? "border-sky-400/60 bg-sky-400/15 text-sky-200"
                        : "border-white/10 bg-black/20 text-slate-300 hover:text-white"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-1.5">
              <div>
                <div className="mb-0.5 text-[9px] text-slate-500">刷新率</div>
                <div className="flex gap-1">
                  {FPS_PRESETS.map((fps) => (
                    <button
                      key={fps}
                      type="button"
                      onClick={() => patchOptions({ fps })}
                      className={`flex-1 rounded-md border px-1 py-1 text-[10px] font-semibold ${
                        preset.fps === fps
                          ? "border-sky-400/60 bg-sky-400/15 text-sky-200"
                          : "border-white/10 bg-black/20 text-slate-300 hover:text-white"
                      }`}
                    >
                      {fps}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-0.5 text-[9px] text-slate-500">编码器</div>
                <select
                  value={preset.codec}
                  onChange={(e) => patchOptions({ codec: e.target.value as StreamPreset["codec"] })}
                  className="h-[26px] rounded-md border border-white/10 bg-black/30 px-1.5 text-[10px] text-slate-200"
                >
                  <option value="hevc">H.265</option>
                  <option value="h264">H.264</option>
                  <option value="av1">AV1</option>
                </select>
              </div>
            </div>

            <div>
              <div className="mb-0.5 flex items-center justify-between text-[9px] text-slate-500">
                <span>码率</span>
                <span className="font-mono text-slate-300">{draftBitrate ?? preset.bitrateMbps} Mbps</span>
              </div>
              <input
                type="range"
                min={4}
                max={80}
                step={1}
                value={Math.min(80, Math.max(4, draftBitrate ?? preset.bitrateMbps))}
                onChange={(e) => setDraftBitrate(Number(e.target.value))}
                onPointerUp={() => {
                  if (draftBitrate != null && draftBitrate !== preset.bitrateMbps) {
                    patchOptions({ bitrateMbps: draftBitrate });
                  }
                }}
                onKeyUp={() => {
                  if (draftBitrate != null && draftBitrate !== preset.bitrateMbps) {
                    patchOptions({ bitrateMbps: draftBitrate });
                  }
                }}
                className="w-full accent-sky-400"
              />
            </div>
          </div>

          {/* Section 2: feel & audio */}
          <div className="space-y-1.5">
            <SectionTitle icon={<Zap className="h-3 w-3 text-amber-300" />}>手感与音频</SectionTitle>

            <div className="grid grid-cols-2 gap-1.5">
              <Toggle
                checked={preset.lowLatency}
                onChange={(lowLatency) => patchOptions({ lowLatency })}
                label="极速低延迟"
                hint="减少画面延迟与拖影"
              />
              <Toggle
                checked={preset.muteHostAudio}
                onChange={(muteHostAudio) => patchOptions({ muteHostAudio })}
                label="被控端静音"
                hint="仅本地出声"
              />
              <Toggle
                checked={preset.showPerfOverlay}
                onChange={(showPerfOverlay) => patchOptions({ showPerfOverlay })}
                label="性能浮层"
                hint="实时延迟/码率"
              />
              <Toggle
                checked={preset.absoluteMouse}
                onChange={(absoluteMouse) => patchOptions({ absoluteMouse })}
                label="绝对鼠标"
                hint={preset.absoluteMouse ? "桌面定位" : "相对游戏"}
              />
            </div>

            <div>
              <div className="mb-0.5 flex items-center gap-1 text-[9px] text-slate-500">
                <Keyboard className="h-2.5 w-2.5" /> 系统键捕获
              </div>
              <Segmented<SystemKeyCaptureMode>
                value={preset.captureSystemKeys}
                options={[
                  { value: "fullscreen", label: "仅全屏" },
                  { value: "always", label: "始终" },
                  { value: "never", label: "关闭" },
                ]}
                onChange={(captureSystemKeys) => patchOptions({ captureSystemKeys })}
              />
            </div>

            <button
              type="button"
              onClick={() => void bridge.switchSessionOfficeMode().catch(() => {})}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-400/40 bg-gradient-to-r from-emerald-500/25 to-teal-500/20 px-2 py-1.5 text-[11px] font-bold text-emerald-100 hover:from-emerald-500/35 hover:to-teal-500/30"
            >
              <MousePointer2 className="h-3.5 w-3.5" />
              切换轻办公模式
            </button>
          </div>

          {/* Section 3: quick actions + Stage 2 live controls */}
          <div className="space-y-1.5">
            <SectionTitle icon={<Gauge className="h-3 w-3 text-slate-400" />}>快捷操作</SectionTitle>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => void bridge.toggleSessionFullscreen().then(applySession)}
                className="inline-flex items-center gap-1 rounded-md border border-sky-400/35 bg-sky-500/10 px-2 py-1 text-[10px] font-semibold text-sky-200 hover:bg-sky-500/20"
                title="快捷切换全屏/窗口（支持 Ctrl+Alt+F 或 Ctrl+Alt+Enter）"
              >
                {isFullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
                {isFullscreen ? "退出全屏" : "切换全屏"} (Ctrl+Alt+F)
              </button>
              <button
                type="button"
                disabled={busy || !state.agentConnected}
                onClick={() => void handleSystemAction("repair_ime")}
                title="已自动禁止本机输入法弹窗左上角漂移；如对方电脑中文输入法卡死，可点此一键重置远端输入法服务"
                className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-slate-300 hover:text-white disabled:opacity-40"
              >
                <Keyboard className="h-3 w-3 text-emerald-300" /> 修复输入法
              </button>
              <button
                type="button"
                onClick={() => void bridge.sendSessionHotkey("mouse")}
                className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-slate-300 hover:text-white"
              >
                <Crosshair className="h-3 w-3" /> 切换鼠标锁定
              </button>
              <button
                type="button"
                onClick={() => void bridge.sendSessionHotkey("perf")}
                className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-slate-300 hover:text-white"
              >
                <AudioLines className="h-3 w-3" /> 性能监控
              </button>
              <button
                type="button"
                onClick={() => void bridge.focusSessionRemote()}
                className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-slate-300 hover:text-white"
              >
                <Wifi className="h-3 w-3" /> 回到远程窗口
              </button>
              <button
                type="button"
                onClick={() => void bridge.disconnectSession()}
                className="inline-flex items-center gap-1 rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/20"
              >
                <Unplug className="h-3 w-3" /> 断开
              </button>
            </div>
          </div>

          {/* Section 4: multi-monitor switching */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <SectionTitle icon={<Layers className="h-3 w-3 text-sky-400" />}>屏幕切换</SectionTitle>
              <button
                type="button"
                disabled={busy || !state.agentConnected}
                onClick={() => void handleRefreshDisplays()}
                className="inline-flex items-center gap-1 rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[9px] text-slate-300 hover:text-white disabled:opacity-40"
              >
                <RefreshCw className={`h-2.5 w-2.5 ${busy ? "animate-spin" : ""}`} /> 刷新
              </button>
            </div>

            {!state.agentConnected ? (
              <div className="rounded-lg border border-dashed border-white/10 bg-black/10 px-2 py-1.5 text-[10px] text-slate-500">
                远控增强服务未就绪，暂不支持切换被控端显示器
              </div>
            ) : state.displays.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/10 bg-black/10 px-2 py-1.5 text-[10px] text-slate-500">
                未读取到被控端显示器，请点击刷新
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {state.displays.map((display) => {
                  const selected = display.id === state.selectedDisplayId;
                  return (
                    <button
                      key={display.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSelectDisplay(display.id)}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors disabled:opacity-50 ${
                        selected
                          ? "border-sky-400/60 bg-sky-400/15 text-sky-100"
                          : "border-white/10 bg-black/20 text-slate-300 hover:text-white"
                      }`}
                    >
                      <Monitor className="h-3 w-3" />
                      <span className="font-semibold">
                        {display.isPrimary ? "主屏" : display.isVirtual ? "虚拟屏" : `屏 ${display.index + 1}`}
                      </span>
                      <span className="text-slate-500">
                        {display.width}x{display.height}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section 5: hardware privacy & audio */}
          <div className="space-y-1.5">
            <SectionTitle icon={<Lock className="h-3 w-3 text-emerald-300" />}>硬件隐私与声音</SectionTitle>
            <div className="grid grid-cols-2 gap-1.5">
              <Toggle
                checked={state.hostMuted}
                onChange={(next) => void handleHostMute(next)}
                label="被控静音"
                hint={state.agentConnected ? "被控端扬声器主静音" : "本机静音（增强服务未就绪）"}
              />
              <Toggle
                checked={state.privacyActive}
                onChange={(next) => void handlePrivacy(next)}
                disabled={!state.agentConnected || !state.privacySupported}
                title="被控端物理屏全黑，仅远程可见真实桌面；在被控端按 Ctrl+Alt+Shift+P 可立即恢复显示"
                label="防窥隐私屏"
                hint={
                  !state.agentConnected
                    ? "需要被控端增强服务就绪"
                    : state.privacySupported
                      ? "对方物理屏黑屏，本机 Ctrl+Alt+Shift+P 可救援"
                      : "仅支持 Windows 被控端"
                }
              />
              <Toggle
                checked={state.autoLockOnDisconnect}
                onChange={(next) => void handleAutoLock(next)}
                label="断开后自动锁屏"
                hint="会话结束时锁定被控端"
              />
            </div>
          </div>

          {/* Section 6: remote system actions */}
          <div className="space-y-1.5">
            <SectionTitle icon={<Power className="h-3 w-3 text-amber-300" />}>远程系统操作</SectionTitle>
            <div className="flex flex-wrap gap-1">
              {SYSTEM_ACTION_ORDER.map((action) => {
                const guarded = action === "reboot" || action === "shutdown";
                const armed = pendingConfirm === action;
                const disabled = busy || !state.agentConnected;
                return (
                  <button
                    key={action}
                    type="button"
                    disabled={disabled}
                    onClick={() => void handleSystemAction(action)}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-40 ${
                      armed
                        ? "border-red-400/70 bg-red-500/25 text-red-100"
                        : guarded
                          ? "border-red-400/30 bg-red-500/10 text-red-200 hover:bg-red-500/20"
                          : "border-white/10 bg-black/20 text-slate-300 hover:text-white"
                    }`}
                  >
                    {guarded ? <Power className="h-3 w-3" /> : action === "lock" ? <Lock className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
                    {armed ? `确认${SYSTEM_ACTION_LABELS[action]}?` : SYSTEM_ACTION_LABELS[action]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Stage 3: clipboard sync + file transfer */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <SectionTitle icon={<ClipboardCopy className="h-3 w-3 text-fuchsia-300" />}>
                剪贴板与文件快传
              </SectionTitle>
              <span
                className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${clipboardStatusBadge(state).className}`}
                title={state.clipboardError || undefined}
              >
                {clipboardStatusBadge(state).text}
              </span>
            </div>

            {!state.agentConnected ? (
              <div className="rounded-lg border border-dashed border-white/10 bg-black/10 px-2 py-1.5 text-[10px] text-slate-500">
                远控增强服务未就绪，暂不支持文件与剪贴板通道
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={clipboardBusy}
                    onClick={() => void handleClipboardToggle(!state.clipboardSyncEnabled)}
                    className={`inline-flex flex-1 items-center justify-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors disabled:opacity-50 ${
                      state.clipboardSyncEnabled
                        ? "border-sky-400/60 bg-sky-400/15 text-sky-100"
                        : "border-white/10 bg-black/20 text-slate-400 hover:text-white"
                    }`}
                  >
                    <ClipboardCheck className="h-3 w-3" />
                    双向剪贴板同步 (Ctrl+C/V)
                  </button>
                  <button
                    type="button"
                    disabled={clipboardBusy || !state.clipboardSyncEnabled}
                    onClick={() => void handleClipboardSyncNow()}
                    className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-slate-300 hover:text-white disabled:opacity-40"
                  >
                    {clipboardBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    立即同步
                  </button>
                </div>

                {state.clipboardError && (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-100">
                    {state.clipboardError}
                  </div>
                )}

                {state.transfers.length > 0 && (
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {state.transfers.map((task) => (
                      <TransferRow key={task.id} task={task} />
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      void bridge
                        .pickAndUploadSessionFiles()
                        .then((tasks) => {
                          if (tasks.length > 0) showBanner(true, `已上传 ${tasks.length} 个文件`);
                        })
                        .catch((err) => showBanner(false, err instanceof Error ? err.message : String(err)))
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-slate-300 hover:text-white"
                  >
                    <Upload className="h-3 w-3" /> 选择文件上传
                  </button>
                  <button
                    type="button"
                    onClick={() => setFileDrawerOpen((open) => !open)}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold ${
                      fileDrawerOpen
                        ? "border-sky-400/50 bg-sky-400/10 text-sky-100"
                        : "border-white/10 bg-black/20 text-slate-300 hover:text-white"
                    }`}
                  >
                    <FolderOpen className="h-3 w-3" />
                    {fileDrawerOpen ? "收起文件管理" : "展开文件管理"}
                  </button>
                </div>

                {fileDrawerOpen && <FileBrowser bridge={bridge} notifyError={(msg) => showBanner(false, msg)} />}

                <div className="rounded-lg border border-dashed border-white/10 bg-black/10 px-2 py-1 text-[9px] text-slate-500">
                  直接拖放文件到悬浮条即可上传；超过 50 MiB 的剪贴板文件请使用上方文件管理。
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-white/10 px-3 py-1.5 text-[9px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <Radio className="h-2.5 w-2.5" /> {state.resolvedApp === "Virtual Display" ? "扩展虚拟屏" : "物理桌面"}
            {state.availableApps.length > 0 ? ` · ${state.availableApps.length} 个桌面模式` : ""}
          </span>
          <span className="inline-flex items-center gap-1">
            {preset.lowLatency ? <Zap className="h-2.5 w-2.5 text-amber-300" /> : <MonitorOff className="h-2.5 w-2.5" />}
            {preset.lowLatency ? "低延迟开" : "低延迟关"}
          </span>
        </div>
      </div>
    </div>
  );
}
