"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

const {
  DEFAULT_AGENT_PORT,
  AgentAuthManager,
  generateTempAccessPassword,
  hashAccessPassword,
  isIpInCidr,
  normalizeIpAddress,
  verifyAccessPassword,
} = require("../dist-electron/services/hostAgentAuth.js");

const {
  AGENT_VERSION,
  HostAgentServer,
} = require("../dist-electron/services/hostAgentServer.js");

const {
  AgentClientError,
  HostAgentClient,
} = require("../dist-electron/services/hostAgentClient.js");

const MESH_CIDR = "10.144.0.0/24";

function makeConfig(overrides = {}) {
  return {
    requireAccessPassword: true,
    permanentPasswordHash: "",
    tempPassword: "",
    tempPasswordExpiresAt: 0,
    allowSameAccountBypass: true,
    hostOwnerUserId: "owner-user",
    ...overrides,
  };
}

function makeDisplays() {
  return [
    {
      index: 0,
      id: "\\\\.\\DISPLAY1",
      deviceName: "\\\\.\\DISPLAY1",
      friendlyName: "Primary 4K",
      width: 3840,
      height: 2160,
      x: 0,
      y: 0,
      isPrimary: true,
      isVirtual: false,
      active: true,
    },
    {
      index: 1,
      id: "\\\\.\\DISPLAY2",
      deviceName: "\\\\.\\DISPLAY2",
      friendlyName: "Virtual Display",
      width: 2560,
      height: 1440,
      x: 3840,
      y: 0,
      isPrimary: false,
      isVirtual: true,
      active: false,
    },
  ];
}

function makeHandlers(overrides = {}) {
  const calls = { sessionEnd: [] };
  const handlers = {
    getHostInfo: async () => ({
      hostDeviceId: "host-device-1",
      hostname: "THINK-PC",
      requirePassword: true,
      privacyActive: false,
      muted: false,
      autoLockOnDisconnect: true,
      apolloPort: 47984,
      apolloReady: true,
      capabilities: ["displays", "audio", "privacy", "system", "session"],
    }),
    listDisplays: async () => makeDisplays(),
    selectDisplay: async (displayId) => ({
      ok: true,
      selectedDisplayId: displayId,
      restartRecommended: true,
      displays: makeDisplays(),
    }),
    getMuteState: async () => ({ muted: false }),
    setMuteState: async (muted) => ({ muted }),
    getPrivacyState: async () => ({ active: false, supported: true }),
    setPrivacyState: async (active) => ({ active, supported: true }),
    runSystemAction: async (action) => ({ ok: true, message: `executed:${action}` }),
    onSessionEnded: async (opts) => {
      calls.sessionEnd.push(opts);
      return { locked: Boolean(opts.autoLock), muteRestored: true, privacyRestored: true };
    },
    ...overrides,
  };
  return { handlers, calls };
}

// ---------------------------------------------------------------------------
// 1. IP normalization & CIDR checks
// ---------------------------------------------------------------------------

test("normalizeIpAddress: strips IPv4-mapped prefix, zone id and maps ::1", () => {
  assert.equal(normalizeIpAddress(""), "");
  assert.equal(normalizeIpAddress("   "), "");
  assert.equal(normalizeIpAddress("::ffff:10.144.0.12"), "10.144.0.12");
  assert.equal(normalizeIpAddress("::FFFF:10.144.0.12"), "10.144.0.12");
  assert.equal(normalizeIpAddress("fe80::1%12"), "fe80::1");
  assert.equal(normalizeIpAddress("::1"), "127.0.0.1");
  assert.equal(normalizeIpAddress("[::1]"), "127.0.0.1");
  assert.equal(normalizeIpAddress("10.144.0.12"), "10.144.0.12");
});

test("isIpInCidr: IPv4 addresses inside and outside the Mesh range", () => {
  assert.equal(isIpInCidr("10.144.0.10", MESH_CIDR), true);
  assert.equal(isIpInCidr("10.144.0.255", MESH_CIDR), true);
  assert.equal(isIpInCidr("::ffff:10.144.0.10", MESH_CIDR), true);
  assert.equal(isIpInCidr("10.144.1.10", MESH_CIDR), false);
  assert.equal(isIpInCidr("10.145.0.10", MESH_CIDR), false);
  assert.equal(isIpInCidr("192.168.1.10", MESH_CIDR), false);
  assert.equal(isIpInCidr("127.0.0.1", MESH_CIDR), false);
});

