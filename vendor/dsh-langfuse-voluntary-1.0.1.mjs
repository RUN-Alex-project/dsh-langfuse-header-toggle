// Explicit, per-session Langfuse upload for DSH 0.2.2-rc.3.
// No global OTEL provider, background exporter, transcript scan, or npm dependency.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const name = 'dsh-langfuse-voluntary';
export const inject = ['commands'];
export const VERSION = '1.0.1';
const TRACE_NAME = 'DeepSeek Harness Agent Turn';
const DIAGNOSTIC = Symbol.for('dsh.langfuse.voluntary');
const ROOT = path.dirname(fileURLToPath(import.meta.url));

function iso(value) {
  const date = typeof value === 'number' ? new Date(value) : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
function nanos(value) { return (BigInt(new Date(iso(value)).getTime()) * 1000000n).toString(); }
function number(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function firstNumber(...values) { return values.map(number).find(value => value !== undefined); }
function safeJson(value) { try { return JSON.stringify(value); } catch { return '[unserializable]'; } }
function text(value, max = 20000) {
  if (typeof value === 'string') return value.slice(0, max);
  if (Array.isArray(value)) return value.map(part => text(part, max)).filter(Boolean).join('\n').slice(0, max);
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.slice(0, max);
  if (value.content !== undefined) return text(value.content, max);
  if (value.message !== undefined) return text(value.message, max);
  return '';
}
function sid(session) { return typeof session?.id === 'string' && session.id.length > 0 ? session.id : null; }
function scalar(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return { arrayValue: { values: value.map(stringValue => ({ stringValue })) } };
  return { stringValue: typeof value === 'string' ? value : safeJson(value) };
}
function attributes(values) {
  return Object.entries(values).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => ({ key, value: scalar(value) }));
}

export function normalizeUsage(usage = {}) {
  const input = firstNumber(usage.inputTokens, usage.input_tokens, usage.input, usage.promptTokens);
  const output = firstNumber(usage.outputTokens, usage.output_tokens, usage.output, usage.completionTokens);
  const cacheRead = firstNumber(usage.cacheReadTokens, usage.cache_read_input_tokens, usage.cache_read_tokens, usage.cacheRead, usage.cachedInputTokens);
  const cacheWrite = firstNumber(usage.cacheWriteTokens, usage.cache_creation_input_tokens, usage.cache_write_tokens, usage.cacheWrite);
  // DSH's documented components are per-call and disjoint. Never export or
  // subtract a session-cumulative total: it can include a private/off interval.
  const total = input !== undefined && output !== undefined ? input + output + (cacheRead || 0) + (cacheWrite || 0) : undefined;
  return { input, output, cacheRead, cacheWrite, total, available: input !== undefined || output !== undefined };
}

function repoContext(session) {
  const cwd = session?.header?.identity?.cwd || session?.identity?.cwd || session?.header?.cwd || session?.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return {};
  const result = { cwd, cwd_source: 'session', git_repo_name: path.basename(cwd) };
  try {
    const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    result.git_branch = git(['branch', '--show-current']);
    result.git_commit = git(['rev-parse', 'HEAD']);
    result.is_git_repo = true;
  } catch { result.is_git_repo = false; }
  return result;
}

export function postOtlp(config, payload, signal) {
  const target = new URL('/api/public/otel/v1/traces', config.baseUrl);
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method: 'POST', signal,
      headers: {
        Authorization: `Basic ${Buffer.from(config.publicKey + ':' + config.secretKey).toString('base64')}`,
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

export function buildOtlp(config, state, buffer) {
  const sessionId = state.id;
  const interactionId = `dsh:${sessionId}:${buffer.turn}`;
  const traceId = crypto.createHash('sha256').update(interactionId + ':voluntary-v1').digest('hex').slice(0, 32);
  const spanId = role => crypto.createHash('sha256').update(interactionId + ':' + role).digest('hex').slice(0, 16);
  const generations = [...buffer.generations.values()].sort((a, b) => a.step - b.step);
  const usage = generations.map(item => normalizeUsage(item.usage));
  const sum = key => usage.some(item => item[key] !== undefined) ? usage.reduce((total, item) => total + (item[key] || 0), 0) : undefined;
  const totals = { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), total: sum('total') };
  const output = text(generations.at(-1)?.message, config.maxChars);
  const input = text(buffer.userText, config.maxChars);
  const tools = [...buffer.tools.values()];
  const skills = [];
  for (const tool of tools) {
    if (!/(?:^|[._/-])skill(?:$|[._/-])/i.test(tool.name)) continue;
    let args = tool.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const skill = args?.name || args?.skill || args?.skillName;
    if (typeof skill === 'string' && skill) skills.push({ name: skill, callId: tool.id });
  }
  const model = generations.at(-1)?.model || null;
  const meta = {
    source: 'dsh', agent: 'dsh', user_id: config.userId, session_id: sessionId,
    interaction_id: interactionId, interaction_count: 1, metrics_schema_version: '1.1',
    turn_number: buffer.turn, model, input_tokens: totals.input ?? null, output_tokens: totals.output ?? null,
    total_tokens: totals.total ?? null, usage_details_total_tokens: totals.total ?? null,
    token_metrics_available: usage.some(item => item.available),
    cache_read_tokens: totals.cacheRead ?? null, cache_write_tokens: totals.cacheWrite ?? null,
    user_message_count: input ? 1 : 0, assistant_message_count: output ? 1 : 0,
    tool_call_count: tools.length, tool_result_count: tools.filter(tool => tool.result !== undefined).length,
    step_count: generations.length, skill_use_count: skills.length,
    unique_skill_count: new Set(skills.map(skill => skill.name)).size,
    repeated_skill_count: skills.length - new Set(skills.map(skill => skill.name)).size,
    skill_names: [...new Set(skills.map(skill => skill.name))],
    completed: ['completed', 'max-tokens'].includes(buffer.reason),
    aborted: ['aborted', 'blocked', 'interrupted'].includes(buffer.reason),
    turn_end_reason: buffer.reason, voluntary_upload: true,
    consent_epoch: state.epoch, consent_from_seq: state.fromSeq,
    oh_langfuse_runtime_target: 'dsh', voluntary_plugin_version: VERSION,
    ...repoContext(state.session),
  };
  const common = {
    'langfuse.trace.name': TRACE_NAME, 'langfuse.user.id': config.userId,
    'langfuse.session.id': sessionId, 'langfuse.trace.tags': ['dsh', 'voluntary'],
    'langfuse.version': VERSION,
  };
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    // Langfuse parses metadata strings as JSON; preserve numeric-looking
    // strings (schema/version identifiers) as strings rather than numbers.
    common['langfuse.trace.metadata.' + key] = safeJson(value);
    common['langfuse.observation.metadata.' + key] = safeJson(value);
  }
  const makeSpan = (role, name, type, values = {}, parent, start = buffer.start, end = buffer.end) => ({
    traceId, spanId: spanId(role), ...(parent ? { parentSpanId: parent } : {}),
    name, kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end),
    attributes: attributes({ ...common, 'langfuse.observation.type': type, ...values }),
    status: { code: 1 },
  });
  const rootId = spanId('root');
  const spans = [makeSpan('root', TRACE_NAME, 'span', {
    'langfuse.observation.input': safeJson({ role: 'user', content: input }),
    'langfuse.observation.output': safeJson({ role: 'assistant', content: output }),
  })];
  generations.forEach((generation, index) => {
    const count = usage[index];
    const details = {};
    if (count.input !== undefined) details.input = count.input;
    if (count.output !== undefined) details.output = count.output;
    if (count.cacheRead !== undefined) details.input_cached_tokens = count.cacheRead;
    if (count.cacheWrite !== undefined) details.input_cache_creation_tokens = count.cacheWrite;
    spans.push(makeSpan('generation-' + generation.step, 'Agent Response', 'generation', {
      'langfuse.observation.model.name': generation.model || undefined,
      'langfuse.observation.usage_details': Object.keys(details).length ? safeJson(details) : undefined,
      'langfuse.observation.input': safeJson({ role: 'user', content: input }),
      'langfuse.observation.output': safeJson({ role: 'assistant', content: text(generation.message, config.maxChars) }),
    }, rootId, generation.start || buffer.start, generation.end || buffer.end));
  });
  for (const tool of tools) {
    spans.push(makeSpan('tool-' + tool.id, 'Tool Call', 'tool', {
      'langfuse.observation.input': safeJson({ name: tool.name, arguments: text(typeof tool.arguments === 'string' ? tool.arguments : safeJson(tool.arguments), config.maxChars) }),
      'langfuse.observation.output': tool.result !== undefined ? safeJson(text(tool.result, config.maxChars)) : undefined,
      'langfuse.observation.metadata.tool_name': tool.name,
    }, rootId, tool.start, tool.end || buffer.end));
  }
  skills.forEach((skill, index) => spans.push(makeSpan('skill-' + index, 'Skill Use', 'span', {
    'langfuse.observation.metadata.skill_name': skill.name,
    'langfuse.observation.metadata.skill_use_count': 1,
    'langfuse.observation.metadata.skill_call_id': skill.callId,
  }, rootId)));
  return {
    traceId, spanCount: spans.length,
    payload: { resourceSpans: [{
      resource: { attributes: attributes({ 'service.name': 'dsh-langfuse-voluntary', 'service.version': VERSION }) },
      scopeSpans: [{ scope: { name: 'dsh-langfuse-voluntary', version: VERSION }, spans }],
    }] },
  };
}

