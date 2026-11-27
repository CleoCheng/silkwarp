"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MOONLIGHT_FAST_CONNECT_DEFAULTS,
  optimizeMoonlightIni,
} = require("../dist-electron/services/moonlightIni.js");

test("optimizeMoonlightIni: inserts fast-connect defaults into [General] without touching certs or [hosts]", () => {
  const sampleIni = [
    "[General]",
    'certificate="@ByteArray(-----BEGIN CERTIFICATE-----\\nMIIBdata\\n-----END CERTIFICATE-----\\n)"',
    'key="@ByteArray(-----BEGIN PRIVATE KEY-----\\nMIIBkey\\n-----END PRIVATE KEY-----\\n)"',
    "uniqueid=cfc8f8f168723efd",
    "latestsupportedversion-v1=99.99.99.99",
    "",
    "[hosts]",
    "1\\hostname=Think",
    "1\\manualaddress=10.144.0.11",
    "1\\manualport=47989",
    "size=1",
    "",
    "[gcmapping]",
    "size=0",
    "",
  ].join("\r\n");

  const first = optimizeMoonlightIni(sampleIni);
  assert.equal(first.changed, true);
  assert.ok(first.content.includes("\r\n"), "CRLF line endings should be preserved");

  for (const [k, v] of Object.entries(MOONLIGHT_FAST_CONNECT_DEFAULTS)) {
    assert.ok(first.content.includes(`${k}=${v}`), `missing ${k}=${v}`);
  }
  assert.ok(
    first.content.includes('certificate="@ByteArray(-----BEGIN CERTIFICATE-----\\nMIIBdata\\n-----END CERTIFICATE-----\\n)"'),
    "certificate must remain intact",
  );
  assert.ok(first.content.includes("[hosts]\r\n1\\hostname=Think"), "[hosts] must remain intact");
  assert.ok(first.content.includes("[gcmapping]\r\nsize=0"), "[gcmapping] must remain intact");
  assert.ok(first.content.indexOf("confwarnings=false") < first.content.indexOf("[hosts]"));

  const second = optimizeMoonlightIni(first.content);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test("optimizeMoonlightIni: flips existing slow flags to false case-insensitively", () => {
  const sampleIni = [
    "[General]",
    "uniqueid=ABCDEF",
    "confwarnings=true",
    "mdns=true",
    "detectnetblocking=true",
    "backgroundgamepad=true",
    "richpresence=true",
    "",
    "[hosts]",
    "size=0",
    "",
  ].join("\n");

  const res = optimizeMoonlightIni(sampleIni);
  assert.equal(res.changed, true);
  assert.ok(!res.content.includes("\r\n"), "LF line endings should be preserved");
  assert.ok(res.content.includes("confwarnings=false"));
  assert.ok(res.content.includes("mdns=false"));
  assert.ok(res.content.includes("detectnetblocking=false"));
  assert.ok(res.content.includes("backgroundgamepad=false"));
  assert.ok(res.content.includes("richpresence=false"));

  const again = optimizeMoonlightIni(res.content);
  assert.equal(again.changed, false);
});

test("optimizeMoonlightIni: creates [General] cleanly when input is empty", () => {
  const res = optimizeMoonlightIni("");
  assert.equal(res.changed, true);
  assert.match(res.content, /^\[General\]/);
  for (const [k, v] of Object.entries(MOONLIGHT_FAST_CONNECT_DEFAULTS)) {
    assert.ok(res.content.includes(`${k}=${v}`));
  }
  const second = optimizeMoonlightIni(res.content);
  assert.equal(second.changed, false);
});