test("isIpInCidr: /0 and /32 prefixes and unsigned bit math at 255 octets", () => {
  assert.equal(isIpInCidr("8.8.8.8", "0.0.0.0/0"), true);
  assert.equal(isIpInCidr("10.144.0.10", "10.144.0.10/32"), true);
  assert.equal(isIpInCidr("10.144.0.11", "10.144.0.10/32"), false);
  assert.equal(isIpInCidr("10.144.0.10", "10.144.0.0/16"), true);
  assert.equal(isIpInCidr("10.144.0.10", "10.144.0.0/8"), true);
  assert.equal(isIpInCidr("255.255.255.255", "255.255.255.0/24"), true);
  assert.equal(isIpInCidr("10.144.0.10", "10.144.0.0/33"), false);
  assert.equal(isIpInCidr("10.144.0.10", "10.144.0.0/abc"), false);
});

test("isIpInCidr: malformed input returns false without throwing", () => {
  assert.equal(isIpInCidr("", MESH_CIDR), false);
  assert.equal(isIpInCidr("10.144.0.10", ""), false);
  assert.equal(isIpInCidr("not-an-ip", MESH_CIDR), false);
  assert.equal(isIpInCidr("10.144.0.999", MESH_CIDR), false);
  assert.equal(isIpInCidr("10.144.0", MESH_CIDR), false);
  assert.equal(isIpInCidr("10.144.0.10", "10.144.0.0"), false);
  assert.equal(isIpInCidr("10.144.0.10", "10.144.0.0/"), false);
  assert.equal(isIpInCidr("10.144.0.10", "not-a-cidr"), false);
  assert.equal(isIpInCidr("::1", MESH_CIDR), false);
});

// ---------------------------------------------------------------------------
// 2. Password hashing, verification and temp password generation
// ---------------------------------------------------------------------------

test("hashAccessPassword: PBKDF2-SHA512 format with random 16-byte salt", () => {
  const first = hashAccessPassword("hunter2");
  const second = hashAccessPassword("hunter2");

  const parts = first.split("$");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "pbkdf2_sha512");
  assert.equal(parts[1], "120000");
  assert.match(parts[2], /^[0-9a-f]{32}$/); // 16-byte salt -> 32 hex chars
  assert.match(parts[3], /^[0-9a-f]{64}$/); // 32-byte key -> 64 hex chars
  assert.notEqual(first, second, "salted hashes must differ");

  assert.equal(verifyAccessPassword("hunter2", first), true);
  assert.equal(verifyAccessPassword("hunter3", first), false);
  assert.equal(verifyAccessPassword("", first), false);
  assert.equal(verifyAccessPassword("hunter2", ""), false);
});

test("verifyAccessPassword: rejects malformed stored hashes cleanly", () => {
  assert.equal(verifyAccessPassword("x", "plaintext"), false);
  assert.equal(verifyAccessPassword("x", "pbkdf2_sha512$120000$zzzz$zzzz"), false);
  assert.equal(verifyAccessPassword("x", "pbkdf2_sha512$abc$aa$bb"), false);
  assert.equal(verifyAccessPassword("x", "md5$1$aa$bb"), false);
  assert.equal(verifyAccessPassword("x", "pbkdf2_sha512$0$aa$bb"), false);
});

test("generateTempAccessPassword: always six digits and non-trivial", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const pwd = generateTempAccessPassword();
    assert.match(pwd, /^\d{6}$/);
    assert.ok(Number(pwd) >= 100000 && Number(pwd) <= 999999);
    seen.add(pwd);
  }
  assert.ok(seen.size > 1, "temp passwords must be random");
});

// ---------------------------------------------------------------------------
// 3. Same-account bypass vs stranger rejection
// ---------------------------------------------------------------------------

