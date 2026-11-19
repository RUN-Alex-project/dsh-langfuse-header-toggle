/**
 * Payload-parity regression tests against the official oh-langfuse 1.2.5 DSH
 * plugin. Expected values are taken from the real 1.2.5 module captured in
 * baseline/golden (local OTLP sink), not from the old custom emitter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulePath = fileURLToPath(new URL('../vendor/dsh-langfuse-voluntary-2.0.0.mjs', import.meta.url));
const module = await import(pathToFileURL(modulePath).href);
const { buildPayload, normalizeUsage } = module;

process.env.OH_LANGFUSE_PACKAGE_NAME = 'oh-langfuse';
process.env.OH_LANGFUSE_PACKAGE_VERSION = '1.2.5';
process.env.OH_LANGFUSE_RUNTIME_VERSION = '1.2.5';
process.env.OH_LANGFUSE_DISTRIBUTION = 'standalone';
process.env.OH_LANGFUSE_RUNTIME_TARGET = 'dsh';

const config = {
  baseUrl: 'http://127.0.0.1:9',
  publicKey: 'pk-lf-offline-test',
  secretKey: 'sk-lf-offline-test',
  userId: 'j00000000',
  maxChars: 20000,
};
const model = 'deepseek/deepseek-v4.1-flash';

function decode(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(decode);
  return undefined;
}
function attrs(span) {
  return Object.fromEntries((span.attributes || []).map(item => [item.key, decode(item.value)]));
}
function spansOf(payload) {
  return payload.resourceSpans[0].scopeSpans[0].spans;
}
function span(payload, name) {
  return spansOf(payload).find(item => item.name === name);
}
function root(payload) {
  return spansOf(payload).find(item => !item.parentSpanId);
}
function metaValue(span, key) {
  const raw = attrs(span)[`langfuse.observation.metadata.${key}`];
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function buffer(overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-parity-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha beta gamma\n', 'utf8');
  const session = { id: 'session-parity', cwd, header: { config: { model: 'deepseek-v4.1-flash' } } };
  return {
    state: { id: session.id, session },
    buffer: {
      turn: 1,
      epoch: 'epoch-test',
      userText: 'Please read a.txt and summarize it.',
      assistantText: 'The file contains alpha, beta and gamma.',
      model,
      usageCalls: [
        normalizeUsage({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 10 }),
        normalizeUsage({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 300 }),
      ],
      toolCalls: [{
        callId: 'call-1', name: 'read_file', arguments: { path: 'a.txt' },
        result: 'alpha beta gamma', error: null,
      }],
      toolByCallId: new Map(),
      stepCount: 2,
      reason: 'completed',
      ...overrides,
    },
  };
}

test('normal turn matches the 1.2.5 span shape and token semantics', async () => {
  const { state, buffer: turn } = buffer();
  const { payload } = await buildPayload(config, state, turn);
  const names = spansOf(payload).map(item => item.name).sort();
  assert.deepEqual(names, ['Agent Response', 'DeepSeek Harness Agent Turn', 'Tool Call', 'Tool Result']);

  const rootSpan = root(payload);
  const rootAttrs = attrs(rootSpan);
  assert.deepEqual(rootAttrs['langfuse.trace.tags'], ['dsh']);
  assert.equal(metaValue(rootSpan, 'interaction_id'), 'dsh:session-parity:1');
  assert.equal(metaValue(rootSpan, 'total_tokens'), 2690);
  assert.equal(metaValue(rootSpan, 'cache_read_tokens'), 300);
  assert.equal(metaValue(rootSpan, 'completed'), true);
  assert.equal(metaValue(rootSpan, 'aborted'), false);
  assert.equal(metaValue(rootSpan, 'step_count'), 2);
  assert.equal(metaValue(rootSpan, 'tool_result_count'), 1);
  assert.equal(metaValue(rootSpan, 'input_preview'), 'Please read a.txt and summarize it.');
  assert.equal(rootAttrs['langfuse.internal.is_app_root'], true);

  const generation = span(payload, 'Agent Response');
  const usage = JSON.parse(attrs(generation)['langfuse.observation.usage_details']);
  assert.deepEqual(usage, {
    input_tokens: 2200,
    output_tokens: 180,
    total_tokens: 2690,
    cache_read_tokens: 300,
    cache_write_tokens: 10,
  });
  assert.equal(attrs(generation)['langfuse.observation.model.name'], model);
  assert.equal(JSON.parse(attrs(generation)['langfuse.observation.metadata.model']), model);

  const toolResult = span(payload, 'Tool Result');
  assert.equal(JSON.parse(attrs(toolResult)['langfuse.observation.metadata.status']), 'ok');
  assert.equal(attrs(toolResult)['langfuse.observation.output'], 'alpha beta gamma');

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /voluntary_upload|consent_epoch|consent_from_seq|voluntary_plugin_version/);
  assert.doesNotMatch(JSON.stringify(attrs(rootSpan)['langfuse.trace.tags']), /voluntary/);
});

test('multi-step is one generation and sums per-call usage', async () => {
  const { state, buffer: turn } = buffer({
    usageCalls: [
      normalizeUsage({ inputTokens: 300, outputTokens: 20, cacheReadTokens: 50 }),
      normalizeUsage({ inputTokens: 400, outputTokens: 25, cacheReadTokens: 75 }),
      normalizeUsage({ inputTokens: 500, outputTokens: 30, cacheReadTokens: 100 }),
    ],
    toolCalls: [],
    stepCount: 3,
  });
  const { payload } = await buildPayload(config, state, turn);
  assert.equal(spansOf(payload).filter(item => item.name === 'Agent Response').length, 1);
  const usage = JSON.parse(attrs(span(payload, 'Agent Response'))['langfuse.observation.usage_details']);
  assert.deepEqual(usage, {
    input_tokens: 1200,
    output_tokens: 75,
    total_tokens: 1375,
    cache_read_tokens: 100,
  });
});

test('cumulative cache reads take the last value and tool errors stay visible', async () => {
  const { state, buffer: turn } = buffer({
    usageCalls: [
      normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 100 }),
      normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 250 }),
      normalizeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 400 }),
    ],
    toolCalls: [{
      callId: 'call-err', name: 'read_file', arguments: { path: 'missing.txt' },
      result: null, error: { code: 'ENOENT', message: 'missing.txt not found' },
    }],
    stepCount: 3,
  });
  const { payload } = await buildPayload(config, state, turn);
  const usage = JSON.parse(attrs(span(payload, 'Agent Response'))['langfuse.observation.usage_details']);
  assert.deepEqual(usage, {
    input_tokens: 300,
    output_tokens: 30,
    total_tokens: 730,
    cache_read_tokens: 400,
  });
  const toolResult = span(payload, 'Tool Result');
  assert.equal(JSON.parse(attrs(toolResult)['langfuse.observation.metadata.status']), 'error');
  assert.equal(JSON.parse(attrs(toolResult)['langfuse.observation.metadata.error']), JSON.stringify({ code: 'ENOENT', message: 'missing.txt not found' }));
});

test('a user-only aborted turn still emits the original root trace', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-parity-user-'));
  const session = { id: 'session-parity-user', cwd, header: {} };
  const { payload } = await buildPayload(config, { id: session.id, session }, {
    turn: 1,
    epoch: 'epoch-test',
    userText: 'This turn never gets an assistant response.',
    assistantText: '',
    model: '',
    usageCalls: [],
    toolCalls: [],
    toolByCallId: new Map(),
    stepCount: 0,
    reason: 'aborted',
  });
  assert.deepEqual(spansOf(payload).map(item => item.name), ['DeepSeek Harness Agent Turn']);
  const rootSpan = root(payload);
  assert.equal(metaValue(rootSpan, 'aborted'), true);
  assert.equal(metaValue(rootSpan, 'completed'), false);
  assert.equal(attrs(rootSpan)['langfuse.observation.output'], undefined);
  assert.equal(attrs(rootSpan)['langfuse.observation.input'], JSON.stringify({ role: 'user', content: 'This turn never gets an assistant response.' }));
});
