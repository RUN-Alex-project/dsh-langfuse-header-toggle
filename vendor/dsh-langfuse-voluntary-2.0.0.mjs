// Explicit, per-session Langfuse upload for DSH, with payload semantics aligned
// to the official oh-langfuse 1.2.5 DSH plugin. No npm dependency: the original
// 1.2.5 aggregation rules are ported below and verified against golden payloads
// captured from the real module. The switch only decides whether a session's
// events enter this pipeline; it never rewrites the business fields.
import fs from 'node:fs';
import fsPromise from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'dsh-langfuse-voluntary';
export const inject = ['commands'];
export const VERSION = '2.0.0';
const AGENT_NAME = 'dsh';
const METRICS_SCHEMA_VERSION = '1.1';
const MAX_CHARS = 20000;
const TRACE_NAME = 'DeepSeek Harness Agent Turn';
const DIAGNOSTIC = Symbol.for('dsh.langfuse.voluntary');
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** Per-session consent that survives uploader reloads/DSH restarts. */
const CONSENT_PATH = path.join(ROOT, 'session-consent.json');
const CONSENT_VERSION = 1;
const MAX_CONSENT_SESSIONS = 2000;

export function readConsent(filePath = CONSENT_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (data === null || typeof data !== 'object' || data.version !== CONSENT_VERSION || !Array.isArray(data.sessions)) return [];
    const ids = data.sessions
      .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200)
      .slice(0, MAX_CONSENT_SESSIONS);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function writeConsent(sessions, filePath = CONSENT_PATH) {
  try {
    const list = [...new Set(sessions)]
      .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200)
      .sort()
      .slice(0, MAX_CONSENT_SESSIONS);
    const temporary = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const body = `${JSON.stringify({ version: CONSENT_VERSION, updatedAt: new Date().toISOString(), sessions: list }, null, 2)}\n`;
    fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* Windows ACL */ }
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
  } catch {
    // Consent persistence is best effort; in-memory state stays correct.
  }
}

function envStr(name, fallback = "") {
  const v = process.env[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function logDir() {
  return path.join(dshHome(), "langfuse");
}

function logFile() {
  return path.join(logDir(), "dsh-langfuse-plugin.log");
}

function appendLog(message) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging is best-effort; never throw.
  }
}

let _runtimeRecordCache;
function readRuntimeRecord() {
  if (_runtimeRecordCache !== undefined) return _runtimeRecordCache;
  try {
    const statePath = path.join(os.homedir(), ".config", "oh-langfuse", "runtime.json");
    if (!fs.existsSync(statePath)) {
      _runtimeRecordCache = {};
      return {};
    }
    const text = fs.readFileSync(statePath, "utf8");
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const data = JSON.parse(stripped);
    const targets = data && data.targets && typeof data.targets === "object" ? data.targets : {};
    const rec = targets[AGENT_NAME];
    _runtimeRecordCache = rec && typeof rec === "object" ? rec : {};
  } catch {
    _runtimeRecordCache = {};
  }
  return _runtimeRecordCache;
}

function truncate(value, max = MAX_CHARS) {
  const text = value == null ? "" : typeof value === "string" ? value : safeJson(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function numberOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function stringifyForPropagation(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (v == null) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else out[k] = safeJson(v);
  }
  return out;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { available: false, input: null, output: null, cacheRead: null, cacheWrite: null, total: null };
  }
  const input = numberOrNull(usage.input ?? usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens);
  const output = numberOrNull(usage.output ?? usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens);
  const cacheRead = numberOrNull(
    usage.cacheRead
      ?? usage.cacheReadTokens
      ?? usage.cache_read_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cachedInputTokens
      ?? usage.cached_input_tokens,
  );
  const cacheWrite = numberOrNull(
    usage.cacheWrite ?? usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens,
  );
  const upstreamTotal = numberOrNull(usage.total ?? usage.totalTokens ?? usage.total_tokens);
  // DSH reports disjoint per-call counts: the adapters subtract cache reads out
  // of inputTokens (dsh-llm-deepseek/dsh-llm-pi-ai mapUsage) and completion
  // tokens already fold in reasoning, so the upstream `total_tokens` equivalent
  // (prompt_tokens + completion_tokens) is input + output + cacheRead +
  // cacheWrite. Reasoning must NOT be added: it is a subset of outputTokens and
  // adding it would double-count.
  const componentTotal =
    input != null && output != null ? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0) : null;
  const total = upstreamTotal ?? componentTotal;
  // When upstream provides a totalTokens, it is a session-cumulative value
  // (desktop mode). In web mode, upstream does not provide totalTokens but
  // cacheReadTokens is itself cumulative, making componentTotal cumulative too.
  const available = [input, output, total, cacheRead, cacheWrite].some((v) => v != null);
  return { available, input, output, cacheRead, cacheWrite, total, upstreamTotal };
}

// Aggregate per-call usage across multiple LLM calls within a single turn.
// DSH adapters report disjoint per-call counts:
//   - inputTokens / outputTokens / cacheWriteTokens are always per-call → sum
//   - cacheReadTokens: per-call in desktop (upstreamTotal present), cumulative
//     in web (no upstreamTotal) → sum for desktop, take last value for web
//   - upstreamTotal (totalTokens): session-cumulative when present → take last
//     value; flushBuffer computes a per-turn delta across turns.
function aggregateUsageCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return { available: false, input: null, output: null, cacheRead: null, cacheWrite: null, total: null, upstreamTotal: null };
  }
  const valid = calls.filter((c) => c && c.available);
  if (valid.length === 0) {
    return { available: false, input: null, output: null, cacheRead: null, cacheWrite: null, total: null, upstreamTotal: null };
  }
  let aggInput = 0, aggOutput = 0, aggCacheWrite = 0, aggCacheReadSum = 0;
  let lastCacheRead = null, lastUpstreamTotal = null;
  let hasInput = false, hasOutput = false, hasCacheWrite = false, hasCacheRead = false, hasUpstreamTotal = false;
  for (const c of valid) {
    if (c.input != null) { aggInput += c.input; hasInput = true; }
    if (c.output != null) { aggOutput += c.output; hasOutput = true; }
    if (c.cacheWrite != null) { aggCacheWrite += c.cacheWrite; hasCacheWrite = true; }
    if (c.cacheRead != null) { aggCacheReadSum += c.cacheRead; lastCacheRead = c.cacheRead; hasCacheRead = true; }
    if (c.upstreamTotal != null) { hasUpstreamTotal = true; lastUpstreamTotal = c.upstreamTotal; }
  }
  // cacheRead: desktop (has upstreamTotal) = per-call → sum;
  //            web (no upstreamTotal) = cumulative → take last value.
  const cacheRead = hasUpstreamTotal ? (hasCacheRead ? aggCacheReadSum : null) : lastCacheRead;
  // total is always derived from component fields (input+output+cacheRead+
  // cacheWrite) so it stays consistent with the individually-reported fields.
  // In desktop (per-call upstreamTotal) this equals Σ upstreamTotal; in web
  // (cumulative cacheRead) the total is itself cumulative.
  const componentTotal = hasInput && hasOutput
    ? aggInput + aggOutput + (cacheRead ?? 0) + (aggCacheWrite ?? 0)
    : null;
  const total = componentTotal;
  return {
    available: true,
    input: hasInput ? aggInput : null,
    output: hasOutput ? aggOutput : null,
    cacheRead,
    cacheWrite: hasCacheWrite ? aggCacheWrite : null,
    total,
    upstreamTotal: lastUpstreamTotal,
  };
}