test("AgentAuthManager: same-account bypass succeeds without a password", () => {
  const manager = new AgentAuthManager(() => makeConfig());
  const result = manager.authenticate({
    remoteIp: "10.144.0.20",
    clientUserId: "owner-user",
    deviceId: "laptop-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.match(result.token, /^[0-9a-f]{64}$/);
  assert.ok(result.expiresAt > Date.now());
  assert.equal(manager.verifyToken(result.token), true);
});

test("AgentAuthManager: stranger without password gets 401 and no token", () => {
  const manager = new AgentAuthManager(() => makeConfig());
  const result = manager.authenticate({ remoteIp: "10.144.0.20", clientUserId: "stranger" });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, "此主机需要输入访问密码");
});

test("AgentAuthManager: same-account bypass can be disabled", () => {
  const manager = new AgentAuthManager(() => makeConfig({ allowSameAccountBypass: false }));
  const result = manager.authenticate({ remoteIp: "10.144.0.20", clientUserId: "owner-user" });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
});

test("AgentAuthManager: permanent and temporary passwords authenticate", () => {
  const permanent = hashAccessPassword("PermPass#1");
  const now = 1_000_000;
  const manager = new AgentAuthManager(
    () => makeConfig({ permanentPasswordHash: permanent, tempPassword: "123456", tempPasswordExpiresAt: now + 60_000 }),
    () => now,
  );

  assert.equal(manager.authenticate({ remoteIp: "10.144.0.21", password: "PermPass#1" }).ok, true);
  assert.equal(manager.authenticate({ remoteIp: "10.144.0.22", password: " 123456 " }).ok, true);
  const wrong = manager.authenticate({ remoteIp: "10.144.0.23", password: "000000" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.error, "访问密码错误");
});

test("AgentAuthManager: expired temp password is rejected", () => {
  const manager = new AgentAuthManager(
    () => makeConfig({ tempPassword: "123456", tempPasswordExpiresAt: 1000 }),
    () => 2000,
  );
  const result = manager.authenticate({ remoteIp: "10.144.0.21", password: "123456" });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
});

test("AgentAuthManager: requireAccessPassword=false accepts anyone", () => {
  const manager = new AgentAuthManager(() => makeConfig({ requireAccessPassword: false }));
  const result = manager.authenticate({ remoteIp: "10.144.0.30" });
  assert.equal(result.ok, true);
  assert.equal(manager.verifyToken(result.token), true);
});

test("AgentAuthManager: verifyToken rejects unknown and revoked tokens", () => {
  const manager = new AgentAuthManager(() => makeConfig());
  assert.equal(manager.verifyToken("deadbeef"), false);
  assert.equal(manager.verifyToken(""), false);

  const result = manager.authenticate({ remoteIp: "10.144.0.20", clientUserId: "owner-user" });
  assert.equal(manager.verifyToken(result.token), true);
  manager.revokeAllTokens();
  assert.equal(manager.verifyToken(result.token), false);
});

test("AgentAuthManager: tokens expire after their TTL", () => {
  let now = 5_000_000;
  const manager = new AgentAuthManager(() => makeConfig(), () => now);
  const result = manager.authenticate({ remoteIp: "10.144.0.20", clientUserId: "owner-user" });
  assert.equal(manager.verifyToken(result.token), true);

  now += 8 * 3600 * 1000 + 1;
  assert.equal(manager.verifyToken(result.token), false);
});

// ---------------------------------------------------------------------------
// 4. Rate limiting: 5 failures -> 60s lock, recovery after the window
// ---------------------------------------------------------------------------

test("AgentAuthManager: five wrong passwords lock the IP for 60 seconds", () => {
  let now = 2_000_000;
  const manager = new AgentAuthManager(() => makeConfig(), () => now);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = manager.authenticate({ remoteIp: "10.144.0.40", password: "bad" });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
    assert.equal(result.retryAfterSec, undefined);
    now += 1000;
  }

  const fifth = manager.authenticate({ remoteIp: "10.144.0.40", password: "bad" });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.statusCode, 429);
  assert.equal(fifth.retryAfterSec, 60);

  // Still locked a moment later, even with the correct password.
  now += 10_000;
  const locked = manager.authenticate({
    remoteIp: "10.144.0.40",
    clientUserId: "owner-user",
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.retryAfterSec, 50);
  assert.equal(locked.error, "密码错误次数过多，请稍后再试");

  // Another IP is unaffected by the lock.
  const other = manager.authenticate({ remoteIp: "10.144.0.41", clientUserId: "owner-user" });
  assert.equal(other.ok, true);
});

test("AgentAuthManager: lock resets after the 60s window and failures are cleared", () => {
  let now = 3_000_000;
  const manager = new AgentAuthManager(() => makeConfig(), () => now);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    manager.authenticate({ remoteIp: "10.144.0.42", password: "bad" });
  }
  assert.equal(manager.authenticate({ remoteIp: "10.144.0.42", password: "bad" }).statusCode, 429);

  now += 60_001;
  const recovered = manager.authenticate({ remoteIp: "10.144.0.42", clientUserId: "owner-user" });
  assert.equal(recovered.ok, true);

  // A successful login clears the failure tracker for the IP.
  const again = manager.authenticate({ remoteIp: "10.144.0.42", password: "bad" });
  assert.equal(again.statusCode, 401);
  assert.equal(again.retryAfterSec, undefined);
});

