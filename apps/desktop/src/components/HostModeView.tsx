import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  MousePointer2,
  RefreshCw,
  Shield,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import type { AppRuntimeState } from "../../electron/types";
import type { AccessPasswordPayload } from "../../electron/preload";

interface HostModeViewProps {
  state: AppRuntimeState;
  onUpdateHostSettings: (patch: {
    isHost?: boolean;
    autoApprovePair?: boolean;
    autoStart?: boolean;
    apolloUser?: string;
    apolloPass?: string;
  }) => Promise<void>;
  onSetAccessPassword: (payload: AccessPasswordPayload) => Promise<void>;
  onRotateTempPassword: () => Promise<void>;
  onRetryProvision: () => Promise<void>;
  onConfigureFirewall: () => Promise<void>;
  onConfigureRustDesk: () => Promise<void>;
  onInstallApollo: () => Promise<void>;
  onInstallRustDesk: () => Promise<void>;
  onOpenExternal: (url: string) => Promise<void>;
  notify: (msg: string) => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function HostModeView({
  state,
  onUpdateHostSettings,
  onSetAccessPassword,
  onRotateTempPassword,
  onRetryProvision,
  onConfigureFirewall,
  onConfigureRustDesk,
  onInstallApollo,
  onInstallRustDesk,
  onOpenExternal,
  notify,
}: HostModeViewProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [apolloUser, setApolloUser] = useState(state.settings.apolloUser);
  const [apolloPass, setApolloPass] = useState(state.settings.apolloPass);
  const [permanentPassword, setPermanentPassword] = useState("");
  const [showTempPassword, setShowTempPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [rotatingTemp, setRotatingTemp] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { host, easytier, settings, lastPairLogs } = state;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const tempPasswordRemainingMin = useMemo(() => {
    if (!settings.tempAccessPassword || !settings.tempAccessPasswordExpiresAt) return 0;
    return Math.max(0, Math.ceil((settings.tempAccessPasswordExpiresAt - now) / 60_000));
  }, [settings.tempAccessPassword, settings.tempAccessPasswordExpiresAt, now]);

  async function saveAccessPassword(patch: AccessPasswordPayload): Promise<boolean> {
    setSavingPassword(true);
    try {
      await onSetAccessPassword(patch);
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleSetPermanentPassword() {
    const value = permanentPassword.trim();
    if (value.length < 4) {
      notify("固定访问密码至少需要 4 个字符");
      return;
    }
    if (await saveAccessPassword({ permanentPassword: value, requireAccessPassword: true })) {
      setPermanentPassword("");
      notify("固定访问密码已更新，旧令牌已全部失效");
    }
  }

  async function handleCopyTempPassword() {
    if (!settings.tempAccessPassword) return;
    const ok = await copyText(settings.tempAccessPassword);
    notify(ok ? "临时访问密码已复制到剪贴板" : "复制失败，请手动选中密码复制");
  }

  async function handleRotateTempPassword() {
    setRotatingTemp(true);
    try {
      await onRotateTempPassword();
      setShowTempPassword(true);
      notify("已生成新的 6 位临时访问密码（30 分钟内有效）");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setRotatingTemp(false);
    }
  }

  const isProvisioning =
    host.provisionStage === "configuring_firewall" ||
    host.provisionStage === "installing_apollo" ||
    host.provisionStage === "starting_apollo" ||
    host.provisionStage === "initializing_apollo" ||
    host.provisionStage === "reinstalling_apollo";

  const readinessItems = [
    { label: "虚拟内网", ok: easytier.running },
    { label: "高清引擎", ok: host.apolloInstalled && host.apolloRunning },
    { label: "静默握手", ok: host.apolloAuthReady },
    { label: "防火墙保护", ok: host.firewallConfigured },
  ];

  return (
    <div className="space-y-5">
      {/* Main Host Switch */}
      <div className="rounded-2xl border border-edge bg-panel p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-bold text-slate-50">本机受控服务</h2>
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full font-medium border ${
                  settings.isHost
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35"
                    : "bg-slate-800 text-slate-400 border-edge"
                }`}
              >
                {settings.isHost ? "已开启" : "已关闭"}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              默认全自动后台静默部署高清串流与自动配对握手，其他设备登录后点击「立即远程」即可直接连接本机。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.autoStart}
                onChange={(e) => void onUpdateHostSettings({ autoStart: e.target.checked })}
                className="rounded border-edge bg-panelHover text-sky-400"
              />
              开机自启 SilkWarp
            </label>
            <button
              type="button"
              onClick={() => void onUpdateHostSettings({ isHost: !settings.isHost })}
              className={`rounded-xl px-5 py-2.5 text-sm font-bold transition-colors ${
                settings.isHost
                  ? "bg-red-500/20 text-red-200 border border-red-500/40 hover:bg-red-500/30"
                  : "bg-gradient-to-r from-sky-400 to-blue-500 text-slate-950"
              }`}
            >
              {settings.isHost ? "关闭被控" : "允许本机被远程"}
            </button>
          </div>
        </div>

        {/* 4-dot automatic readiness status bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-edge/60">
          {readinessItems.map((item) => (
            <div
              key={item.label}
              className="rounded-xl border border-edge/80 bg-obsidian/70 px-3.5 py-2.5 flex items-center justify-between text-xs"
            >
              <span className="text-slate-300 font-medium">{item.label}</span>
              <span className={`inline-flex items-center gap-1 font-semibold ${item.ok ? "text-emerald-300" : "text-amber-300"}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                {item.ok ? "就绪" : isProvisioning ? "准备中" : "待完成"}
              </span>
            </div>
          ))}
        </div>

        {settings.isHost && host.provisionStage !== "ready" && (
          <div className="rounded-xl border border-sky-500/35 bg-sky-500/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-sky-100">
            <div className="flex items-center gap-2">
              {isProvisioning && <Loader2 className="w-4 h-4 animate-spin text-sky-300 shrink-0" />}
              <span>{host.provisionMessage || "正在检测并自动准备受控环境..."}</span>
            </div>
            {(host.provisionStage === "error" || host.provisionStage === "idle") && (
              <button
                type="button"
                onClick={() => void onRetryProvision().catch((e) => notify(e.message))}
                className="inline-flex items-center gap-1 rounded-lg bg-sky-400 px-3 py-1 font-bold text-slate-950"
              >
                <RefreshCw className="w-3 h-3" /> 重试自动部署
              </button>
            )}
          </div>
        )}
      </div>

      {/* Access password & security */}
      <div className="rounded-2xl border border-edge bg-panel p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-sky-300" />
              <h3 className="text-sm font-bold text-slate-50">访问密码与安全保护</h3>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${
                  host.agentRunning
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35"
                    : "bg-slate-800 text-slate-400 border-edge"
                }`}
              >
                Companion Agent · {host.agentRunning ? `${host.agentPort} 运行中` : "未启动"}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">
              开启后，其他设备连接本机前必须输入访问密码；同账号设备可配置免密直连。
              密码仅以哈希保存在本机，不会上传到控制中心。
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
          <label className="flex items-center justify-between gap-2 rounded-xl border border-edge bg-obsidian/60 px-3 py-2.5 text-xs cursor-pointer">
            <span className="text-slate-300">
              启用访问密码保护
              <span className="block text-[10px] text-slate-500">连接前校验密码或临时码</span>
            </span>
            <input
              type="checkbox"
              checked={settings.requireAccessPassword}
              disabled={savingPassword}
              onChange={(e) => {
                const next = e.target.checked;
                void saveAccessPassword({ requireAccessPassword: next }).then((ok) => {
                  if (ok) {
                    notify(next ? "已开启访问密码保护" : "已关闭访问密码保护，所有已授权令牌已失效");
                  }
                });
              }}
              className="h-4 w-4 rounded border-edge bg-panelHover text-sky-400"
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-xl border border-edge bg-obsidian/60 px-3 py-2.5 text-xs cursor-pointer">
            <span className="text-slate-300">
              同账号设备免密直连
              <span className="block text-[10px] text-slate-500">信任同一账号下的设备</span>
            </span>
            <input
              type="checkbox"
              checked={settings.allowSameAccountBypass}
              disabled={savingPassword}
              onChange={(e) => void saveAccessPassword({ allowSameAccountBypass: e.target.checked })}
              className="h-4 w-4 rounded border-edge bg-panelHover text-sky-400"
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-xl border border-edge bg-obsidian/60 px-3 py-2.5 text-xs cursor-pointer">
            <span className="text-slate-300">
              断开远程后自动锁屏
              <span className="block text-[10px] text-slate-500">防止远程结束后本机无人值守</span>
            </span>
            <input
              type="checkbox"
              checked={settings.autoLockOnDisconnect}
              disabled={savingPassword}
              onChange={(e) => {
                const next = e.target.checked;
                void saveAccessPassword({ autoLockOnDisconnect: next }).then((ok) => {
                  if (ok) notify(next ? "已开启断开后自动锁屏" : "已关闭断开后自动锁屏");
                });
              }}
              className="h-4 w-4 rounded border-edge bg-panelHover text-sky-400"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Fixed password */}
          <div className="rounded-xl border border-edge bg-obsidian/60 p-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 font-bold text-slate-200">
                <Lock className="w-3.5 h-3.5 text-sky-400" /> 固定访问密码
              </span>
              <span className={settings.hasAccessPassword ? "text-emerald-300" : "text-amber-300"}>
                {settings.hasAccessPassword ? "已配置固定密码" : "未设置"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="password"
                autoComplete="new-password"
                placeholder="输入新的固定访问密码"
                value={permanentPassword}
                onChange={(e) => setPermanentPassword(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-edge bg-panelHover px-2.5 py-1.5 text-xs text-slate-100"
              />
              <button
                type="button"
                disabled={savingPassword}
                onClick={() => void handleSetPermanentPassword()}
                className="inline-flex items-center gap-1 rounded-lg bg-sky-400 px-3 py-1.5 text-xs font-bold text-slate-950 disabled:opacity-50"
              >
                {savingPassword ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
                设置/更新固定密码
              </button>
              {settings.hasAccessPassword && (
                <button
                  type="button"
                  disabled={savingPassword}
                  onClick={() =>
                    void saveAccessPassword({ clearPermanentPassword: true }).then(() =>
                      notify("固定访问密码已清除，已授权令牌全部失效"),
                    )
                  }
                  className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/20 disabled:opacity-50"
                >
                  清除固定密码
                </button>
              )}
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              固定密码以 PBKDF2-SHA512 哈希保存在本机；修改或清除后所有已授权客户端需重新验证。
            </p>
          </div>

          {/* Temporary password */}
          <div className="rounded-xl border border-edge bg-obsidian/60 p-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 font-bold text-slate-200">
                <KeyRound className="w-3.5 h-3.5 text-amber-300" /> 临时访问密码
              </span>
              {settings.requireAccessPassword && settings.tempAccessPassword ? (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                    tempPasswordRemainingMin > 0
                      ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                      : "border-red-500/35 bg-red-500/10 text-red-200"
                  }`}
                >
                  {tempPasswordRemainingMin > 0 ? `剩余 ${tempPasswordRemainingMin} 分钟` : "已过期"}
                </span>
              ) : (
                <span className="text-slate-500">开启保护后自动生成</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-edge bg-panelHover px-3 py-1.5">
                <span className="font-mono text-lg font-bold tracking-[0.25em] text-amber-200">
                  {settings.requireAccessPassword && settings.tempAccessPassword
                    ? showTempPassword
                      ? settings.tempAccessPassword
                      : "••••••"
                    : "------"}
                </span>
                <button
                  type="button"
                  aria-label={showTempPassword ? "隐藏临时密码" : "显示临时密码"}
                  onClick={() => setShowTempPassword((v) => !v)}
                  className="ml-auto rounded p-1 text-slate-400 hover:text-slate-100"
                >
                  {showTempPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <button
                type="button"
                disabled={!settings.tempAccessPassword}
                onClick={() => void handleCopyTempPassword()}
                className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-2.5 py-1.5 text-xs text-slate-200 hover:text-white disabled:opacity-40"
              >
                <Copy className="w-3 h-3" /> 复制
              </button>
              <button
                type="button"
                disabled={rotatingTemp || !settings.requireAccessPassword}
                title={settings.requireAccessPassword ? undefined : "请先开启访问密码保护"}
                onClick={() => void handleRotateTempPassword()}
                className="inline-flex items-center gap-1 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
              >
                {rotatingTemp ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                刷新临时码
              </button>
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              6 位临时密码 30 分钟内有效，适合临时让同事连接；过期后自动作废，刷新会立即替换旧码。
            </p>
          </div>
        </div>
      </div>

      {host.uuRemoteDetected && (
        <div className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4 flex items-start gap-3 text-xs text-amber-100 leading-relaxed">
          <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          <div>
            <strong className="text-amber-200">检测到本机正在运行网易 UU 远程（GameViewer）：</strong>
            SilkWarp 使用独立虚拟网段 <code className="px-1 py-0.5 rounded bg-black/30">{state.bootstrap?.mesh_cidr || "独立私有网段"}</code>（与 UU 远程及 Clash 无端口/路由冲突）。
            建议避免同时用 UU 远程和 SilkWarp 向本机并发发起串流，以免抢占显卡编码与虚拟显示器。
          </div>
        </div>
      )}

      {/* Office-mode RustDesk channel */}
      <div className="rounded-2xl border border-emerald-500/25 bg-panel p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <MousePointer2 className="w-4 h-4 text-emerald-300" />
              <h3 className="text-sm font-bold text-slate-50">办公极速光标通道（自建 RustDesk）</h3>
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full font-medium border ${
                  host.rustdeskInstalled
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/35"
                    : "bg-slate-800 text-slate-400 border-edge"
                }`}
              >
                {host.rustdeskInstalled ? "已安装" : "未安装"}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">
              高刷看视频、设计渲染请使用上面的 Apollo 低延迟串流；文字办公、精细点击、操作锁屏 / UAC 弹窗时，
              其他设备可一键切入 RustDesk，获得 <strong className="text-emerald-200">0ms 本地硬件光标</strong>。
              本机只需配齐自建中继与公钥，其他设备即可随时切入。
            </p>
          </div>

          <div className="rounded-xl border border-edge bg-obsidian/70 px-4 py-2.5 text-xs min-w-[170px]">
            <div className="text-slate-500">当前 RustDesk ID</div>
            <div className="mt-0.5 font-mono text-base font-bold text-emerald-200">
              {host.rustdeskId || "未读取到"}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-[11px]">
          <div className="rounded-xl border border-edge bg-obsidian/60 px-3 py-2 flex items-center justify-between">
            <span className="text-slate-400">RustDesk 客户端</span>
            <span className={host.rustdeskInstalled ? "text-emerald-300 font-semibold" : "text-amber-300 font-semibold"}>
              {host.rustdeskInstalled ? "已安装" : "待安装"}
            </span>
          </div>
          <div className="rounded-xl border border-edge bg-obsidian/60 px-3 py-2 flex items-center justify-between">
            <span className="text-slate-400">本机 ID 上报</span>
            <span className={host.rustdeskId ? "text-emerald-300 font-semibold" : "text-amber-300 font-semibold"}>
              {host.rustdeskId ? "已就绪" : "待同步"}
            </span>
          </div>
          <div className="rounded-xl border border-edge bg-obsidian/60 px-3 py-2 flex items-center justify-between">
            <span className="text-slate-400">自建中继 / 公钥</span>
            <span className={state.bootstrap?.rustdesk?.public_key ? "text-emerald-300 font-semibold" : "text-slate-400 font-semibold"}>
              {state.bootstrap?.rustdesk?.public_key ? "已下发" : "登录后自动下发"}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!host.rustdeskInstalled ? (
            <button
              type="button"
              onClick={() => void onInstallRustDesk().then(() => notify("已下载并启动 RustDesk 安装，完成后将自动接入自建中继")).catch((e) => notify(e.message))}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-500 px-4 py-2 text-xs font-bold text-slate-950 hover:opacity-95"
            >
              <Download className="w-3.5 h-3.5" /> 一键安装并接入自建中继
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onConfigureRustDesk().then(() => notify("已同步自建 RustDesk 中继配置")).catch((e) => notify(e.message))}
              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-500/25"
            >
              <Wrench className="w-3.5 h-3.5" /> 同步自建服务器配置
            </button>
          )}
          <button
            type="button"
            onClick={() => void onOpenExternal("https://rustdesk.com/docs/en/self-host/").catch((e) => notify(e.message))}
            className="inline-flex items-center gap-1 rounded-xl border border-edge bg-panelHover px-3 py-2 text-xs text-slate-300 hover:text-white"
          >
            <ExternalLink className="w-3.5 h-3.5" /> 自建中继说明
          </button>
          {host.rustdeskInstalled && (
            <span className="text-[11px] text-slate-500">
              配置写入后会重启 RustDesk 使 ID / 中继立即生效。
            </span>
          )}
        </div>
      </div>

      {/* Collapsed Advanced Controls */}
      <div className="rounded-2xl border border-edge bg-panel overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full px-5 py-4 flex items-center justify-between text-xs font-semibold text-slate-300 hover:bg-panelHover/60 transition-colors"
        >
          <span>高级与运维设置（一般用户无需操作）</span>
          {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {showAdvanced && (
          <div className="p-5 pt-2 border-t border-edge/60 space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-edge bg-obsidian/60 p-4 space-y-3 text-xs">
                <div className="font-bold text-slate-200">串流与运维组件管理</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void onInstallApollo().then(() => notify("已启动 Apollo 安装向导")).catch((e) => notify(e.message))}
                    className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-3 py-1.5 text-slate-200"
                  >
                    <Download className="w-3.5 h-3.5 text-sky-400" /> 手动重装 Apollo
                  </button>
                  <button
                    type="button"
                    onClick={() => void onConfigureFirewall().then(() => notify("防火墙规则已刷新")).catch((e) => notify(e.message))}
                    className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-3 py-1.5 text-slate-200"
                  >
                    <Shield className="w-3.5 h-3.5 text-sky-400" /> 放行内网防火墙
                  </button>
                  <button
                    type="button"
                    onClick={() => void onOpenExternal("https://localhost:47990")}
                    className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-3 py-1.5 text-slate-200"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> 打开 Apollo 控制台
                  </button>
                  {!host.rustdeskInstalled ? (
                    <button
                      type="button"
                      onClick={() => void onInstallRustDesk().then(() => notify("已下载并启动 RustDesk 安装")).catch((e) => notify(e.message))}
                      className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-3 py-1.5 text-slate-200"
                    >
                      <Download className="w-3.5 h-3.5 text-sky-400" /> 安装 RustDesk 运维兜底
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onConfigureRustDesk().then(() => notify("已同步 RustDesk 配置")).catch((e) => notify(e.message))}
                      className="inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-3 py-1.5 text-slate-200"
                    >
                      <Wrench className="w-3.5 h-3.5 text-sky-400" /> 重写 RustDesk 配置 ({host.rustdeskId || "未读到ID"})
                    </button>
                  )}
                </div>

                <div className="pt-2 border-t border-edge/60 space-y-2">
                  <div className="text-slate-400">如需覆盖自动初始化的本地 Apollo 管理员凭据：</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder="Apollo 用户名"
                      value={apolloUser}
                      onChange={(e) => setApolloUser(e.target.value)}
                      className="rounded-lg border border-edge bg-panelHover px-2.5 py-1.5 text-slate-100"
                    />
                    <input
                      type="password"
                      placeholder="Apollo 密码"
                      value={apolloPass}
                      onChange={(e) => setApolloPass(e.target.value)}
                      className="rounded-lg border border-edge bg-panelHover px-2.5 py-1.5 text-slate-100"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void onUpdateHostSettings({ apolloUser, apolloPass }).then(() => notify("已保存并重新校验 Apollo 凭据"))
                    }
                    className="rounded-lg border border-edge bg-panelHover px-3 py-1.5 font-medium text-slate-200"
                  >
                    保存本地凭据
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-edge bg-obsidian/60 p-4 space-y-2 text-xs">
                <div className="font-bold text-slate-200">本机硬件与唤醒信息</div>
                <div className="flex justify-between py-1 border-b border-edge/50">
                  <span className="text-slate-400">主机名 / 权限</span>
                  <span className="text-slate-100">{host.hostname} ({host.isElevated ? "管理员" : "普通用户"})</span>
                </div>
                <div className="flex justify-between py-1 border-b border-edge/50">
                  <span className="text-slate-400">处理器</span>
                  <span className="text-slate-100 truncate max-w-[240px]">{host.cpu || "-"}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-edge/50">
                  <span className="text-slate-400">显卡</span>
                  <span className="text-slate-100 truncate max-w-[240px]">{host.gpu || "-"}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-edge/50">
                  <span className="text-slate-400">MAC / 广播</span>
                  <span className="text-slate-100 font-mono">{host.macAddress || "-"} · {host.broadcastIp}</span>
                </div>
                {lastPairLogs.length > 0 && (
                  <div className="pt-1 font-mono text-[11px] text-slate-300 space-y-0.5 max-h-24 overflow-y-auto">
                    {lastPairLogs.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
