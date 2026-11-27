import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronLeft,
  Cpu,
  Edit3,
  File as FileIcon,
  Folder,
  FolderOpen,
  KeyRound,
  Loader2,
  Lock,
  MonitorPlay,
  MousePointer2,
  Power,
  RefreshCw,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { getBridge } from "../bridge";
import type {
  ConnectDeviceResult,
  ConnectProgressEvent,
  DeviceInfo,
  RemoteFileListing,
  ResolutionMode,
  StreamPreset,
  TransferTaskItem,
} from "../../electron/types";
import type { ConnectOptions } from "../../electron/preload";

type ConnectMode = "connect" | "stream" | "rustdesk" | "transfer";

interface PasswordPrompt {
  device: DeviceInfo;
  mode: ConnectMode;
  message: string;
  retryAfterSec?: number;
}

const MODE_LABELS: Record<ConnectMode, string> = {
  connect: "高清远控",
  stream: "高清远控",
  rustdesk: "轻办公模式",
  transfer: "极速文件传输",
};

function formatConnectRoute(routeType?: string, latencyMs?: number | null): string {
  const r = (routeType || "").toLowerCase();
  const base = r.startsWith("relay") ? "私有中继" : r === "p2p" ? "极速直连" : r === "local" ? "局域网" : "";
  if (!base) return "";
  return latencyMs != null ? `${base} · ${Math.round(latencyMs)}ms` : base;
}