export function runtimeVersionMetadata(env = process.env, record) {
  const rec = record !== undefined ? (record || {}) : readRuntimeRecord();
  const envVal = (name, fallback = "") => {
    const v = env[name];
    return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
  };
  const packageName = envVal("OH_LANGFUSE_PACKAGE_NAME") || String(rec.packageName || "");
  const packageVersion = envVal("OH_LANGFUSE_PACKAGE_VERSION") || String(rec.packageVersion || "");
  const runtimeVersion =
    envVal("OH_LANGFUSE_RUNTIME_VERSION")
    || String(rec.langfuseRuntimeVersion || rec.runtimeVersion || "")
    || packageVersion;
  const distribution =
    envVal("OH_LANGFUSE_DISTRIBUTION")
    || String(rec.distribution || "")
    || (packageName === "oh-langfuse" ? "standalone" : packageName === "oh-aicoding-tool" ? "aggregate" : "unknown");
  return {
    oh_langfuse_runtime_version: runtimeVersion,
    oh_langfuse_runtime_target: envVal("OH_LANGFUSE_RUNTIME_TARGET", AGENT_NAME),
    oh_langfuse_package_name: packageName,
    oh_langfuse_package_version: packageVersion,
    oh_langfuse_distribution: distribution || "unknown",
    oh_langfuse_version_source: env.OH_LANGFUSE_RUNTIME_VERSION ? "env" : (runtimeVersion ? "runtime_json" : "unknown"),
  };
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") parts.push(block.text);
      else if (typeof block.content === "string") parts.push(block.content);
    }
    return parts.join("\n");
  }
  return "";
}

function extractModel(message, header) {
  const provider = message?.provider || header?.config?.provider || message?.modelProvider || "";
  const model = message?.model || header?.config?.model || "";
  if (provider && model) return `${provider}/${model}`;
  return model || provider || "";
}

function extractToolResultText(resultMessage) {
  if (!resultMessage || typeof resultMessage !== "object") return "";
  const content = resultMessage.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") parts.push(block.text);
      else if (typeof block.content === "string") parts.push(block.content);
      else if (block.type === "tool-result" || block.type === "tool_result") {
        if (typeof block.text === "string") parts.push(block.text);
        else if (typeof block.content === "string") parts.push(block.content);
      }
    }
    return parts.join("\n");
  }
  return safeJson(resultMessage);
}

function newToolCall(callId, name, args, turn, step) {
  return { callId, name, arguments: args, turn, step, result: null, error: null, meta: null };
}

function newTurnBuffer(sessionId, turn, startedAt) {
  return {
    sessionId,
    turn,
    startedAt,
    endedAt: null,
    reason: null,
    userText: "",
    assistantText: "",
    model: "",
    usageCalls: [],
    toolCalls: [],
    toolByCallId: new Map(),
    stepCount: 0,
  };
}

function buildInteractionId(sessionId, turn) {
  return `${AGENT_NAME}:${sessionId || "unknown"}:${Number(turn) || 0}`;
}

function mapReasonToCompleted(reason) {
  const kind = reason && typeof reason === "object" ? reason.kind : String(reason || "");
  return kind === "completed" || kind === "max-tokens";
}

function mapReasonToAborted(reason) {
  const kind = reason && typeof reason === "object" ? reason.kind : String(reason || "");
  return ["aborted", "blocked", "interrupted"].includes(kind);
}

// Defensively extract { session, event, sessionId } from a session/event dispatch.
function extractSessionEvent(...args) {
  let session = null;
  let event = null;
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    if (event === null && typeof arg.type === "string" && arg.type.includes("/") && "data" in arg && "seq" in arg) {
      event = arg;
    }
    if (session === null && ("append" in arg || "events" in arg || "header" in arg || "deriveMessages" in arg) && ("id" in arg || "header" in arg)) {
      session = arg;
    }
  }
  if (event === null) {
    for (const arg of args) {
      if (arg && typeof arg === "object" && typeof arg.type === "string" && arg.type.includes("/") && "data" in arg) {
        event = arg;
        break;
      }
    }
  }
  if (!event && args.length === 1 && args[0] && typeof args[0] === "object") {
    const wrap = args[0];
    if (wrap.event && typeof wrap.event === "object") event = wrap.event;
    if (!session && wrap.session && typeof wrap.session === "object") session = wrap.session;
  }
  const sessionId =
    session?.id ||
    session?.header?.id ||
    event?.sessionId ||
    event?.session?.id ||
    event?.data?.sessionId ||
    event?.data?.session?.id ||
    "";
  return { session, event, sessionId: String(sessionId || "") };
}

// DSH desktop launches the node process from a non-project directory, so
// process.cwd() is unreliable there and leaves Agent Turn git context empty
// plus a wrong cwd metadata. The Session carries its project cwd in its
// identity/header; probe the common field shapes and fall back to "" so the
// caller can drop back to process.cwd() when the session exposes nothing.
function resolveSessionCwd(session) {
  if (!session || typeof session !== "object") return "";
  const candidates = [
    session.cwd,
    session?.header?.cwd,
    session?.identity?.cwd,
    session?.header?.identity?.cwd,
    session?.data?.identity?.cwd,
    session?.data?.cwd,
    session?.options?.cwd,
    session.projectPath,
    session?.header?.projectPath,
    session.workspace,
    session?.header?.workspace,
    session.rootDir,
    session?.header?.rootDir,
  ];
  for (const c of candidates) {
    const s = typeof c === "string" ? c.trim() : "";
    if (s && s !== ".") return s;
  }
  return "";
}

// --- Git repo context (ported from opencode-plugin-langfuse) ---

const _SKILL_SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "__pycache__", ".cache", "venv", ".venv", "env", ".env", "vendor", "third_party", "third-party", ".idea", ".vscode", ".vs", "target", "out", ".gradle", ".hvigor", ".sass-cache", ".turbo", ".parcel-cache"]);

function emptyRepoContext(cwd = "", cwdSource = "unavailable", available = false, error = "", isGitRepo = false) {
  return {
    cwd: String(cwd || ""),
    cwd_source: cwdSource || "unavailable",
    git_context_available: Boolean(available),
    git_context_error: error || "",
    is_git_repo: Boolean(isGitRepo),
    git_root: "",
    git_remote: "",
    git_remote_host: "",
    git_repo_owner: "",
    git_repo_name: "",
    git_repo_slug: "",
    git_branch: "",
    git_commit: "",
  };
}

