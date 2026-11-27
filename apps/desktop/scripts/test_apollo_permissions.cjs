"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APOLLO_PERM_ALL,
  needsApolloPermissionUpgrade,
  parseApolloAppEntries,
  parseApolloCurrentGameId,
  parseApolloServerInfoPermission,
  parseMoonlightIniCredentials,
} = require("../dist-electron/services/apolloPermissions.js");

test("needsApolloPermissionUpgrade: view|list only (0x03000000) still needs upgrade", () => {
  // The Think host was paired with Permission=50331648 (0x03000000, view|list).
  // The old `permVal >= 0x00ffffff` check wrongly treated it as authorized.
  assert.equal(needsApolloPermissionUpgrade(50331648, true), true);
});

test("needsApolloPermissionUpgrade: full Apollo permission set is already authorized", () => {
  assert.equal(needsApolloPermissionUpgrade(0x071f1f00, true), false);
  assert.equal(APOLLO_PERM_ALL, 119480064);
});

test("needsApolloPermissionUpgrade: 0xffffffff superset is authorized", () => {
  assert.equal(needsApolloPermissionUpgrade(0xffffffff, true), false);
});

test("needsApolloPermissionUpgrade: full permissions but client commands disabled", () => {
  assert.equal(needsApolloPermissionUpgrade(0x071f1f00, false), true);
});

test("needsApolloPermissionUpgrade: zero permission needs upgrade", () => {
  assert.equal(needsApolloPermissionUpgrade(0, true), true);
});

test("parseMoonlightIniCredentials: extracts Qt @ByteArray cert/key and uniqueid", () => {
  const certBody = "-----BEGIN CERTIFICATE-----\\nMIIBcertdata\\n-----END CERTIFICATE-----\\n";
  const keyBody = "-----BEGIN PRIVATE KEY-----\\nMIIBkeydata\\n-----END PRIVATE KEY-----\\n";
  const ini = [
    "[General]",
    "uniqueid=0123456789ABCDEF",
    `certificate="@ByteArray(${certBody})"`,
    `key="@ByteArray(${keyBody})"`,
    "",
  ].join("\r\n");

  const parsed = parseMoonlightIniCredentials(ini);
  assert.ok(parsed);
  assert.equal(parsed.uniqueId, "0123456789ABCDEF");
  assert.match(parsed.cert, /BEGIN CERTIFICATE/);
  assert.match(parsed.key, /BEGIN PRIVATE KEY/);
  // Literal `\n` escapes must be restored to real newlines.
  assert.ok(parsed.cert.includes("\n"));
  assert.ok(!parsed.cert.includes("\\n"));
});

test("parseMoonlightIniCredentials: supports unquoted values and LF line endings", () => {
  const ini = [
    "[General]",
    "uniqueid=ABCDEF",
    "certificate=@ByteArray(-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----)",
    "key=@ByteArray(-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----)",
  ].join("\n");

  const parsed = parseMoonlightIniCredentials(ini);
  assert.ok(parsed);
  assert.equal(parsed.uniqueId, "ABCDEF");
});

test("parseMoonlightIniCredentials: returns null when a field is missing", () => {
  const certOnly = [
    "[General]",
    "uniqueid=ABCDEF",
    "certificate=@ByteArray(-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----)",
  ].join("\n");
  assert.equal(parseMoonlightIniCredentials(certOnly), null);

  const missingUnique = [
    "[General]",
    "certificate=@ByteArray(-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----)",
    "key=@ByteArray(-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----)",
  ].join("\n");
  assert.equal(parseMoonlightIniCredentials(missingUnique), null);
});

test("parseMoonlightIniCredentials: rejects non-PEM payloads", () => {
  const ini = [
    "[General]",
    "uniqueid=ABCDEF",
    "certificate=@ByteArray(not-a-cert)",
    "key=@ByteArray(not-a-key)",
  ].join("\n");
  assert.equal(parseMoonlightIniCredentials(ini), null);
});

test("parseApolloServerInfoPermission: view|list permission has no input", () => {
  const xml = "<root><PairStatus>1</PairStatus><Permission>50331648</Permission></root>";
  assert.deepEqual(parseApolloServerInfoPermission(xml), {
    paired: true,
    permission: 50331648,
    hasInput: false,
  });
});

test("parseApolloServerInfoPermission: full permission has input", () => {
  const xml = "<root><PairStatus>1</PairStatus><Permission>119480064</Permission></root>";
  assert.deepEqual(parseApolloServerInfoPermission(xml), {
    paired: true,
    permission: 119480064,
    hasInput: true,
  });
});

test("parseApolloServerInfoPermission: standard Sunshine without Permission tag fails open", () => {
  const xml = "<root><PairStatus>1</PairStatus><hostname>Sunshine</hostname></root>";
  assert.deepEqual(parseApolloServerInfoPermission(xml), {
    paired: true,
    permission: null,
    hasInput: true,
  });
});

test("parseApolloCurrentGameId: extracts running app ID and falls back to 0 when idle or invalid", () => {
  assert.equal(parseApolloCurrentGameId("<root><currentgame>881448767</currentgame></root>"), 881448767);
  assert.equal(parseApolloCurrentGameId("<root><currentgame>0</currentgame></root>"), 0);
  assert.equal(parseApolloCurrentGameId("<root><state>SUNSHINE_SERVER_FREE</state></root>"), 0);
});

test("parseApolloAppEntries: extracts ordered title + numeric app ID from applist XML", () => {
  const xml = [
    '<root status_code="200">',
    "<App><IsHdrSupported>1</IsHdrSupported><AppTitle>Desktop</AppTitle><ID>881448767</ID></App>",
    "<App><IsHdrSupported>1</IsHdrSupported><AppTitle>Virtual Display</AppTitle><ID>382300562</ID></App>",
    "</root>",
  ].join("");
  assert.deepEqual(parseApolloAppEntries(xml), [
    { title: "Desktop", id: 881448767 },
    { title: "Virtual Display", id: 382300562 },
  ]);
  assert.deepEqual(parseApolloAppEntries("<root></root>"), []);
});