test("AgentAuthManager: stale failures outside the rolling window do not accumulate", () => {
  let now = 4_000_000;
  const manager = new AgentAuthManager(() => makeConfig(), () => now);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    manager.authenticate({ remoteIp: "10.144.0.43", password: "bad" });
    now += 20_000; // each failure is older than 60s by the time the next arrives
  }
  const result = manager.authenticate({ remoteIp: "10.144.0.43", password: "bad" });
  assert.equal(result.statusCode, 401);
});

// ---------------------------------------------------------------------------
// 5. HTTP server + client integration on 127.0.0.1:<ephemeral>
// ---------------------------------------------------------------------------

/**
 * Windows loopback drops the first SYN on roughly 1% of freshly allocated
 * ephemeral ports (reproducible with plain `http.createServer`, independent of
 * this project). Retry startup on a fresh port so the suite is not flaky.
 */
async function startServerOnReachablePort(server, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { port } = await server.start("127.0.0.1", 0);
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.setTimeout(1500);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("timeout", () => {
          socket.destroy();
          reject(new Error("loopback connect timeout"));
        });
        socket.once("error", reject);
      });
      return port;
    } catch (err) {
      lastError = err;
      await server.stop();
    }
  }
  throw lastError;
}

async function startServer(overrides = {}) {
  const authManager = overrides.authManager ?? new AgentAuthManager(() => makeConfig());
  const { handlers, calls } = makeHandlers(overrides.handlers);
  const server = new HostAgentServer({
    authManager,
    getMeshCidr: () => overrides.meshCidr ?? MESH_CIDR,
    allowLoopback: overrides.allowLoopback ?? true,
    handlers,
  });
  const port = await startServerOnReachablePort(server);
  return { server, port, authManager, handlers, calls };
}

/**
 * Wraps the typed client with transport-level retries.
 *
 * The same Windows loopback SYN-drop affects any *new* connection, not just
 * the first one. Agent handlers used by these tests are idempotent, so a
 * retry on ETIMEDOUT is safe here and must never be added to production code
 * (POST /system/action is not idempotent).
 */
function makeClient() {
  const inner = new HostAgentClient();
  const methods = [
    "probeInfo",
    "authenticate",
    "listDisplays",
    "selectDisplay",
    "getMuteState",
    "setMuteState",
    "getPrivacyState",
    "setPrivacyState",
    "runSystemAction",
    "notifySessionEnd",
  ];
  const wrapped = { inner };
  for (const name of methods) {
    wrapped[name] = async (...args) => {
      let lastError;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return await inner[name](...args);
        } catch (err) {
          const transportFlake =
            err instanceof AgentClientError &&
            err.statusCode === 0 &&
            (err.code === "timeout" || /ETIMEDOUT|EAI_AGAIN|ECONNRESET/.test(err.message));
          if (!transportFlake) throw err;
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      throw lastError;
    };
  }
  return wrapped;
}

test("HostAgentServer: start is idempotent and stop releases the port", async () => {
  const { server, port } = await startServer();
  try {
    assert.ok(port > 0);
    assert.equal(server.getPort(), port);
    const again = await server.start("127.0.0.1", 0);
    assert.equal(again.port, port, "same port requested again must not rebind");
  } finally {
    await server.stop();
  }
  assert.equal(server.getPort(), 0);
  await server.stop(); // stopping twice is safe
});

test("HostAgentServer: non-Mesh loopback is rejected with 403 when allowLoopback=false", async () => {
  const { server, port } = await startServer({ allowLoopback: false });
  const client = new HostAgentClient();
  try {
    await assert.rejects(
      () => client.probeInfo("127.0.0.1", port, 2000),
      (err) => {
        assert.ok(err instanceof AgentClientError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, "mesh_only");
        return true;
      },
    );
  } finally {
    await server.stop();
  }
});

