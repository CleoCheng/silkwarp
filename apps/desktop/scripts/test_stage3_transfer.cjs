"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  computeClipboardFingerprint,
  isSafeReadableSubpath,
  normalizeTargetDir,
  resolveUniqueFilePath,
  sanitizeUploadFilename,
} = require("../dist-electron/services/transferValidation.js");

const {
  createHostTransferExtraRoute,
} = require("../dist-electron/services/hostTransferService.js");

const {
  ClipboardSyncManager,
  MAX_CLIPBOARD_AUTO_FILES_BYTES,
} = require("../dist-electron/services/clipboardSyncManager.js");

const { AgentAuthManager } = require("../dist-electron/services/hostAgentAuth.js");
const { HostAgentServer } = require("../dist-electron/services/hostAgentServer.js");
const { AgentClientError, HostAgentClient } = require("../dist-electron/services/hostAgentClient.js");

const MESH_CIDR = "10.144.0.0/24";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const tempDirs = [];

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `silkwarp-stage3-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; Windows can briefly hold handles on .part files.
    }
  }
}

test.after(cleanupTempDirs);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function makeConfig(overrides = {}) {
  return {
    requireAccessPassword: false,
    permanentPasswordHash: "",
    tempPassword: "",
    tempPasswordExpiresAt: 0,
    allowSameAccountBypass: true,
    hostOwnerUserId: "owner-user",
    ...overrides,
  };
}

function makeClipboardStub() {
  const state = {
    current: { kind: "empty", updatedAt: Date.now() },
    writes: [],
  };
  return {
    state,
    adapter: {
      read: async () => state.current,
      write: async (payload) => {
        state.current = payload;
        state.writes.push(payload);
        return { ok: true, kind: payload.kind };
      },
    },
  };
}

/**
 * Windows loopback occasionally drops the first SYN on a freshly allocated
 * ephemeral port. Retry startup on a new port so the suite is not flaky.
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

function makeHandlers(onExtraRoute) {
  return {
    getHostInfo: async () => ({
      hostDeviceId: "host-device-stage3",
      hostname: "STAGE3-HOST",
      requirePassword: false,
      privacyActive: false,
      muted: false,
      autoLockOnDisconnect: false,
      apolloPort: 47984,
      apolloReady: false,
      capabilities: ["files", "clipboard"],
    }),
    listDisplays: async () => [],
    selectDisplay: async (displayId) => ({
      ok: true,
      selectedDisplayId: displayId,
      restartRecommended: false,
      displays: [],
    }),
    getMuteState: async () => ({ muted: false }),
    setMuteState: async (muted) => ({ muted }),
    getPrivacyState: async () => ({ active: false, supported: true }),
    setPrivacyState: async (active) => ({ active, supported: true }),
    runSystemAction: async (action) => ({ ok: true, message: `executed:${action}` }),
    onExtraRoute,
  };
}

async function startTransferServer(transferOptions = {}) {
  const receiveDir = transferOptions.defaultReceiveDir ?? makeTempDir("recv");
  const clipboard = transferOptions.clipboard ?? makeClipboardStub();
  const received = [];
  const remoteClipboardUpdates = [];

  const extraRoute = createHostTransferExtraRoute({
    defaultReceiveDir: receiveDir,
    roots: transferOptions.roots,
    restrictToRoots: transferOptions.restrictToRoots ?? false,
    maxUploadBytes: transferOptions.maxUploadBytes,
    clipboard: clipboard.adapter,
    onFileReceived: (info) => received.push(info),
    onRemoteClipboardUpdated: (payload) => remoteClipboardUpdates.push(payload),
  });

  const authManager = new AgentAuthManager(() => makeConfig());
  const server = new HostAgentServer({
    authManager,
    getMeshCidr: () => MESH_CIDR,
    allowLoopback: true,
    handlers: makeHandlers(extraRoute),
  });

  const port = await startServerOnReachablePort(server);
  const client = new HostAgentClient();
  const auth = await client.authenticate("127.0.0.1", port, { clientUserId: "owner-user" });

  return {
    server,
    port,
    token: auth.token,
    client,
    receiveDir,
    clipboard,
    received,
    remoteClipboardUpdates,
  };
}

function rawRequest(port, method, requestPath, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined && requestHeaders["Content-Length"] === undefined) {
      requestHeaders["Content-Length"] = String(body.length);
    }

    const req = http.request(
      { host: "127.0.0.1", port, method, path: requestPath, headers: requestHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(raw.toString("utf8"));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 1. transferValidation: filename sanitization
// ---------------------------------------------------------------------------

test("sanitizeUploadFilename: strips traversal, drive colons and invalid chars", () => {
  const cases = [
    "../../../../etc/passwd",
    "..\\..\\Windows\\System32\\evil.exe",
    "..\\..\\evil:file?.txt",
    "/absolute/path/report.pdf",
    "C:\\Users\\Roger\\secret<name>|.bin",
    'bad"name"*.log',
  ];

  for (const raw of cases) {
    const safe = sanitizeUploadFilename(raw);
    assert.ok(safe.length > 0, `empty result for ${raw}`);
    assert.ok(!safe.includes("/"), `slash survived: ${safe}`);
    assert.ok(!safe.includes("\\"), `backslash survived: ${safe}`);
    assert.ok(!/[<>:"|?*\x00-\x1f]/.test(safe), `invalid char survived: ${safe}`);
    assert.notEqual(safe, ".");
    assert.notEqual(safe, "..");
    assert.equal(path.basename(safe), safe);
  }

  assert.equal(sanitizeUploadFilename("..\\..\\evil:file?.txt"), "evil_file_.txt");
  assert.equal(sanitizeUploadFilename("../../../../etc/passwd"), "passwd");
});

test("sanitizeUploadFilename: preserves UTF-8 Chinese names and percent-decodes", () => {
  assert.equal(sanitizeUploadFilename("测试报告 (终版).pdf"), "测试报告 (终版).pdf");
  assert.equal(
    sanitizeUploadFilename(encodeURIComponent("测试报告 (终版).pdf")),
    "测试报告 (终版).pdf",
  );
  assert.equal(sanitizeUploadFilename("季度总结 2026.xlsx"), "季度总结 2026.xlsx");
});

test("sanitizeUploadFilename: empty / dot / dotdot fall back to unnamed.bin", () => {
  for (const raw of ["", "   ", ".", "..", "\0", "...", "\\\\", "////"]) {
    assert.equal(sanitizeUploadFilename(raw), "unnamed.bin", `fallback failed for ${JSON.stringify(raw)}`);
  }
});

test("sanitizeUploadFilename: caps very long names at 180 chars and keeps the extension", () => {
  const longStem = "a".repeat(400);
  const capped = sanitizeUploadFilename(`${longStem}.tar.gz`);
  assert.ok(capped.length <= 180, `length ${capped.length} exceeds 180`);
  assert.ok(capped.endsWith(".gz"), `extension lost: ${capped.slice(-10)}`);

  const chineseLong = sanitizeUploadFilename(`${"测试".repeat(200)}.pdf`);
  assert.ok(chineseLong.length <= 180);
  assert.ok(chineseLong.endsWith(".pdf"));

  // Trailing dots/spaces are invalid on Windows and must not survive.
  assert.equal(sanitizeUploadFilename("report...   "), "report");
  assert.equal(sanitizeUploadFilename("trailing .txt. "), "trailing .txt");
});

test("sanitizeUploadFilename: malformed percent sequences are kept verbatim", () => {
  assert.equal(sanitizeUploadFilename("50% off sale.txt"), "50% off sale.txt");
  assert.equal(sanitizeUploadFilename("100%.bin"), "100%.bin");
});

// ---------------------------------------------------------------------------
// 2. transferValidation: unique naming
// ---------------------------------------------------------------------------

test("resolveUniqueFilePath: creates report (1).txt and report (2).txt on duplicates", () => {
  const dir = makeTempDir("unique");
  fs.writeFileSync(path.join(dir, "report.txt"), "first");

  const first = resolveUniqueFilePath(dir, "report.txt");
  assert.equal(first, path.join(dir, "report (1).txt"));

  fs.writeFileSync(first, "second");
  const second = resolveUniqueFilePath(dir, "report.txt");
  assert.equal(second, path.join(dir, "report (2).txt"));

  fs.writeFileSync(second, "third");
  assert.equal(resolveUniqueFilePath(dir, "report.txt"), path.join(dir, "report (3).txt"));

  // Extension-less and multi-dot names keep their shape.
  assert.equal(resolveUniqueFilePath(dir, "LICENSE"), path.join(dir, "LICENSE"));
  fs.writeFileSync(path.join(dir, "LICENSE"), "x");
  assert.equal(resolveUniqueFilePath(dir, "LICENSE"), path.join(dir, "LICENSE (1)"));

  fs.writeFileSync(path.join(dir, "archive.tar.gz"), "x");
  assert.equal(resolveUniqueFilePath(dir, "archive.tar.gz"), path.join(dir, "archive (1).tar.gz"));
});

test("resolveUniqueFilePath: sanitizes the incoming name before allocating", () => {
  const dir = makeTempDir("unique-sanitize");
  const allocated = resolveUniqueFilePath(dir, "..\\..\\evil:name?.txt");
  assert.equal(path.dirname(allocated), dir);
  assert.equal(path.basename(allocated), "evil_name_.txt");
});

test("resolveUniqueFilePath: injectable existsFn avoids touching the disk", () => {
  const taken = new Set(["C:\\recv\\a.txt", "C:\\recv\\a (1).txt"]);
  const allocated = resolveUniqueFilePath("C:\\recv", "a.txt", (candidate) => taken.has(candidate));
  assert.equal(allocated, path.join("C:\\recv", "a (2).txt"));
});

// ---------------------------------------------------------------------------
// 3. transferValidation: directory containment
// ---------------------------------------------------------------------------

test("normalizeTargetDir: empty input resolves to the default directory", () => {
  const defaultDir = path.resolve(os.tmpdir(), "silkwarp-default");
  assert.equal(normalizeTargetDir(undefined, defaultDir), defaultDir);
  assert.equal(normalizeTargetDir("", defaultDir), defaultDir);
  assert.equal(normalizeTargetDir("   ", defaultDir), defaultDir);
});

test("normalizeTargetDir: blocks directory escape when allowedRoots is set", () => {
  const root = path.resolve(os.tmpdir(), "silkwarp-root");
  const nested = path.join(root, "nested");
  const outside = path.resolve(os.tmpdir(), "silkwarp-outside");

  assert.equal(normalizeTargetDir(root, root, [root]), root);
  assert.equal(normalizeTargetDir(nested, root, [root]), nested);

  for (const escape of [outside, path.join(root, "..", "silkwarp-outside"), "..\\..\\Windows"]) {
    assert.throws(
      () => normalizeTargetDir(escape, root, [root]),
      /path_outside_allowed_roots/,
      `escape not blocked: ${escape}`,
    );
  }

  // Without roots, the same path is accepted (unrestricted desktop mode).
  assert.equal(normalizeTargetDir(outside, root), outside);
});

test("normalizeTargetDir: strips null bytes before resolving", () => {
  const root = path.resolve(os.tmpdir(), "silkwarp-nullroot");
  const resolved = normalizeTargetDir(`${root}\0\\child`, root);
  assert.ok(!resolved.includes("\0"));
  assert.equal(resolved, path.join(root, "child"));
});

test("normalizeTargetDir: sibling prefix is not treated as inside the root", () => {
  const root = path.resolve(os.tmpdir(), "silkwarp-rootx");
  const sibling = path.resolve(os.tmpdir(), "silkwarp-rootx-evil");
  assert.throws(() => normalizeTargetDir(sibling, root, [root]), /path_outside_allowed_roots/);
});

test("isSafeReadableSubpath: rejects null bytes and out-of-root paths", () => {
  const root = path.resolve(os.tmpdir(), "silkwarp-read");
  assert.equal(isSafeReadableSubpath(path.join(root, "a.txt"), [root]), true);
  assert.equal(isSafeReadableSubpath(root, [root]), true);
  assert.equal(isSafeReadableSubpath("", [root]), false);
  assert.equal(isSafeReadableSubpath("   ", [root]), false);
  assert.equal(isSafeReadableSubpath(`${root}\0evil`, [root]), false);
  assert.equal(isSafeReadableSubpath(path.resolve(os.tmpdir(), "elsewhere", "a.txt"), [root]), false);
  // Unrestricted mode accepts any non-empty clean path.
  assert.equal(isSafeReadableSubpath(path.resolve(os.tmpdir(), "elsewhere", "a.txt")), true);
});

// ---------------------------------------------------------------------------
// 4. transferValidation: clipboard fingerprint
// ---------------------------------------------------------------------------

test("computeClipboardFingerprint: stable, kind-separated and normalized", () => {
  const textA = computeClipboardFingerprint({ kind: "text", text: "hello world" });
  const textB = computeClipboardFingerprint({ kind: "text", text: "  hello world\r\n" });
  assert.equal(textA, textB, "trim/CRLF must not change the fingerprint");
  assert.match(textA, /^[0-9a-f]{64}$/);

  const textOther = computeClipboardFingerprint({ kind: "text", text: "hello world!" });
  assert.notEqual(textA, textOther);

  const imageA = computeClipboardFingerprint({ kind: "image", imageBase64: "iVBORw0KGgo=" });
  const imageB = computeClipboardFingerprint({ kind: "image", imageBase64: "iVBORw0KGgo=\n" });
  assert.equal(imageA, imageB);

  const filesA = computeClipboardFingerprint({
    kind: "files",
    files: ["C:\\b.txt", "C:\\a.txt"],
  });
  const filesB = computeClipboardFingerprint({
    kind: "files",
    files: ["C:\\a.txt", "C:\\b.txt"],
  });
  assert.equal(filesA, filesB, "file order must not change the fingerprint");

  const empty = computeClipboardFingerprint({ kind: "empty" });
  const emptyWithText = computeClipboardFingerprint({ kind: "empty", text: "ignored" });
  assert.equal(empty, emptyWithText, "empty kind has a constant fingerprint");

  const all = new Set([empty, textA, imageA, filesA]);
  assert.equal(all.size, 4, "kinds must never collide");
});

// ---------------------------------------------------------------------------
// 5. HTTP: authentication guard
// ---------------------------------------------------------------------------

test("HTTP: unauthenticated file and clipboard routes return 401", async () => {
  const { server, port } = await startTransferServer();
  try {
    const routes = [
      ["GET", "/api/agent/files/list"],
      ["GET", "/api/agent/files/download?path=C%3A%5Cx.bin"],
      ["GET", "/api/agent/clipboard"],
    ];
    for (const [method, route] of routes) {
      const response = await rawRequest(port, method, route);
      assert.equal(response.status, 401, `${method} ${route} must be 401`);
      assert.equal(response.json.error, "unauthorized");
    }

    const upload = await rawRequest(port, "POST", "/api/agent/files/upload", {
      headers: { "x-silkwarp-filename": "x.bin", "Content-Type": "application/octet-stream" },
      body: Buffer.from("no token"),
    });
    assert.equal(upload.status, 401);

    const clipboardPost = await rawRequest(port, "POST", "/api/agent/clipboard", {
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ kind: "text", text: "x" })),
    });
    assert.equal(clipboardPost.status, 401);

    const badToken = await rawRequest(port, "GET", "/api/agent/files/list", { token: "deadbeef" });
    assert.equal(badToken.status, 401);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 6. HTTP: streamed upload / listing / download roundtrip
// ---------------------------------------------------------------------------

test("HTTP: 2 MB binary upload with Chinese filename streams to disk and auto-renames duplicates", async () => {
  const { server, port, token, client, receiveDir, received } = await startTransferServer();
  try {
    const payload = crypto.randomBytes(2 * 1024 * 1024);
    const sourceDir = makeTempDir("upload-src");
    const sourcePath = path.join(sourceDir, "测试报告 (终版).bin");
    fs.writeFileSync(sourcePath, payload);

    const progress = [];
    const first = await client.uploadFileStream("127.0.0.1", port, token, sourcePath, {
      onProgress: (p) => progress.push(p),
    });

    assert.equal(first.ok, true);
    assert.equal(first.filename, "测试报告 (终版).bin");
    assert.equal(first.size, payload.length);
    assert.equal(path.dirname(first.path), receiveDir);

    const onDisk = fs.readFileSync(first.path);
    assert.equal(onDisk.length, payload.length);
    assert.equal(sha256(onDisk), sha256(payload), "uploaded bytes must match the source");

    assert.ok(progress.length > 0, "progress callback must fire");
    assert.equal(progress[progress.length - 1].transferred, payload.length);
    assert.equal(progress[progress.length - 1].total, payload.length);
    for (const point of progress) {
      assert.ok(point.transferred > 0 && point.transferred <= payload.length);
      assert.equal(point.total, payload.length);
    }

    assert.equal(received.length, 1);
    assert.equal(received[0].filename, "测试报告 (终版).bin");
    assert.equal(received[0].size, payload.length);

    // Duplicate upload must not overwrite: auto-rename to " (1)".
    const progress2 = [];
    const second = await client.uploadFileStream("127.0.0.1", port, token, sourcePath, {
      onProgress: (p) => progress2.push(p),
    });
    assert.equal(second.ok, true);
    assert.equal(second.filename, "测试报告 (终版) (1).bin");
    assert.notEqual(second.path, first.path);
    assert.equal(sha256(fs.readFileSync(second.path)), sha256(payload));
    assert.equal(fs.readFileSync(first.path).length, payload.length, "original must be untouched");
    assert.equal(received.length, 2);

    // A third upload goes to " (2)".
    const third = await client.uploadFileStream("127.0.0.1", port, token, sourcePath);
    assert.equal(third.filename, "测试报告 (终版) (2).bin");

    // No leftover part files anywhere in the receive directory.
    const leftovers = fs.readdirSync(receiveDir).filter((name) => name.includes(".silkwarp.part"));
    assert.deepEqual(leftovers, []);
  } finally {
    await server.stop();
  }
});

test("HTTP: listRemoteFiles reports entries, sizes, directories-first sorting and roots", async () => {
  const receiveDir = makeTempDir("list");
  fs.mkdirSync(path.join(receiveDir, "subdir"));
  const small = Buffer.from("hello silkwarp", "utf8");
  const large = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(path.join(receiveDir, "zeta.txt"), small);
  fs.writeFileSync(path.join(receiveDir, "alpha.bin"), large);
  fs.writeFileSync(path.join(receiveDir, "中文文件.dat"), Buffer.from("cn"));

  const { server, port, token, client } = await startTransferServer({ defaultReceiveDir: receiveDir });
  try {
    const listing = await client.listRemoteFiles("127.0.0.1", port, token);
    assert.equal(listing.currentPath, receiveDir);
    assert.equal(listing.roots.length >= 1, true);
    assert.equal(listing.roots[0].path, receiveDir);

    const names = listing.entries.map((entry) => entry.name);
    assert.deepEqual(names, ["subdir", "alpha.bin", "zeta.txt", "中文文件.dat"]);

    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("subdir").isDirectory, true);
    assert.equal(byName.get("subdir").size, 0);
    assert.equal(byName.get("alpha.bin").size, large.length);
    assert.equal(byName.get("zeta.txt").size, small.length);
    assert.equal(byName.get("中文文件.dat").size, 2);
    for (const entry of listing.entries) {
      assert.equal(typeof entry.modifiedAt, "number");
      assert.equal(entry.path, path.join(receiveDir, entry.name));
    }

    // Browsing into a subdirectory reports the parent.
    const sub = await client.listRemoteFiles("127.0.0.1", port, token, path.join(receiveDir, "subdir"));
    assert.equal(sub.currentPath, path.join(receiveDir, "subdir"));
    assert.equal(sub.parentPath, receiveDir);
    assert.deepEqual(sub.entries, []);

    // The receive directory is created on demand for an empty default.
    const emptyDir = path.join(makeTempDir("list-empty-parent"), "not-yet-created");
    const other = await startTransferServer({ defaultReceiveDir: emptyDir });
    try {
      const created = await other.client.listRemoteFiles("127.0.0.1", other.port, other.token);
      assert.equal(created.currentPath, emptyDir);
      assert.equal(fs.existsSync(emptyDir), true);
    } finally {
      await other.server.stop();
    }
  } finally {
    await server.stop();
  }
});

test("HTTP: downloadFileStream roundtrips byte-for-byte and fires progress", async () => {
  const { server, port, token, client, receiveDir } = await startTransferServer();
  try {
    const payload = crypto.randomBytes(512 * 1024 + 17);
    const uploadSource = path.join(makeTempDir("dl-src"), "payload.bin");
    fs.writeFileSync(uploadSource, payload);

    const uploaded = await client.uploadFileStream("127.0.0.1", port, token, uploadSource);
    assert.equal(sha256(fs.readFileSync(uploaded.path)), sha256(payload));

    const savePath = path.join(makeTempDir("dl-dest"), "nested", "restored.bin");
    const progress = [];
    const downloaded = await client.downloadFileStream(
      "127.0.0.1",
      port,
      token,
      uploaded.path,
      savePath,
      { onProgress: (p) => progress.push(p) },
    );

    assert.equal(downloaded.ok, true);
    assert.equal(downloaded.path, savePath);
    assert.equal(downloaded.size, payload.length);
    assert.equal(sha256(fs.readFileSync(savePath)), sha256(payload), "downloaded bytes must match exactly");
    assert.ok(progress.length > 0, "download progress must fire");
    assert.equal(progress[progress.length - 1].transferred, payload.length);
    assert.equal(progress[progress.length - 1].total, payload.length);

    // Intermediate .part file is renamed away.
    assert.equal(fs.existsSync(`${savePath}.part`), false);

    // Uploaded file also lives in the receive dir with the expected name.
    assert.equal(path.dirname(uploaded.path), receiveDir);
  } finally {
    await server.stop();
  }
});

test("HTTP: download rejects missing paths and directories", async () => {
  const { server, port, token, client, receiveDir } = await startTransferServer();
  try {
    await assert.rejects(
      () => client.downloadFileStream("127.0.0.1", port, token, path.join(receiveDir, "missing.bin"), path.join(makeTempDir("dl-missing"), "x.bin")),
      (err) => err instanceof AgentClientError && err.statusCode === 404,
    );

    await assert.rejects(
      () => client.downloadFileStream("127.0.0.1", port, token, receiveDir, path.join(makeTempDir("dl-dir"), "x.bin")),
      (err) => err instanceof AgentClientError && err.statusCode === 400,
    );

    const emptyPath = await rawRequest(port, "GET", "/api/agent/files/download", { token });
    assert.equal(emptyPath.status, 400);
    assert.equal(emptyPath.json.error, "path_required");
  } finally {
    await server.stop();
  }
});

test("HTTP: target-dir header uploads into a subfolder and rejects escapes in restricted mode", async () => {
  const receiveDir = makeTempDir("target");
  const { server, port, token, client } = await startTransferServer({
    defaultReceiveDir: receiveDir,
    roots: [{ label: "接收文件夹", path: receiveDir }],
    restrictToRoots: true,
  });
  try {
    const source = path.join(makeTempDir("target-src"), "inside.txt");
    fs.writeFileSync(source, "inside-bytes");

    const target = path.join(receiveDir, "sub", "deeper");
    const result = await client.uploadFileStream("127.0.0.1", port, token, source, { targetDir: target });
    assert.equal(result.ok, true);
    assert.equal(path.dirname(result.path), target);
    assert.equal(fs.readFileSync(result.path, "utf8"), "inside-bytes");

    const outsideDir = makeTempDir("target-outside");
    await assert.rejects(
      () => client.uploadFileStream("127.0.0.1", port, token, source, { targetDir: outsideDir }),
      (err) => err instanceof AgentClientError && err.statusCode === 403,
    );

    const escapeListing = await rawRequest(
      port,
      "GET",
      `/api/agent/files/list?path=${encodeURIComponent(outsideDir)}`,
      { token },
    );
    assert.equal(escapeListing.status, 403);

    const escapeDownload = await rawRequest(
      port,
      "GET",
      `/api/agent/files/download?path=${encodeURIComponent(path.join(outsideDir, "x.txt"))}`,
      { token },
    );
    assert.equal(escapeDownload.status, 403);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 7. HTTP: upload size guard
// ---------------------------------------------------------------------------

test("HTTP: upload over maxUploadBytes returns 413 and leaves no orphan .part file", async () => {
  const receiveDir = makeTempDir("oversize");
  const maxUploadBytes = 256 * 1024;
  const { server, port, token, client, received } = await startTransferServer({
    defaultReceiveDir: receiveDir,
    maxUploadBytes,
  });
  try {
    const tooLarge = crypto.randomBytes(maxUploadBytes + 1);
    const source = path.join(makeTempDir("oversize-src"), "too-big.bin");
    fs.writeFileSync(source, tooLarge);

    await assert.rejects(
      () => client.uploadFileStream("127.0.0.1", port, token, source),
      (err) => {
        assert.ok(err instanceof AgentClientError);
        assert.equal(err.statusCode, 413);
        assert.equal(err.code, "file_too_large");
        return true;
      },
    );

    assert.deepEqual(fs.readdirSync(receiveDir), [], "no file or .part may survive a rejected upload");
    assert.equal(received.length, 0);

    // Exactly at the limit still succeeds.
    const exact = crypto.randomBytes(maxUploadBytes);
    const exactSource = path.join(makeTempDir("oversize-exact"), "exact.bin");
    fs.writeFileSync(exactSource, exact);
    const accepted = await client.uploadFileStream("127.0.0.1", port, token, exactSource);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.size, maxUploadBytes);
    assert.equal(sha256(fs.readFileSync(accepted.path)), sha256(exact));
  } finally {
    await server.stop();
  }
});

test("HTTP: declared Content-Length over the limit is rejected before reading the body", async () => {
  const receiveDir = makeTempDir("declared");
  const { server, port, token } = await startTransferServer({
    defaultReceiveDir: receiveDir,
    maxUploadBytes: 1024,
  });
  try {
    const response = await rawRequest(port, "POST", "/api/agent/files/upload", {
      token,
      headers: {
        "x-silkwarp-filename": "big.bin",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(4096),
      },
      body: Buffer.alloc(16),
    });
    assert.equal(response.status, 413);
    assert.equal(response.json.error, "file_too_large");
    assert.equal(response.json.maxUploadBytes, 1024);
    assert.deepEqual(fs.readdirSync(receiveDir), []);
  } finally {
    await server.stop();
  }
});

test("HTTP: an aborted upload removes its .silkwarp.part file", async () => {
  const receiveDir = makeTempDir("aborted");
  const { server, port, token } = await startTransferServer({ defaultReceiveDir: receiveDir });
  try {
    await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/agent/files/upload",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-silkwarp-filename": "aborted.bin",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(1024 * 1024),
        },
      });
      req.on("error", resolve);
      req.write(Buffer.alloc(64 * 1024));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 80);
    });

    // Give the server a moment to observe the socket teardown and clean up.
    for (let attempt = 0; attempt < 40 && fs.readdirSync(receiveDir).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(fs.readdirSync(receiveDir), [], "aborted upload must not leave a .part file");
  } finally {
    await server.stop();
  }
});

test("HTTP: upload via query filename and raw (unencoded) header both work", async () => {
  const receiveDir = makeTempDir("filename-sources");
  const { server, port, token } = await startTransferServer({ defaultReceiveDir: receiveDir });
  try {
    // Query fallback: URLSearchParams decodes once, server must not decode twice.
    const viaQuery = await rawRequest(
      port,
      "POST",
      `/api/agent/files/upload?filename=${encodeURIComponent("100% 完成.bin")}`,
      {
        token,
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from("query-bytes"),
      },
    );
    assert.equal(viaQuery.status, 200);
    assert.equal(viaQuery.json.filename, "100% 完成.bin");
    assert.equal(fs.readFileSync(viaQuery.json.path, "utf8"), "query-bytes");

    // Header with a literal percent sign (no valid escape) must survive.
    const viaHeader = await rawRequest(port, "POST", "/api/agent/files/upload", {
      token,
      headers: { "Content-Type": "application/octet-stream", "x-silkwarp-filename": "50% off.txt" },
      body: Buffer.from("header-bytes"),
    });
    assert.equal(viaHeader.status, 200);
    assert.equal(viaHeader.json.filename, "50% off.txt");
  } finally {
    await server.stop();
  }
});

test("HTTP: concurrent uploads of the same name never overwrite each other", async () => {
  const receiveDir = makeTempDir("concurrent");
  const { server, port, token, client } = await startTransferServer({ defaultReceiveDir: receiveDir });
  try {
    const sourceDir = makeTempDir("concurrent-src");
    const source = path.join(sourceDir, "same-name.bin");
    const payload = crypto.randomBytes(256 * 1024);
    fs.writeFileSync(source, payload);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.uploadFileStream("127.0.0.1", port, token, source)),
    );

    const filenames = results.map((result) => result.filename).sort();
    assert.deepEqual(filenames, [
      "same-name (1).bin",
      "same-name (2).bin",
      "same-name (3).bin",
      "same-name (4).bin",
      "same-name.bin",
    ]);
    assert.equal(new Set(results.map((result) => result.path)).size, 5, "every upload needs its own path");
    for (const result of results) {
      assert.equal(sha256(fs.readFileSync(result.path)), sha256(payload));
    }
    assert.equal(fs.readdirSync(receiveDir).filter((name) => name.includes(".part")).length, 0);
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 8. HTTP: clipboard roundtrip
// ---------------------------------------------------------------------------

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("HTTP: clipboard text roundtrip via GET/POST", async () => {
  const { server, port, token, client, clipboard, remoteClipboardUpdates } = await startTransferServer();
  try {
    const initial = await client.getRemoteClipboard("127.0.0.1", port, token);
    assert.equal(initial.ok, true);
    assert.equal(initial.payload.kind, "empty");

    const result = await client.setRemoteClipboard("127.0.0.1", port, token, {
      kind: "text",
      text: "从主控端复制的中文剪贴板",
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "text");
    assert.match(result.fingerprint, /^[0-9a-f]{64}$/);

    const echoed = await client.getRemoteClipboard("127.0.0.1", port, token);
    assert.equal(echoed.payload.kind, "text");
    assert.equal(echoed.payload.text, "从主控端复制的中文剪贴板");
    assert.equal(typeof echoed.payload.updatedAt, "number");

    assert.equal(clipboard.state.writes.length, 1);
    assert.equal(remoteClipboardUpdates.length, 1);
    assert.equal(remoteClipboardUpdates[0].kind, "text");
  } finally {
    await server.stop();
  }
});

test("HTTP: clipboard image roundtrip and oversized image rejection", async () => {
  const { server, port, token, client } = await startTransferServer();
  try {
    const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
    const result = await client.setRemoteClipboard("127.0.0.1", port, token, {
      kind: "image",
      imageBase64: TINY_PNG_BASE64,
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "image");

    const echoed = await client.getRemoteClipboard("127.0.0.1", port, token);
    assert.equal(echoed.payload.kind, "image");
    assert.equal(echoed.payload.imageBase64, TINY_PNG_BASE64);
    assert.equal(Buffer.from(echoed.payload.imageBase64, "base64").length, pngBytes.length);

    // Build a base64 payload whose decoded size is just over the 10 MiB limit.
    const oversizedBytes = MAX_CLIPBOARD_IMAGE_BYTES + 1024;
    const oversizedBase64 = Buffer.alloc(oversizedBytes, 0x41).toString("base64");
    await assert.rejects(
      () =>
        client.setRemoteClipboard("127.0.0.1", port, token, {
          kind: "image",
          imageBase64: oversizedBase64,
        }),
      (err) => {
        assert.ok(err instanceof AgentClientError);
        assert.equal(err.statusCode, 413);
        assert.equal(err.code, "clipboard_image_too_large");
        return true;
      },
    );

    // Missing image data is a 400.
    await assert.rejects(
      () => client.setRemoteClipboard("127.0.0.1", port, token, { kind: "image" }),
      (err) => err instanceof AgentClientError && err.statusCode === 400 && err.code === "image_required",
    );
  } finally {
    await server.stop();
  }
});

test("HTTP: clipboard files roundtrip, invalid kind rejected, fingerprint stable", async () => {
  const { server, port, token, client } = await startTransferServer();
  try {
    const files = ["C:\\Users\\Roger\\Desktop\\a.txt", "C:\\Users\\Roger\\Desktop\\b.pdf"];
    const first = await client.setRemoteClipboard("127.0.0.1", port, token, { kind: "files", files });
    assert.equal(first.ok, true);
    assert.equal(first.kind, "files");

    const echoed = await client.getRemoteClipboard("127.0.0.1", port, token);
    assert.equal(echoed.payload.kind, "files");
    assert.deepEqual(echoed.payload.files, files);

    const reordered = await client.setRemoteClipboard("127.0.0.1", port, token, {
      kind: "files",
      files: [...files].reverse(),
    });
    assert.equal(reordered.fingerprint, first.fingerprint, "sorted file list must fingerprint identically");

    const invalid = await rawRequest(port, "POST", "/api/agent/clipboard", {
      token,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ kind: "video", text: "nope" })),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, "invalid_clipboard_kind");

    const emptyKind = await rawRequest(port, "POST", "/api/agent/clipboard", {
      token,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ kind: "empty" })),
    });
    assert.equal(emptyKind.status, 400);
    assert.equal(emptyKind.json.error, "invalid_clipboard_kind");
  } finally {
    await server.stop();
  }
});

test("HTTP: clipboard text fingerprint matches the shared helper", async () => {
  const { server, port, token, client } = await startTransferServer();
  try {
    const text = "跨端剪贴板 fingerprint 校验";
    const result = await client.setRemoteClipboard("127.0.0.1", port, token, { kind: "text", text });
    assert.equal(result.fingerprint, computeClipboardFingerprint({ kind: "text", text }));
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------------
// 9. Constants
// ---------------------------------------------------------------------------

test("constants: 2 GiB upload ceiling and 10 MiB clipboard image ceiling", () => {
  assert.equal(MAX_UPLOAD_FILE_BYTES, 2 * 1024 * 1024 * 1024);
  assert.equal(MAX_CLIPBOARD_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_CLIPBOARD_AUTO_FILES_BYTES, 50 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// 10. ClipboardSyncManager: loop suppression
// ---------------------------------------------------------------------------

/**
 * In-memory double of the parts of HostAgentClient the sync manager uses.
 * `remote` models the host clipboard, `setCalls` records pushes so the tests can
 * assert that a mirrored value is never echoed back.
 */
function makeSyncHarness(options = {}) {
  const remote = {
    payload: options.remote ?? { kind: "empty", updatedAt: Date.now() },
    setCalls: [],
    getCalls: 0,
  };
  const local = {
    payload: options.local ?? { kind: "empty", updatedAt: Date.now() },
    writes: [],
  };
  const uploads = [];
  const downloads = [];

  const adapter = {
    read: async () => local.payload,
    write: async (payload) => {
      local.payload = payload;
      local.writes.push(payload);
      return { ok: true, kind: payload.kind };
    },
  };

  const client = {
    setRemoteClipboard: async (_host, _port, _token, payload) => {
      remote.setCalls.push(payload);
      remote.payload = { ...payload, updatedAt: Date.now() };
      return { ok: true, kind: payload.kind, fingerprint: computeClipboardFingerprint(payload) };
    },
    getRemoteClipboard: async () => {
      remote.getCalls += 1;
      return { ok: true, payload: remote.payload };
    },
    uploadFileStream: async (_host, _port, _token, localFilePath) => {
      uploads.push(localFilePath);
      return {
        ok: true,
        filename: path.basename(localFilePath),
        path: `C:\\remote\\SilkWarpRecv\\${path.basename(localFilePath)}`,
        size: fs.statSync(localFilePath).size,
      };
    },
    listRemoteFiles: async () => ({ currentPath: "C:\\remote", parentPath: null, roots: [], entries: [] }),
    downloadFileStream: async (_host, _port, _token, remotePath, localSavePath) => {
      downloads.push({ remotePath, localSavePath });
      fs.mkdirSync(path.dirname(localSavePath), { recursive: true });
      fs.writeFileSync(localSavePath, "downloaded");
      return { ok: true, path: localSavePath, size: 10 };
    },
  };

  const manager = new ClipboardSyncManager({
    getTarget: () => ({ connected: true, host: "127.0.0.1", port: 19580, token: "test-token" }),
    adapter,
    client,
    defaultReceiveDir: options.receiveDir ?? makeTempDir("clip-recv"),
  });

  return { manager, remote, local, adapter, client, uploads, downloads };
}

test("ClipboardSyncManager: local text syncs to the host exactly once (no echo on later ticks)", async () => {
  const harness = makeSyncHarness();
  harness.local.payload = { kind: "text", text: "主控端复制的中文文本", updatedAt: Date.now() };

  await harness.manager.syncOnce();
  assert.equal(harness.remote.setCalls.length, 1, "first tick must push the local text");
  assert.equal(harness.remote.setCalls[0].kind, "text");
  assert.equal(harness.remote.setCalls[0].text, "主控端复制的中文文本");
  assert.equal(harness.manager.lastKind, "text");
  assert.equal(typeof harness.manager.lastSyncedAt, "number");

  // The host now reports the same text back; it must be recognised as our own
  // write and neither re-pushed nor re-applied locally.
  for (let i = 0; i < 3; i += 1) {
    await harness.manager.syncOnce();
  }
  assert.equal(harness.remote.setCalls.length, 1, "identical local clipboard must not be re-pushed");
  assert.equal(harness.local.writes.length, 0, "our own text must never be written back locally");
  assert.equal(harness.manager.lastError, "");
});

test("ClipboardSyncManager: remote text applies locally without echoing back to the host", async () => {
  const harness = makeSyncHarness();
  harness.remote.payload = { kind: "text", text: "来自被控端的剪贴板", updatedAt: Date.now() };

  await harness.manager.syncOnce();
  assert.equal(harness.local.writes.length, 1, "remote text must be written to the local clipboard");
  assert.equal(harness.local.writes[0].text, "来自被控端的剪贴板");
  assert.equal(harness.remote.setCalls.length, 0, "nothing was locally changed, so nothing is pushed");
  assert.equal(harness.manager.lastKind, "text");

  // The local clipboard now holds the applied text; subsequent ticks must be
  // silent in both directions.
  for (let i = 0; i < 3; i += 1) {
    await harness.manager.syncOnce();
  }
  assert.equal(harness.local.writes.length, 1, "the applied text must not be re-applied");
  assert.equal(harness.remote.setCalls.length, 0, "the applied text must not be echoed to the host");
});

test("ClipboardSyncManager: disabled toggle stops all automatic synchronisation", async () => {
  const harness = makeSyncHarness();
  harness.local.payload = { kind: "text", text: "暂停期间复制的内容", updatedAt: Date.now() };
  harness.remote.payload = { kind: "text", text: "暂停期间远端内容", updatedAt: Date.now() };

  harness.manager.setEnabled(false);
  assert.equal(harness.manager.enabled, false);

  for (let i = 0; i < 3; i += 1) {
    await harness.manager.syncOnce();
  }
  assert.equal(harness.remote.setCalls.length, 0, "disabled manager must not push");
  assert.equal(harness.remote.getCalls, 0, "disabled manager must not even poll the host");
  assert.equal(harness.local.writes.length, 0, "disabled manager must not apply remote payloads");

  // Re-enabling resumes on the next explicit tick.
  harness.manager.setEnabled(true);
  await harness.manager.syncOnce();
  assert.ok(harness.remote.setCalls.length + harness.local.writes.length > 0, "re-enabled manager must sync");
});

test("ClipboardSyncManager: clipboard image syncs both ways without loops", async () => {
  const pngBase64 = TINY_PNG_BASE64;
  const harness = makeSyncHarness();
  harness.local.payload = { kind: "image", imageBase64: pngBase64, updatedAt: Date.now() };

  await harness.manager.syncOnce();
  assert.equal(harness.remote.setCalls.length, 1);
  assert.equal(harness.remote.setCalls[0].kind, "image");
  assert.equal(harness.remote.setCalls[0].imageBase64, pngBase64);

  await harness.manager.syncOnce();
  assert.equal(harness.remote.setCalls.length, 1, "image echo must be suppressed");

  // Reverse direction: a fresh remote image reaches the local clipboard.
  harness.remote.payload = {
    kind: "image",
    imageBase64: Buffer.from("silkwarp-second-image").toString("base64"),
    updatedAt: Date.now(),
  };
  await harness.manager.syncOnce();
  assert.equal(harness.local.writes.length, 1, "remote image must be applied locally");
  assert.equal(harness.manager.lastKind, "image");
});

test("ClipboardSyncManager: clipboard files upload once then suppress the echoed file list", async () => {
  const receiveDir = makeTempDir("clip-files-recv");
  const sourceDir = makeTempDir("clip-files-src");
  const first = path.join(sourceDir, "a.txt");
  const second = path.join(sourceDir, "b.bin");
  fs.writeFileSync(first, "alpha");
  fs.writeFileSync(second, crypto.randomBytes(2048));

  const harness = makeSyncHarness({ receiveDir });
  harness.local.payload = { kind: "files", files: [first, second], updatedAt: Date.now() };

  await harness.manager.syncOnce();
  assert.deepEqual(harness.uploads, [first, second], "each clipboard file is uploaded once");
  assert.equal(harness.remote.setCalls.length, 1);
  assert.equal(harness.remote.setCalls[0].kind, "files");
  assert.equal(harness.remote.setCalls[0].files.length, 2);
  assert.equal(harness.manager.lastKind, "files");

  await harness.manager.syncOnce();
  assert.equal(harness.remote.setCalls.length, 1, "the uploaded file list must not be pushed again");
  assert.equal(harness.local.writes.length, 0, "the echoed remote path list must not replace local files");
});

test("ClipboardSyncManager: clipboard files over 50 MiB are skipped instead of uploaded", async () => {
  const sourceDir = makeTempDir("clip-huge-src");
  const huge = path.join(sourceDir, "huge.bin");
  // Sparse file: fs.stat reports the size without writing 51 MiB to disk.
  fs.writeFileSync(huge, "");
  fs.truncateSync(huge, MAX_CLIPBOARD_AUTO_FILES_BYTES + 1);

  const harness = makeSyncHarness();
  harness.local.payload = { kind: "files", files: [huge], updatedAt: Date.now() };

  await harness.manager.syncOnce();
  assert.deepEqual(harness.uploads, [], "oversized clipboard files must not be uploaded");
  assert.equal(harness.remote.setCalls.length, 0);
  assert.match(harness.manager.lastError, /50 MiB/);

  // The skipped selection is remembered, so it is not retried on every tick.
  await harness.manager.syncOnce();
  assert.deepEqual(harness.uploads, []);
});

test("ClipboardSyncManager: remote clipboard files download into SilkWarpRecv and update both fingerprints", async () => {
  const receiveDir = makeTempDir("clip-pull-recv");
  const harness = makeSyncHarness({ receiveDir });
  harness.remote.payload = {
    kind: "files",
    files: ["C:\\Host\\Desktop\\报告.pdf"],
    updatedAt: Date.now(),
  };

  await harness.manager.syncOnce();
  assert.equal(harness.downloads.length, 1);
  assert.equal(harness.downloads[0].remotePath, "C:\\Host\\Desktop\\报告.pdf");
  assert.equal(path.dirname(harness.downloads[0].localSavePath), receiveDir);
  assert.equal(path.basename(harness.downloads[0].localSavePath), "报告.pdf");

  assert.equal(harness.local.writes.length, 1, "downloaded paths must land on the local file clipboard");
  assert.equal(harness.local.writes[0].kind, "files");
  assert.deepEqual(harness.local.writes[0].files, [harness.downloads[0].localSavePath]);
  assert.equal(harness.manager.lastKind, "files");

  // Local CF_HDROP now exposes local paths — pushing them back would re-upload
  // the same file under a new name, so the fingerprint must already match.
  for (let i = 0; i < 2; i += 1) {
    await harness.manager.syncOnce();
  }
  assert.equal(harness.uploads.length, 0, "downloaded files must never be uploaded back");
  assert.equal(harness.local.writes.length, 1);
});

test("ClipboardSyncManager: empty clipboards and single-flight guard produce no traffic", async () => {
  const harness = makeSyncHarness();

  await harness.manager.syncOnce();
  assert.equal(harness.remote.setCalls.length, 0);
  assert.equal(harness.local.writes.length, 0);
  assert.equal(harness.manager.lastKind, "empty");

  // Concurrent ticks: the in-flight lock drops the second call entirely.
  harness.local.payload = { kind: "text", text: "并发保护", updatedAt: Date.now() };
  await Promise.all([harness.manager.syncOnce(), harness.manager.syncOnce(), harness.manager.syncOnce()]);
  assert.equal(harness.remote.setCalls.length, 1, "single-flight lock must collapse concurrent ticks");

  // A disconnected target stops all work.
  const idle = new ClipboardSyncManager({
    getTarget: () => ({ connected: false, host: "127.0.0.1", port: 19580, token: "" }),
    adapter: harness.adapter,
    client: harness.client,
  });
  await idle.syncOnce();
  assert.equal(harness.remote.getCalls > 0, true);
});

test("ClipboardSyncManager: adapter write failures surface as lastError without echoing", async () => {
  const harness = makeSyncHarness();
  const failingAdapter = {
    read: async () => ({ kind: "empty", updatedAt: Date.now() }),
    write: async () => ({ ok: false, kind: "text", message: "剪贴板被占用" }),
  };
  const manager = new ClipboardSyncManager({
    getTarget: () => ({ connected: true, host: "127.0.0.1", port: 19580, token: "t" }),
    adapter: failingAdapter,
    client: harness.client,
  });

  harness.remote.payload = { kind: "text", text: "远端文本", updatedAt: Date.now() };
  await manager.syncOnce();
  assert.equal(manager.lastError, "剪贴板被占用");
  assert.equal(harness.remote.setCalls.length, 0, "a failed local write must not be pushed back");
  // The failed payload is not marked as applied, so the next tick retries it.
  harness.remote.payload = { kind: "text", text: "远端文本", updatedAt: Date.now() };
  await manager.syncOnce();
  assert.equal(manager.lastError, "剪贴板被占用");
});

// ---------------------------------------------------------------------------
// 11. ClipboardSyncManager: Electron adapter (injected, no Electron needed)
// ---------------------------------------------------------------------------

test("createElectronClipboardAdapter: reads files > image > text in priority order", async () => {
  const { createElectronClipboardAdapter } = require("../dist-electron/services/clipboardSyncManager.js");
  const fileA = path.join(makeTempDir("adapter-src"), "存在.txt");
  fs.writeFileSync(fileA, "x");
  const missing = path.join(os.tmpdir(), `silkwarp-missing-${Date.now()}.bin`);

  let imageIsEmpty = false;
  let textValue = "退而求其次的文本";
  const written = { texts: [], images: [] };
  const deps = {
    clipboard: {
      readText: () => textValue,
      writeText: (text) => written.texts.push(text),
      readImage: () => ({
        isEmpty: () => imageIsEmpty,
        toPNG: () => Buffer.from(TINY_PNG_BASE64, "base64"),
      }),
      writeImage: (img) => written.images.push(img),
    },
    nativeImage: { createFromBuffer: (buffer) => ({ buffer }) },
    fileDropList: {
      read: async () => [fileA, missing],
      write: async (paths) => paths.length > 0,
    },
  };
  const adapter = createElectronClipboardAdapter(deps);

  // Files win when present; missing paths are filtered out.
  const filesPayload = await adapter.read();
  assert.equal(filesPayload.kind, "files");
  assert.deepEqual(filesPayload.files, [fileA]);

  // No files -> image.
  deps.fileDropList.read = async () => [];
  imageIsEmpty = false;
  const imagePayload = await adapter.read();
  assert.equal(imagePayload.kind, "image");
  assert.equal(imagePayload.imageBase64, TINY_PNG_BASE64);

  // No image -> text.
  imageIsEmpty = true;
  const textPayload = await adapter.read();
  assert.equal(textPayload.kind, "text");
  assert.equal(textPayload.text, textValue);

  // No text -> empty.
  textValue = "";
  const emptyPayload = await adapter.read();
  assert.equal(emptyPayload.kind, "empty");

  // Writes route by kind.
  const textWrite = await adapter.write({ kind: "text", text: "写入", updatedAt: Date.now() });
  assert.equal(textWrite.ok, true);
  assert.deepEqual(written.texts, ["写入"]);

  const imageWrite = await adapter.write({
    kind: "image",
    imageBase64: TINY_PNG_BASE64,
    updatedAt: Date.now(),
  });
  assert.equal(imageWrite.ok, true);
  assert.equal(written.images.length, 1);

  const fileWrite = await adapter.write({ kind: "files", files: [fileA], updatedAt: Date.now() });
  assert.equal(fileWrite.ok, true);

  const missingWrite = await adapter.write({ kind: "files", files: [missing], updatedAt: Date.now() });
  assert.equal(missingWrite.ok, false);
  assert.match(missingWrite.message, /没有可写入/);
});

test("createElectronClipboardAdapter: oversized image payloads are rejected", async () => {
  const { createElectronClipboardAdapter } = require("../dist-electron/services/clipboardSyncManager.js");
  const adapter = createElectronClipboardAdapter({
    clipboard: {
      readText: () => "",
      writeText: () => {},
      readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
      writeImage: () => {},
    },
    nativeImage: { createFromBuffer: (buffer) => ({ buffer }) },
    fileDropList: { read: async () => [], write: async () => true },
  });

  const oversized = Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1, 0x41).toString("base64");
  const result = await adapter.write({ kind: "image", imageBase64: oversized, updatedAt: Date.now() });
  assert.equal(result.ok, false);
  assert.match(result.message, /10 MiB/);
});

test("createElectronClipboardAdapter: caches CF_HDROP probe when native clipboard buffers are unchanged", async () => {
  const { createElectronClipboardAdapter } = require("../dist-electron/services/clipboardSyncManager.js");
  const dir = makeTempDir("adapter-drop-cache");
  const file1 = path.join(dir, "one.txt");
  const file2 = path.join(dir, "two.txt");
  fs.writeFileSync(file1, "1");
  fs.writeFileSync(file2, "2");

  let activeFiles = [file1];
  let currentBuf = Buffer.from("drop-v1", "utf8");
  let readCalls = 0;

  const adapter = createElectronClipboardAdapter({
    clipboard: {
      readText: () => "",
      writeText: () => {},
      readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
      writeImage: () => {},
      availableFormats: () => ["FileNameW"],
      readBuffer: (fmt) => (fmt === "FileNameW" ? currentBuf : Buffer.alloc(0)),
    },
    nativeImage: { createFromBuffer: (buffer) => ({ buffer }) },
    fileDropList: {
      read: async () => {
        readCalls += 1;
        return activeFiles;
      },
      write: async () => true,
    },
  });

  const first = await adapter.read();
  assert.deepEqual(first.files, [file1]);
  assert.equal(readCalls, 1);

  // Repeated polls with identical buffer signature reuse the cache instead of respawning PowerShell.
  const second = await adapter.read();
  const third = await adapter.read();
  assert.deepEqual(second.files, [file1]);
  assert.deepEqual(third.files, [file1]);
  assert.equal(readCalls, 1);

  // Changing the native clipboard buffer invalidates the cache immediately.
  activeFiles = [file2];
  currentBuf = Buffer.from("drop-v2", "utf8");
  const updated = await adapter.read();
  assert.deepEqual(updated.files, [file2]);
  assert.equal(readCalls, 2);

  // Calling write() invalidates the cache even if mock buffer stayed identical.
  await adapter.write({ kind: "text", text: "reset", updatedAt: Date.now() });
  const afterWrite = await adapter.read();
  assert.deepEqual(afterWrite.files, [file2]);
  assert.equal(readCalls, 3);
});