export class VoluntaryCollector {
  #config;
  #states = new Map();
  #transport;
  #audit;
  #tasks = new Set();
  #disposed = false;
  constructor({ config, transport = postOtlp, audit = () => {} }) {
    this.#config = config;
    this.#transport = transport;
    this.#audit = audit;
  }
  #state(session) {
    const id = sid(session);
    if (!id) throw new Error('no_session_identity');
    let state = this.#states.get(id);
    if (state && state.session !== session) { this.#revoke(state); this.#states.delete(id); state = null; }
    if (!state) {
      state = { id, session, enabled: false, epoch: '', fromSeq: 0, turns: new Map(), pendingUser: '',
        sentTurns: new Set(), requests: new Set(), sent: 0, failed: 0, last: null };
      this.#states.set(id, state);
    }
    return state;
  }
  #revoke(state) {
    state.enabled = false;
    state.epoch = crypto.randomUUID();
    state.turns.clear(); state.pendingUser = '';
    for (const request of state.requests) request.abort();
    state.requests.clear();
  }
  command(invocation) {
    if (this.#disposed) return { kind: 'error', text: '上传控制器已卸载，当前未开启上传。' };
    const session = invocation?.agent?.session;
    const action = String(invocation?.rawInput || '').trim().toLowerCase() || 'status';
    if (!sid(session)) return { kind: 'error', text: '无法确定当前会话，未开启上传。' };
    if (action === 'off-all') {
      for (const state of this.#states.values()) this.#revoke(state);
      this.#audit({ event: 'off-all' });
      return { kind: 'success', text: '已关闭所有会话的 Langfuse 上传，并清除尚未提交的缓存。' };
    }
    const state = this.#state(session);
    if (action === 'on') {
      if (!this.#config) return { kind: 'error', text: '上传器配置尚未就绪，仍保持关闭。' };
      if (state.enabled) return { kind: 'success', text: `当前会话已开启上传：${state.id}；保留原有开启起点。` };
      if (!Number.isSafeInteger(session.seq) || session.seq < 0) return { kind: 'error', text: '无法确定会话事件起点，仍保持关闭。' };
      const selection = invocation.agent?.model?.current?.();
      state.defaultModel = selection?.model || invocation.agent?.options?.model || '';
      state.enabled = true; state.epoch = crypto.randomUUID(); state.fromSeq = session.seq;
      state.turns.clear(); state.pendingUser = '';
      state.enabledAt = new Date().toISOString();
      this.#audit({ event: 'on', sessionId: state.id, fromSeq: state.fromSeq });
      return { kind: 'success', text: `已开启当前会话上传：${state.id}\n仅上传此后新开始的轮次；历史内容与其他会话保持关闭。\n工号：${this.#config.userId}` };
    }
    if (action === 'off') {
      this.#revoke(state);
      this.#audit({ event: 'off', sessionId: state.id });
      return { kind: 'success', text: `已关闭当前会话上传：${state.id}\n尚未提交的缓存已清除；已发送的数据无法撤回。` };
    }
    if (action !== 'status') return { kind: 'error', text: '用法：/lf on | /lf off | /lf status | /lf off-all' };
    const last = state.last ? `${state.last.at} ${state.last.ok ? '平台 HTTP 已接收' : '发送未完成：' + state.last.error}${state.last.traceId ? '；trace=' + state.last.traceId : ''}` : '尚无发送';
    return { kind: 'success', text: [
      `当前会话：${state.id}`, `Langfuse 上传：${state.enabled ? '开启' : '关闭（默认）'}`,
      `上传器：${this.#config ? '已配置，工号 ' + this.#config.userId : '未配置'}`,
      `本次进程已接收确认：${state.sent} 轮；失败：${state.failed} 轮`,
      `待完成轮次：${state.turns.size}；发送中：${state.requests.size}`,
      `最近结果：${last}`, '其他会话独立控制；DSH 重启后全部恢复关闭。',
    ].join('\n') };
  }
  handle(session, event) {
    if (this.#disposed) return;
    const id = sid(session);
    const state = id ? this.#states.get(id) : null;
    // This check precedes reading event.data, resolving cwd, or buffering text.
    if (!state?.enabled || state.session !== session) return;
    if (!Number.isSafeInteger(event?.seq) || event.seq < state.fromSeq) return;
    const type = event.type;
    if (!['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'request/header'].includes(type)) return;
    const data = event.data || {};
    const turn = Number(data.turn);
    if (type === 'turn/start') {
      if (!Number.isSafeInteger(turn) || turn <= 0 || state.sentTurns.has(turn)) return;
      state.turns.set(turn, { turn, epoch: state.epoch, start: iso(event.time), userText: state.pendingUser,
        model: state.defaultModel || '', generations: new Map(), tools: new Map(), reason: '' });
      state.pendingUser = '';
      return;
    }
    if (type === 'user/message') {
      if (data.source?.kind && !['user', 'human'].includes(data.source.kind)) return;
      const content = text(data.message || data, this.#config.maxChars);
      if (!content) return;
      const buffer = state.turns.get(turn) || [...state.turns.values()].at(-1);
      if (buffer && !buffer.userText) buffer.userText = content;
      else if (!buffer && !state.pendingUser) state.pendingUser = content;
      return;
    }
    if (type === 'request/header') {
      const model = data.header?.config?.model;
      if (typeof model === 'string' && model) {
        state.defaultModel = model;
        const current = [...state.turns.values()].at(-1);
        if (current) current.model = model;
      }
      return;
    }
    const buffer = state.turns.get(turn);
    if (type === 'turn/end') {
      state.pendingUser = '';
      if (!buffer) return;
      state.turns.delete(turn);
      buffer.end = iso(event.time);
      buffer.reason = typeof data.reason === 'object' ? data.reason?.kind || '' : String(data.reason || '');
      if (buffer.generations.size === 0 && buffer.tools.size === 0) return;
      const task = this.#send(state, buffer);
      this.#tasks.add(task);
      task.finally(() => this.#tasks.delete(task));
      return;
    }
    // Never create a partial buffer for a turn that started while consent was off.
    if (!buffer || buffer.epoch !== state.epoch) return;
    if (type === 'assistant/message') {
      const step = Number.isSafeInteger(data.step) ? data.step : buffer.generations.size;
      buffer.generations.set(step, { step, start: buffer.start, end: iso(event.time),
        message: text(data.message || data, this.#config.maxChars), usage: data.usage || {},
        model: data.message?.model || data.model || buffer.model || session.header?.config?.model || '' });
    } else if (type === 'tool/call') {
      const callId = String(data.callId || data.call_id || 'tool-' + buffer.tools.size);
      buffer.tools.set(callId, { id: callId, name: String(data.name || ''),
        arguments: text(typeof data.arguments === 'string' ? data.arguments : safeJson(data.arguments), this.#config.maxChars), start: iso(event.time) });
    } else if (type === 'tool/result') {
      const callId = String(data.callId || data.call_id || data.message?.callId || '');
      const tool = buffer.tools.get(callId);
      if (tool) { tool.result = text(data.message || data, this.#config.maxChars); tool.end = iso(event.time); }
    }
  }
  async #send(state, buffer) {
    await Promise.resolve();
    if (!state.enabled || state.epoch !== buffer.epoch || this.#disposed || state.sentTurns.has(buffer.turn)) return;
    const request = new AbortController();
    state.requests.add(request);
    let traceId;
    try {
      const built = buildOtlp(this.#config, state, buffer);
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
  sessionDisposed(session) { const state = this.#states.get(sid(session)); if (state?.session === session) this.#revoke(state); }
  async drain() { await Promise.allSettled([...this.#tasks]); }
  dispose() { this.#disposed = true; for (const state of this.#states.values()) this.#revoke(state); }
  diagnostics() {
    return { version: VERSION, defaultUpload: false, ready: !!this.#config,
      endpoint: this.#config?.baseUrl, userId: this.#config?.userId,
      sessions: [...this.#states.values()].map(state => ({ id: state.id, enabled: state.enabled, fromSeq: state.fromSeq, sent: state.sent, failed: state.failed, last: state.last })) };
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
    try { fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', 'utf8'); } catch { /* metadata-only log is best effort */ }
  };
  const controller = new VoluntaryCollector({ config: loadConfig(), audit });
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
      name: 'lf', description: '自愿上传当前会话到团队 Langfuse（默认关闭）',
      input: { hint: 'on | off | status | off-all' },
      handler: invocation => controller.command(invocation),
    });
  }, 'langfuse voluntary controls');
  audit({ event: 'loaded', version: VERSION, ready: controller.diagnostics().ready, defaultUpload: false });
}

export default { name, inject, apply };