test("HostAgentServer: info is public, protected routes require a bearer token", async () => {
  const { server, port } = await startServer();
  const client = new HostAgentClient();
  try {
    const info = await client.probeInfo("127.0.0.1", port);
    assert.equal(info.ok, true);
    assert.equal(info.version, AGENT_VERSION);
    assert.equal(info.requirePassword, true);
    assert.equal(info.hostDeviceId, "host-device-1");
    assert.equal(info.hostname, "THINK-PC");
    assert.deepEqual(info.capabilities, ["displays", "audio", "privacy", "system", "session"]);

    await assert.rejects(
      () => client.listDisplays("127.0.0.1", port, ""),
      (err) => {
        assert.ok(err instanceof AgentClientError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, "unauthorized");
        return true;
      },
    );

    await assert.rejects(
      () => client.listDisplays("127.0.0.1", port, "not-a-real-token"),
      (err) => err instanceof AgentClientError && err.statusCode === 401,
    );
  } finally {
    await server.stop();
  }
});

test("HostAgentServer: full authenticated control flow via the typed client", async () => {
  const now = 9_000_000;
  const authManager = new AgentAuthManager(
    () =>
      makeConfig({
        tempPassword: "654321",
        tempPasswordExpiresAt: now + 10 * 60_000,
      }),
    () => now,
  );
  const { server, port, calls } = await startServer({ authManager });
  const client = new HostAgentClient();
  try {
    // Wrong password first: 401 with a readable Chinese message.
    await assert.rejects(
      () => client.authenticate("127.0.0.1", port, { password: "000000" }),
      (err) => {
        assert.ok(err instanceof AgentClientError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.message, "访问密码错误");
        return true;
      },
    );

    const auth = await client.authenticate("127.0.0.1", port, { password: "654321" });
    assert.equal(auth.ok, true);
    assert.match(auth.token, /^[0-9a-f]{64}$/);
    assert.equal(auth.expiresAt, now + 8 * 3600 * 1000);

    const displays = await client.listDisplays("127.0.0.1", port, auth.token);
    assert.equal(displays.length, 2);
    assert.equal(displays[0].isPrimary, true);
    assert.equal(displays[1].isVirtual, true);

    const selected = await client.selectDisplay("127.0.0.1", port, auth.token, "\\\\.\\DISPLAY2");
    assert.equal(selected.ok, true);
    assert.equal(selected.selectedDisplayId, "\\\\.\\DISPLAY2");
    assert.equal(selected.restartRecommended, true);
    assert.equal(selected.displays.length, 2);

    assert.deepEqual(await client.getMuteState("127.0.0.1", port, auth.token), { muted: false });
    assert.deepEqual(await client.setMuteState("127.0.0.1", port, auth.token, true), { muted: true });

    assert.deepEqual(await client.getPrivacyState("127.0.0.1", port, auth.token), {
      active: false,
      supported: true,
    });
    assert.deepEqual(await client.setPrivacyState("127.0.0.1", port, auth.token, true), {
      active: true,
      supported: true,
    });

    assert.deepEqual(await client.runSystemAction("127.0.0.1", port, auth.token, "lock"), {
      ok: true,
      message: "executed:lock",
    });

    assert.deepEqual(await client.notifySessionEnd("127.0.0.1", port, auth.token, { autoLock: true }), {
      locked: true,
      muteRestored: true,
      privacyRestored: true,
    });
    assert.deepEqual(calls.sessionEnd, [{ autoLock: true }]);
  } finally {
    await server.stop();
  }
});

test("HostAgentServer: route validation rejects malformed payloads", async () => {
  const { server, port } = await startServer();
  const client = new HostAgentClient();
  try {
    const auth = await client.authenticate("127.0.0.1", port, { clientUserId: "owner-user" });
    const token = auth.token;

    await assert.rejects(
      () => client.selectDisplay("127.0.0.1", port, token, "   "),
      (err) => err instanceof AgentClientError && err.statusCode === 400,
    );
    await assert.rejects(
      () => client.runSystemAction("127.0.0.1", port, token, "format_disk"),
      (err) => err instanceof AgentClientError && err.statusCode === 400,
    );

    const rawPost = (path, body) =>
      new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body), "utf8");
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(payload.length),
              Authorization: `Bearer ${token}`,
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }),
            );
          },
        );
        req.on("error", reject);
        req.end(payload);
      });

    const badMute = await rawPost("/api/agent/audio/mute", { muted: "yes" });
    assert.equal(badMute.status, 400);
    assert.equal(badMute.body.error, "muted_boolean_required");

    const badPrivacy = await rawPost("/api/agent/privacy", {});
    assert.equal(badPrivacy.status, 400);
    assert.equal(badPrivacy.body.error, "active_boolean_required");

    const unknown = await rawPost("/api/agent/does-not-exist", {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "not_found");
  } finally {
    await server.stop();
  }
});

