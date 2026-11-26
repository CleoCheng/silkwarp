import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Gauge,
  Keyboard,
  Layers,
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
  Wifi,
  Zap,
} from "lucide-react";
import { getBridge } from "../bridge";
import type {
  ActiveSessionState,
  DisplayMode,
  StreamAppTarget,
  StreamPreset,
  SystemActionType,
  SystemKeyCaptureMode,
} from "../../electron/types";

const RESOLUTION_PRESETS: Array<{ label: string; value: string }> = [
  { label: "720P", value: "1280x720" },
  { label: "1080P", value: "1920x1080" },
  { label: "2K", value: "2560x1440" },
  { label: "4K", value: "3840x2160" },
];

const FPS_PRESETS: Array<StreamPreset["fps"]> = [30, 60, 120, 144];

function routeLabel(routeType: string): string {
  const r = routeType.toLowerCase();
  if (r.startsWith("relay")) return "中继";
  if (r === "p2p") return "直连";
  if (r === "local") return "本地";
  return routeType || "未知";
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

export function SessionBar() {
  const bridge = useMemo(() => getBridge(), []);
  const [state, setState] = useState<ActiveSessionState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [draftBitrate, setDraftBitrate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<SystemActionType | null>(null);
  const [actionBanner, setActionBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const dragRef = useRef<{ lastX: number; moved: boolean } | null>(null);
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

  if (!state) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <div className="rounded-full border border-white/10 bg-[#101522]/90 px-4 py-1.5 text-[11px] text-slate-400 backdrop-blur-xl">
          正在等待远程会话…
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
      <div className="flex h-full w-full items-center bg-transparent px-1 py-1">
        <div className="flex h-full w-full items-center gap-2 rounded-full border border-white/10 bg-[#0d1220]/85 px-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl">
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

          {cappedByRelay && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-200">
              中继保护
            </span>
          )}

          <button
            type="button"
            aria-label={isFullscreen ? "切换为窗口" : "切换为全屏"}
            title={isFullscreen ? "切换为窗口" : "切换为全屏"}
            onClick={() => void bridge.toggleSessionFullscreen().then((next) => next && setState(next))}
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
    <div className="flex h-full w-full bg-transparent p-1">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d1220]/92 shadow-[0_16px_50px_rgba(0,0,0,0.6)] backdrop-blur-2xl">
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
              <RefreshCw className="h-2.5 w-2.5 animate-spin" /> 应用参数并重连…
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

        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-2.5 text-slate-200">
          {/* Section 1: display */}
          <div className="space-y-1.5">
            <SectionTitle icon={<Monitor className="h-3 w-3 text-sky-400" />}>画面与窗口</SectionTitle>

            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <div className="mb-0.5 text-[9px] text-slate-500">显示模式</div>
                <Segmented<DisplayMode>
                  value={preset.displayMode}
                  options={[
                    { value: "windowed", label: "窗口" },
                    { value: "borderless", label: "无边框" },
                    { value: "fullscreen", label: "全屏" },
                  ]}
                  onChange={(displayMode) => patchOptions({ displayMode })}
                />
              </div>
              <div>
                <div className="mb-0.5 text-[9px] text-slate-500">画面源</div>
                <Segmented<StreamAppTarget>
                  value={preset.streamApp}
                  options={[
                    { value: "Virtual Display", label: "虚拟屏" },
                    { value: "Desktop", label: "物理桌面" },
                  ]}
                  onChange={(streamApp) => patchOptions({ streamApp })}
                />
              </div>
            </div>

            <div>
              <div className="mb-0.5 flex items-center justify-between text-[9px] text-slate-500">
                <span>分辨率 {preset.resolution}</span>
                <button
                  type="button"
                  onClick={() => void bridge.fitSessionWindow().then((next) => next && setState(next))}
                  className="rounded border border-sky-400/40 bg-sky-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-sky-200 hover:bg-sky-400/20"
                >
                  适应窗口
                </button>
              </div>
              <div className="flex gap-1">
                {RESOLUTION_PRESETS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => patchOptions({ resolution: r.value })}
                    className={`flex-1 rounded-md border px-1 py-1 text-[10px] font-semibold ${
                      preset.resolution === r.value
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
                label="低延迟零缓冲"
                hint="去 V-Sync + 抗分片"
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
              切办公模式（0ms 本地光标）
            </button>
          </div>

          {/* Section 3: quick actions + Stage 2 live controls */}
          <div className="space-y-1.5">
            <SectionTitle icon={<Gauge className="h-3 w-3 text-slate-400" />}>快捷操作</SectionTitle>
            <div className="flex flex-wrap gap-1">
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
                Host Companion Agent 未连接，无法切换被控端显示器
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
                hint={state.agentConnected ? "被控端扬声器主静音" : "本机静音（Agent 未连接）"}
              />
              <Toggle
                checked={state.privacyActive}
                onChange={(next) => void handlePrivacy(next)}
                disabled={!state.agentConnected || !state.privacySupported}
                title="被控端物理屏全黑，采集侧仍可见真实桌面；在被控端按 Ctrl+Alt+Shift+P 可立即恢复显示"
                label="防窥隐私屏"
                hint={
                  !state.agentConnected
                    ? "需要被控端 Host Companion Agent"
                    : state.privacySupported
                      ? "被控端物理屏黑屏，本机 Ctrl+Alt+Shift+P 可救援"
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

            {actionBanner && (
              <div
                className={`rounded-lg border px-2 py-1 text-[10px] ${
                  actionBanner.ok
                    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                    : "border-red-400/30 bg-red-500/10 text-red-100"
                }`}
              >
                {actionBanner.text}
              </div>
            )}
          </div>

          {/* Stage 3 banner */}
          <div className="rounded-lg border border-dashed border-white/10 bg-black/10 px-2 py-1 text-[9px] text-slate-500">
            阶段 3 即将接入：拖拽传文件 · 双向剪贴板同步
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-white/10 px-3 py-1.5 text-[9px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <Radio className="h-2.5 w-2.5" /> {state.resolvedApp}
            {state.availableApps.length > 0 ? ` · ${state.availableApps.length} 个应用` : ""}
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
