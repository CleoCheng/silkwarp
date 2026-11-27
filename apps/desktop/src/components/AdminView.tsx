import { useEffect, useRef, useState } from "react";
import { Activity, Copy, RefreshCw, Smartphone, UserPlus } from "lucide-react";
import type { BootstrapConfig, EasyTierStatus, UserInfo } from "../../electron/types";

interface AdminViewProps {
  currentUser: UserInfo;
  apiUrl: string;
  bootstrap: BootstrapConfig | null;
  easytier: EasyTierStatus;
  onStartEasyTier: () => Promise<void>;
  onReconnectUdp: () => Promise<void>;
  onRelaunchAdmin: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onListUsers: () => Promise<UserInfo[]>;
  onCreateUser: (payload: { username: string; display_name: string; password: string; role: "admin" | "member" }) => Promise<UserInfo>;
  onUpdateUser: (userId: string, patch: { enabled?: boolean }) => Promise<UserInfo>;
  onDeleteUser: (userId: string) => Promise<boolean>;
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

export function AdminView({
  currentUser,
  apiUrl,
  bootstrap,
  easytier,
  onStartEasyTier,
  onReconnectUdp,
  onRelaunchAdmin,
  onRefresh,
  onListUsers,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  notify,
}: AdminViewProps) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [reconnectingUdp, setReconnectingUdp] = useState(false);
  const [confirmDeleteUserId, setConfirmDeleteUserId] = useState<string>("");
  const confirmTimerRef = useRef<number | null>(null);

  async function reload() {
    if (currentUser.role !== "admin") return;
    const list = await onListUsers();
    setUsers(list);
  }