function sanitizeGitRemote(remote) {
  const empty = { git_remote: "", git_remote_host: "", git_repo_owner: "", git_repo_name: "", git_repo_slug: "" };
  const raw = String(remote || "").trim();
  if (!raw) return empty;
  try {
    let host = "";
    let parts = [];
    if (raw.includes("://")) {
      const parsed = new URL(raw);
      host = parsed.hostname;
      parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    } else {
      const scp = raw.match(/^[^@]+@([^:]+):(.+)$/);
      if (scp) {
        host = scp[1];
        parts = scp[2].replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      } else {
        const parsed = new URL(`ssh://${raw}`);
        host = parsed.hostname;
        parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      }
    }
    if (!host || parts.length < 2) return empty;
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1].replace(/\.git$/i, "");
    if (!owner || !repo) return empty;
    const slug = `${owner}/${repo}`;
    return { git_remote: `${host}/${slug}`, git_remote_host: host, git_repo_owner: owner, git_repo_name: repo, git_repo_slug: slug };
  } catch {
    return empty;
  }
}

function runGit(cwd, args) {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] });
    return { ok: true, stdout: String(stdout || "").trim(), error: "" };
  } catch (error) {
    if (error && error.code === "ETIMEDOUT") return { ok: false, stdout: "", error: "timeout" };
    if (error && error.code === "ENOENT") return { ok: false, stdout: "", error: "git_unavailable" };
    return { ok: false, stdout: "", error: "git_error" };
  }
}

const repoContextCache = new Map();
const REPO_CACHE_TTL = 30000;

function collectRepoContext(cwd, cwdSource = "process") {
  const cwdText = String(cwd || "").trim();
  if (!cwdText) return emptyRepoContext("", "unavailable", false, "missing_cwd");
  const now = Date.now();
  const memCached = repoContextCache.get(cwdText);
  if (memCached && now - memCached.time <= REPO_CACHE_TTL) {
    return { ...memCached.context, cwd_source: cwdSource || memCached.context.cwd_source };
  }
  let context = emptyRepoContext(cwdText, cwdSource, false, "", false);
  const inside = runGit(cwdText, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    const reason = ["timeout", "git_unavailable"].includes(inside.error) ? inside.error : "";
    context = reason ? emptyRepoContext(cwdText, cwdSource, false, reason, false) : emptyRepoContext(cwdText, cwdSource, true, "", false);
    repoContextCache.set(cwdText, { time: now, context });
    return context;
  }
  if (inside.stdout.toLowerCase() !== "true") {
    context = emptyRepoContext(cwdText, cwdSource, true, "", false);
    repoContextCache.set(cwdText, { time: now, context });
    return context;
  }
  context = emptyRepoContext(cwdText, cwdSource, true, "", true);
  const root = runGit(cwdText, ["rev-parse", "--show-toplevel"]);
  if (!root.ok && ["timeout", "git_unavailable"].includes(root.error)) {
    context.git_context_available = false;
    context.git_context_error = root.error;
    repoContextCache.set(cwdText, { time: now, context });
    return context;
  }
  context.git_root = root.stdout || "";
  let sanitized = { git_remote: "", git_remote_host: "", git_repo_owner: "", git_repo_name: "", git_repo_slug: "" };
  for (const name of ["origin", "gitcode", "upstream"]) {
    const r = runGit(cwdText, ["config", "--get", `remote.${name}.url`]);
    if (r.ok && r.stdout) {
      sanitized = sanitizeGitRemote(r.stdout);
      if (sanitized.git_remote) break;
      sanitized = { git_remote: "", git_remote_host: "", git_repo_owner: "", git_repo_name: "", git_repo_slug: "" };
    }
  }
  if (!sanitized.git_remote) {
    const list = runGit(cwdText, ["remote"]);
    if (list.ok && list.stdout) {
      const first = (list.stdout.split(/\r?\n/).find((l) => l.trim()) || "").trim();
      if (first) {
        const r = runGit(cwdText, ["config", "--get", `remote.${first}.url`]);
        if (r.ok && r.stdout) sanitized = sanitizeGitRemote(r.stdout);
      }
    }
  }
  if (sanitized.git_remote) {
    context = { ...context, ...sanitized };
  }
  const branch = runGit(cwdText, ["branch", "--show-current"]);
  if (branch.ok) context.git_branch = branch.stdout || "";
  const commit = runGit(cwdText, ["rev-parse", "--short", "HEAD"]);
  if (commit.ok) context.git_commit = commit.stdout || "";
  repoContextCache.set(cwdText, { time: now, context });
  return context;
}

// --- Skill detection (ported from opencode-plugin-langfuse) ---

function normalizeSkillNames(names) {
  if (!Array.isArray(names)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function skillNamespace(name) {
  return String(name || "").includes(":") ? String(name).split(":", 1)[0] : "";
}

function skillAgentPath(detectedBy) {
  if (detectedBy === "tool_call") return "dsh_skill_tool";
  if (detectedBy === "slash_command") return "dsh_slash_prompt";
  if (detectedBy === "natural_language_request") return "dsh_prompt_skill_name";
  if (detectedBy === "skill_file_path") return "skill_file_path";
  return detectedBy || "metadata";
}

function skillInvocationMode(detectedBy) {
  if (detectedBy === "slash_command") return "explicit_request";
  if (detectedBy === "natural_language_request") return "implicit_request";
  if (detectedBy === "tool_call" || detectedBy === "plugin_event") return "implicit";
  return "detected";
}

function skillEventType(detectedBy) {
  return (detectedBy === "slash_command" || detectedBy === "natural_language_request") ? "requested" : (detectedBy === "tool_call" || detectedBy === "plugin_event" ? "invoked" : "detected");
}

function skillIdSegment(name) {
  return String(name || "unknown").trim().replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeExplicitSkillCommand(value) {
  const command = String(value || "").replace(/^\/+/, "").trim();
  if (!command) return "";
  return command.split(/\s+/, 1)[0];
}

function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectStrings(item, out);
    }
  }
  return out;
}