test("HostAgentServer: session/end without a handler returns safe defaults", async () => {
  const { server, port } = await startServer({ handlers: { onSessionEnded: undefined } });
  const client = new HostAgentClient();
  try {
    const auth = await client.authenticate("127.0.0.1", port, { clientUserId: "owner-user" });
    assert.deepEqual(await client.notifySessionEnd("127.0.0.1", port, auth.token), {
      locked: false,
      muteRestored: false,
      privacyRestored: false,
    });
  } finally {
    await server.stop();
  }
});

test("HostAgentServer: onExtraRoute receives the raw request body stream untouched", async () => {
  const received = [];
  const { server, port } = await startServer({
    handlers: {
      onExtraRoute: async (ctx) => {
        if (ctx.method !== "POST" || ctx.pathname !== "/api/agent/files/upload") {
          return false;
        }
        const chunks = [];
        for await (const chunk of ctx.req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        received.push({ remoteIp: ctx.remoteIp, query: ctx.query.get("name"), body });
        ctx.sendJson(200, { ok: true, bytes: body.length });
        return true;
      },
    },
  });
  const client = new HostAgentClient();
  try {
    const auth = await client.authenticate("127.0.0.1", port, { clientUserId: "owner-user" });
    const payload = Buffer.from("STAGE-3-UPLOAD-PAYLOAD-中文", "utf8");

    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/agent/files/upload?name=demo.bin",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(payload.length),
            Authorization: `Bearer ${auth.token}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.bytes, payload.length);
    assert.equal(received.length, 1);
    assert.equal(received[0].remoteIp, "127.0.0.1");
    assert.equal(received[0].query, "demo.bin");
    assert.deepEqual(received[0].body, payload, "streamed bytes must arrive intact");
  } finally {
    await server.stop();
  }
});

test("HostAgentServer: rate limit surfaces 429 + Retry-After through the client", async () => {
  let now = 6_000_000;
  const authManager = new AgentAuthManager(
    () => makeConfig({ tempPassword: "111111", tempPasswordExpiresAt: now + 60_000 }),
    () => now,
  );
  const { server, port } = await startServer({ authManager });
  const client = new HostAgentClient();
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await client.authenticate("127.0.0.1", port, { password: "999999" });
        assert.fail("expected authentication failure");
      } catch (err) {
        assert.ok(err instanceof AgentClientError);
        if (attempt < 5) {
          assert.equal(err.statusCode, 401);
        } else {
          assert.equal(err.statusCode, 429);
          assert.equal(err.retryAfterSec, 60);
        }
      }
    }

    // Even the correct temp password is refused while the lock is active.
    await assert.rejects(
      () => client.authenticate("127.0.0.1", port, { password: "111111" }),
      (err) => err instanceof AgentClientError && err.statusCode === 429 && err.retryAfterSec === 60,
    );

    now += 60_001;
    const recovered = await client.authenticate("127.0.0.1", port, { password: "111111" });
    assert.equal(recovered.ok, true);
  } finally {
    await server.stop();
  }
});

test("HostAgentClient: connection errors and timeouts surface as AgentClientError", async () => {
  const client = new HostAgentClient();

  await assert.rejects(
    () => client.probeInfo("127.0.0.1", 1, 1000),
    (err) => {
      assert.ok(err instanceof AgentClientError);
      assert.equal(err.statusCode, 0);
      assert.equal(err.code, "network_error");
      return true;
    },
  );

  const { server, port } = await startServer({
    handlers: {
      getHostInfo: () => new Promise(() => {}),
    },
  });
  try {
    await assert.rejects(
      () => client.probeInfo("127.0.0.1", port, 150),
      (err) => err instanceof AgentClientError && err.code === "timeout",
    );
  } finally {
    await server.stop();
  }
});

test("DEFAULT_AGENT_PORT is 19580", () => {
  assert.equal(DEFAULT_AGENT_PORT, 19580);
});
