import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Shield,
  Wrench,
} from "lucide-react";
import type { AppRuntimeState } from "../../electron/types";

interface HostModeViewProps {
  state: AppRuntimeState;
  onUpdateHostSettings: (patch: {
    isHost?: boolean;
    autoApprovePair?: boolean;
    autoStart?: boolean;
    apolloUser?: string;
    apolloPass?: string;
  }) => Promise<void>;
  onRetryProvision: () => Promise<void>;
  onConfigureFirewall: () => Promise<void>;
  onConfigureRustDesk: () => Promise<void>;
  onInstallApollo: () => Promise<void>;
  onInstallRustDesk: () => Promise<void>;
  onOpenExternal: (url: string) => Promise<void>;
  notify: (msg: string) => void;
}

export function HostModeView({
  state,
  onUpdateHostSettings,
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
  const { host, easytier, settings, lastPairLogs } = state;

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
