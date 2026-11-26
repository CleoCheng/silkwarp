import { Activity, RefreshCw, ShieldAlert } from "lucide-react";
import type { EasyTierStatus } from "../../electron/types";

interface NetworkViewProps {
  easytier: EasyTierStatus;
  onStartEasyTier: () => Promise<void>;
  onRelaunchAdmin: () => Promise<void>;
  onRefresh: () => Promise<void>;
  notify: (msg: string) => void;
}

export function NetworkView({ easytier, onStartEasyTier, onRelaunchAdmin, onRefresh, notify }: NetworkViewProps) {
  return (
    <div className="space-y-4">
      {easytier.needsElevation && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-amber-100">
            <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0" />
            <span>{easytier.error || "Windows 创建 Wintun 虚拟网卡需要管理员权限。"}</span>
          </div>
          <button
            type="button"
            onClick={() => void onRelaunchAdmin().catch((e) => notify(e instanceof Error ? e.message : String(e)))}
            className="rounded-xl bg-amber-400 px-3.5 py-1.5 text-xs font-bold text-slate-950"
          >
            以管理员权限重启 SilkWarp
          </button>
        </div>
      )}

      <div className="rounded-2xl border border-edge bg-panel p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Activity className={`w-5 h-5 ${easytier.running ? "text-emerald-400" : "text-slate-400"}`} />
          <div>
            <div className="font-bold text-sm text-slate-100">
              EasyTier 私有 Mesh 状态：{easytier.running ? "已连接骨干网" : "未启动"}
            </div>
            <div className="text-xs text-slate-400">
              本机虚拟 IP：{easytier.meshIp || "-"} {easytier.externalService ? "· 托管自系统服务" : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!easytier.running && (
            <button
              type="button"
              onClick={() => void onStartEasyTier()}
              className="rounded-xl bg-sky-400 px-3.5 py-1.5 text-xs font-bold text-slate-950"
            >
              启动虚拟网卡
            </button>
          )}
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-edge bg-panelHover px-3 py-1.5 text-xs font-medium text-slate-200"
          >
            <RefreshCw className="w-3.5 h-3.5" /> 刷新节点路由
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-edge bg-panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-panelHover text-slate-400 border-b border-edge">
              <tr className="whitespace-nowrap">
                <th className="px-4 py-3">虚拟 IP</th>
                <th className="px-4 py-3">节点名称</th>
                <th className="px-4 py-3">链路方式</th>
                <th className="px-4 py-3">延迟</th>
                <th className="px-4 py-3">丢包</th>
                <th className="px-4 py-3">协议 / NAT</th>
                <th className="px-4 py-3">收 / 发流量</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge/60 text-slate-200">
              {easytier.peers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    暂无 EasyTier 路由表数据。
                  </td>
                </tr>
              ) : (
                easytier.peers.map((p, idx) => (
                  <tr key={idx} className="hover:bg-panelHover/50 whitespace-nowrap">
                    <td className="px-4 py-2.5 font-mono">{p.ipv4 || "-"}</td>
                    <td className="px-4 py-2.5 font-medium">{p.hostname}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          p.cost === "p2p"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : p.cost === "Local"
                              ? "bg-sky-500/15 text-sky-300"
                              : "bg-amber-500/15 text-amber-300"
                        }`}
                      >
                        {p.cost}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">{p.latencyMs != null ? `${p.latencyMs.toFixed(1)} ms` : "-"}</td>
                    <td className="px-4 py-2.5">{p.loss}</td>
                    <td className="px-4 py-2.5">{p.tunnel} · {p.nat}</td>
                    <td className="px-4 py-2.5 text-slate-400">{p.rx} / {p.tx}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
