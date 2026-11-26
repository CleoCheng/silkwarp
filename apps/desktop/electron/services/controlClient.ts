import { net } from "electron";
import type { BootstrapConfig, DeviceInfo, UserInfo } from "../types";

export interface PairRequestItem {
  id: string;
  host_device_id: string;
  client_device_id: string;
  client_name: string;
  pin: string;
  status: "pending" | "approved" | "rejected" | "failed";
  message?: string;
}

export class ControlClient {
  constructor(
    private getBaseUrl: () => string,
    private getToken: () => string,
  ) {}

  private async request<T>(relPath: string, init: RequestInit = {}): Promise<T> {
    const base = this.getBaseUrl().replace(/\/+$/, "");
    const url = `${base}/${relPath.replace(/^\/+/, "")}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    const tok = this.getToken();
    if (tok) {
      headers.Authorization = `Bearer ${tok}`;
    }

    const resp = await net.fetch(url, { ...(init as RequestInit), headers });
    const text = await resp.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`HTTP ${resp.status}: 非 JSON 响应`);
    }
    if (!resp.ok) {
      throw new Error(String(json.error || `HTTP ${resp.status}`));
    }
    return json as T;
  }

  login(username: string, password: string, deviceId: string): Promise<{ token: string; expires_at: string; user: UserInfo }> {
    return this.request("api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, device_id: deviceId }),
    });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request("api/auth/logout", { method: "POST", body: "{}" });
  }

  me(): Promise<{ user: UserInfo }> {
    return this.request("api/auth/me");
  }

  bootstrap(deviceId: string, name: string, osName: string): Promise<BootstrapConfig> {
    const q = new URLSearchParams({ device_id: deviceId, name, os: osName });
    return this.request(`api/bootstrap/config?${q.toString()}`);
  }

  listDevices(): Promise<{ devices: DeviceInfo[] }> {
    return this.request("api/devices");
  }

  heartbeat(payload: Record<string, unknown>): Promise<{ ok: boolean; device: DeviceInfo; pending_pairs: PairRequestItem[] }> {
    return this.request("api/devices/heartbeat", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  updateDevice(deviceId: string, patch: Partial<Pick<DeviceInfo, "name" | "mac_address" | "broadcast_ip" | "visibility">>): Promise<{ device: DeviceInfo }> {
    return this.request(`api/devices/${encodeURIComponent(deviceId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteDevice(deviceId: string): Promise<{ ok: boolean }> {
    return this.request(`api/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    });
  }

  createPairRequest(hostDeviceId: string, pin: string, clientDeviceId: string, clientName: string): Promise<{ pair_request: PairRequestItem }> {
    return this.request(`api/devices/${encodeURIComponent(hostDeviceId)}/pair-request`, {
      method: "POST",
      body: JSON.stringify({ pin, client_device_id: clientDeviceId, client_name: clientName }),
    });
  }

  getPairRequest(reqId: string): Promise<{ pair_request: PairRequestItem }> {
    return this.request(`api/pair-requests/${encodeURIComponent(reqId)}`);
  }

  resolvePairRequest(reqId: string, status: "approved" | "rejected" | "failed", message = ""): Promise<{ pair_request: PairRequestItem }> {
    return this.request(`api/pair-requests/${encodeURIComponent(reqId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ status, message }),
    });
  }

  getPendingPairs(deviceId: string): Promise<{ pending_pairs: PairRequestItem[] }> {
    return this.request(`api/devices/${encodeURIComponent(deviceId)}/pending-pairs`);
  }

  listUsers(): Promise<{ users: UserInfo[] }> {
    return this.request("api/admin/users");
  }

  createUser(payload: { username: string; display_name: string; password: string; role: "admin" | "member" }): Promise<{ user: UserInfo }> {
    return this.request("api/admin/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  updateUser(userId: string, patch: { display_name?: string; role?: "admin" | "member"; enabled?: boolean; password?: string }): Promise<{ user: UserInfo }> {
    return this.request(`api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteUser(userId: string): Promise<{ ok: boolean }> {
    return this.request(`api/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
  }
}