function collectExplicitSkillUsages(value, out = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectExplicitSkillUsages(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  const command = normalizeExplicitSkillCommand(value.command ?? value.commandName ?? value.promptCommand ?? value.properties?.command ?? value.properties?.commandName);
  if (command) {
    const callId = String(value.commandID || value.commandId || value.id || "");
    out.push({ name: command, skill_namespace: skillNamespace(command), detected_by: "slash_command", skill_call_id: callId });
  }
  const toolName = String(value.tool ?? value.toolName ?? value.name ?? "").toLowerCase();
  const input = value.input ?? value.state?.input ?? value.properties?.input;
  if (toolName === "skill" && input && typeof input === "object" && !Array.isArray(input)) {
    const skill = String(input.skill_name ?? input.skill ?? input.name ?? "");
    const callId = String(value.callID ?? value.callId ?? value.id ?? value.toolCallID ?? value.toolCallId ?? "");
    if (skill) out.push({ name: skill, skill_namespace: skillNamespace(skill), detected_by: "tool_call", skill_call_id: callId });
  }
  for (const item of Object.values(value)) collectExplicitSkillUsages(item, out);
  return out;
}

function detectPromptSkillRequests(haystack, skills) {
  const text = String(haystack || "");
  if (!text.trim()) return [];
  const out = [];
  for (const skillName of skills) {
    const escaped = escapeRegExp(skillName);
    const pattern = new RegExp(`(?:请\\s*)?(?:使用|调用|启用|采用|加载|引入|运行)\\s*[\"'""'']?(?:技能[:：]?\\s*)?${escaped}(?=$|[\\s,，。；;:：、])|\\b(?:use|invoke|run|apply|loaded?|imported?)\\s+(?:skill\\s+)?[\"']?${escaped}(?=$|[\\s,，。；;:：])|(?:skill|技能)\\s*[:：]\\s*[\"'""'']?${escaped}(?=$|[\\s,，。；;:：、])`, "i");
    if (pattern.test(text)) out.push({ name: skillName, skill_namespace: skillNamespace(skillName), detected_by: "natural_language_request", skill_call_id: "" });
  }
  return out;
}

function detectDshSkillUsages(buffer, knownSkills) {
  const skills = normalizeSkillNames(knownSkills);
  if (skills.length === 0) return [];
  const found = [];
  const explicitSeen = new Set();
  // 1. Tool calls — check for skill tool or skill names in arguments
  for (const tool of buffer.toolCalls) {
    const toolName = String(tool.name || "").toLowerCase();
    const toolArgs = typeof tool.arguments === "string" ? tool.arguments : safeJson(tool.arguments);
    if (toolName === "skill" && toolArgs) {
      try {
        const parsed = JSON.parse(toolArgs);
        const skillName = String(parsed?.skill_name ?? parsed?.skill ?? parsed?.name ?? "");
        if (skillName && skills.includes(skillName)) {
          const key = `call:${tool.callId || skillName}`;
          if (!explicitSeen.has(key)) { explicitSeen.add(key); found.push({ name: skillName, skill_namespace: skillNamespace(skillName), detected_by: "tool_call", skill_call_id: tool.callId || "" }); }
        }
      } catch {}
    }
  }
  // 2. Natural language requests in user prompt
  const haystack = [buffer.userText, buffer.assistantText, ...buffer.toolCalls.map((t) => safeJson(t.arguments))].join("\n");
  const promptSeen = new Set(found.map((u) => u.name));
  for (const usage of detectPromptSkillRequests(haystack, skills)) {
    if (promptSeen.has(usage.name)) continue;
    promptSeen.add(usage.name);
    found.push(usage);
  }
  // 3. Skill file paths in tool arguments
  const pathSeen = new Set(found.map((u) => u.name));
  for (const match of haystack.matchAll(/(?:^|["'\s])(?:[A-Za-z]:)?[^"'\n\r]*[\\/]+([^\\/"'\n\r]+)[\\/]+SKILL\.md(?=$|["'\s])/gi)) {
    const skillName = match[1];
    if (!skills.includes(skillName) || pathSeen.has(skillName)) continue;
    pathSeen.add(skillName);
    found.push({ name: skillName, skill_namespace: skillNamespace(skillName), detected_by: "skill_file_path", skill_call_id: "" });
  }
  return found;
}

async function _collectSkillNamesRecursive(base, names, depth, maxDepth) {
  if (depth > maxDepth) return;
  try {
    const entries = await fsPromise.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || _SKILL_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      try {
        await fsPromise.access(path.join(base, entry.name, "SKILL.md"));
        names.add(entry.name);
      } catch {
        await _collectSkillNamesRecursive(path.join(base, entry.name), names, depth + 1, maxDepth);
      }
    }
  } catch {}
}

let knownSkillNames = null;
let knownSkillNamesPromise = null;

async function collectKnownSkillNames() {
  if (knownSkillNames) return knownSkillNames;
  if (knownSkillNamesPromise) return knownSkillNamesPromise;
  knownSkillNamesPromise = (async () => {
    const dirs = [
      path.join(process.cwd(), ".opencode", "skill"),
      path.join(process.cwd(), ".opencode", "skills"),
      path.join(os.homedir(), ".config", "opencode", "skill"),
      path.join(os.homedir(), ".config", "opencode", "skills"),
      path.join(os.homedir(), ".opencode", "skill"),
      path.join(os.homedir(), ".opencode", "skills"),
      path.join(os.homedir(), ".dsh", "skills"),
    ];
    // Also try the oh-langfuse skills discover script
    try {
      const discoverPath = path.join(os.homedir(), ".config", "oh-langfuse", "opencode-skills-discover.mjs");
      const mod = await import(pathToFileURL(discoverPath).href);
      const roots = mod && typeof mod.collectSkillRoots === "function" ? mod.collectSkillRoots(process.cwd()) : [];
      if (Array.isArray(roots)) for (const r of roots) if (typeof r === "string") dirs.push(r);
    } catch {}
    const names = new Set();
    for (const dir of dirs) {
      try {
        const entries = await fsPromise.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          try {
            await fsPromise.access(path.join(dir, entry.name, "SKILL.md"));
            names.add(entry.name);
          } catch {
            await _collectSkillNamesRecursive(path.join(dir, entry.name), names, 0, 5);
          }
        }
      } catch {}
    }
    knownSkillNames = [...names];
    return knownSkillNames;
  })();
  return knownSkillNamesPromise;
}

function dedupeSkillUsages(usages) {
  const out = [];
  const seen = new Set();
  for (const usage of usages || []) {
    const key = usage.skill_call_id ? `call:${usage.skill_call_id}` : `${usage.name}:${usage.detected_by}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(usage);
  }
  return out;
}

function buildSkillUseEvents(interactionId, skillUsages) {
  const usages = dedupeSkillUsages(skillUsages);
  const total = usages.length;
  return usages.map((usage, index) => {
    const skillName = String(usage.name || "").trim();
    const detectedBy = String(usage.detected_by || "metadata");
    const invocationMode = skillInvocationMode(detectedBy);
    return {
      skill_use_id: `${interactionId}:skill:${index + 1}:${skillIdSegment(skillName)}`,
      skill_use_index: index + 1,
      skill_use_count_in_interaction: total,
      skill_event_type: skillEventType(detectedBy),
      skill_trigger: invocationMode,
      skill_invocation_mode: invocationMode,
      skill_agent_path: skillAgentPath(detectedBy),
      skill_name: skillName,
      skill_use_count: 1,
      skill_namespace: usage.skill_namespace || skillNamespace(skillName),
      detected_by: detectedBy,
      ...(usage.skill_call_id ? { skill_call_id: usage.skill_call_id } : {}),
    };
  }).filter((event) => event.skill_name);
}

function summarizeSkillUsages(skillUsages) {
  const usages = dedupeSkillUsages(skillUsages);
  const names = normalizeSkillNames(usages.map((u) => u.name));
  const allEvents = buildSkillUseEvents("", usages);
  return {
    skill_use_count: usages.length,
    unique_skill_count: names.length,
    repeated_skill_count: Math.max(0, usages.length - names.length),
    skill_names: names,
    skill_names_csv: names.join(","),
    skill_names_all: allEvents.map((e) => e.skill_name),
    skill_invocation_modes: allEvents.map((e) => e.skill_invocation_mode).filter(Boolean),
    skill_agent_paths: allEvents.map((e) => e.skill_agent_path).filter(Boolean),
  };
}

export { normalizeUsage, aggregateUsageCalls };

function nanos(value) {
  const date = typeof value === 'number' ? new Date(value) : new Date(value || Date.now());
  return (BigInt(Number.isFinite(date.getTime()) ? date.getTime() : Date.now()) * 1000000n).toString();
}
function sidOf(session) {
  return typeof session?.id === 'string' && session.id.length > 0 ? session.id : null;
}
function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return { arrayValue: { values: value.map(stringValue => ({ stringValue })) } };
  return { stringValue: typeof value === 'string' ? value : safeJson(value) };
}
function attributes(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

/**
 * The team runtime record is the authoritative source. Without a dsh entry
 * (the official DSH collector is intentionally not installed) fall back to the
 * 1.2.5 schema identity so downstream version dimensions stay meaningful.
 */
function compatRuntimeMetadata() {
  const meta = runtimeVersionMetadata();
  if (meta.oh_langfuse_package_name) return meta;
  return {
    oh_langfuse_runtime_version: '1.2.5',
    oh_langfuse_runtime_target: AGENT_NAME,
    oh_langfuse_package_name: 'oh-langfuse',
    oh_langfuse_package_version: '1.2.5',
    oh_langfuse_distribution: 'standalone',
    oh_langfuse_version_source: 'compat',
  };
}

function propagationValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeJson(value);
}
function traceMetaValue(value) {
  return safeJson(propagationValue(value));
}
function observationMetaValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return safeJson(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeJson(value);
}
function emptyTurnBuffer(sessionId, turn, epoch, startedAt) {
  const buffer = newTurnBuffer(sessionId, turn, startedAt);
  buffer.epoch = epoch;
  return buffer;
}

/**
 * Build the OTLP payload for one completed turn using the exact 1.2.5 DSH
 * metadata/spans semantics. Control-layer fields (consent epoch/fromSeq,
 * voluntary flags) never enter this object.
 * @param {any} config
 * @param {any} state
 * @param {any} buffer
 * @returns {Promise<{traceId: string, spanCount: number, payload: any}>}
 */
export async function buildPayload(config, state, buffer) {
  const sessionId = String(state.id);
  const turnNumber = Number(buffer.turn) || 0;
  const interactionId = buildInteractionId(sessionId, turnNumber);
  const userText = truncate(buffer.userText);
  const assistantText = truncate(buffer.assistantText);
  const usage = aggregateUsageCalls(buffer.usageCalls);
  const runtimeMeta = compatRuntimeMetadata();
  const cwd = resolveSessionCwd(state.session) || process.cwd();
  const repoContext = collectRepoContext(cwd, resolveSessionCwd(state.session) ? 'session' : 'process');
  const knownSkills = await collectKnownSkillNames();
  const skillUsages = detectDshSkillUsages(buffer, knownSkills);
  const skillEvents = buildSkillUseEvents(interactionId, skillUsages);
  const skillSummary = summarizeSkillUsages(skillUsages);
  const completed = mapReasonToCompleted(buffer.reason);
  const aborted = mapReasonToAborted(buffer.reason);
  const reason = buffer.reason && typeof buffer.reason === 'object' ? buffer.reason.kind : String(buffer.reason || '');
  const meta = {
    source: AGENT_NAME,
    agent: AGENT_NAME,
    user_id: config.userId || '',
    session_id: sessionId,
    interaction_id: interactionId,
    interaction_count: 1,
    metrics_schema_version: METRICS_SCHEMA_VERSION,
    ...runtimeMeta,
    user_message_count: buffer.userText ? 1 : 0,
    assistant_message_count: buffer.assistantText ? 1 : 0,
    tool_call_count: buffer.toolCalls.length,
    tool_result_count: buffer.toolCalls.filter(tool => tool.result != null || tool.error != null).length,
    skill_use_count: skillSummary.skill_use_count,
    unique_skill_count: skillSummary.unique_skill_count,
    repeated_skill_count: skillSummary.repeated_skill_count,
    ...(skillSummary.skill_names?.length ? {
      skill_names: skillSummary.skill_names,
      skill_names_csv: skillSummary.skill_names_csv,
      skill_names_all: skillSummary.skill_names_all,
      skill_invocation_modes: skillSummary.skill_invocation_modes,
      skill_agent_paths: skillSummary.skill_agent_paths,
    } : {}),
    ...(usage.available
      ? { token_metrics_available: true, input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total, cache_read_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite }
      : { token_metrics_available: false, input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null }),
    model: buffer.model || null,
    turn_number: turnNumber,
    input_preview: (buffer.userText || '').slice(0, 120),
    output_preview: (buffer.assistantText || '').slice(0, 120),
    completed,
    aborted,
    turn_end_reason: reason,
    step_count: buffer.stepCount,
    ...repoContext,
  };

  const traceMetadata = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) continue;
    traceMetadata[`langfuse.trace.metadata.${key}`] = traceMetaValue(value);
  }
  const common = {
    'user.id': config.userId || '',
    'session.id': sessionId,
    'langfuse.trace.tags': [AGENT_NAME],
    ...traceMetadata,
  };
  const observationMetadata = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) continue;
    observationMetadata[`langfuse.observation.metadata.${key}`] = observationMetaValue(value);
  }

  const traceId = crypto.createHash('sha256').update(`${interactionId}:dsh-compat-v2`).digest('hex').slice(0, 32);
  const spanId = role => crypto.createHash('sha256').update(`${traceId}:${role}`).digest('hex').slice(0, 16);
  const now = new Date().toISOString();
  const makeSpan = (role, name, values, parent) => ({
    traceId,
    spanId: spanId(role),
    ...(parent ? { parentSpanId: parent } : {}),
    name,
    kind: 1,
    startTimeUnixNano: nanos(now),
    endTimeUnixNano: nanos(new Date(Date.now() + 1).toISOString()),
    attributes: attributes({ ...common, ...values }),
    status: { code: 0 },
  });

  const rootId = spanId('root');
  const rootAttrs = {
    ...observationMetadata,
    'langfuse.observation.type': 'span',
    'langfuse.internal.is_app_root': true,
  };
  if (userText) rootAttrs['langfuse.observation.input'] = safeJson({ role: 'user', content: userText });
  if (assistantText) rootAttrs['langfuse.observation.output'] = safeJson({ role: 'assistant', content: assistantText });
  const spans = [makeSpan('root', TRACE_NAME, rootAttrs, null)];

  if (assistantText || buffer.model || usage.available) {
    const generationAttrs = {
      'langfuse.observation.type': 'generation',
      'langfuse.observation.metadata.interaction_id': observationMetaValue(interactionId),
    };
    if (buffer.model) generationAttrs['langfuse.observation.metadata.model'] = observationMetaValue(buffer.model);
    if (userText) generationAttrs['langfuse.observation.input'] = safeJson({ role: 'user', content: userText });
    if (assistantText) generationAttrs['langfuse.observation.output'] = safeJson({ role: 'assistant', content: assistantText });
    if (buffer.model) generationAttrs['langfuse.observation.model.name'] = buffer.model;
    if (usage.available) {
      const details = {};
      if (usage.input !== null && usage.input !== undefined) details.input_tokens = usage.input;
      if (usage.output !== null && usage.output !== undefined) details.output_tokens = usage.output;
      if (usage.total !== null && usage.total !== undefined) details.total_tokens = usage.total;
      if (usage.cacheRead !== null && usage.cacheRead !== undefined) details.cache_read_tokens = usage.cacheRead;
      if (usage.cacheWrite !== null && usage.cacheWrite !== undefined) details.cache_write_tokens = usage.cacheWrite;
      generationAttrs['langfuse.observation.usage_details'] = safeJson(details);
    }
    spans.push(makeSpan('generation', 'Agent Response', generationAttrs, rootId));
  }

  for (const tool of buffer.toolCalls) {
    const toolArgs = truncate(typeof tool.arguments === 'string' ? tool.arguments : safeJson(tool.arguments));
    spans.push(makeSpan(`tool-call-${tool.callId || tool.name}`, 'Tool Call', {
      'langfuse.observation.type': 'tool',
      'langfuse.observation.input': safeJson({ name: tool.name || '', arguments: toolArgs }),
      'langfuse.observation.metadata.interaction_id': observationMetaValue(interactionId),
      'langfuse.observation.metadata.tool_id': observationMetaValue(tool.callId || ''),
      'langfuse.observation.metadata.tool_name': observationMetaValue(tool.name || ''),
    }, rootId));
    if (tool.result != null || tool.error != null) {
      const resultAttrs = {
        'langfuse.observation.type': 'tool',
        'langfuse.observation.metadata.interaction_id': observationMetaValue(interactionId),
        'langfuse.observation.metadata.tool_id': observationMetaValue(tool.callId || ''),
        'langfuse.observation.metadata.tool_name': observationMetaValue(tool.name || ''),
        'langfuse.observation.metadata.status': observationMetaValue(tool.error ? 'error' : 'ok'),
      };
      if (tool.result != null) resultAttrs['langfuse.observation.output'] = truncate(tool.result);
      if (tool.error != null) resultAttrs['langfuse.observation.metadata.error'] = observationMetaValue(safeJson(tool.error));
      spans.push(makeSpan(`tool-result-${tool.callId || tool.name}`, 'Tool Result', resultAttrs, rootId));
    }
  }

  for (const event of skillEvents) {
    const skillAttrs = {
      'langfuse.observation.type': 'span',
      'langfuse.observation.metadata.interaction_id': observationMetaValue(interactionId),
    };
    for (const [key, value] of Object.entries(event)) {
      if (key === 'interaction_id') continue;
      skillAttrs[`langfuse.observation.metadata.${key}`] = observationMetaValue(value);
    }
    spans.push(makeSpan(`skill-${event.skill_use_index}`, 'Skill Use', skillAttrs, rootId));
  }

  return {
    traceId,
    spanCount: spans.length,
    payload: {
      resourceSpans: [{
        resource: { attributes: attributes({ 'service.name': 'dsh-langfuse-voluntary', 'service.version': VERSION }) },
        scopeSpans: [{ scope: { name: 'dsh-langfuse-compat', version: VERSION }, spans }],
      }],
    },
  };
}

export function postOtlp(config, payload, signal) {
  const target = new URL('/api/public/otel/v1/traces', config.baseUrl);
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method: 'POST', signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`,
        'Content-Type': 'application/json', 'Content-Length': body.length,
        'x-langfuse-ingestion-version': '4',
      },
    }, response => {
      let result = '';
      response.on('data', chunk => { if (result.length < 8192) result += chunk.toString(); });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) { reject(new Error(`HTTP_${response.statusCode}`)); return; }
        let parsed = {};
        try { parsed = result ? JSON.parse(result) : {}; } catch { reject(new Error('invalid_receiver_response')); return; }
        if (Number(parsed.partialSuccess?.rejectedSpans || 0) > 0) { reject(new Error('receiver_rejected_spans')); return; }
        resolve({ status: response.statusCode });
      });
    });
    request.setTimeout(config.requestTimeoutMs || 10000, () => request.destroy(new Error('receiver_timeout')));
    request.on('error', error => reject(new Error(signal.aborted ? 'cancelled' : (error.message.match(/^HTTP_\d+$|receiver_timeout$/)?.[0] || error.code || 'transport_error'))));
    request.end(body);
  });
}

