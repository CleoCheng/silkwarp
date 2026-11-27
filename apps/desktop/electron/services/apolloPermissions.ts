/**
 * Apollo 0.4.6 client permission helpers.
 *
 * This module intentionally has NO `electron` imports so it can be exercised
 * directly by Node's built-in test runner against the compiled output.
 */

// Apollo v0.4.6 PERM bit masks (see Apollo `src/crypto.h`).
export const APOLLO_PERM_INPUT_CONTROLLER = 0x00000100;
export const APOLLO_PERM_INPUT_TOUCH = 0x00000200;
export const APOLLO_PERM_INPUT_PEN = 0x00000400;
export const APOLLO_PERM_INPUT_MOUSE = 0x00000800;
export const APOLLO_PERM_INPUT_KBD = 0x00001000;
export const APOLLO_PERM_ALL_INPUTS = 0x00001f00;
export const APOLLO_PERM_ALL_OPERATIONS = 0x001f0000;
export const APOLLO_PERM_ALL_ACTIONS = 0x07000000;
export const APOLLO_PERM_ALL = 0x071f1f00; // 119480064
export const APOLLO_REQUIRED_INPUT_PERM = APOLLO_PERM_INPUT_MOUSE | APOLLO_PERM_INPUT_KBD; // 0x00001800

/**
 * Returns true when the stored client permission does not cover every Apollo
 * permission bit, or when client commands are disabled.
 *
 * Note: the previous check (`permVal >= 0x00ffffff`) treated `0x03000000`
 * (view | list only) as fully authorized and skipped the upgrade.
 */
export function needsApolloPermissionUpgrade(perm: unknown, allowClientCommands: unknown): boolean {
  const permVal = Number(perm ?? 0) >>> 0;
  const allowCmd = Boolean(allowClientCommands);
  return (permVal & APOLLO_PERM_ALL) !== APOLLO_PERM_ALL || !allowCmd;
}

function parseQtByteArray(iniContent: string, fieldName: string): string | null {
  const pattern = new RegExp(
    `(?:^|[\\r\\n])\\s*${fieldName}\\s*=\\s*"?@ByteArray\\(([\\s\\S]*?)\\)"?`,
    "i",
  );
  const match = iniContent.match(pattern);
  if (!match) return null;
  // QSettings stores newlines as literal `\n` escapes inside @ByteArray(...).
  return match[1].replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}

/**
 * Extracts the client certificate, private key and unique id that Moonlight
 * persisted in its portable `Moonlight.ini`.
 */
export function parseMoonlightIniCredentials(
  iniContent: string,
): { cert: string; key: string; uniqueId: string } | null {
  const cert = parseQtByteArray(iniContent, "certificate");
  const key = parseQtByteArray(iniContent, "key");

  const uniqueMatch = iniContent.match(
    /(?:^|[\r\n])\s*uniqueid\s*=\s*"?([^"\r\n]+)"?\s*(?:\r?\n|$)/i,
  );
  const uniqueId = uniqueMatch?.[1]?.trim() ?? "";

  if (!cert || !key || !uniqueId) return null;
  if (!cert.includes("BEGIN CERTIFICATE")) return null;
  if (!key.includes("BEGIN PRIVATE KEY")) return null;

  return { cert, key, uniqueId };
}

/**
 * Parses the relevant fields of Apollo/Sunshine's `/serverinfo` XML response.
 *
 * Standard Sunshine does not expose a `<Permission>` tag, in which case we
 * treat input as available (fail-open) so normal streaming is never blocked.
 */
export function parseApolloServerInfoPermission(xml: string): {
  paired: boolean;
  permission: number | null;
  hasInput: boolean;
} {
  const pairMatch = xml.match(/<PairStatus>\s*(\d+)\s*<\/PairStatus>/);
  const paired = pairMatch?.[1] === "1";

  const permMatch = xml.match(/<Permission>\s*(\d+)\s*<\/Permission>/);
  if (!permMatch) {
    return { paired, permission: null, hasInput: true };
  }

  const permission = Number(permMatch[1]) >>> 0;
  const hasInput = (permission & APOLLO_REQUIRED_INPUT_PERM) === APOLLO_REQUIRED_INPUT_PERM;
  return { paired, permission, hasInput };
}

/**
 * Extracts `<currentgame>` from Apollo's `/serverinfo` XML (`0` when idle or absent).
 */
export function parseApolloCurrentGameId(xml: string): number {
  const match = xml.match(/<currentgame>\s*(\d+)\s*<\/currentgame>/i);
  if (!match) return 0;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export interface ApolloAppEntry {
  title: string;
  id: number;
}

/**
 * Parses `<App>` entries from Apollo's `/applist` XML preserving title and numeric app ID.
 */
export function parseApolloAppEntries(xml: string): ApolloAppEntry[] {
  const entries: ApolloAppEntry[] = [];
  const blockRe = /<App>([\s\S]*?)<\/App>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(xml)) !== null) {
    const block = blockMatch[1];
    const titleMatch = /<AppTitle>\s*([^<]+?)\s*<\/AppTitle>/i.exec(block);
    const title = titleMatch?.[1]?.trim();
    if (!title) continue;
    const idMatch = /<ID>\s*(\d+)\s*<\/ID>/i.exec(block);
    const id = idMatch ? Number(idMatch[1]) : 0;
    entries.push({ title, id: Number.isSafeInteger(id) && id > 0 ? id : 0 });
  }
  if (entries.length > 0) return entries;

  const titleRe = /<AppTitle>\s*([^<]+?)\s*<\/AppTitle>/gi;
  let titleMatch: RegExpExecArray | null;
  while ((titleMatch = titleRe.exec(xml)) !== null) {
    const title = titleMatch[1].trim();
    if (title) entries.push({ title, id: 0 });
  }
  return entries;
}