interface DevicesViewProps {
  devices: DeviceInfo[];
  selfDeviceId: string;
  preset: StreamPreset;
  onUpdatePreset: (preset: StreamPreset) => Promise<void>;
  onConnect: (device: DeviceInfo, opts?: ConnectOptions) => Promise<ConnectDeviceResult>;
  onStream: (device: DeviceInfo, opts?: ConnectOptions) => Promise<ConnectDeviceResult>;
  onRustDesk: (device: DeviceInfo, opts?: ConnectOptions) => Promise<ConnectDeviceResult>;
  onWake: (device: DeviceInfo) => Promise<void>;
  onUpdateDevice: (
    deviceId: string,
    patch: Partial<Pick<DeviceInfo, "name" | "mac_address" | "broadcast_ip" | "visibility">>,
  ) => Promise<void>;
  onDeleteDevice: (deviceId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  notify: (msg: string) => void;
}

const QUICK_PRESETS: Array<{ label: string; preset: Pick<StreamPreset, "resolution" | "fps" | "bitrateMbps"> }> = [
  { label: "流畅 · 1080P60", preset: { resolution: "1920x1080", fps: 60, bitrateMbps: 15 } },
  { label: "均衡 · 2K60", preset: { resolution: "2560x1440", fps: 60, bitrateMbps: 20 } },
  { label: "高刷 · 2K120", preset: { resolution: "2560x1440", fps: 120, bitrateMbps: 35 } },
  { label: "丝滑 · 2K144", preset: { resolution: "2560x1440", fps: 144, bitrateMbps: 40 } },
  { label: "原画 · 4K60", preset: { resolution: "3840x2160", fps: 60, bitrateMbps: 60 } },
];

/**
 * `dragenter`/`dragover` expose the payload only through `types`; `files` is
 * empty until `drop`, and some sources omit the `Files` entry entirely.
 */
function isFileDrag(data: DataTransfer | null): boolean {
  if (!data) return false;
  if (data.files.length > 0) return true;
  return Array.from(data.types).includes("Files");
}

export function DevicesView({
  devices,
  selfDeviceId,
  preset,
  onUpdatePreset,
  onConnect,
  onStream,
  onRustDesk,
  onWake,
  onUpdateDevice,
  onDeleteDevice,
  onRefresh,
  notify,
}: DevicesViewProps) {
  const [connectingId, setConnectingId] = useState<string>("");
  const [editTarget, setEditTarget] = useState<DeviceInfo | null>(null);
  const [editName, setEditName] = useState("");
  const [editMac, setEditMac] = useState("");
  const [editVis, setEditVis] = useState<"team" | "private">("team");
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [rememberPassword, setRememberPassword] = useState(true);
  const [passwordError, setPasswordError] = useState("");
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [submittingPassword, setSubmittingPassword] = useState(false);

  const bridge = useMemo(() => getBridge(), []);
  const [localDisplayRes, setLocalDisplayRes] = useState("");
  const [connectProgress, setConnectProgress] = useState<ConnectProgressEvent | null>(null);
  const [connectOverlayHidden, setConnectOverlayHidden] = useState(false);
  const [transferDevice, setTransferDevice] = useState<DeviceInfo | null>(null);
  const [transferToken, setTransferToken] = useState("");
  const [transferPort, setTransferPort] = useState(19580);
  const [transferListing, setTransferListing] = useState<RemoteFileListing | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [transferTasks, setTransferTasks] = useState<TransferTaskItem[]>([]);
  const [transferDragActive, setTransferDragActive] = useState(false);
  const [confirmDeleteDeviceId, setConfirmDeleteDeviceId] = useState<string>("");
  const transferDragDepth = useRef(0);
  const confirmDeleteTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void bridge.getLocalDisplayResolution().then(setLocalDisplayRes).catch(() => {});
    return bridge.onConnectProgress((ev) => {
      if (ev && ev.step <= 1) {
        setConnectOverlayHidden(false);
      }
      setConnectProgress(ev);
    });
  }, [bridge]);

  useEffect(() => {
    return () => {
      if (confirmDeleteTimerRef.current !== null) window.clearTimeout(confirmDeleteTimerRef.current);
    };
  }, []);

  function updatePresetSafe(next: StreamPreset) {
    void onUpdatePreset(next).catch((err) => notify(err instanceof Error ? err.message : String(err)));
  }

  function handleDeleteDeviceClick(device: DeviceInfo) {
    if (confirmDeleteTimerRef.current !== null) window.clearTimeout(confirmDeleteTimerRef.current);
    if (confirmDeleteDeviceId === device.id) {
      setConfirmDeleteDeviceId("");
      void onDeleteDevice(device.id)
        .then(() => notify(`已移除设备「${device.name}」`))
        .catch((err) => notify(err instanceof Error ? err.message : String(err)));
      return;
    }
    setConfirmDeleteDeviceId(device.id);
    confirmDeleteTimerRef.current = window.setTimeout(() => {
      setConfirmDeleteDeviceId("");
    }, 4000);
  }

  useEffect(() => {
    if (retryCountdown <= 0) return;
    const timer = setInterval(() => {
      setRetryCountdown((cur) => Math.max(0, cur - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [retryCountdown]);

  function openEdit(d: DeviceInfo) {
    setEditTarget(d);
    setEditName(d.name);
    setEditMac(d.mac_address);
    setEditVis(d.visibility);
  }

  function closePasswordPrompt() {
    setPasswordPrompt(null);
    setPasswordDraft("");
    setPasswordError("");
    setRetryCountdown(0);
  }

  /**
   * Runs a connect action, funnelling `needsPassword` results into the modal
   * and re-submitting the exact same action once a password is entered.
   */
  async function runConnectAction(mode: ConnectMode, d: DeviceInfo, opts?: ConnectOptions): Promise<void> {
    const invoke =
      mode === "rustdesk" ? onRustDesk : mode === "stream" ? onStream : onConnect;
    setConnectingId(d.id);
    if (mode === "connect" || mode === "stream") {
      setConnectOverlayHidden(false);
      setConnectProgress({
        deviceId: d.id,
        deviceName: d.name,
        stage: "connecting",
        step: 1,
        totalSteps: 3,
        title: `正在连接 ${d.name}`,
        detail: "正在并行建立高速加密通道…",
        routeType: d.route_type,
        latencyMs: d.latency_ms,
      });
    }
    try {
      const res = await invoke(d, opts);
      if (res?.needsPassword) {
        setConnectProgress(null);
        setPasswordPrompt({
          device: d,
          mode,
          message: res.message || "此电脑需要访问密码",
          retryAfterSec: res.retryAfterSec,
        });
        setPasswordDraft(opts?.password ?? "");
        // A first-time prompt is expected, not an error; only surface the
        // server message when a password was actually rejected.
        setPasswordError(opts?.password ? res.message || "访问密码错误" : "");
        setRetryCountdown(res.retryAfterSec ?? 0);
        return;
      }
      if (res?.message) notify(res.message);
      if (res?.ok) {
        closePasswordPrompt();
        if (mode !== "connect" && mode !== "stream") {
          setConnectProgress(null);
        } else {
          window.setTimeout(() => {
            setConnectProgress((cur) => (cur?.deviceId === d.id ? null : cur));
          }, 2600);
        }
      } else {
        setConnectProgress(null);
      }
    } catch (err) {
      setConnectProgress(null);
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectingId("");
    }
  }

  async function handleConnect(d: DeviceInfo) {
    await runConnectAction("connect", d);
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordPrompt || submittingPassword || retryCountdown > 0) return;
    const password = passwordDraft.trim();
    if (!password) {
      setPasswordError("请输入访问密码或临时密码");
      return;
    }
    setSubmittingPassword(true);
    setPasswordError("");
    try {
      const { device, mode } = passwordPrompt;
      if (mode === "transfer") {
        await openTransferModal(device, { password, rememberPassword });
        return;
      }
      const invoke = mode === "rustdesk" ? onRustDesk : mode === "stream" ? onStream : onConnect;
      setConnectingId(device.id);
      const res = await invoke(device, { password, rememberPassword });
      if (res?.needsPassword) {
        setPasswordError(res.message || "访问密码错误");
        setRetryCountdown(res.retryAfterSec ?? 0);
        return;
      }
      // Password was accepted (or not needed): any failure from here on is a
      // connection problem, not a credential problem, so close the prompt.
      closePasswordPrompt();
      if (res?.message) notify(res.message);
    } catch (err) {
      closePasswordPrompt();
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingPassword(false);
      setConnectingId("");
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    try {
      await onUpdateDevice(editTarget.id, {
        name: editName.trim(),
        mac_address: editMac.trim(),
        visibility: editVis,
      });
      setEditTarget(null);
      notify("设备信息已更新");
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新失败");
    }
  }

  // --- Stage 3: Mesh file quick-transfer modal ----------------------------

  function closeTransferModal() {
    setTransferDevice(null);
    setTransferToken("");
    setTransferListing(null);
    setTransferError("");
    setTransferTasks([]);
    setTransferDragActive(false);
    transferDragDepth.current = 0;
  }

  async function loadDeviceFiles(dirPath?: string, tokenOverride?: string) {
    const device = transferDevice;
    if (!device) return;
    const token = tokenOverride ?? transferToken;
    if (!token) return;
    setTransferBusy(true);
    setTransferError("");
    try {
      const listing = await bridge.listDeviceFiles({
        meshIp: device.mesh_ip,
        port: transferPort,
        token,
        dirPath,
      });
      setTransferListing(listing);
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  }

  /**
   * Opens the transfer modal and authenticates the file channel. A host with a
   * password surfaces the existing Access Password prompt; the modal is only
   * opened once a token is issued.
   */
  async function openTransferModal(d: DeviceInfo, opts?: ConnectOptions) {
    setConnectingId(d.id);
    try {
      const res = await bridge.prepareDeviceAgent(d, opts);
      if (!res.ok) {
        if (res.needsPassword) {
          setPasswordPrompt({
            device: d,
            mode: "transfer",
            message: res.message || "此主机需要访问密码",
            retryAfterSec: res.retryAfterSec,
          });
          setPasswordDraft(opts?.password ?? "");
          setPasswordError(opts?.password ? res.message || "访问密码错误" : "");
          setRetryCountdown(res.retryAfterSec ?? 0);
          return;
        }
        notify(res.message || "无法建立文件通道");
        return;
      }
      closePasswordPrompt();
      setTransferDevice(d);
      setTransferPort(res.agentPort);
      setTransferToken(res.agentToken);
      setTransferTasks([]);
      setTransferError("");
      setTransferBusy(true);
      try {
        const listing = await bridge.listDeviceFiles({
          meshIp: d.mesh_ip,
          port: res.agentPort,
          token: res.agentToken,
        });
        setTransferListing(listing);
      } catch (err) {
        setTransferError(err instanceof Error ? err.message : String(err));
      } finally {
        setTransferBusy(false);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectingId("");
    }
  }

  async function uploadPathsToDevice(paths: string[]) {
    const device = transferDevice;
    if (!device || !transferToken || paths.length === 0) return;
    setTransferBusy(true);
    try {
      const tasks = await bridge.uploadDeviceFiles({
        meshIp: device.mesh_ip,
        port: transferPort,
        token: transferToken,
        localPaths: paths,
        targetDir: transferListing?.currentPath,
      });
      setTransferTasks((prev) => [...tasks, ...prev].slice(0, 12));
      const failed = tasks.filter((task) => task.status === "error");
      if (failed.length > 0) {
        notify(`${failed.length} 个文件上传失败：${failed[0].message || failed[0].filename}`);
      } else {
        notify(`已上传 ${tasks.length} 个文件到「${device.name}」`);
      }
      await loadDeviceFiles(transferListing?.currentPath);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  }

  async function handlePickAndUpload() {
    const device = transferDevice;
    if (!device || !transferToken) return;
    setTransferBusy(true);
    try {
      const tasks = await bridge.pickAndUploadDeviceFiles({
        meshIp: device.mesh_ip,
        port: transferPort,
        token: transferToken,
        targetDir: transferListing?.currentPath,
      });
      if (tasks.length === 0) return;
      setTransferTasks((prev) => [...tasks, ...prev].slice(0, 12));
      notify(`已上传 ${tasks.length} 个文件到「${device.name}」`);
      await loadDeviceFiles(transferListing?.currentPath);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  }

  async function handleDownloadEntry(entry: { path: string; name: string }) {
    const device = transferDevice;
    if (!device || !transferToken) return;
    setTransferBusy(true);
    try {
      const task = await bridge.downloadDeviceFile({
        meshIp: device.mesh_ip,
        port: transferPort,
        token: transferToken,
        remotePath: entry.path,
        suggestedName: entry.name,
      });
      if (task) {
        setTransferTasks((prev) => [task, ...prev].slice(0, 12));
        if (task.status === "done") notify(`已下载「${task.filename}」到本机`);
        else notify(task.message || "下载失败");
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusy(false);
    }
  }

  function collectDroppedPaths(data: DataTransfer | null): string[] {
    if (!data) return [];
    const paths: string[] = [];
    for (const file of Array.from(data.files)) {
      let resolved = "";
      try {
        resolved = bridge.getPathForFile(file);
      } catch {
        resolved = "";
      }
      if (!resolved) resolved = (file as { path?: string }).path || "";
      if (resolved) paths.push(resolved);
    }
    return paths;
  }

  function handleTransferDrop(e: React.DragEvent) {
    e.preventDefault();
    transferDragDepth.current = 0;
    setTransferDragActive(false);
    const paths = collectDroppedPaths(e.dataTransfer);
    if (paths.length === 0) {
      notify("未能解析拖入文件的本地路径");
      return;
    }
    void uploadPathsToDevice(paths);
  }

  return (
    <div className="space-y-5">
      {/* Stream Preset Bar */}
      <div className="rounded-2xl border border-edge bg-panel p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_PRESETS.map((q) => {
              const active =
                preset.resolutionMode === "fixed" &&
                preset.resolution === q.preset.resolution &&
                preset.fps === q.preset.fps &&
                preset.bitrateMbps === q.preset.bitrateMbps;
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => updatePresetSafe({ ...preset, ...q.preset, resolutionMode: "fixed" })}
                  className={`rounded-xl px-3 py-1.5 text-xs font-semibold border transition-colors ${
                    active
                      ? "bg-sky-500/15 text-sky-300 border-sky-500/40"
                      : "border-edge bg-panelHover text-slate-300 hover:text-white"
                  }`}
                >
                  {q.label}
                </button>
              );
            })}

            <select
              aria-label="编码器"
              value={preset.codec}
              onChange={(e) => updatePresetSafe({ ...preset, codec: e.target.value as StreamPreset["codec"] })}
              className="rounded-xl border border-edge bg-panelHover px-2.5 py-1.5 text-xs text-slate-200"
            >
              <option value="hevc">H.265 (推荐)</option>
              <option value="av1">AV1 (新显卡)</option>
              <option value="h264">H.264 (兼容)</option>
            </select>

            <label className="inline-flex items-center gap-1.5 ml-1 text-xs text-slate-300 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={preset.muteHostAudio}
                onChange={(e) => updatePresetSafe({ ...preset, muteHostAudio: e.target.checked })}
                className="rounded border-edge bg-panelHover text-sky-400"
              />
              被控端静音
            </label>

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={preset.lowLatency}
                onChange={(e) => updatePresetSafe({ ...preset, lowLatency: e.target.checked })}
                className="rounded border-edge bg-panelHover text-sky-400"
              />
              极速低延迟
            </label>
          </div>

          <button
            type="button"
            onClick={() => void onRefresh().catch((err) => notify(err instanceof Error ? err.message : String(err)))}
            className="inline-flex items-center gap-1.5 rounded-xl border border-edge bg-panelHover px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-500/50 transition-colors shrink-0 whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新设备
          </button>
        </div>

        {/* Stage 1 + UU-style quick switches */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3 border-t border-edge/60 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">分辨率策略</span>
            <div className="flex rounded-lg border border-edge bg-obsidian/70 p-0.5">
              {([
                {
                  value: "follow_client" as ResolutionMode,
                  label: localDisplayRes ? `跟随主控端 (${localDisplayRes.replace("x", "×")})` : "跟随主控端",
                },
                { value: "follow_host" as ResolutionMode, label: "跟随被控端" },
                { value: "fixed" as ResolutionMode, label: "固定分辨率" },
              ]).map((m) => {
                const selected =
                  m.value === "fixed"
                    ? preset.resolutionMode === "fixed" || preset.resolutionMode === "fit_window"
                    : preset.resolutionMode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => {
                      if (m.value === "follow_client") {
                        updatePresetSafe({
                          ...preset,
                          resolutionMode: "follow_client",
                          resolution: localDisplayRes || preset.resolution,
                          streamApp: "Virtual Display",
                        });
                      } else if (m.value === "follow_host") {
                        updatePresetSafe({
                          ...preset,
                          resolutionMode: "follow_host",
                          streamApp: "Desktop",
                        });
                      } else {
                        updatePresetSafe({ ...preset, resolutionMode: "fixed" });
                      }
                    }}
                    className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${
                      selected
                        ? "bg-sky-500/20 text-sky-300"
                        : "text-slate-400 hover:text-slate-100"
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-1.5" title="连接后按 Ctrl+Alt+F 或 Ctrl+Alt+Enter 快速切换全屏/窗口">
            <span className="text-slate-500">显示模式</span>
            <div className="flex rounded-lg border border-edge bg-obsidian/70 p-0.5">
              {([
                { value: "windowed", label: "窗口" },
                { value: "borderless", label: "无边框" },
                { value: "fullscreen", label: "全屏" },
              ] as const).map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => updatePresetSafe({ ...preset, displayMode: m.value })}
                  className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${
                    preset.displayMode === m.value
                      ? "bg-sky-500/20 text-sky-300"
                      : "text-slate-400 hover:text-slate-100"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">屏幕模式</span>
            <div className="flex rounded-lg border border-edge bg-obsidian/70 p-0.5">
              {([
                { value: "Virtual Display", label: "隐私扩展屏" },
                { value: "Desktop", label: "同步物理屏" },
              ] as const).map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => updatePresetSafe({ ...preset, streamApp: m.value })}
                  className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${
                    preset.streamApp === m.value
                      ? "bg-sky-500/20 text-sky-300"
                      : "text-slate-400 hover:text-slate-100"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className="flex items-center gap-1.5"
            title="桌面绝对适合自由跨窗办公；1000Hz+ 电竞鼠标若拖动微卡，切换「极速原生」可批量传输原始输入（按 Ctrl+Alt+Shift+Z 释放指针）"
          >
            <span className="text-slate-500">鼠标模式</span>
            <div className="flex rounded-lg border border-edge bg-obsidian/70 p-0.5">
              {([
                { value: true, label: "桌面绝对" },
                { value: false, label: "极速原生" },
              ] as const).map((m) => (
                <button
                  key={String(m.value)}
                  type="button"
                  onClick={() => updatePresetSafe({ ...preset, absoluteMouse: m.value })}
                  className={`rounded-md px-2 py-0.5 font-semibold transition-colors ${
                    preset.absoluteMouse === m.value
                      ? "bg-sky-500/20 text-sky-300"
                      : "text-slate-400 hover:text-slate-100"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Device Grid */}
      {devices.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-edge bg-panel/60 p-12 text-center text-sm text-slate-400">
          暂无可见设备。在另一台电脑安装 SilkWarp 并登录同一个账号，即可自动出现在此处。
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
          {devices.map((d) => {
            const isSelf = d.id === selfDeviceId;
            const isBusy = connectingId === d.id;
            const statusLabel = !d.online
              ? "离线"
              : d.apollo_ready
                ? "可一键远程"
                : d.is_host
                  ? "正在自动准备..."
                  : "在线";
            const statusStyle = !d.online
              ? "bg-slate-800/80 text-slate-400 border-edge"
              : d.apollo_ready
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35"
                : "bg-amber-500/15 text-amber-300 border-amber-500/35";

            return (
              <article
                key={d.id}
                className="min-w-0 rounded-2xl border border-edge bg-panel p-5 flex flex-col justify-between gap-4 hover:border-slate-600 transition-colors"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base text-slate-50 truncate">{d.name}</h3>
                        {isSelf && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-edge shrink-0 whitespace-nowrap">
                            本机
                          </span>
                        )}
                        {d.has_access_password && (
                          <span
                            title="该主机已启用访问密码保护，连接时需输入密码或临时码"
                            className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-500/35 shrink-0 whitespace-nowrap"
                          >
                            <Lock className="w-2.5 h-2.5 shrink-0" />
                            需密码
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {d.owner_username} · {d.mesh_ip}
                      </div>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-full font-medium border shrink-0 ${statusStyle}`}
                    >
                      {d.online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                      {statusLabel}
                    </span>
                  </div>

                  <div className="rounded-xl bg-obsidian/70 border border-edge/70 p-3 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2 text-slate-300">
                      <span className="text-slate-400 flex items-center gap-1.5 shrink-0 whitespace-nowrap">
                        <Cpu className="w-3.5 h-3.5 text-sky-400" /> 显卡
                      </span>
                      <span className="truncate min-w-0 text-right font-medium">{d.gpu || "检测中"}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-slate-400">网络链路</span>
                      <span className="font-medium">
                        {d.route_type === "p2p" ? (
                          <span className="text-emerald-300">极速直连</span>
                        ) : d.route_type?.startsWith("relay") ? (
                          <span className="text-amber-300">私有中继</span>
                        ) : (
                          d.route_type
                        )}
                        {d.latency_ms != null ? ` · ${d.latency_ms.toFixed(1)} ms` : ""}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <button
                    type="button"
                    disabled={!d.online || isSelf || isBusy}
                    onClick={() => void handleConnect(d)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-400 to-blue-500 px-4 py-2.5 text-sm font-bold text-slate-950 hover:opacity-95 transition-opacity disabled:opacity-40"
                  >
                    {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MonitorPlay className="w-4 h-4" />}
                    {isSelf ? "当前本机" : isBusy ? "正在极速连接..." : "立即远程"}
                  </button>

                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      {d.mac_address && (
                        <button
                          type="button"
                          onClick={() =>
                            void onWake(d)
                              .then(() => notify(`已向 ${d.name} 发送远程开机指令`))
                              .catch((e) => notify(e.message))
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-2.5 py-1 text-[11px] text-slate-200 hover:border-emerald-500/40 whitespace-nowrap shrink-0"
                        >
                          <Power className="w-3 h-3 text-emerald-400 shrink-0" />
                          远程开机
                        </button>
                      )}
                      {d.rustdesk_id && !isSelf && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void runConnectAction("rustdesk", d)}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40 whitespace-nowrap shrink-0"
                          title="使用轻量办公模式操控桌面（0ms 本地光标，支持锁屏与系统弹窗）"
                        >
                          <MousePointer2 className="w-3 h-3 shrink-0" />
                          轻办公模式
                        </button>
                      )}
                      {d.online && !isSelf && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void openTransferModal(d)}
                          className="inline-flex items-center gap-1 rounded-lg border border-sky-500/35 bg-sky-500/10 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/20 disabled:opacity-40 whitespace-nowrap shrink-0"
                          title="无需打开远程桌面，直接浏览、上传、下载对方电脑文件"
                        >
                          <Upload className="w-3 h-3 shrink-0" />
                          传文件
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1 ml-auto shrink-0">
                      <button
                        type="button"
                        aria-label="编辑设备"
                        onClick={() => openEdit(d)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-panelHover"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="删除设备"
                        onClick={() => handleDeleteDeviceClick(d)}
                        className={`rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                          confirmDeleteDeviceId === d.id
                            ? "border border-red-400/60 bg-red-500/25 px-2 py-1 text-[10px] font-semibold text-red-100"
                            : "p-1.5 text-slate-400 hover:text-red-300 hover:bg-red-500/10"
                        }`}
                      >
                        {confirmDeleteDeviceId === d.id ? "确认删除?" : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Friendly Connecting Progress Overlay */}
      {connectProgress && !connectOverlayHidden && (
        <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-edge bg-panel/95 p-6 shadow-2xl space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-sky-500/15 border border-sky-500/35 flex items-center justify-center shrink-0">
                  <Loader2 className="w-5 h-5 text-sky-300 animate-spin motion-reduce:animate-none" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-slate-100 truncate">
                      {connectProgress.deviceName}
                    </span>
                    {formatConnectRoute(connectProgress.routeType, connectProgress.latencyMs) && (
                      <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                        {formatConnectRoute(connectProgress.routeType, connectProgress.latencyMs)}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">SilkWarp 极速远控通道</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setConnectOverlayHidden(true)}
                className="rounded-lg border border-edge bg-panelHover px-2.5 py-1 text-[11px] text-slate-300 hover:text-white transition-colors"
              >
                隐藏
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { step: 1, label: "建立通道" },
                { step: 2, label: "安全校验" },
                { step: 3, label: "进入桌面" },
              ].map((s) => {
                const done = connectProgress.step > s.step;
                const active = connectProgress.step === s.step;
                return (
                  <div key={s.step} className="space-y-1.5">
                    <div
                      className={`h-1.5 rounded-full transition-colors duration-200 motion-reduce:transition-none ${
                        done ? "bg-emerald-400" : active ? "bg-sky-400" : "bg-slate-700"
                      }`}
                    />
                    <div
                      className={`text-[11px] font-medium text-center ${
                        done ? "text-emerald-300" : active ? "text-sky-200" : "text-slate-500"
                      }`}
                    >
                      {s.label}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="rounded-xl border border-edge/80 bg-obsidian/70 px-4 py-3 space-y-1">
              <div className="text-sm font-semibold text-slate-100">{connectProgress.title}</div>
              <div className="text-xs text-slate-400 leading-relaxed">{connectProgress.detail}</div>
            </div>
          </div>
        </div>
      )}

      {/* Quick File Transfer Modal */}
      {transferDevice && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-edge bg-panel p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-sky-300" />
                  <h3 className="font-bold text-slate-100">极速文件传输 · {transferDevice.name}</h3>
                </div>
                <p className="text-[11px] text-slate-400">
                  无需打开远程桌面，直接与「{transferDevice.name}」高速互传文件。
                </p>
              </div>
              <button
                type="button"
                onClick={closeTransferModal}
                className="text-slate-400 hover:text-slate-100"
                aria-label="关闭文件快传"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div
              onDragEnter={(e) => {
                if (!isFileDrag(e.dataTransfer)) return;
                e.preventDefault();
                transferDragDepth.current += 1;
                setTransferDragActive(true);
              }}
              onDragOver={(e) => {
                if (!isFileDrag(e.dataTransfer)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(e) => {
                if (!isFileDrag(e.dataTransfer)) return;
                transferDragDepth.current = Math.max(0, transferDragDepth.current - 1);
                if (transferDragDepth.current === 0) setTransferDragActive(false);
              }}
              onDrop={handleTransferDrop}
              className={`rounded-xl border-2 border-dashed px-4 py-3 text-center text-xs transition-colors ${
                transferDragActive
                  ? "border-sky-400/80 bg-sky-500/15 text-sky-100"
                  : "border-edge bg-obsidian/60 text-slate-400"
              }`}
            >
              <Upload className="mx-auto mb-1 h-4 w-4" />
              将文件拖到这里上传，或
              <button
                type="button"
                disabled={transferBusy}
                onClick={() => void handlePickAndUpload()}
                className="mx-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
              >
                选择文件上传
              </button>
              到当前目录
            </div>

            {transferError && (
              <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                {transferError}
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1">
                {transferListing?.roots.map((root) => (
                  <button
                    key={root.path}
                    type="button"
                    onClick={() => void loadDeviceFiles(root.path)}
                    className={`rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${
                      transferListing.currentPath === root.path
                        ? "border-sky-500/50 bg-sky-500/15 text-sky-200"
                        : "border-edge bg-panelHover text-slate-300 hover:text-white"
                    }`}
                  >
                    {root.label}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={transferBusy || !transferListing?.parentPath}
                  onClick={() => transferListing?.parentPath && void loadDeviceFiles(transferListing.parentPath)}
                  className="ml-auto inline-flex items-center gap-0.5 rounded-lg border border-edge bg-panelHover px-2 py-0.5 text-[10px] text-slate-300 hover:text-white disabled:opacity-30"
                >
                  <ChevronLeft className="w-3 h-3" /> 上级目录
                </button>
                <button
                  type="button"
                  disabled={transferBusy}
                  onClick={() => void loadDeviceFiles(transferListing?.currentPath)}
                  className="rounded-lg border border-edge bg-panelHover p-1 text-slate-300 hover:text-white disabled:opacity-40"
                  aria-label="刷新远端目录"
                >
                  <RefreshCw className={`w-3 h-3 ${transferBusy ? "animate-spin" : ""}`} />
                </button>
              </div>

              <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-xl border border-edge bg-obsidian/60 p-1.5">
                {!transferListing || transferListing.entries.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[11px] text-slate-500">
                    {transferBusy ? "正在读取远端目录…" : "此目录为空，可拖入文件上传"}
                  </div>
                ) : (
                  transferListing.entries.map((entry) => (
                    <div key={entry.path} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-panelHover">
                      {entry.isDirectory ? (
                        <Folder className="w-3.5 h-3.5 shrink-0 text-amber-300" />
                      ) : (
                        <FileIcon className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                      )}
                      {entry.isDirectory ? (
                        <button
                          type="button"
                          onClick={() => void loadDeviceFiles(entry.path)}
                          className="min-w-0 flex-1 truncate text-left text-[11px] text-slate-200 hover:text-sky-200"
                          title={entry.path}
                        >
                          {entry.name}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300" title={entry.path}>
                          {entry.name}
                        </span>
                      )}
                      {!entry.isDirectory && (
                        <>
                          <span className="shrink-0 text-[10px] text-slate-500">
                            {entry.size >= 1024 * 1024
                              ? `${(entry.size / (1024 * 1024)).toFixed(1)} MB`
                              : `${Math.max(1, Math.round(entry.size / 1024))} KB`}
                          </span>
                          <button
                            type="button"
                            disabled={transferBusy}
                            onClick={() => void handleDownloadEntry(entry)}
                            className="inline-flex shrink-0 items-center gap-0.5 rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                          >
                            <ArrowDownToLine className="w-2.5 h-2.5" /> 另存为
                          </button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {transferTasks.length > 0 && (
              <div className="max-h-32 space-y-1 overflow-y-auto">
                {transferTasks.map((task) => {
                  const percent =
                    task.total > 0
                      ? Math.min(100, Math.round((task.transferred / task.total) * 100))
                      : task.status === "done"
                        ? 100
                        : 0;
                  return (
                    <div key={task.id} className="rounded-lg border border-edge bg-obsidian/60 px-2 py-1">
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className="min-w-0 flex-1 truncate text-slate-200">{task.filename}</span>
                        <span
                          className={`shrink-0 rounded-full border px-1.5 text-[9px] font-bold ${
                            task.status === "done"
                              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                              : task.status === "error"
                                ? "border-red-500/35 bg-red-500/10 text-red-200"
                                : "border-sky-500/35 bg-sky-500/10 text-sky-200"
                          }`}
                        >
                          {task.status === "done" ? "完成" : task.status === "error" ? "失败" : `${percent}%`}
                        </span>
                      </div>
                      {task.status === "error" && task.message && (
                        <div className="mt-0.5 truncate text-[9px] text-red-300">{task.message}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Access Password Modal */}
      {passwordPrompt && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-edge bg-panel p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-amber-300" />
                  <h3 className="font-bold text-slate-100">需要访问密码</h3>
                </div>
                <p className="text-xs text-slate-400">
                  目标主机「{passwordPrompt.device.name}」已启用访问密码保护。
                </p>
              </div>
              <button
                type="button"
                onClick={closePasswordPrompt}
                disabled={submittingPassword}
                className="text-slate-400 hover:text-slate-100 disabled:opacity-40"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 text-[11px]">
              <span className="rounded-full border border-edge bg-obsidian/70 px-2 py-0.5 text-slate-300">
                {MODE_LABELS[passwordPrompt.mode]}
              </span>
              <span className="text-slate-500">加密直连通道</span>
            </div>

            <form onSubmit={submitPassword} className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block text-slate-400">访问密码 / 6 位临时密码</label>
                <input
                  type="password"
                  autoFocus
                  autoComplete="off"
                  value={passwordDraft}
                  onChange={(e) => {
                    setPasswordDraft(e.target.value);
                    setPasswordError("");
                  }}
                  placeholder="请输入对方提供的密码"
                  className="w-full rounded-xl border border-edge bg-panelHover px-3 py-2 text-sm font-mono tracking-widest text-slate-100"
                />
              </div>

              <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={(e) => setRememberPassword(e.target.checked)}
                  className="rounded border-edge bg-panelHover text-sky-400"
                />
                记住此设备密码
              </label>

              {passwordError && (
                <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                  {passwordError}
                </div>
              )}

              {retryCountdown > 0 && (
                <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                  密码错误次数过多，请在 {retryCountdown} 秒后重试。
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={submittingPassword || retryCountdown > 0}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-400 to-blue-500 px-4 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-50"
                >
                  {submittingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                  验证并连接
                </button>
                <button
                  type="button"
                  onClick={closePasswordPrompt}
                  disabled={submittingPassword}
                  className="rounded-xl border border-edge bg-panelHover px-4 py-2.5 text-sm text-slate-300 disabled:opacity-40"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Device Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-edge bg-panel p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-100">编辑设备信息</h3>
              <button type="button" onClick={() => setEditTarget(null)} className="text-slate-400 hover:text-slate-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={submitEdit} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">设备名称</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  className="w-full rounded-xl border border-edge bg-panelHover px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">唤醒网卡 MAC（用于 WOL 远程开机）</label>
                <input
                  value={editMac}
                  onChange={(e) => setEditMac(e.target.value)}
                  placeholder="aa:bb:cc:dd:ee:ff"
                  className="w-full rounded-xl border border-edge bg-panelHover px-3 py-2 text-sm text-slate-100 font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">可见范围</label>
                <select
                  value={editVis}
                  onChange={(e) => setEditVis(e.target.value as "team" | "private")}
                  className="w-full rounded-xl border border-edge bg-panelHover px-3 py-2 text-sm text-slate-100"
                >
                  <option value="team">团队可见（所有同事可连）</option>
                  <option value="private">仅自己可见</option>
                </select>
              </div>
              <button type="submit" className="w-full rounded-xl bg-sky-400 py-2.5 text-sm font-bold text-slate-950">
                保存修改
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