export class VoluntaryCollector {
  #config;
  #states = new Map();
  #transport;
  #audit;
  #tasks = new Set();
  #disposed = false;
  #persisted;
  #persistConsent;
  constructor({ config, transport = postOtlp, audit = () => {}, restoredSessions = [], persistConsent = null }) {
    this.#config = config;
    this.#transport = transport;
    this.#audit = audit;
    this.#persisted = new Set(Array.isArray(restoredSessions) ? restoredSessions : []);
    this.#persistConsent = typeof persistConsent === 'function' ? persistConsent : null;
  }
  #saveConsent() {
    try { this.#persistConsent?.([...this.#persisted]); } catch { /* best effort */ }
  }
  #state(session) {
    const id = sidOf(session);
    if (!id) throw new Error('no_session_identity');
    let state = this.#states.get(id);
    if (state && state.session !== session) { this.#revoke(state); this.#states.delete(id); state = null; }
    if (!state) {
      state = {
        id, session, enabled: false, epoch: '', fromSeq: 0, turns: new Map(),
        lastUserText: '', history: [], sentTurns: new Set(), requests: new Set(),
        sent: 0, failed: 0, last: null,
      };
      this.#states.set(id, state);
    }
    return state;
  }
  #revoke(state) {
    state.enabled = false;
    state.epoch = crypto.randomUUID();
    state.turns.clear(); state.lastUserText = ''; state.history = [];
    for (const request of state.requests) request.abort();
    state.requests.clear();
  }
  command(invocation) {
    if (this.#disposed) return { kind: 'error', text: '上传控制器已卸载，当前未开启上传。' };
    const session = invocation?.agent?.session;
    const rawInput = String(invocation?.rawInput || '').trim();
    const tokens = rawInput.toLowerCase().split(/\s+/).filter(Boolean);
    const action = tokens[0] || 'status';
    const flags = tokens.slice(1);
    const historyFlag = flags.some(flag => ['--history', 'history', '--backfill', 'backfill'].includes(flag));
    const unknownFlags = flags.filter(flag => !['--history', 'history', '--backfill', 'backfill'].includes(flag));
    if (unknownFlags.length > 0 || (flags.length > 0 && action !== 'on')) {
      return { kind: 'error', text: '用法：/lf on [--history] | /lf off | /lf status | /lf off-all' };
    }
    if (!sidOf(session)) return { kind: 'error', text: '无法确定当前会话，未开启上传。' };
    if (action === 'off-all') {
      for (const state of this.#states.values()) this.#revoke(state);
      this.#persisted.clear(); this.#saveConsent();
      this.#audit({ event: 'off-all' });
      return { kind: 'success', text: '已关闭所有会话的 Langfuse 上传，清除尚未提交的缓存，并取消重启后的状态恢复。' };
    }
    const state = this.#state(session);
    if (action === 'on') {
      if (!this.#config) return { kind: 'error', text: '上传器配置尚未就绪，仍保持关闭。' };
      if (state.enabled) return { kind: 'success', text: `当前会话已开启上传：${state.id}；保留原有开启起点。如需补传历史，请先 /lf off 再 /lf on --history。` };
      if (!Number.isSafeInteger(session.seq) || session.seq < 0) return { kind: 'error', text: '无法确定会话事件起点，仍保持关闭。' };
      const selection = invocation.agent?.model?.current?.();
      state.defaultModel = selection?.model || invocation.agent?.options?.model || '';
      state.enabled = true; state.epoch = crypto.randomUUID(); state.fromSeq = session.seq;
      state.turns.clear(); state.lastUserText = ''; state.history = [];
      state.enabledAt = new Date().toISOString();
      if (historyFlag) {
        state.history = this.#stageHistory(state, session);
        this.#audit({ event: 'history-staged', sessionId: state.id, fromSeq: state.fromSeq, turns: state.history.length });
      }
      this.#persisted.add(state.id); this.#saveConsent();
      this.#audit({ event: 'on', sessionId: state.id, fromSeq: state.fromSeq, history: state.history.length, persisted: true });
      if (historyFlag) {
        return {
          kind: 'success',
          text: `已开启当前会话上传：${state.id}\n将在下一条消息开始时补传此前 ${state.history.length} 个历史轮次；补传内容同样无法撤回。\n已记住开启状态：DSH 重启后仍保持开启（只上传恢复后的新轮次）。\n工号：${this.#config.userId}`,
        };
      }
      return { kind: 'success', text: `已开启当前会话上传：${state.id}\n仅上传此后新开始的轮次；历史内容与其他会话保持关闭。\n已记住开启状态：DSH 重启后仍保持开启（只上传恢复后的新轮次）。\n工号：${this.#config.userId}` };
    }
    if (action === 'off') {
      this.#revoke(state);
      this.#persisted.delete(state.id); this.#saveConsent();
      this.#audit({ event: 'off', sessionId: state.id, persisted: false });
      return { kind: 'success', text: `已关闭当前会话上传：${state.id}\n尚未提交的缓存已清除；已发送的数据无法撤回；重启后不会再自动恢复。` };
    }
    if (action !== 'status') return { kind: 'error', text: '用法：/lf on [--history] | /lf off | /lf status | /lf off-all' };
    const last = state.last ? `${state.last.at} ${state.last.ok ? '平台 HTTP 已接收' : '发送未完成：' + state.last.error}${state.last.traceId ? '；trace=' + state.last.traceId : ''}` : '尚无发送';
    return {
      kind: 'success',
      text: [
        `当前会话：${state.id}`,
        `Langfuse 上传：${state.enabled ? '开启' : '关闭（默认）'}`,
        `上传器：${this.#config ? `已配置，工号 ${this.#config.userId}` : '未配置'}`,
        `历史补传：${state.history?.length ? `待补传 ${state.history.length} 轮（下一条消息开始时上传）` : '无'}`,
        `本次进程已接收确认：${state.sent} 轮；失败：${state.failed} 轮`,
        `待完成轮次：${state.turns.size}；发送中：${state.requests.size}`,
        `最近结果：${last}`,
        `重启后保持：${state.enabled ? '开（已记住）' : '关'}`,
        '其他会话独立控制；已记住的会话在 DSH 重启后恢复开启，只上传恢复后的新轮次。',
      ].join('\n'),
    };
  }
  #stageHistory(state, session) {
    let events = [];
    try {
      if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents(0, state.fromSeq);
      else if (typeof session.ownEvents === 'function') events = session.ownEvents();
    } catch { events = []; }
    const buffers = new Map();
    let pendingUser = '';
    let current = null;
    const flushCurrent = () => {
      if (current && current.endedAt) buffers.set(current.turn, current);
      current = null;
    };
    for (const event of events) {
      if (!event || typeof event.type !== 'string') continue;
      if (Number.isSafeInteger(event.seq) && event.seq >= state.fromSeq) continue;
      const data = event.data || {};
      const turn = Number(data.turn);
      if (event.type === 'user/message') {
        const content = extractMessageText(data) || extractMessageText(data.message);
        if (content) {
          if (current && !current.userText) current.userText = content;
          else if (!current && !pendingUser) pendingUser = content;
        }
        continue;
      }
      if (event.type === 'turn/start') {
        if (!Number.isSafeInteger(turn) || turn <= 0) continue;
        flushCurrent();
        current = emptyTurnBuffer(state.id, turn, state.epoch, event.time ? new Date(event.time).toISOString() : new Date().toISOString());
        if (pendingUser) { current.userText = pendingUser; pendingUser = ''; }
        continue;
      }
      if (!current) continue;
      if (event.type === 'step/start') { current.stepCount += 1; continue; }
      if (event.type === 'assistant/message') {
        current.assistantText = truncate(extractMessageText(data.message || data));
        if (data.usage) current.usageCalls.push(normalizeUsage(data.usage));
        const model = extractModel(data.message || {}, null);
        if (model) current.model = model;
        continue;
      }
      if (event.type === 'tool/call') {
        const callId = String(data.callId ?? data.call_id ?? '');
        const tool = newToolCall(callId, String(data.name ?? ''), data.arguments ?? '', turn, Number(data.step) || 0);
        current.toolCalls.push(tool);
        current.toolByCallId.set(callId, tool);
        continue;
      }
      if (event.type === 'tool/result') {
        const callId = String(data.callId ?? data.call_id ?? '');
        const tool = (callId && current.toolByCallId.get(callId)) || current.toolCalls[current.toolCalls.length - 1];
        if (tool) {
          tool.result = extractToolResultText(data.message);
          tool.error = data.error || null;
          tool.meta = data.meta || null;
        }
        continue;
      }
      if (event.type === 'turn/end') {
        current.reason = data.reason || null;
        current.endedAt = event.time ? new Date(event.time).toISOString() : new Date().toISOString();
        flushCurrent();
      }
    }
    return [...buffers.values()].sort((left, right) => left.turn - right.turn);
  }
  #flushHistory(state) {
    const staged = Array.isArray(state.history) ? state.history : [];
    if (staged.length === 0) return;
    state.history = [];
    for (const buffer of staged) {
      buffer.epoch = state.epoch;
      const task = this.#send(state, buffer);
      this.#tasks.add(task);
      task.finally(() => this.#tasks.delete(task));
    }
  }
  handle(session, event) {
    if (this.#disposed) return;
    const id = sidOf(session);
    let state = id ? this.#states.get(id) : null;
    if (state && state.session !== session) {
      this.#revoke(state);
      this.#states.delete(id);
      state = null;
    }
    if (!state && id && this.#persisted.has(id)) {
      state = this.#state(session);
      const fromSeq = Number.isSafeInteger(event?.seq) ? event.seq : session.seq;
      if (Number.isSafeInteger(fromSeq) && fromSeq >= 0) {
        state.enabled = true;
        state.epoch = crypto.randomUUID();
        state.fromSeq = fromSeq;
        state.turns.clear(); state.lastUserText = ''; state.history = [];
        state.restoredAt = new Date().toISOString();
        this.#audit({ event: 'restored', sessionId: id, fromSeq });
      }
    }
    if (!state?.enabled || state.session !== session) return;
    if (!Number.isSafeInteger(event?.seq) || event.seq < state.fromSeq) return;
    const type = event.type;
    const allowed = ['turn/start', 'turn/end', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result'];
    if (!allowed.includes(type)) return;
    const data = event.data || {};
    const turn = Number(data.turn);

    if (type === 'user/message') {
      const content = extractMessageText(data) || extractMessageText(data.message);
      if (content && !state.lastUserText) state.lastUserText = content;
      return;
    }
    if (type === 'turn/start') {
      if (!Number.isSafeInteger(turn) || turn <= 0 || state.sentTurns.has(turn)) return;
      state.turns.set(turn, emptyTurnBuffer(state.id, turn, state.epoch, event.time ? new Date(event.time).toISOString() : new Date().toISOString()));
      this.#flushHistory(state);
      return;
    }
    const buffer = state.turns.get(turn);
    if (type === 'step/start') {
      if (buffer) buffer.stepCount += 1;
      return;
    }
    if (type === 'turn/end') {
      if (!buffer) return;
      state.turns.delete(turn);
      buffer.reason = data.reason || null;
      buffer.endedAt = event.time ? new Date(event.time).toISOString() : new Date().toISOString();
      const task = this.#send(state, buffer);
      this.#tasks.add(task);
      task.finally(() => this.#tasks.delete(task));
      return;
    }
    // Events of a turn that started while consent was off never create a partial
    // buffer; only a forwarded turn/start opens a turn.
    if (!buffer || buffer.epoch !== state.epoch) return;
    if (type === 'assistant/message') {
      buffer.assistantText = truncate(extractMessageText(data.message || data));
      if (data.usage) buffer.usageCalls.push(normalizeUsage(data.usage));
      const model = extractModel(data.message || {}, null);
      if (model) buffer.model = model;
      return;
    }
    if (type === 'tool/call') {
      const callId = String(data.callId ?? data.call_id ?? '');
      const tool = newToolCall(callId, String(data.name ?? ''), data.arguments ?? '', turn, Number(data.step) || 0);
      buffer.toolCalls.push(tool);
      buffer.toolByCallId.set(callId, tool);
      return;
    }
    if (type === 'tool/result') {
      const callId = String(data.callId ?? data.call_id ?? '');
      const tool = (callId && buffer.toolByCallId.get(callId)) || buffer.toolCalls[buffer.toolCalls.length - 1];
      if (tool) {
        tool.result = extractToolResultText(data.message);
        tool.error = data.error || null;
        tool.meta = data.meta || null;
      }
    }
  }
  async #send(state, buffer) {
    await Promise.resolve();
    if (!state.enabled || state.epoch !== buffer.epoch || this.#disposed || state.sentTurns.has(buffer.turn)) return;
    if (!buffer.userText && state.lastUserText) {
      buffer.userText = state.lastUserText;
      state.lastUserText = '';
    }
    const request = new AbortController();
    state.requests.add(request);
    let traceId;
    try {
      const built = await buildPayload(this.#config, state, buffer);
      traceId = built.traceId;
      if (!state.enabled || state.epoch !== buffer.epoch || request.signal.aborted || this.#disposed) return;
      const result = await this.#transport(this.#config, built.payload, request.signal);
      state.sentTurns.add(buffer.turn); state.sent += 1;
      state.last = { at: new Date().toISOString(), ok: true, traceId, http: result.status };
      this.#audit({ event: 'sent', sessionId: state.id, turn: buffer.turn, traceId, http: result.status, spans: built.spanCount });
    } catch (error) {
      state.failed += 1;
      const code = /^[a-zA-Z0-9_]+$/.test(error?.message || '') ? error.message : 'transport_error';
      state.last = { at: new Date().toISOString(), ok: false, error: code, traceId };
      this.#audit({ event: 'send-failed', sessionId: state.id, turn: buffer.turn, code });
    } finally { state.requests.delete(request); }
  }
  sessionDisposed(session) { const state = this.#states.get(sidOf(session)); if (state?.session === session) this.#revoke(state); }
  async drain() { await Promise.allSettled([...this.#tasks]); }
  dispose() { this.#disposed = true; for (const state of this.#states.values()) this.#revoke(state); }
  diagnostics() {
    const sessions = [...this.#states.values()].map(state => ({
      id: state.id, enabled: state.enabled, fromSeq: state.fromSeq, sent: state.sent,
      failed: state.failed, historyStaged: state.history?.length ?? 0, last: state.last,
    }));
    for (const id of this.#persisted) {
      if (this.#states.has(id)) continue;
      sessions.push({ id, enabled: true, persisted: true, restorePending: true, fromSeq: 0, sent: 0, failed: 0, historyStaged: 0, last: null });
    }
    return {
      version: VERSION, defaultUpload: false, ready: !!this.#config,
      endpoint: this.#config?.baseUrl, userId: this.#config?.userId,
      persisted: [...this.#persisted], sessions,
    };
  }
}

export function loadConfig(configPath = path.join(ROOT, 'config.json')) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') return null;
    if (!/^[a-z]((30|00|60)\d{6}|wx\d{6,})$/.test(value.userId || '')) return null;
    if (!String(value.publicKey || '').startsWith('pk-lf-') || !String(value.secretKey || '').startsWith('sk-lf-')) return null;
    return { ...value, maxChars: Math.min(Number(value.maxChars) || 20000, 20000), baseUrl: url.origin };
  } catch { return null; }
}

export function apply(ctx) {
  const logPath = path.join(ROOT, 'control-events.jsonl');
  const audit = value => {
    try { fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, 'utf8'); } catch { /* best effort */ }
  };
  const controller = new VoluntaryCollector({
    config: loadConfig(),
    audit,
    restoredSessions: readConsent(),
    persistConsent: sessions => writeConsent(sessions),
  });
  const diagnostic = { controller, context: ctx, version: VERSION };
  globalThis[DIAGNOSTIC] = diagnostic;
  ctx.on('session/event', (session, event) => controller.handle(session, event));
  ctx.on('session/disposed', session => controller.sessionDisposed(session));
  ctx.effect(function* () {
    yield () => {
      controller.dispose();
      if (globalThis[DIAGNOSTIC] === diagnostic) delete globalThis[DIAGNOSTIC];
    };
    yield ctx.commands.register({
      name: 'lf',
      description: '自愿上传当前会话到团队 Langfuse（默认关闭）',
      input: { hint: 'on [--history] | off | status | off-all' },
      handler: invocation => controller.command(invocation),
    });
  }, 'langfuse voluntary controls');
  audit({ event: 'loaded', version: VERSION, ready: controller.diagnostics().ready, defaultUpload: false, persisted: controller.diagnostics().persisted?.length ?? 0 });
}

export default { name, inject, apply };
