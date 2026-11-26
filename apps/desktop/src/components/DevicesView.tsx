import { useEffect, useState } from "react";
import {
  Cpu,
  Edit3,
  KeyRound,
  Loader2,
  Lock,
  MonitorPlay,
  MousePointer2,
  Power,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import type { ConnectDeviceResult, DeviceInfo, StreamPreset } from "../../electron/types";
import type { ConnectOptions } from "../../electron/preload";

type ConnectMode = "connect" | "stream" | "rustdesk";

interface PasswordPrompt {
  device: DeviceInfo;
  mode: ConnectMode;
  message: string;
  retryAfterSec?: number;
}

const MODE_LABELS: Record<ConnectMode, string> = {
  connect: "高清串流",
  stream: "高清串流",
  rustdesk: "RustDesk 办公",
};

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
  { label: "流畅省流 · 1080P 60帧", preset: { resolution: "1920x1080", fps: 60, bitrateMbps: 15 } },
  { label: "超清高刷 · 2K 120帧", preset: { resolution: "2560x1440", fps: 120, bitrateMbps: 35 } },
  { label: "极致原画 · 4K 60帧", preset: { resolution: "3840x2160", fps: 60, bitrateMbps: 60 } },
];

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
    try {
      const res = await invoke(d, opts);
      if (res?.needsPassword) {
        setPasswordPrompt({
          device: d,
          mode,
          message: res.message || "此主机需要访问密码",
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
      if (res?.ok) closePasswordPrompt();
    } catch (err) {
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

  return (
    <div className="space-y-5">
      {/* Stream Preset Bar */}
      <div className="rounded-2xl border border-edge bg-panel p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_PRESETS.map((q) => {
              const active =
                preset.resolution === q.preset.resolution &&
                preset.fps === q.preset.fps &&
                preset.bitrateMbps === q.preset.bitrateMbps;
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => void onUpdatePreset({ ...preset, ...q.preset })}
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
              onChange={(e) => void onUpdatePreset({ ...preset, codec: e.target.value as StreamPreset["codec"] })}
              className="rounded-xl border border-edge bg-panelHover px-2.5 py-1.5 text-xs text-slate-200"
            >
              <option value="hevc">H.265 (推荐)</option>
              <option value="av1">AV1 (新显卡)</option>
              <option value="h264">H.264 (兼容)</option>
            </select>
          </div>

          <button
            type="button"
            onClick={() => void onRefresh()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-edge bg-panelHover px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-sky-500/50 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            刷新设备
          </button>
        </div>

        {/* Stage 1 quick switches */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-3 border-t border-edge/60 text-[11px]">
          <div className="flex items-center gap-1.5">
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
                  onClick={() => void onUpdatePreset({ ...preset, displayMode: m.value })}
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
            <span className="text-slate-500">画面源</span>
            <div className="flex rounded-lg border border-edge bg-obsidian/70 p-0.5">
              {([
                { value: "Virtual Display", label: "虚拟屏" },
                { value: "Desktop", label: "桌面" },
              ] as const).map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => void onUpdatePreset({ ...preset, streamApp: m.value })}
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

          <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={preset.muteHostAudio}
              onChange={(e) => void onUpdatePreset({ ...preset, muteHostAudio: e.target.checked })}
              className="rounded border-edge bg-panelHover text-sky-400"
            />
            被控端静音
          </label>

          <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={preset.lowLatency}
              onChange={(e) => void onUpdatePreset({ ...preset, lowLatency: e.target.checked })}
              className="rounded border-edge bg-panelHover text-sky-400"
            />
            低延迟抗分片
          </label>
        </div>
      </div>

      {/* Device Grid */}
      {devices.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-edge bg-panel/60 p-12 text-center text-sm text-slate-400">
          暂无可见设备。在另一台电脑安装 SilkWarp 并登录同一个账号，即可自动出现在此处。
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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
                className="rounded-2xl border border-edge bg-panel p-5 flex flex-col justify-between gap-4 hover:border-slate-600 transition-colors"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base text-slate-50 truncate">{d.name}</h3>
                        {isSelf && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-edge">
                            本机
                          </span>
                        )}
                        {d.has_access_password && (
                          <span
                            title="该主机已启用访问密码保护，连接时需输入密码或临时码"
                            className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-500/35"
                          >
                            <Lock className="w-2.5 h-2.5" />
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

                  {d.route_type?.startsWith("relay") &&
                    preset.adaptiveRelayCap &&
                    (preset.fps > 60 || preset.bitrateMbps > 15) && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                        <Zap className="w-3 h-3" /> 中继保护 60Hz
                      </span>
                    )}

                  <div className="rounded-xl bg-obsidian/70 border border-edge/70 p-3 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-slate-400 flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5 text-sky-400" /> 显卡
                      </span>
                      <span className="truncate max-w-[195px] font-medium">{d.gpu || "检测中"}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-300">
                      <span className="text-slate-400">网络链路</span>
                      <span className="font-medium">
                        {d.route_type === "p2p" ? (
                          <span className="text-emerald-300">P2P 直连</span>
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
                    {isSelf ? "当前本机" : isBusy ? "正在静默握手并连接..." : "立即远程"}
                  </button>

                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5">
                      {d.mac_address && (
                        <button
                          type="button"
                          onClick={() =>
                            void onWake(d)
                              .then(() => notify(`已向 ${d.name} 发送远程开机指令`))
                              .catch((e) => notify(e.message))
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-2.5 py-1 text-[11px] text-slate-200 hover:border-emerald-500/40"
                        >
                          <Power className="w-3 h-3 text-emerald-400" />
                          远程开机
                        </button>
                      )}
                      {d.rustdesk_id && !isSelf && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void runConnectAction("rustdesk", d)}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                          title="停止高刷串流并以本地 0ms 硬件光标接管，适合文字办公与锁屏/UAC 运维"
                        >
                          <MousePointer2 className="w-3 h-3" />
                          办公模式 (0ms光标)
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1 ml-auto">
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
                        onClick={() => void onDeleteDevice(d.id).catch((e) => notify(e.message))}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-300 hover:bg-red-500/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
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
              <span className="font-mono text-slate-500">{passwordPrompt.device.mesh_ip}</span>
              {passwordPrompt.device.agent_port ? (
                <span className="text-slate-500">Agent :{passwordPrompt.device.agent_port}</span>
              ) : null}
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
