/**
 * Host half of the "Langfuse session upload switch" bundle.
 *
 * This plugin owns no collection, buffering, or upload code. It is a minimal,
 * authenticated bridge in front of the installed voluntary uploader
 * (`dsh-langfuse-voluntary`, which publishes
 * `globalThis[Symbol.for('dsh.langfuse.voluntary')]`). The bridge:
 *
 * - reads the uploader's per-session consent state through its public
 *   `diagnostics()` snapshot;
 * - forwards an explicit human consent decision (on/off) through the uploader's
 *   own `command()` path, so the header switch and the `/lf` commands operate
 *   exactly one state machine;
 * - exposes both operations to the browser through the existing authenticated
 *   Connection transport: two exact Fetch routes below DSH's `/api` channel
 *   (`connection.fetch.register`). That registry is carrier-neutral, applies
 *   DSH's Host/Origin fence and browser-cookie authentication before dispatch,
 *   and serves only the owner Peer. No extra control port is opened.
 *
 * Why exact routes instead of a dedicated logical RPC channel: the shipped
 * `connection.rpc.handle()` registry registers its physical route through the
 * Connection service's own context, which does not declare `webServer` as a
 * dependency; calling it from a third-party plugin therefore throws
 * `cannot get property "webServer" without inject`. The documented
 * `connection.rpc.intercept('/api', …)` slot is single-owner and already taken
 * by the Gateway. The exact Fetch route registry is the remaining official,
 * authenticated path on the same channel and needs no extra dependency.
 *
 * Invariants:
 * - new sessions start disabled (the uploader's default; absence of a session
 *   row in `diagnostics()` is reported as disabled, never as enabled);
 * - a query can never enable anything;
 * - enabling requires the live Session object so the uploader can pin the
 *   starting `seq` (only turns started after the switch are uploaded);
 * - unknown ids, malformed payloads, and unavailable uploaders fail closed.
 *
 * @module @local/dsh-langfuse-header-toggle
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** File-system location of this bundle (used to ship the vendor uploader). */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Cordis plugin name shown by the Loader. */
export const name = 'dsh-langfuse-header-toggle';

/** Bundle version, mirrored into RPC state for support diagnostics. */
export const VERSION = '1.2.0';

/** Uploader version this bundle vendors for migration. */
export const VENDORED_UPLOADER_VERSION = '1.0.2';

/** Loader row id used for the managed voluntary uploader entry. */
export const VOLUNTARY_ROW_ID = 'dsh-langfuse-voluntary-1-0-1';

/** Managed-block markers written into the profile patch. */
export const MANAGED_BEGIN = '# BEGIN dsh-langfuse-voluntary';
export const MANAGED_END = '# END dsh-langfuse-voluntary';

/** Loader row ids of the original automatic collectors this bundle replaces. */
export const AUTO_UPLOADER_ROW_IDS = Object.freeze(['dsh-langfuse', 'dsh-langfuse-telemetry']);

/** Shared `/api` route prefix of the Host endpoints. */
export const ROUTE_BASE = '/api/dsh-langfuse-toggle';

/** Exact Host route answering one session's consent snapshot. */
export const ROUTE_STATE = `${ROUTE_BASE}/state`;

/** Exact Host route applying one explicit consent decision. */
export const ROUTE_SET = `${ROUTE_BASE}/set`;

/** Exact Host route returning the upload-hook inventory of this DSH process. */
export const ROUTE_SCAN = `${ROUTE_BASE}/scan`;

/** Exact Host route migrating the original auto collector to the voluntary one. */
export const ROUTE_MIGRATE = `${ROUTE_BASE}/migrate`;

/**
 * Exact Host route for the first-install connection config.
 *
 * `get` reports a redacted status, `save` validates and atomically writes
 * `config.json`, and `install` copies the vendored uploader and mounts its
 * managed Loader row. None of the three actions can grant upload consent.
 */
export const ROUTE_CONFIG = `${ROUTE_BASE}/config`;

/**
 * Document-relative forms the browser fetches. DSH app routes are
 * document-relative so a mount proxy keeps working.
 */
export const CLIENT_ROUTES = Object.freeze({
  state: `${ROUTE_STATE.slice(1)}`,
  set: `${ROUTE_SET.slice(1)}`,
  scan: `${ROUTE_SCAN.slice(1)}`,
  migrate: `${ROUTE_MIGRATE.slice(1)}`,
  config: `${ROUTE_CONFIG.slice(1)}`,
});

/**
 * Uploader diagnostic slot. The voluntary uploader publishes
 * `{ controller, context, version }` under this registered symbol.
 * @see ~/.dsh/langfuse-voluntary/dsh-langfuse-voluntary-1.0.2.mjs
 */
export const UPLOADER_SYMBOL = Symbol.for('dsh.langfuse.voluntary');

const MAX_SESSION_ID_LENGTH = 200;
const MAX_ERROR_TEXT = 200;

/**
 * Build one successful RPC result.
 * @param {unknown} value - JSON-serializable success payload.
 * @returns {{ ok: true, value: unknown }} the success envelope.
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * Build one failed RPC result.
 * @param {string} code - stable machine-readable failure code.
 * @param {string} message - short human-readable reason (already sanitized).
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the failure envelope.
 */
function fail(code, message) {
  const text = typeof message === 'string' ? message.slice(0, MAX_ERROR_TEXT) : '';
  return { ok: false, error: { code, message: text, details: {} } };
}

/**
 * Locate the running voluntary uploader through its published diagnostic slot.
 * @param {any} [globalObject] - object to inspect; defaults to `globalThis`.
 * @returns {any | null} the uploader controller, or null when it is absent or
 *   does not expose the two public methods this bridge relies on.
 */
export function locateUploader(globalObject = globalThis) {
  const diagnostic = globalObject === undefined || globalObject === null
    ? undefined
    : globalObject[UPLOADER_SYMBOL];
  const controller = diagnostic === undefined || diagnostic === null ? undefined : diagnostic.controller;
  if (controller === undefined || controller === null || typeof controller !== 'object') return null;
  if (typeof controller.command !== 'function') return null;
  if (typeof controller.diagnostics !== 'function') return null;
  return controller;
}

/**
 * Read one session's consent state from the uploader snapshot.
 *
 * A session the uploader has never seen is reported as disabled: the uploader
 * only creates a state row after a control operation, and every fresh session
 * starts without consent.
 *
 * @param {any} controller - controller returned by {@link locateUploader}.
 * @param {string} sessionId - exact session identity to report.
 * @returns {object} JSON-safe state for the Client.
 */
