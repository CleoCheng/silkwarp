import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Lock, Server, ShieldCheck, User } from "lucide-react";

interface LoginViewProps {
  initialApiUrl: string;
  onLogin: (args: { apiUrl: string; username: string; password: string }) => Promise<void>;
}

export function LoginView({ initialApiUrl, onLogin }: LoginViewProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [apiUrl, setApiUrl] = useState(initialApiUrl || "");
  const [showAdvanced, setShowAdvanced] = useState(!initialApiUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialApiUrl) {
      setApiUrl((prev) => prev || initialApiUrl);
    }
  }, [initialApiUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiUrl.trim()) {
      setShowAdvanced(true);
      setError("请先填写控制中心地址（或在目录中放置 silkwarp.config.json 自动载入）");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await onLogin({ apiUrl: apiUrl.trim(), username, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请检查网络或账号密码");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[radial-gradient(circle_at_15%_15%,rgba(56,189,248,0.12),transparent_42%),radial-gradient(circle_at_85%_80%,rgba(59,130,246,0.10),transparent_40%),#0b0d13]">
      <div className="w-full max-w-md rounded-2xl border border-edge bg-panel/95 p-8 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="flex items-center gap-3.5 mb-6">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-slate-950 font-black text-lg shadow-lg shadow-sky-500/20">
            SW
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-50 tracking-tight">SilkWarp 远程桌面</h1>
            <p className="text-xs text-slate-400">高刷低延迟 · 零配置自动组网 · 隐私虚拟屏</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5" htmlFor="sw-user">
              团队账号
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="sw-user"
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="输入用户名"
                className="w-full rounded-xl border border-edge bg-panelHover pl-9 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5" htmlFor="sw-pass">
              登录密码
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="sw-pass"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入密码"
                className="w-full rounded-xl border border-edge bg-panelHover pl-9 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-sky-400 transition-colors"
            >
              {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              控制中心地址设置
            </button>
            {showAdvanced && (
              <div className="mt-2 space-y-1.5">
                <div className="relative">
                  <Server className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="url"
                    required
                    value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)}
                    placeholder="https://your-server.example.com/silkwarp"
                    className="w-full rounded-xl border border-edge bg-panelHover pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-500"
                  />
                </div>
                <p className="text-[11px] text-slate-400">
                  提示：也可在程序同目录或仓库根目录放置 <code className="text-slate-300">silkwarp.config.json</code> 自动载入
                </p>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-gradient-to-r from-sky-400 to-blue-500 py-2.5 text-sm font-bold text-slate-950 hover:opacity-95 transition-opacity disabled:opacity-50"
          >
            {loading ? "正在安全登录并下发配置..." : "登录并自动接入"}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-edge/80 flex items-center gap-2 text-[11px] text-slate-400">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>登录后自动同步专属加密虚拟内网与团队主控权限，无需手动填 IP 或密钥。</span>
        </div>
      </div>
    </div>
  );
}
