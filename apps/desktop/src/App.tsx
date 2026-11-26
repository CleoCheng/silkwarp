import { useEffect, useMemo, useState } from "react";
import { Laptop, LogOut, Monitor, Network, ShieldAlert } from "lucide-react";
import { getBridge } from "./bridge";
import { AdminView } from "./components/AdminView";
import { DevicesView } from "./components/DevicesView";
import { HostModeView } from "./components/HostModeView";
import { LoginView } from "./components/LoginView";
import type { AppRuntimeState } from "../electron/types";

type TabId = "devices" | "host" | "admin";

export default function App() {
  const bridge = useMemo(() => getBridge(), []);
  const [state, setState] = useState<AppRuntimeState | null>(null);
  const [tab, setTab] = useState<TabId>("devices");
  const [toastMsg, setToastMsg] = useState("");

  function notify(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((cur) => (cur === msg ? "" : cur)), 5500);
  }

  useEffect(() => {
    void bridge.getState().then(setState);
    return bridge.onStateChanged(setState);
  }, [bridge]);

  if (!state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-obsidian text-slate-400 text-sm">
        正在初始化 SilkWarp...
      </div>
    );
  }

  if (!state.authenticated || !state.user) {
    return (
      <LoginView
        initialApiUrl={state.settings.apiUrl}
        onLogin={async (args) => {
          const next = await bridge.login(args);
          setState(next);
        }}
      />
    );
  }

  return (
    <div className="h-screen overflow-hidden flex bg-obsidian text-slate-100">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-edge bg-panel/80 flex flex-col justify-between p-4 overflow-y-auto">
        <div className="space-y-6">
          <div className="flex items-center gap-3 px-2 pt-1">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-slate-950 font-black text-sm">
              SW
            </div>
            <div>
              <div className="font-bold text-sm tracking-tight text-slate-50">SilkWarp</div>
              <div className="text-[11px] text-slate-400">零配置极速远控</div>
            </div>
          </div>

          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => setTab("devices")}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
                tab === "devices" ? "bg-sky-500/15 text-sky-300 border border-sky-500/35" : "text-slate-300 hover:bg-panelHover"
              }`}
            >
              <Monitor className="w-4 h-4" />
              我的设备
            </button>
            <button
              type="button"
              onClick={() => setTab("host")}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
                tab === "host" ? "bg-sky-500/15 text-sky-300 border border-sky-500/35" : "text-slate-300 hover:bg-panelHover"
              }`}
            >
              <Laptop className="w-4 h-4" />
              本机受控
            </button>
            <button
              type="button"
              onClick={() => setTab("admin")}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-colors ${
                tab === "admin" ? "bg-sky-500/15 text-sky-300 border border-sky-500/35" : "text-slate-300 hover:bg-panelHover"
              }`}
            >
              <Network className="w-4 h-4" />
              网络与账号
            </button>
          </nav>
        </div>

        <div className="space-y-3 pt-4 border-t border-edge">
          <div className="rounded-xl bg-obsidian border border-edge p-3 text-[11px] space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">当前账号</span>
              <span className="font-bold text-slate-200">{state.user.display_name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">本机虚拟 IP</span>
              <span className="font-mono text-sky-300">{state.easytier.meshIp || state.bootstrap?.mesh_ip || "-"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">受控服务</span>
              <span className={state.host.provisionStage === "ready" ? "text-emerald-300" : "text-amber-300"}>
                {!state.settings.isHost
                  ? "未开启"
                  : state.host.provisionStage === "ready"
                    ? "已就绪"
                    : !state.host.isElevated || state.easytier.needsElevation
                      ? "待授权"
                      : "准备中"}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void bridge.logout().then(setState)}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-edge bg-panelHover py-2 text-xs text-slate-300 hover:text-white"
          >
            <LogOut className="w-3.5 h-3.5" />
            退出登录
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-6 overflow-y-auto space-y-5">
        {state.easytier.needsElevation && (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-amber-100">
              <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0" />
              <span>开启虚拟内网与后台自动部署需要系统管理员授权（仅需点一次）。</span>
            </div>
            <button
              type="button"
              onClick={() => void bridge.relaunchAsAdmin().catch((e) => notify(e instanceof Error ? e.message : String(e)))}
              className="rounded-xl bg-amber-400 px-4 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-300 transition-colors"
            >
              一键授权启用
            </button>
          </div>
        )}

        {tab === "devices" && (
          <DevicesView
            devices={state.devices}
            selfDeviceId={state.settings.deviceId}
            preset={state.settings.preset}
            onUpdatePreset={async (p) => setState(await bridge.updatePreset(p))}
            onConnect={(d) => bridge.connectDevice(d)}
            onRustDesk={(d) => bridge.connectRustDesk(d)}
            onWake={async (d) => {
              await bridge.wakeDevice(d);
            }}
            onUpdateDevice={async (deviceId, patch) => setState(await bridge.updateDevice({ deviceId, patch }))}
            onDeleteDevice={async (deviceId) => setState(await bridge.deleteDevice(deviceId))}
            onRefresh={async () => setState(await bridge.refresh())}
            notify={notify}
          />
        )}

        {tab === "host" && (
          <HostModeView
            state={state}
            onUpdateHostSettings={async (patch) => setState(await bridge.updateHostSettings(patch))}
            onRetryProvision={async () => setState(await bridge.retryProvision())}
            onConfigureFirewall={async () => setState(await bridge.configureFirewall())}
            onConfigureRustDesk={async () => {
              await bridge.configureRustDesk();
            }}
            onInstallApollo={async () => {
              await bridge.installApollo();
            }}
            onInstallRustDesk={async () => {
              await bridge.installRustDesk();
            }}
            onOpenExternal={(url) => bridge.openExternal(url)}
            notify={notify}
          />
        )}

        {tab === "admin" && (
          <AdminView
            currentUser={state.user}
            apiUrl={state.bootstrap?.api_url || state.settings.apiUrl}
            bootstrap={state.bootstrap}
            easytier={state.easytier}
            onStartEasyTier={async () => setState(await bridge.startEasyTier())}
            onRelaunchAdmin={() => bridge.relaunchAsAdmin()}
            onRefresh={async () => setState(await bridge.refresh())}
            onListUsers={() => bridge.adminListUsers()}
            onCreateUser={(payload) => bridge.adminCreateUser(payload)}
            onUpdateUser={(userId, patch) => bridge.adminUpdateUser({ userId, patch })}
            onDeleteUser={(userId) => bridge.adminDeleteUser(userId)}
            notify={notify}
          />
        )}
      </main>

      {toastMsg && (
        <div className="fixed right-5 bottom-5 z-50 max-w-md rounded-xl border border-sky-400/60 bg-panel px-4 py-2.5 text-xs font-medium text-slate-100 shadow-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