export function readState(controller, sessionId) {
  const diagnostic = controller.diagnostics();
  const snapshot = diagnostic !== null && typeof diagnostic === 'object' ? diagnostic : {};
  const rows = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const row = rows.find(entry => entry !== null && typeof entry === 'object' && entry.id === sessionId);
  const last = row !== null && row !== undefined && row.last !== null && row.last !== undefined && typeof row.last === 'object'
    ? {
        at: typeof row.last.at === 'string' ? row.last.at : null,
        ok: row.last.ok === true,
        error: typeof row.last.error === 'string' ? row.last.error : null,
      }
    : null;
  return {
    sessionId,
    enabled: row !== undefined && row.enabled === true,
    tracked: row !== undefined,
    uploader: {
      ready: snapshot.ready === true,
      version: typeof snapshot.version === 'string' ? snapshot.version : null,
      pluginVersion: VERSION,
    },
    sent: row !== undefined && Number.isInteger(row.sent) ? row.sent : 0,
    failed: row !== undefined && Number.isInteger(row.failed) ? row.failed : 0,
    last,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Extract a short refusal message from the uploader command result. The
 * uploader's success text mentions the work id, so only failures are read here.
 * @param {any} result - value returned by the uploader `command()`.
 * @returns {string} sanitized reason or an empty string.
 */
function refusalText(result) {
  if (result === null || typeof result !== 'object') return '';
  return typeof result.text === 'string' ? result.text.slice(0, MAX_ERROR_TEXT) : '';
}

/**
 * Build the bridge around one uploader locator and one live-session lookup.
 *
 * Both dependencies are injected so the bridge stays testable without Cordis
 * and so a reloaded uploader plugin is picked up on the next call (the locator
 * is evaluated per request, never cached).
 *
 * @param {object} options - bridge dependencies.
 * @param {() => any | null} [options.locate] - returns the current uploader controller.
 * @param {(sessionId: string) => any | undefined} [options.lookupSession] - returns the live Session or undefined.
 * @returns {{ state(id: string): object, set(id: string, enabled: boolean): object, handle(endpoint: string, payload: unknown): object }} bridge operations.
 */
export function createBridge(options = {}) {
  const locate = typeof options.locate === 'function' ? options.locate : () => locateUploader();
  const lookupSession = typeof options.lookupSession === 'function' ? options.lookupSession : () => undefined;

  /**
   * Validate the caller-supplied identity and resolve the live Session.
   * @param {unknown} sessionId - wire value.
   * @returns {{ session: any } | { error: string, message: string }} resolution.
   */
  function resolveSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
      return { error: 'bad_request', message: 'sessionId must be a non-empty string' };
    }
    let session;
    try {
      session = lookupSession(sessionId);
    } catch {
      return { error: 'sessions_unavailable', message: 'session store lookup failed' };
    }
    if (session === undefined || session === null || typeof session !== 'object') {
      return { error: 'session_not_found', message: 'no live session with this id' };
    }
    return { session };
  }

  /**
   * Read the state of one exact session. Never enables anything.
   * @param {unknown} sessionId - exact session identity from the Client.
   * @returns {object} RPC result envelope.
   */
  function state(sessionId) {
    const controller = locate();
    if (controller === null) return fail('uploader_unavailable', 'voluntary uploader is not loaded');
    const resolved = resolveSession(sessionId);
    if (resolved.error !== undefined) return fail(resolved.error, resolved.message);
    return ok(readState(controller, sessionId));
  }

  /**
   * Apply one explicit human decision to one exact session and confirm it.
   * @param {unknown} sessionId - exact session identity from the Client.
   * @param {unknown} enabled - must be a boolean.
   * @returns {object} RPC result envelope with the confirmed state.
   */
  function set(sessionId, enabled) {
    if (typeof enabled !== 'boolean') return fail('bad_request', 'enabled must be a boolean');
    const controller = locate();
    if (controller === null) return fail('uploader_unavailable', 'voluntary uploader is not loaded');
    const resolved = resolveSession(sessionId);
    if (resolved.error !== undefined) return fail(resolved.error, resolved.message);
    const result = controller.command({
      rawInput: enabled ? 'on' : 'off',
      agent: { session: resolved.session },
    });
    if (result === null || typeof result !== 'object' || result.kind !== 'success') {
      const reason = refusalText(result);
      return fail('uploader_refused', reason.length > 0 ? reason : 'uploader refused the operation');
    }
    const confirmed = readState(controller, sessionId);
    if (confirmed.enabled !== enabled) {
      return fail('state_not_confirmed', 'uploader did not confirm the requested state');
    }
    return ok(confirmed);
  }

  /**
   * Dispatch one authenticated RPC endpoint. Endpoint and payload are validated
   * here so a malformed request can never reach the uploader.
   * @param {string} endpoint - channel-relative endpoint name.
   * @param {unknown} payload - JSON payload from the Client.
   * @returns {object} RPC result envelope.
   */
  function handle(endpoint, payload) {
    if (endpoint === 'state') {
      const sessionId = payload !== null && typeof payload === 'object' ? payload.sessionId : undefined;
      return state(sessionId);
    }
    if (endpoint === 'set') {
      if (payload === null || typeof payload !== 'object') return fail('bad_request', 'payload must be an object');
      return set(payload.sessionId, payload.enabled);
    }
    return fail('not_found', 'unknown endpoint');
  }

  return { state, set, handle };
}

/**
 * Resolve the live Session through the session store service.
 * @param {any} ctx - Cordis context of this plugin.
 * @param {string} sessionId - exact session identity.
 * @returns {any | undefined} the live Session instance, or undefined.
 */
function sessionFromContext(ctx, sessionId) {
  const sessions = ctx.get('sessions');
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined;
  return sessions.get(sessionId);
}

/**
 * Parse the Langfuse credential env names the original collector used.
 *
 * The auto collector only reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
 * `LANGFUSE_BASEURL`/`LANGFUSE_HOST` and `LANGFUSE_USER_ID`. When it is
 * running, the same env is visible to this Host process, so a first migration
 * can bootstrap the voluntary config file from it. Only booleans and the host
 * name ever leave the Host; the key values stay in this function's result.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {{ publicKey: boolean, secretKey: boolean, baseUrl: boolean, userId: boolean, complete: boolean, baseUrlHost: string | null, value: object | null }} credential availability.
 */
export function readEnvConfig(env = process.env) {
  const publicKey = typeof env.LANGFUSE_PUBLIC_KEY === 'string' ? env.LANGFUSE_PUBLIC_KEY : '';
  const secretKey = typeof env.LANGFUSE_SECRET_KEY === 'string' ? env.LANGFUSE_SECRET_KEY : '';
  const baseUrlRaw = (typeof env.LANGFUSE_BASEURL === 'string' && env.LANGFUSE_BASEURL.length > 0)
    ? env.LANGFUSE_BASEURL
    : (typeof env.LANGFUSE_HOST === 'string' ? env.LANGFUSE_HOST : '');
  const userId = typeof env.LANGFUSE_USER_ID === 'string' ? env.LANGFUSE_USER_ID : '';
  const baseUrl = baseUrlRaw.length > 0 ? baseUrlRaw : 'https://metrics.openharmonyhub.cn';
  let baseUrlValid = false;
  let baseUrlHost = null;
  try {
    baseUrlHost = new URL(baseUrl).host;
    baseUrlValid = baseUrlHost.length > 0;
  } catch {
    baseUrlValid = false;
  }
  const result = {
    publicKey: publicKey.startsWith('pk-lf-'),
    secretKey: secretKey.startsWith('sk-lf-'),
    baseUrl: baseUrlValid,
    userId: /^[a-z]((30|00|60)\d{6}|wx\d{6,})$/.test(userId),
    complete: false,
    baseUrlHost,
    value: null,
  };
  result.complete = result.publicKey && result.secretKey && result.baseUrl && result.userId;
  if (result.complete) {
    result.value = { baseUrl, publicKey, secretKey, userId, maxChars: 20000 };
  }
  return result;
}

