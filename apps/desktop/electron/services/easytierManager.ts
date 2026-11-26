import { app } from "electron";
import { ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BootstrapConfig, EasyTierStatus, PeerStatus } from "../types";

const execFileAsync = promisify(execFile);

export function resolveEasyTierDir(): string {
  const candidates = [
    path.join(process.resourcesPath || "", "easytier"),
    path.resolve(__dirname, "../../resources/easytier"),
    path.resolve(process.cwd(), "resources/easytier"),
    "C:\\ProgramData\\SilkWarp\\easytier",
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, "easytier-core.exe"))) {
      return dir;
    }
  }
  return candidates[0];
}

export class EasyTierManager {
  private proc: ChildProcess | null = null;
  private lastConfigContent = "";
  private status: EasyTierStatus = {
    running: false,
    externalService: false,
    needsElevation: false,
    meshIp: "",
    peers: [],
    error: "",
  };

  getStatus(): EasyTierStatus {
    return this.status;
  }

  private getConfigPath(): string {
    return path.join(app.getPath("userData"), "easytier.toml");
  }

  writeConfig(cfg: BootstrapConfig): string {
    const p = this.getConfigPath();
    const etDir = path.dirname(p);
    fs.mkdirSync(etDir, { recursive: true });
    const meshCidrPrefix = cfg.mesh_cidr.split("/")[1] || "24";
    const lines = [
      `hostname = "${os.hostname().replace(/"/g, "")}"`,
      `ipv4 = "${cfg.mesh_ip}/${meshCidrPrefix}"`,
      `dhcp = false`,
      ``,
      `listeners = [`,
      `    "tcp://0.0.0.0:0",`,
      `    "udp://0.0.0.0:0",`,
      `    "tcp://[::]:0",`,
      `    "udp://[::]:0",`,
      `]`,
      ``,
      `rpc_portal = "127.0.0.1:15888"`,
      ``,
      ...cfg.easytier.peers.flatMap((uri) => [`[[peer]]`, `uri = "${uri}"`, ``]),
      `[network_identity]`,
      `network_name = "${cfg.easytier.network_name}"`,
      `network_secret = "${cfg.easytier.network_secret}"`,
      ``,
      `[flags]`,
      `dev_name = "SilkWarp"`,
      `enable_exit_node = false`,
      `accept_dns = false`,
      `latency_first = true`,
      `multi_thread = true`,
      `enable_ipv6 = true`,
      `enable_encryption = true`,
      ``,
    ];
    const content = lines.join("\n");
    if (content !== this.lastConfigContent || !fs.existsSync(p)) {
      fs.writeFileSync(p, content, { encoding: "utf-8", mode: 0o600 });
      this.lastConfigContent = content;
    }
    return p;
  }

  private async isRpcAlive(): Promise<boolean> {
    const dir = resolveEasyTierDir();
    const cli = path.join(dir, "easytier-cli.exe");
    if (!fs.existsSync(cli)) return false;
    try {
      await execFileAsync(cli, ["-p", "127.0.0.1:15888", "node", "info"], { timeout: 2500, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  async ensureStarted(cfg: BootstrapConfig, isElevated: boolean): Promise<EasyTierStatus> {
    this.status.meshIp = cfg.mesh_ip;
    const cfgPath = this.writeConfig(cfg);

    if (await this.isRpcAlive()) {
      this.status.running = true;
      this.status.externalService = !this.proc;
      this.status.needsElevation = false;
      this.status.error = "";
      await this.refreshPeers();
      return this.status;
    }

    if (!isElevated) {
      this.status.running = false;
      this.status.needsElevation = true;
      this.status.error = "创建虚拟网卡需要管理员权限（或安装系统开机自启服务）。";
      return this.status;
    }

    const dir = resolveEasyTierDir();
    const core = path.join(dir, "easytier-core.exe");
    if (!fs.existsSync(core)) {
      this.status.running = false;
      this.status.error = `未找到内核文件: ${core}`;
      return this.status;
    }

    this.stop();
    this.status.needsElevation = false;
    this.status.error = "";

    this.proc = spawn(
      core,
      ["-c", cfgPath, "--rpc-portal", "127.0.0.1:15888", "--rpc-portal-whitelist", "127.0.0.1,127.0.0.0/8,::1/128"],
      { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg.toLowerCase().includes("access is denied") || msg.includes("拒绝访问")) {
        this.status.needsElevation = true;
        this.status.error = "EasyTier 创建 Wintun 虚拟网卡权限不足，请点击“以管理员权限重启”。";
      }
    });

    this.proc.on("exit", (code) => {
      this.proc = null;
      this.status.running = false;
      if (code && code !== 0 && !this.status.error) {
        this.status.error = `EasyTier 进程退出 (code=${code})`;
      }
    });

    await new Promise((r) => setTimeout(r, 1400));
    this.status.running = (await this.isRpcAlive()) || Boolean(this.proc);
    await this.refreshPeers();
    return this.status;
  }

  async refreshPeers(): Promise<PeerStatus[]> {
    const cli = path.join(resolveEasyTierDir(), "easytier-cli.exe");
    if (!fs.existsSync(cli)) return [];
    try {
      const { stdout } = await execFileAsync(cli, ["-p", "127.0.0.1:15888", "-o", "json", "peer"], {
        timeout: 3000,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout.trim() || "[]");
      const list = Array.isArray(parsed) ? parsed : [];
      const peers: PeerStatus[] = list.map((item: Record<string, unknown>) => {
        const latNum = parseFloat(String(item.lat_ms ?? ""));
        return {
          ipv4: String(item.ipv4 || "").split("/")[0],
          hostname: String(item.hostname || ""),
          cost: String(item.cost || ""),
          latencyMs: Number.isFinite(latNum) ? latNum : null,
          loss: String(item.loss_rate || "-"),
          rx: String(item.rx_bytes || "-"),
          tx: String(item.tx_bytes || "-"),
          tunnel: String(item.tunnel_proto || "-"),
          nat: String(item.nat_type || "-"),
        };
      });
      this.status.peers = peers;
      this.status.running = true;
      return peers;
    } catch {
      return [];
    }
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = null;
    }
    this.status.running = false;
  }
}