  useEffect(() => {
    void reload().catch(() => {});
  }, [currentUser.role]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  function armDeleteUser(userId: string) {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    if (confirmDeleteUserId === userId) {
      setConfirmDeleteUserId("");
      void onDeleteUser(userId)
        .then(async () => {
          notify("已删除成员账号");
          await reload();
        })
        .catch((err) => notify(err instanceof Error ? err.message : String(err)));
      return;
    }
    setConfirmDeleteUserId(userId);
    confirmTimerRef.current = window.setTimeout(() => {
      setConfirmDeleteUserId("");
    }, 4000);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await onCreateUser({ username, display_name: displayName || username, password, role });
      setUsername("");
      setDisplayName("");
      setPassword("");
      notify("成员账号已创建");
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "创建失败");
    }
  }

  async function copyVal(text: string, label: string) {
    const ok = await copyText(text);
    notify(ok ? `已复制 ${label}` : `复制 ${label} 失败，请手动选中复制`);
  }

  const hasTcpFallbackPeer = easytier.peers.some(
    (p) =>
      p.cost !== "Local" &&
      p.tunnel &&
      p.tunnel.toLowerCase().includes("tcp") &&
      !p.tunnel.toLowerCase().includes("udp"),
  );

  return (
    <div className="space-y-5">
      {/* Compact EasyTier Mesh Status & Routes */}
      <div className="rounded-2xl border border-edge bg-panel overflow-hidden">
        <div className="p-5 flex flex-wrap items-center justify-between gap-4 border-b border-edge">
          <div className="flex items-center gap-3">
            <Activity className={`w-5 h-5 ${easytier.running ? "text-emerald-400" : "text-slate-400"}`} />
            <div>
              <div className="font-bold text-sm text-slate-100">
                私有内网通道：{easytier.running ? "已连接骨干网" : "未启动"}
              </div>
              <div className="text-xs text-slate-400">本机虚拟 IP：{easytier.meshIp || "-"}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {easytier.needsElevation && (
              <button
                type="button"
                onClick={() => void onRelaunchAdmin().catch((e) => notify(e instanceof Error ? e.message : String(e)))}
                className="rounded-xl bg-amber-400 px-3 py-1.5 text-xs font-bold text-slate-950"
              >
                以管理员授权启用
              </button>
            )}
            {!easytier.running && !easytier.needsElevation && (
              <button
                type="button"
                onClick={() =>
                  void onStartEasyTier().catch((e) => notify(e instanceof Error ? e.message : String(e)))
                }
                className="rounded-xl bg-sky-400 px-3 py-1.5 text-xs font-bold text-slate-950"
              >
                启动虚拟网卡
              </button>
            )}
            {easytier.running && (
              <button
                type="button"
                disabled={reconnectingUdp}
                onClick={() => {
                  setReconnectingUdp(true);
                  void onReconnectUdp()
                    .then(() => notify("已重新触发纯 UDP 直连协商"))
                    .catch((e) => notify(e instanceof Error ? e.message : String(e)))
                    .finally(() => setReconnectingUdp(false));
                }}
                title="当隧道因临时断网回落为 TCP 时，点击可强制重新尝试纯 UDP 低延迟建链"
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                  hasTcpFallbackPeer
                    ? "border-amber-500/45 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
                    : "border-edge bg-panelHover text-slate-200 hover:border-sky-500/40"
                }`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${reconnectingUdp ? "animate-spin" : ""}`} />
                {reconnectingUdp ? "正在重建 UDP..." : "重建纯 UDP"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void onRefresh().catch((e) => notify(e instanceof Error ? e.message : String(e)))}
              className="inline-flex items-center gap-1.5 rounded-xl border border-edge bg-panelHover px-3 py-1.5 text-xs font-medium text-slate-200"
            >
              <RefreshCw className="w-3.5 h-3.5" /> 刷新路由
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-panelHover text-slate-400 border-b border-edge">
              <tr className="whitespace-nowrap">
                <th className="px-4 py-2.5">虚拟 IP</th>
                <th className="px-4 py-2.5">节点名称</th>
                <th className="px-4 py-2.5">链路方式</th>
                <th className="px-4 py-2.5">延迟</th>
                <th className="px-4 py-2.5">丢包</th>
                <th className="px-4 py-2.5">协议 / NAT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge/60 text-slate-200">
              {easytier.peers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    暂无对端节点路由数据。
                  </td>
                </tr>
              ) : (
                easytier.peers.map((p, idx) => (
                  <tr key={idx} className="hover:bg-panelHover/50 whitespace-nowrap">
                    <td className="px-4 py-2 font-mono">{p.ipv4 || "-"}</td>
                    <td className="px-4 py-2 font-medium">{p.hostname}</td>
                    <td className="px-4 py-2">
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
                    <td className="px-4 py-2">{p.latencyMs != null ? `${p.latencyMs.toFixed(1)} ms` : "-"}</td>
                    <td className="px-4 py-2">{p.loss}</td>
                    <td className="px-4 py-2">{p.tunnel} · {p.nat}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {currentUser.role === "admin" && (
        <>
          <div className="rounded-2xl border border-edge bg-panel p-5 space-y-3">
            <div className="flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-sky-400" />
              <h3 className="font-bold text-sm text-slate-100">新增团队成员账号</h3>
            </div>
            <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-5 gap-2.5 items-end text-xs">
              <input
                required
                placeholder="用户名（如 zhangsan）"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="rounded-xl border border-edge bg-panelHover px-3 py-2 text-slate-100"
              />
              <input
                placeholder="昵称（可选）"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="rounded-xl border border-edge bg-panelHover px-3 py-2 text-slate-100"
              />
              <input
                required
                minLength={6}
                type="password"
                placeholder="初始密码（≥6位）"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-xl border border-edge bg-panelHover px-3 py-2 text-slate-100"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "member" | "admin")}
                className="rounded-xl border border-edge bg-panelHover px-3 py-2 text-slate-100"
              >
                <option value="member">普通成员</option>
                <option value="admin">管理员</option>
              </select>
              <button type="submit" className="rounded-xl bg-sky-400 py-2 font-bold text-slate-950">
                创建账号
              </button>
            </form>
          </div>

          <div className="rounded-2xl border border-edge bg-panel overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-panelHover text-slate-400 border-b border-edge">
                <tr>
                  <th className="px-4 py-3">用户名</th>
                  <th className="px-4 py-3">昵称</th>
                  <th className="px-4 py-3">角色</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-4 py-3">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/60 text-slate-200">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2.5 font-bold">{u.username}</td>
                    <td className="px-4 py-2.5">{u.display_name}</td>
                    <td className="px-4 py-2.5">{u.role === "admin" ? "管理员" : "成员"}</td>
                    <td className="px-4 py-2.5">
                      <span className={u.enabled ? "text-emerald-300" : "text-red-300"}>
                        {u.enabled ? "启用" : "禁用"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 flex gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void onUpdateUser(u.id, { enabled: !u.enabled })
                            .then(reload)
                            .catch((e) => notify(e instanceof Error ? e.message : String(e)))
                        }
                        className="rounded-lg border border-edge bg-panelHover px-2.5 py-1 text-[11px]"
                      >
                        {u.enabled ? "禁用" : "启用"}
                      </button>
                      {u.id !== currentUser.id && (
                        <button
                          type="button"
                          onClick={() => armDeleteUser(u.id)}
                          className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                            confirmDeleteUserId === u.id
                              ? "border-red-400 bg-red-500/30 text-red-100"
                              : "border-red-500/40 bg-red-500/10 text-red-200"
                          }`}
                        >
                          {confirmDeleteUserId === u.id ? "确认删除?" : "删除"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Mobile & Mac Companion Card */}
      <div className="rounded-2xl border border-edge bg-panel p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-sky-400" />
          <h3 className="font-bold text-sm text-slate-100">手机端（iOS / Android）与 macOS 快速接入信息</h3>
        </div>
        <p className="text-xs text-slate-400">
          手机浏览器打开{" "}
          <strong>{apiUrl ? `${apiUrl.replace(/\/+$/, "")}/` : "控制中心 Web 地址"}</strong>{" "}
          即可查看设备在线状态并复制接入参数。
        </p>
        {bootstrap && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-edge bg-obsidian p-3.5 space-y-1.5">
              <div className="font-semibold text-slate-200">RustDesk 移动/Mac 原生端</div>
              <div className="text-slate-400">ID 服务器：<span className="text-slate-100 font-mono">{bootstrap.rustdesk.id_server}</span></div>
              <div className="text-slate-400">中继服务器：<span className="text-slate-100 font-mono">{bootstrap.rustdesk.relay_server}</span></div>
              <div className="text-slate-400">API 服务器：<span className="text-slate-100 font-mono">{bootstrap.rustdesk.api_server}</span></div>
              <button
                type="button"
                onClick={() => void copyVal(bootstrap.rustdesk.public_key, "RustDesk 公钥")}
                className="mt-1 inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-2.5 py-1 text-[11px] text-slate-200"
              >
                <Copy className="w-3 h-3" /> 复制 RustDesk Key
              </button>
            </div>
            <div className="rounded-xl border border-edge bg-obsidian p-3.5 space-y-1.5">
              <div className="font-semibold text-slate-200">EasyTier + Moonlight/Artemis 高刷串流</div>
              <div className="text-slate-400">网络名：<span className="text-slate-100 font-mono">{bootstrap.easytier.network_name}</span></div>
              <div className="text-slate-400">首选节点：<span className="text-slate-100 font-mono">{bootstrap.easytier.peers[0]}</span></div>
              <button
                type="button"
                onClick={() => void copyVal(bootstrap.easytier.network_secret, "EasyTier 网络密钥")}
                className="mt-1 inline-flex items-center gap-1 rounded-lg border border-edge bg-panelHover px-2.5 py-1 text-[11px] text-slate-200"
              >
                <Copy className="w-3 h-3" /> 复制网络密钥
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