/**
 * Resolve the DSH home directory of this process.
 * @returns {string} absolute DSH home path.
 */
function dshHomePath() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.length > 0) return env;
  return path.join(os.homedir(), '.dsh');
}

/**
 * Resolve the active profile directory of this process.
 * @returns {string} absolute profile directory path.
 */
function profileDirPath() {
  const env = process.env.DSH_PROFILE_DIR;
  if (typeof env === 'string' && env.length > 0) return env;
  return path.join(dshHomePath(), 'profiles', process.env.DSH_PROFILE || 'desktop');
}

/**
 * All paths the inventory and migration touch.
 * @returns {object} resolved paths and file locations.
 */
export function resolvePaths() {
  const home = dshHomePath();
  const profileDir = profileDirPath();
  const voluntaryDir = path.join(home, 'langfuse-voluntary');
  return {
    home,
    profileDir,
    profilePatch: path.join(profileDir, 'cordis.patch.yml'),
    homePatch: path.join(home, 'cordis.patch.yml'),
    voluntaryDir,
    voluntaryModule: path.join(voluntaryDir, `dsh-langfuse-voluntary-${VENDORED_UPLOADER_VERSION}.mjs`),
    configPath: path.join(voluntaryDir, 'config.json'),
    backupDir: path.join(voluntaryDir, 'backups'),
    vendorModule: path.join(MODULE_DIR, 'vendor', `dsh-langfuse-voluntary-${VENDORED_UPLOADER_VERSION}.mjs`),
  };
}

/**
 * Read the running DSH CLI version from the installation manifest.
 * @returns {string | null} version or null when unavailable.
 */
function runningDshVersion() {
  const candidates = [];
  const installDir = process.env.DSH_INSTALL_DIR;
  if (typeof installDir === 'string' && installDir.length > 0) {
    candidates.push(path.join(installDir, 'package.json'));
  }
  const resourcesPath = process.resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, 'app.asar', 'dsh', 'package.json'));
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Name of the active profile, falling back to the profile directory name.
 * @returns {string | null} profile name.
 */
function runningProfileName() {
  const env = process.env.DSH_PROFILE;
  if (typeof env === 'string' && env.length > 0) return env;
  const base = path.basename(profileDirPath());
  return base.length > 0 ? base : null;
}

/**
 * Classify one Loader row as an upload hook of a known kind.
 * @param {string} entryId - Loader entry id.
 * @param {string} moduleName - Loader row module specifier.
 * @returns {'switch' | 'voluntary' | 'auto' | 'other' | null} hook kind.
 */
export function classifyHook(entryId, moduleName) {
  const id = String(entryId || '');
  const name = String(moduleName || '');
  const text = `${id} ${name}`;
  if (/dsh-langfuse-header-toggle/i.test(text)) return 'switch';
  if (/dsh-langfuse-voluntary/i.test(text)) return 'voluntary';
  if (AUTO_UPLOADER_ROW_IDS.some(candidate => id === candidate || id.endsWith(`:${candidate}`))) return 'auto';
  if (/dsh-langfuse-telemetry/i.test(text) || /dsh-langfuse-plugin\.js/i.test(text)) return 'auto';
  if (/(^|[^-\w])dsh-langfuse([^-\w]|$)/i.test(id)) return 'auto';
  if (/langfuse/i.test(text)) return 'other';
  return null;
}

/**
 * Convert an absolute file path to a `file://` module specifier.
 * @param {string} filename - absolute path.
 * @returns {string} file URL.
 */
