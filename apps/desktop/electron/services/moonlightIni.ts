/**
 * Pure Moonlight portable INI optimization helpers.
 *
 * IMPORTANT: this module must not import `electron` so that Node unit tests
 * can import the compiled CommonJS module directly.
 */

export const MOONLIGHT_FAST_CONNECT_DEFAULTS = {
  confwarnings: "false",
  mdns: "false",
  detectnetblocking: "false",
  backgroundgamepad: "false",
  richpresence: "false",
} as const;

/**
 * Optimizes portable `Moonlight.ini` `[General]` settings to eliminate
 * 3.5-second launch warning delays (`confwarnings=false`), 6-second STUN
 * timeouts (`detectnetblocking=false`), and noisy mDNS background discovery
 * (`mdns=false`) while preserving certificates, keys, `[hosts]`, and
 * `[gcmapping]` byte-for-byte.
 */
export function optimizeMoonlightIni(
  raw: string,
  defaults: Record<string, string> = MOONLIGHT_FAST_CONNECT_DEFAULTS,
): { content: string; changed: boolean } {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = raw.length > 0 && (raw.endsWith("\n") || raw.endsWith("\r"));
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/);
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let generalStart = -1;
  let generalEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const secMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (!secMatch) continue;
    if (generalStart < 0) {
      if (secMatch[1].trim().toLowerCase() === "general") {
        generalStart = i;
      }
    } else {
      generalEnd = i;
      break;
    }
  }

  const desiredEntries = Object.entries(defaults);
  const desiredLower = new Map<string, [string, string]>();
  for (const [key, val] of desiredEntries) {
    desiredLower.set(key.toLowerCase(), [key, val]);
  }

  let changed = false;

  if (generalStart < 0) {
    // No [General] section found: prepend [General] with all fast defaults.
    const prefix = ["[General]", ...desiredEntries.map(([k, v]) => `${k}=${v}`)];
    if (lines.length > 0 && lines[0].trim() !== "") {
      prefix.push("");
    }
    const nextLines = [...prefix, ...lines];
    return {
      content: nextLines.join(eol) + eol,
      changed: true,
    };
  }

  const seenKeys = new Set<string>();
  const outLines = [...lines];

  for (let i = generalStart + 1; i < generalEnd; i++) {
    const line = outLines[i];
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const rawKey = line.slice(0, eqIdx);
    const trimmedKey = rawKey.trim().toLowerCase();
    const match = desiredLower.get(trimmedKey);
    if (!match) continue;

    seenKeys.add(trimmedKey);
    const [canonicalKey, desiredVal] = match;
    const currentVal = line.slice(eqIdx + 1).trim();
    if (currentVal !== desiredVal) {
      outLines[i] = `${rawKey.trim() || canonicalKey}=${desiredVal}`;
      changed = true;
    }
  }

  const missingLines: string[] = [];
  for (const [key, val] of desiredEntries) {
    if (!seenKeys.has(key.toLowerCase())) {
      missingLines.push(`${key}=${val}`);
    }
  }

  if (missingLines.length > 0) {
    // Insert right after the last non-empty key line inside [General] so blank
    // separator lines before the next [section] remain untouched.
    let insertAt = generalEnd;
    while (insertAt > generalStart + 1 && outLines[insertAt - 1].trim() === "") {
      insertAt--;
    }
    outLines.splice(insertAt, 0, ...missingLines);
    changed = true;
  }

  if (!changed) {
    return { content: raw, changed: false };
  }

  const nextContent = outLines.join(eol) + (hadTrailingNewline || raw.length === 0 ? eol : "");
  return { content: nextContent, changed: true };
}
