"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  compareSemver,
  extractSha256FromRelease,
  isAllowedUpdateDownloadUrl,
  parseLatestReleasePayload,
  parseSemver,
  verifyFileSha256,
} = require("../dist-electron/services/updateLogic.js");

test("parseSemver & compareSemver: compares major/minor/patch accurately", () => {
  assert.deepEqual(parseSemver("v3.3.0"), [3, 3, 0]);
  assert.deepEqual(parseSemver("3.2.1-rc.1"), [3, 2, 1]);
  assert.equal(parseSemver("not-a-version"), null);

  assert.equal(compareSemver("3.3.0", "3.2.0"), 1);
  assert.equal(compareSemver("3.10.0", "3.9.9"), 1);
  assert.equal(compareSemver("v3.3.0", "3.3.0"), 0);
  assert.equal(compareSemver("3.2.0", "3.3.0"), -1);
});

test("isAllowedUpdateDownloadUrl: restricts downloads to official GitHub HTTPS origins", () => {
  assert.equal(
    isAllowedUpdateDownloadUrl("https://github.com/CleoCheng/silkwarp/releases/download/v3.3.0/SilkWarp-Setup-3.3.0.exe"),
    true,
  );
  assert.equal(
    isAllowedUpdateDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/123/SilkWarp.exe"),
    true,
  );
  assert.equal(
    isAllowedUpdateDownloadUrl("https://release-assets.githubusercontent.com/foo.exe"),
    true,
  );
  assert.equal(
    isAllowedUpdateDownloadUrl("http://github.com/CleoCheng/silkwarp/releases/download/v3.3.0/SilkWarp-Setup-3.3.0.exe"),
    false,
  );
  assert.equal(isAllowedUpdateDownloadUrl("https://evil.example.com/SilkWarp-Setup-3.3.0.exe"), false);
  assert.equal(isAllowedUpdateDownloadUrl("not a url"), false);
});

test("extractSha256FromRelease: prefers GitHub asset.digest and falls back to release body", () => {
  const hashA = "a".repeat(64);
  const hashB = "B".repeat(64);

  assert.equal(
    extractSha256FromRelease({ name: "SilkWarp-Setup-3.3.0.exe", digest: `sha256:${hashA}` }, `SHA-256: ${hashB}`),
    hashA.toUpperCase(),
  );

  assert.equal(
    extractSha256FromRelease(
      { name: "SilkWarp-Setup-3.3.0.exe" },
      `## Checksums\n- \`SilkWarp-Setup-3.3.0.exe\`: \`${hashB}\`\n`,
    ),
    hashB,
  );

  assert.equal(extractSha256FromRelease({ name: "SilkWarp-Setup-3.3.0.exe" }, "No hash present"), null);
});

test("parseLatestReleasePayload: parses newer release and ignores blockmap assets", () => {
  const hashHex = "1234567890abcdef".repeat(4);
  const payload = {
    tag_name: "v3.3.0",
    name: "SilkWarp v3.3.0",
    published_at: "2026-11-27T10:00:00Z",
    html_url: "https://github.com/CleoCheng/silkwarp/releases/tag/v3.3.0",
    body: `## 更新内容\n- 预编译原生 helper\nSHA-256: \`${hashHex}\``,
    draft: false,
    assets: [
      {
        name: "SilkWarp-Setup-3.3.0.exe.blockmap",
        browser_download_url:
          "https://github.com/CleoCheng/silkwarp/releases/download/v3.3.0/SilkWarp-Setup-3.3.0.exe.blockmap",
        size: 170000,
      },
      {
        name: "SilkWarp-Setup-3.3.0.exe",
        browser_download_url:
          "https://github.com/CleoCheng/silkwarp/releases/download/v3.3.0/SilkWarp-Setup-3.3.0.exe",
        size: 160000000,
        digest: `sha256:${hashHex}`,
      },
    ],
  };

  const avail = parseLatestReleasePayload("3.2.0", payload);
  assert.equal(avail.status, "available");
  assert.equal(avail.hasUpdate, true);
  assert.equal(avail.release.assetName, "SilkWarp-Setup-3.3.0.exe");
  assert.equal(avail.release.sha256, hashHex.toUpperCase());

  const upToDate = parseLatestReleasePayload("3.3.0", payload);
  assert.equal(upToDate.status, "up_to_date");
  assert.equal(upToDate.hasUpdate, false);

  const untrusted = parseLatestReleasePayload("3.2.0", {
    ...payload,
    assets: [
      {
        name: "SilkWarp-Setup-3.3.0.exe",
        browser_download_url: "https://untrusted.example.com/SilkWarp.exe",
        size: 1234,
      },
    ],
  });
  assert.equal(untrusted.status, "error");
  assert.equal(untrusted.hasUpdate, false);
});

test("verifyFileSha256: validates matching and mismatching temp file digests", async () => {
  const tmpFile = path.join(os.tmpdir(), `silkwarp-updater-test-${Date.now()}.bin`);
  const content = Buffer.from("silkwarp-v3.3.0-sha256-payload", "utf8");
  const expected = crypto.createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(tmpFile, content);
  try {
    assert.equal(await verifyFileSha256(tmpFile, expected.toUpperCase()), true);
    assert.equal(await verifyFileSha256(tmpFile, "0".repeat(64)), false);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});