export function toFileUrl(filename) {
  const normalized = String(filename).replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

/**
 * Remove a UTF-8 byte-order mark.
 * @param {string} text - file text.
 * @returns {string} text without BOM.
 */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Detect the dominant line ending of a text file. */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Rewrite LF line endings to the requested convention. */
function toEol(text, eol) {
  return eol === '\n' ? text : text.split('\n').join(eol);
}

function isBlankLine(line) {
  return line.trim() === '';
}

function leadingIndent(line) {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

function dashIndent(line) {
  const match = /^(\s*)-\s/.exec(line);
  return match ? match[1].length : -1;
}

/**
 * Collect every `id:` declared inside one YAML list element.
 * @param {string[]} element - lines of the element.
 * @returns {string[]} declared ids.
 */
function elementIds(element) {
  const ids = [];
  for (const line of element) {
    const match = /^\s*-?\s*id:\s*["']?([^\s"'#]+)/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * Remove list elements (or nested insert children) whose id matches.
 * Line-based on purpose: the patch files use a small YAML subset and DSH
 * itself edits them as text, so no YAML dependency is required.
 * @param {string} content - patch file text.
 * @param {(id: string, blockText: string) => boolean} isMatch - row predicate.
 * @returns {{ content: string, removed: string[] }} rewritten text and removed ids.
 */
export function removeRows(content, isMatch) {
  const lines = content.split(/\r?\n/);
  let baseIndent = -1;
  for (const line of lines) {
    const indent = dashIndent(line);
    if (indent >= 0 && (baseIndent === -1 || indent < baseIndent)) baseIndent = indent;
  }
  if (baseIndent < 0) return { content, removed: [] };
  const removed = [];
  const out = [];
  let index = 0;
  while (index < lines.length) {
    if (dashIndent(lines[index]) !== baseIndent) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      if (isBlankLine(line)) { index += 1; continue; }
      if (leadingIndent(line) > baseIndent) { index += 1; continue; }
      break;
    }
    const element = lines.slice(start, index);
    const ids = elementIds(element);
    const matched = ids.filter(id => isMatch(id, element.join('\n')));
    if (matched.length === 0) {
      out.push(...element);
      continue;
    }
    const isInsertBlock = /^\s*-\s*insert\s*:\s*$/.test(element[0]);
    if (!isInsertBlock) {
      removed.push(...matched);
      continue;
    }
    let childIndent = -1;
    for (const line of element.slice(1)) {
      const indent = dashIndent(line);
      if (indent > baseIndent && (childIndent === -1 || indent < childIndent)) childIndent = indent;
    }
    if (childIndent < 0) {
      removed.push(...matched);
      continue;
    }
    const kept = [];
    let cursor = 1;
    while (cursor < element.length) {
      if (dashIndent(element[cursor]) !== childIndent) {
        kept.push(element[cursor]);
        cursor += 1;
        continue;
      }
      const childStart = cursor;
      cursor += 1;
      while (cursor < element.length) {
        const line = element[cursor];
        if (isBlankLine(line)) { cursor += 1; continue; }
        if (leadingIndent(line) > childIndent) { cursor += 1; continue; }
        break;
      }
      const child = element.slice(childStart, cursor);
      const childIds = elementIds(child);
      const hit = childIds.filter(id => isMatch(id, child.join('\n')));
      if (hit.length > 0) removed.push(...hit);
      else kept.push(...child);
    }
    if (kept.length > 0) out.push(element[0], ...kept);
  }
  let result = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/g, '');
  if (result.length > 0) result += '\n';
  return { content: result, removed };
}

/**
 * Whether a row belongs to the original automatic collector.
 * @param {string} id - row id.
 * @param {string} blockText - row text.
 * @returns {boolean} true for auto collector rows.
 */
function isAutoRow(id, blockText) {
  if (AUTO_UPLOADER_ROW_IDS.includes(id)) return true;
  if (/dsh-langfuse-voluntary/i.test(blockText)) return false;
  return /dsh-langfuse-plugin\.js/i.test(blockText);
}

/**
 * Remove original automatic-collector rows from patch text.
 * @param {string} content - patch text.
 * @returns {{ content: string, removed: string[] }} cleaned text and removed ids.
 */
export function removeAutoRows(content) {
  return removeRows(stripBom(content), isAutoRow);
}

/**
 * Remove the managed voluntary block from patch text.
 * @param {string} content - patch text.
 * @returns {string} text without the managed block.
 */
export function stripManagedBlock(content) {
  const lines = stripBom(content).split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inside && trimmed.startsWith(MANAGED_BEGIN)) { inside = true; continue; }
    if (inside) {
      if (trimmed.startsWith(MANAGED_END)) inside = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Ensure exactly one managed voluntary insert block exists in patch text.
 * @param {string} content - patch text.
 * @param {string} fileUrl - module specifier of the voluntary uploader.
 * @returns {string} rewritten patch text.
 */
export function upsertManagedBlock(content, fileUrl) {
  let next = stripManagedBlock(content);
  next = removeRows(next, id => id === VOLUNTARY_ROW_ID).content;
  // Profile templates ship as an empty flow array `[]`; appending a block
  // sequence after `[]` would produce invalid YAML, so drop bare `[]` lines.
  next = next.replace(/^[ \t]*\[\][ \t]*$/gm, '');
  next = next.replace(/\n{3,}/g, '\n\n').trimEnd();
  const block = [
    `${MANAGED_BEGIN} (default off)`,
    '- insert:',
    `    - id: ${VOLUNTARY_ROW_ID}`,
    `      name: ${JSON.stringify(fileUrl)}`,
    MANAGED_END,
    '',
  ].join('\n');
  return next.length > 0 ? `${next}\n\n${block}` : block;
}

/**
 * List remaining original-collector ids in patch text.
 * @param {string} content - patch text.
 * @returns {string[]} residual auto ids.
 */
export function residualAutoRows(content) {
  return [...stripBom(content).matchAll(/^\s*-?\s*id:\s*["']?([^\s"'#]+)/gm)]
    .map(match => match[1])
    .filter(id => AUTO_UPLOADER_ROW_IDS.includes(id));
}

/**
 * Whether one Loader entry currently runs.
 * @param {any} entry - Loader entry.
 * @returns {boolean} active flag.
 */
function entryIsActive(entry) {
  try {
    return entry.disabled !== true && entry.fiber !== undefined && entry.fiber !== null;
  } catch {
    return false;
  }
}

/**
 * Read the loader entries of this process without assuming the service exists.
 * A missing Loader service is an empty inventory, never an error.
 * @param {any} ctx - Cordis Host context.
 * @returns {any[]} live Loader entries.
 */
function loaderEntries(ctx) {
  try {
    const loader = ctx?.get?.('loader');
    return loader !== undefined && loader !== null && typeof loader.entries === 'function'
      ? [...loader.entries()]
      : [];
  } catch {
    return [];
  }
}

/**
 * Describe one Loader entry as an upload hook.
 * @param {any} entry - Loader entry.
 * @returns {{ entryId: string, moduleName: string, kind: string, active: boolean, listedDisabled: boolean } | null} hook view, or null when irrelevant.
 */
function describeHook(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  const options = entry.options ?? {};
  const entryId = String(entry.id ?? options.id ?? '');
  const moduleName = String(options.name ?? '');
  const kind = classifyHook(entryId, moduleName);
  if (kind === null || kind === 'switch') return null;
  return { entryId, moduleName, kind, active: entryIsActive(entry), listedDisabled: options.disabled === true };
}

/**
 * Inventory the upload hooks of this DSH process.
 *
 * Every open of the plugin panel runs this scan; it reads the Loader entries,
 * the voluntary uploader's public diagnostic surface, and file presence, and
 * never changes anything.
 *
 * @param {any} ctx - Cordis Host context.
 * @returns {object} scan payload for the browser.
 */
export function scanHooks(ctx) {
  const paths = resolvePaths();
  const controller = locateUploader();
  let runtime = null;
  if (controller !== null) {
    try {
      const diagnostic = controller.diagnostics();
      runtime = {
        version: typeof diagnostic?.version === 'string' ? diagnostic.version : null,
        ready: diagnostic?.ready === true,
      };
    } catch {
      runtime = { version: null, ready: false };
    }
  }
  const hooks = [];
  for (const entry of loaderEntries(ctx)) {
    const hook = describeHook(entry);
    if (hook !== null) hooks.push(hook);
  }
  const autoRows = hooks.filter(hook => hook.kind === 'auto');
  const voluntaryRows = hooks.filter(hook => hook.kind === 'voluntary');
  const configPresent = fs.existsSync(paths.configPath);
  const envConfig = readEnvConfig();
  const configSource = configPresent ? 'file' : (envConfig.complete ? 'env' : 'missing');
  const modulePresent = fs.existsSync(paths.voluntaryModule);
  const vendorPresent = fs.existsSync(paths.vendorModule);
  const voluntaryRuntime = runtime !== null;
  const autoActive = autoRows.some(row => row.active);
  const controllable = voluntaryRuntime && !autoActive;
  const canInstall = !voluntaryRuntime && (autoRows.length > 0 || voluntaryRows.length === 0);
  const missingEnv = configPresent
    ? []
    : ['publicKey', 'secretKey', 'baseUrl', 'userId'].filter(field => envConfig[field] !== true);
  const migration = {
    available: canInstall && (configPresent || envConfig.complete),
    reason: canInstall
      ? ((configPresent || envConfig.complete) ? null : 'config_missing')
      : (voluntaryRuntime ? 'already_voluntary' : 'no_action'),
    needsConfig: !configPresent && !envConfig.complete,
    canCreateConfig: !configPresent && envConfig.complete,
    configSource,
    configPath: paths.configPath,
    missingEnv,
    env: {
      publicKey: envConfig.publicKey,
      secretKey: envConfig.secretKey,
      baseUrl: envConfig.baseUrl,
      userId: envConfig.userId,
      baseUrlHost: envConfig.baseUrlHost,
    },
    needsModule: !modulePresent,
    vendorPresent,
    modulePath: paths.voluntaryModule,
    willRemove: autoRows.map(row => row.entryId),
    willInstall: { entryId: VOLUNTARY_ROW_ID, module: paths.voluntaryModule },
  };
  return {
    checkedAt: new Date().toISOString(),
    bundleVersion: VERSION,
    dsh: {
      version: runningDshVersion(),
      profile: runningProfileName(),
      profileDir: paths.profileDir,
      home: paths.home,
    },
    hooks,
    voluntary: {
      present: voluntaryRows.length > 0 || voluntaryRuntime,
      rows: voluntaryRows.length,
      runtime: voluntaryRuntime,
      version: runtime?.version ?? null,
      ready: runtime?.ready === true,
      configPresent,
      configSource,
      configPath: paths.configPath,
      envConfig: {
        publicKey: envConfig.publicKey,
        secretKey: envConfig.secretKey,
        baseUrl: envConfig.baseUrl,
        userId: envConfig.userId,
        baseUrlHost: envConfig.baseUrlHost,
      },
      modulePresent,
      modulePath: paths.voluntaryModule,
    },
    auto: autoRows,
    switch: {
      installed: true,
      controllable,
      reason: controllable ? null : (autoActive ? 'auto_active' : (voluntaryRuntime ? 'not_controlling' : 'no_voluntary')),
    },
    migration,
    paths: {
      profilePatch: paths.profilePatch,
      homePatch: paths.homePatch,
      backupDir: paths.backupDir,
    },
  };
}

/** Milliseconds helper. */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

let migrationRunning = false;

/**
 * Rewrite the profile patch (and the home-level patch when the original
 * collector lives there) so the automatic collector is replaced by the
 * voluntary uploader.
 *
 * Safety properties: explicit `confirm` required, backups written before any
 * mutation, idempotent managed block, refusal on unsupported layouts, and a
 * post-write verification that reports whether a restart is still required.
 *
 * @param {any} ctx - Cordis Host context.
 * @param {{ confirm?: boolean }} [options] - explicit confirmation flag.
 * @returns {Promise<object>} migration result for the browser.
 */
export async function migrateHooks(ctx, options = {}) {
  if (migrationRunning) {
    return { ok: false, error: { code: 'busy', message: 'a migration is already running', details: {} } };
  }
  migrationRunning = true;
  try {
    if (options?.confirm !== true) {
      return { ok: false, error: { code: 'confirmation_required', message: 'confirm must be true', details: {} } };
    }
    const paths = resolvePaths();
    const before = scanHooks(ctx);
    if (before.voluntary.runtime === true && before.auto.every(row => row.active !== true)) {
      return { ok: true, status: 'already', backups: [], changed: [], scan: before };
    }
    let createdConfig = null;
    if (before.voluntary.configPresent !== true) {
      const envConfig = readEnvConfig();
      if (envConfig.complete !== true) {
        return {
          ok: false,
          error: {
            code: 'config_missing',
            message: `voluntary uploader config not found at ${paths.configPath} and the Langfuse env is incomplete`,
            details: {
              configPath: paths.configPath,
              missingEnv: ['publicKey', 'secretKey', 'baseUrl', 'userId'].filter(field => envConfig[field] !== true),
            },
          },
          scan: before,
        };
      }
      fs.mkdirSync(paths.voluntaryDir, { recursive: true });
      fs.writeFileSync(paths.configPath, `${JSON.stringify(envConfig.value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(paths.configPath, 0o600);
      } catch {
        // Windows does not implement POSIX modes; the user profile ACL still applies.
      }
      createdConfig = paths.configPath;
    }
    if (!fs.existsSync(paths.voluntaryModule)) {
      if (!fs.existsSync(paths.vendorModule)) {
        return {
          ok: false,
          error: {
            code: 'module_missing',
            message: `vendored uploader missing: ${paths.vendorModule}`,
            details: {},
          },
          scan: before,
        };
      }
      fs.mkdirSync(paths.voluntaryDir, { recursive: true });
      fs.copyFileSync(paths.vendorModule, paths.voluntaryModule);
    }
    fs.mkdirSync(paths.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const plans = [];
    for (const file of [paths.homePatch, paths.profilePatch]) {
      if (!fs.existsSync(file)) continue;
      const original = fs.readFileSync(file, 'utf8');
      const bom = original.charCodeAt(0) === 0xfeff;
      const body = stripBom(original);
      const eol = detectEol(body);
      let next = removeAutoRows(body).content;
      if (file === paths.profilePatch) next = upsertManagedBlock(next, toFileUrl(paths.voluntaryModule));
      if (residualAutoRows(next).length > 0) {
        return {
          ok: false,
          error: {
            code: 'unsupported_layout',
            message: `could not remove every original collector row from ${file}`,
            details: { file, residual: residualAutoRows(next) },
          },
          scan: before,
        };
      }
      const output = `${bom ? '\uFEFF' : ''}${toEol(next, eol)}`;
      if (output === original) continue;
      plans.push({
        file,
        original,
        output,
        backup: path.join(paths.backupDir, `${path.basename(file)}.${stamp}.${path.basename(path.dirname(file))}.bak`),
      });
    }
    if (plans.length === 0) {
      return {
        ok: false,
        error: { code: 'nothing_to_do', message: 'no patch file needs changes', details: {} },
        configCreated: createdConfig,
        scan: before,
      };
    }
    for (const plan of plans) fs.copyFileSync(plan.file, plan.backup);
    for (const plan of plans) {
      const temporary = `${plan.file}.dsh-toggle-${stamp}.tmp`;
      fs.writeFileSync(temporary, plan.output, 'utf8');
      fs.renameSync(temporary, plan.file);
    }
    const waitMs = Math.max(0, Math.min(8000, Number(options?.reloadTimeoutMs) || 8000));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && locateUploader() === null) await sleep(200);
    const after = scanHooks(ctx);
    const applied = after.voluntary.runtime === true || after.voluntary.present === true;
    const autoStillActive = after.auto.some(row => row.active === true);
    const hmr = ctx.get('hmr');
    const restartRequired = !applied || autoStillActive;
    return {
      ok: applied,
      status: applied ? (restartRequired ? 'applied_restart_required' : 'applied') : 'restart_required',
      backups: plans.map(plan => plan.backup),
      changed: plans.map(plan => plan.file),
      configCreated: createdConfig,
      restartRequired,
      hmrActive: hmr !== undefined && hmr !== null,
      scan: after,
      error: applied
        ? undefined
        : { code: 'reload_pending', message: 'patch written, but the new uploader is not loaded yet', details: {} },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'migration_failed',
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    };
  } finally {
    migrationRunning = false;
  }
}

// ---------------------------------------------------------------------------
// First-install connection config
//
// The uploader reads `<DSH home>/langfuse-voluntary/config.json` once, when its
// module loads. This section is the browser-facing editor for that file:
//
// - `get` reports a redacted snapshot (key presence + a 4-character hint, never
//   the key values);
// - `save` validates every field with the uploader's own `loadConfig()` rules,
//   then replaces the file atomically (temporary file + rename, 0600 on POSIX);
// - `install` copies the vendored uploader and mounts the managed Loader row,
//   reusing the migration's backup style and refusing to replace the original
//   automatic collectors (that remains the migrate flow's job).
//
// None of these actions calls the uploader's `command()`/`set()` path, and none
// of them can grant per-session consent: every session still starts disabled.
// ---------------------------------------------------------------------------

/** Longest credential string accepted from the browser. */
const MAX_CONFIG_VALUE = 2048;

/** Employee-number pattern enforced by the uploader's `loadConfig()`. */
const USER_ID_PATTERN = /^[a-z]((30|00|60)\d{6}|wx\d{6,})$/;

/**
 * Build one field-scoped validation failure.
 * @param {string} field - one of baseUrl/publicKey/secretKey/userId/maxChars.
 * @param {string} reason - stable reason code (never a credential value).
 * @param {string} message - short English explanation for logs.
 * @returns {{ ok: false, error: { code: 'invalid_config', message: string, details: { field: string, reason: string } } }} failure envelope.
 */
function invalidConfig(field, reason, message) {
  return {
    ok: false,
    error: {
      code: 'invalid_config',
      message,
      details: { field, reason },
    },
  };
}

/**
 * Validate a bare Langfuse origin with the same rules as `loadConfig()`.
 * @param {unknown} value - candidate base URL.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }} normalized origin or reason.
 */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return { ok: false, reason: 'missing' };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'not_http' };
  if (url.username.length > 0 || url.password.length > 0) return { ok: false, reason: 'has_credentials' };
  if (url.pathname !== '/') return { ok: false, reason: 'not_origin' };
  return { ok: true, value: url.origin };
}

/**
 * Normalize the optional `maxChars` with the uploader's own cap.
 * @param {unknown} value - browser value; undefined means the 20000 default.
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }} effective limit or reason.
 */
function normalizeMaxChars(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 20000 };
  if (typeof value !== 'number' && typeof value !== 'string') return { ok: false, reason: 'not_number' };
  if (typeof value === 'string' && value.trim().length === 0) return { ok: true, value: 20000 };
  const numeric = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(numeric)) return { ok: false, reason: 'not_number' };
  const integer = Math.floor(numeric);
  if (integer < 1) return { ok: false, reason: 'out_of_range' };
  return { ok: true, value: Math.min(integer, 20000) };
}

/**
 * Validate one complete config object and build the exact file shape.
 *
 * Unknown properties are dropped on purpose: the file only ever contains the
 * five fields the uploader reads, so a crafted payload cannot smuggle extra
 * data into the uploader's private directory.
 *
 * @param {any} value - candidate config object.
 * @returns {{ valid: true, config: object } | { valid: false, field: string, reason: string, message: string }} validation result.
 */
export function validateConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, field: 'baseUrl', reason: 'missing', message: 'config must be a JSON object' };
  }
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  if (!baseUrl.ok) {
    return { valid: false, field: 'baseUrl', reason: baseUrl.reason, message: 'baseUrl must be a bare http(s) origin' };
  }
  if (typeof value.publicKey !== 'string' || value.publicKey.trim().length === 0) {
    return { valid: false, field: 'publicKey', reason: 'missing', message: 'publicKey is required' };
  }
  if (!value.publicKey.trim().startsWith('pk-lf-')) {
    return { valid: false, field: 'publicKey', reason: 'prefix', message: 'publicKey must start with "pk-lf-"' };
  }
  if (typeof value.secretKey !== 'string' || value.secretKey.trim().length === 0) {
    return { valid: false, field: 'secretKey', reason: 'missing', message: 'secretKey is required' };
  }
  if (!value.secretKey.trim().startsWith('sk-lf-')) {
    return { valid: false, field: 'secretKey', reason: 'prefix', message: 'secretKey must start with "sk-lf-"' };
  }
  if (typeof value.userId !== 'string' || value.userId.trim().length === 0) {
    return { valid: false, field: 'userId', reason: 'missing', message: 'userId is required' };
  }
  if (!USER_ID_PATTERN.test(value.userId.trim())) {
    return { valid: false, field: 'userId', reason: 'pattern', message: 'userId does not match the employee-number pattern' };
  }
  const maxChars = normalizeMaxChars(value.maxChars);
  if (!maxChars.ok) {
    return { valid: false, field: 'maxChars', reason: maxChars.reason, message: 'maxChars must be a positive number' };
  }
  return {
    valid: true,
    config: {
      baseUrl: baseUrl.value,
      publicKey: value.publicKey.trim(),
      secretKey: value.secretKey.trim(),
      userId: value.userId.trim(),
      maxChars: maxChars.value,
    },
  };
}

/**
 * Read and parse `config.json` without throwing.
 * @param {string} configPath - absolute config file path.
 * @returns {any | null} parsed object, or null when absent/invalid.
 */
function readConfigFile(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Report whether the managed voluntary block is already written in the profile
 * patch. Used as a persisted "installed" signal before the Loader reloads.
 * @param {string} profilePatch - profile patch path.
 * @returns {boolean} true when the managed row is present.
 */
function managedBlockWritten(profilePatch) {
  try {
    const text = fs.readFileSync(profilePatch, 'utf8');
    return text.includes(MANAGED_BEGIN) && text.includes(`id: ${VOLUNTARY_ROW_ID}`);
  } catch {
    return false;
  }
}

/**
 * Read the running uploader's own diagnostic snapshot, failing closed.
 * @returns {{ present: boolean, ready: boolean, version: string | null }} runtime view.
 */
function uploaderRuntime() {
  const controller = locateUploader();
  if (controller === null) return { present: false, ready: false, version: null };
  try {
    const diagnostic = controller.diagnostics();
    return {
      present: true,
      ready: diagnostic?.ready === true,
      version: typeof diagnostic?.version === 'string' ? diagnostic.version : null,
    };
  } catch {
    return { present: true, ready: false, version: null };
  }
}

/**
 * Build the redacted config status shown by the browser.
 *
 * Invariants: the secret key never leaves this function; the public key is
 * reduced to a prefix + last four characters; a malformed file is reported as
 * `valid: false` rather than guessed at. `ready` means both the file is valid
 * and the running uploader has loaded a config, so a fresh save on an already
 * running uploader is honestly reported as needing a restart.
 *
 * @param {any} ctx - Cordis Host context (only `loader` is read, optionally).
 * @returns {object} JSON-safe status.
 */
export function readConfigStatus(ctx) {
  const paths = resolvePaths();
  const exists = fs.existsSync(paths.configPath);
  const raw = exists ? readConfigFile(paths.configPath) : null;
  const validation = validateConfig(raw);
  const runtime = uploaderRuntime();
  const hooks = loaderEntries(ctx).map(describeHook).filter(hook => hook !== null);
  const voluntaryRows = hooks.filter(hook => hook.kind === 'voluntary');
  const modulePresent = fs.existsSync(paths.voluntaryModule);
  const rowPresent = voluntaryRows.length > 0 || managedBlockWritten(paths.profilePatch);
  const installed = modulePresent && (rowPresent || runtime.present);
  const active = runtime.present || voluntaryRows.some(hook => hook.active === true);
  const publicKey = typeof raw?.publicKey === 'string' ? raw.publicKey.trim() : '';
  const secretKey = typeof raw?.secretKey === 'string' ? raw.secretKey.trim() : '';
  const normalizedMax = normalizeMaxChars(raw?.maxChars);
  const normalizedBase = normalizeBaseUrl(raw?.baseUrl);
  return {
    path: paths.configPath,
    exists,
    valid: validation.valid,
    ready: validation.valid && runtime.ready,
    baseUrl: validation.valid
      ? validation.config.baseUrl
      : (normalizedBase.ok ? normalizedBase.value : null),
    userId: validation.valid
      ? validation.config.userId
      : (typeof raw?.userId === 'string' ? raw.userId.slice(0, MAX_CONFIG_VALUE) : null),
    maxChars: validation.valid ? validation.config.maxChars : (normalizedMax.ok ? normalizedMax.value : 20000),
    publicKeySet: publicKey.length > 0,
    secretKeySet: secretKey.length > 0,
    publicKeyHint: publicKey.length >= 12 && publicKey.startsWith('pk-lf-')
      ? `pk-lf-…${publicKey.slice(-4)}`
      : null,
    defaultOff: true,
    uploader: {
      installed,
      active,
      ready: runtime.ready,
      version: runtime.version ?? (modulePresent ? VENDORED_UPLOADER_VERSION : null),
    },
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Replace `config.json` atomically: write a sibling temporary file, chmod it,
 * then rename over the target. On POSIX the temporary file is created 0600; on
 * Windows the chmod calls are best effort because POSIX modes do not apply.
 * @param {object} paths - result of {@link resolvePaths}.
 * @param {object} config - validated config object.
 * @returns {void}
 */
function writeConfigAtomic(paths, config) {
  fs.mkdirSync(paths.voluntaryDir, { recursive: true, mode: 0o700 });
  const temporary = `${paths.configPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // Windows has no POSIX mode bits; the user profile ACL still applies.
    }
    fs.renameSync(temporary, paths.configPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created.
    }
    throw error;
  }
  try {
    fs.chmodSync(paths.configPath, 0o600);
  } catch {
    // Windows has no POSIX mode bits; the user profile ACL still applies.
  }
}

/**
 * Validate and persist one config payload.
 *
 * A missing or blank key field keeps the value already stored in
 * `config.json`: the browser never receives the saved key, so "leave it blank"
 * is the only way to change a non-key field without retyping credentials. If
 * there is no stored value, the field is required.
 *
 * @param {any} payload - save payload from the browser.
 * @param {{ ctx?: any, paths?: object }} [options] - host context and path override.
 * @returns {object} success envelope with redacted status, or a field-scoped failure.
 */
export function saveConfig(payload, options = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('bad_request', 'payload must be an object');
  }
  const paths = options.paths ?? resolvePaths();
  const existing = readConfigFile(paths.configPath) ?? {};
  const publicKey = typeof payload.publicKey === 'string' && payload.publicKey.trim().length > 0
    ? payload.publicKey.trim()
    : (typeof existing.publicKey === 'string' ? existing.publicKey : '');
  const secretKey = typeof payload.secretKey === 'string' && payload.secretKey.trim().length > 0
    ? payload.secretKey.trim()
    : (typeof existing.secretKey === 'string' ? existing.secretKey : '');
  // Inheriting a stored key across a different origin would let any code with
  // the page's cookie repoint the uploader at another host and receive the
  // Authorization header. Moving the origin therefore requires the key again.
  const secretSupplied = typeof payload.secretKey === 'string' && payload.secretKey.trim().length > 0;
  const storedOrigin = normalizeBaseUrl(existing.baseUrl);
  const requestedOrigin = normalizeBaseUrl(payload.baseUrl);
  const originMoved = storedOrigin.ok && requestedOrigin.ok && storedOrigin.value !== requestedOrigin.value;
  if (!secretSupplied && originMoved && typeof existing.secretKey === 'string' && existing.secretKey.trim().length > 0) {
    return invalidConfig('secretKey', 'required_for_new_host', 'secretKey must be re-entered when baseUrl changes');
  }
  const validation = validateConfig({
    baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl : '',
    publicKey,
    secretKey,
    userId: typeof payload.userId === 'string' ? payload.userId : '',
    maxChars: payload.maxChars,
  });
  if (!validation.valid) {
    return invalidConfig(validation.field, validation.reason, validation.message);
  }
  try {
    writeConfigAtomic(paths, validation.config);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'write_failed',
        message: (error instanceof Error ? error.message : 'could not write config.json').slice(0, MAX_ERROR_TEXT),
        details: {},
      },
    };
  }
  return {
    ok: true,
    value: readConfigStatus(options.ctx),
    saved: true,
    defaultOff: true,
  };
}

let installRunning = false;

/**
 * Install the vendored voluntary uploader and mount its managed Loader row.
 *
 * Safety properties: refuse when an original automatic collector row still
 * exists (the existing migrate flow owns that transition), back up every file
 * before replacing it, keep the managed block idempotent, never touch
 * `config.json`, never call the uploader control path, and report whether a
 * DSH restart is required when the new module does not load within 8 seconds.
 *
 * @param {any} ctx - Cordis Host context.
 * @param {{ reloadTimeoutMs?: number }} [options] - reload observation budget.
 * @returns {Promise<object>} install result with the redacted config status.
 */
export async function installUploader(ctx, options = {}) {
  if (installRunning) {
    return { ok: false, error: { code: 'busy', message: 'an install is already running', details: {} }, defaultOff: true };
  }
  installRunning = true;
  try {
    const paths = resolvePaths();
    const hooks = loaderEntries(ctx).map(describeHook).filter(hook => hook !== null);
    const autoRows = hooks.filter(hook => hook.kind === 'auto');
    const residual = [];
    for (const file of [paths.profilePatch, paths.homePatch]) {
      if (!fs.existsSync(file)) continue;
      try {
        residual.push(...residualAutoRows(fs.readFileSync(file, 'utf8')));
      } catch {
        // An unreadable patch cannot be checked; the write below will report it.
      }
    }
    if (autoRows.length > 0 || residual.length > 0) {
      return {
        ok: false,
        error: {
          code: 'auto_collector_present',
          message: 'an original automatic collector row is still present; use the existing migrate flow first',
          details: {
            rows: [...new Set([...autoRows.map(row => row.entryId), ...residual])],
            migrate: ROUTE_MIGRATE,
          },
        },
        defaultOff: true,
      };
    }
    if (!fs.existsSync(paths.vendorModule)) {
      return {
        ok: false,
        error: { code: 'module_missing', message: `vendored uploader missing: ${paths.vendorModule}`, details: {} },
        defaultOff: true,
      };
    }
    const moduleExists = fs.existsSync(paths.voluntaryModule);
    const moduleChanged = !moduleExists || !filesEqual(paths.vendorModule, paths.voluntaryModule);
    const patchExists = fs.existsSync(paths.profilePatch);
    const original = patchExists ? fs.readFileSync(paths.profilePatch, 'utf8') : null;
    const bom = original !== null && original.charCodeAt(0) === 0xfeff;
    const body = original === null ? '' : stripBom(original);
    const eol = original === null ? '\n' : detectEol(body);
    const next = upsertManagedBlock(body, toFileUrl(paths.voluntaryModule));
    if (residualAutoRows(next).length > 0) {
      return {
        ok: false,
        error: { code: 'unsupported_layout', message: 'the managed block alone would not remove every automatic collector row', details: {} },
        defaultOff: true,
      };
    }
    const output = original === null ? next : `${bom ? '\uFEFF' : ''}${toEol(next, eol)}`;
    const patchChanged = output !== original;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const backups = [];
    const changed = [];
    const moduleBackupNeeded = moduleChanged && moduleExists;
    const patchBackupNeeded = patchChanged && patchExists;
    if (moduleBackupNeeded || patchBackupNeeded) fs.mkdirSync(paths.backupDir, { recursive: true });
    if (moduleBackupNeeded) {
      const backup = path.join(paths.backupDir, `${path.basename(paths.voluntaryModule)}.${stamp}.${path.basename(paths.voluntaryDir)}.bak`);
      fs.copyFileSync(paths.voluntaryModule, backup);
      backups.push(backup);
    }
    if (patchBackupNeeded) {
      const backup = path.join(paths.backupDir, `${path.basename(paths.profilePatch)}.${stamp}.${path.basename(paths.profileDir)}.bak`);
      fs.copyFileSync(paths.profilePatch, backup);
      backups.push(backup);
    }
    if (moduleChanged) {
      fs.mkdirSync(paths.voluntaryDir, { recursive: true, mode: 0o700 });
      const temporary = `${paths.voluntaryModule}.${process.pid}.${stamp}.tmp`;
      try {
        fs.copyFileSync(paths.vendorModule, temporary);
        fs.renameSync(temporary, paths.voluntaryModule);
      } catch (error) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          // The temporary file may never have been created.
        }
        throw error;
      }
      changed.push(paths.voluntaryModule);
    }
    if (patchChanged) {
      fs.mkdirSync(paths.profileDir, { recursive: true });
      const temporary = `${paths.profilePatch}.dsh-toggle-${stamp}.tmp`;
      try {
        fs.writeFileSync(temporary, output, 'utf8');
        fs.renameSync(temporary, paths.profilePatch);
      } catch (error) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          // The temporary file may never have been created.
        }
        throw error;
      }
      changed.push(paths.profilePatch);
    }
    const requested = options?.reloadTimeoutMs;
    const waitMs = requested === undefined ? 8000 : Math.max(0, Math.min(8000, Number(requested) || 0));
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && locateUploader() === null) await sleep(200);
    const status = readConfigStatus(ctx);
    const loaded = locateUploader() !== null;
    const installed = status.uploader.installed;
    return {
      ok: installed,
      status,
      restartRequired: !loaded,
      copied: moduleChanged,
      changed,
      backups,
      alreadyInstalled: !moduleChanged && !patchChanged,
      defaultOff: true,
      error: installed
        ? undefined
        : { code: 'install_failed', message: 'the uploader module or its Loader row is missing after the install', details: {} },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'install_failed',
        message: (error instanceof Error ? error.message : 'install failed').slice(0, MAX_ERROR_TEXT),
        details: {},
      },
      defaultOff: true,
    };
  } finally {
    installRunning = false;
  }
}

/**
 * Whether two files have identical bytes.
 * @param {string} left - first file.
 * @param {string} right - second file.
 * @returns {boolean} true when both files exist and match.
 */
function filesEqual(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}

/**
 * Dispatch one config route action.
 * @param {any} ctx - Cordis Host context.
 * @param {any} payload - decoded JSON body.
 * @returns {Promise<object>} RPC result envelope.
 */
export async function configAction(ctx, payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail('bad_request', 'payload must be an object');
  }
  if (payload.action === 'get') return ok(readConfigStatus(ctx));
  if (payload.action === 'save') return saveConfig(payload, { ctx });
  if (payload.action === 'install') return installUploader(ctx);
  return fail('bad_request', 'action must be one of get, save, install');
}

/**
 * Cordis Host plugin entry.
 *
 * The RPC routes are registered only while `connection` exists, and their
 * registrations are removed when this plugin unloads. No HTTP control port is
 * opened: the shared Connection carrier authenticates the browser session and
 * applies the Host/Origin fence before the handler runs.
 *
 * @param {any} ctx - Cordis Host context.
 */
export function apply(ctx) {
  const bridge = createBridge({
    locate: () => locateUploader(),
    lookupSession: sessionId => sessionFromContext(ctx, sessionId),
  });

  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection;
    if (connection === undefined || connection === null) return;
    const registry = connection.fetch;
    if (registry === undefined || registry === null || typeof registry.register !== 'function') return;

    /**
     * Register one JSON POST route and tie its removal to this plugin fiber.
     * @param {string} routePath - exact absolute path below `/api`.
     * @param {(payload: unknown) => unknown | Promise<unknown>} handler - endpoint body.
     */
    const register = (routePath, handler) => {
      const remove = registry.register({
        path: routePath,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let payload = {};
          try {
            const text = await request.text();
            payload = text.length > 0 ? JSON.parse(text) : {};
          } catch {
            return Response.json(fail('bad_request', 'body must be JSON'));
          }
          try {
            return Response.json(await handler(payload));
          } catch (error) {
            return Response.json(fail('bridge_error', error instanceof Error ? error.message : 'unexpected bridge failure'));
          }
        },
      });
      scope.effect(() => () => {
        Promise.resolve(remove()).catch(() => {});
      }, `dsh-langfuse-header-toggle: ${routePath} route`);
    };

    register(ROUTE_STATE, payload => bridge.handle('state', payload));
    register(ROUTE_SET, payload => bridge.handle('set', payload));
    register(ROUTE_SCAN, () => scanHooks(ctx));
    register(ROUTE_MIGRATE, payload => migrateHooks(ctx, payload));
    register(ROUTE_CONFIG, payload => configAction(ctx, payload));
  });
}

export default { name, apply };
