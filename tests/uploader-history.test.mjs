/**
 * Uploader history-backfill integration test.
 *
 * Loads the installed voluntary uploader in a throw-away directory with a fake
 * `config.json`, points it at a local OTLP recorder, and drives it through the
 * same `command()` + `session/event` path DSH uses:
 *
 *   /lf on --history  -> stages completed turns before the enable point
 *   next turn/start   -> flushes the staged history plus the new turn
 *
 * No network, no DSH process and no real Langfuse endpoint is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UPLOADER_PATH = process.env.LANGFUSE_UPLOADER_PATH
  || path.join(os.homedir(), '.dsh', 'langfuse-voluntary', 'dsh-langfuse-voluntary-1.0.3.mjs');
const uploaderAvailable = fs.existsSync(UPLOADER_PATH);
const uploaderTest = { skip: uploaderAvailable ? false : `uploader not found at ${UPLOADER_PATH}` };

/** Start a local OTLP sink; resolves to { url, requests, close }. */
function startSink() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        requests.push({ malformed: true });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(done => { server.close(done); }),
      });
    });
  });
}

/** Copy the uploader into a temp dir with its own config.json. */
function prepareUploader(sinkUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-history-'));
  const modulePath = path.join(dir, 'dsh-langfuse-voluntary.mjs');
  fs.copyFileSync(UPLOADER_PATH, modulePath);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    baseUrl: sinkUrl,
    publicKey: 'pk-lf-offline-test',
    secretKey: 'sk-lf-offline-test',
    userId: 'j00000000',
    maxChars: 20000,
  }, null, 2), 'utf8');
  return dir;
}

/** Load the module and run its apply() with a minimal fake Cordis context. */
function bootPlugin(modulePath) {
  const state = { events: new Map(), command: null, cleanup: null };
  const ctx = {
    on(name, callback) { state.events.set(name, callback); },
    commands: {
      register(definition) {
        state.command = definition;
        return () => {};
      },
    },
    effect(generator) {
      const iterator = generator();
      if (iterator && typeof iterator.next === 'function') {
        let step = iterator.next();
        while (!step.done) step = iterator.next();
      }
    },
  };
  return import(`${pathToFileURL(modulePath).href}?offline=${Date.now()}`).then(module => {
    module.apply(ctx);
    state.controller = globalThis[Symbol.for('dsh.langfuse.voluntary')].controller;
    return state;
  });
}

/** Build one session event. */
function makeEvent(seq, type, data, baseTime) {
  return { seq, type, time: new Date(baseTime + seq * 1000).toISOString(), data };
}

/** Build the two completed turns that exist before enabling history mode. */
function buildHistory() {
  const baseTime = Date.now() - 120000;
  const events = [];
  let seq = 0;
  const addTurn = (turn, question, answer) => {
    events.push(makeEvent(seq++, 'turn/start', { turn }, baseTime));
    events.push(makeEvent(seq++, 'user/message', {
      turn,
      source: { kind: 'user' },
      message: { role: 'user', content: [{ type: 'text', text: question }] },
    }, baseTime));
    events.push(makeEvent(seq++, 'assistant/message', {
      turn,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }, baseTime));
    events.push(makeEvent(seq++, 'turn/end', { turn, reason: 'completed' }, baseTime));
  };
  addTurn(1, '历史问题一', '历史回答一');
  addTurn(2, '历史问题二', '历史回答二');
  return { events, seq, baseTime };
}

/** Extract the root span (first span) of one OTLP payload. */
function rootSpan(payload) {
  return payload.resourceSpans[0].scopeSpans[0].spans[0];
}

/** Read one attribute value from a span. */
function spanAttribute(span, key) {
  const match = (span.attributes || []).find(item => item.key === key);
  if (!match) return undefined;
  const value = match.value || {};
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  return undefined;
}

/** Decode the `{"role","content"}` JSON stored in observation input/output. */
function observation(span, key) {
  const raw = spanAttribute(span, key);
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

test('uploader: /lf on --history stages older turns and flushes them on the next turn', uploaderTest, async () => {
  const sink = await startSink();
  const dir = prepareUploader(sink.url);
  try {
    const plugin = await bootPlugin(path.join(dir, 'dsh-langfuse-voluntary.mjs'));
    const { events, seq, baseTime } = buildHistory();
    const session = {
      id: 'session-offline-history-test',
      seq,
      header: { config: { model: 'offline-model' } },
      snapshotEvents(from, toExclusive) {
        return events.slice(from, toExclusive);
      },
    };
    const onResponse = plugin.command.handler({ rawInput: 'on --history', agent: { session } });
    assert.equal(onResponse.kind, 'success');
    assert.match(onResponse.text, /2 个历史轮次/, 'the command reports how many turns will be backfilled');
    assert.equal(sink.requests.length, 0, 'enabling alone sends nothing');

    let liveSeq = seq;
    const emit = (type, data) => {
      const event = { seq: liveSeq++, time: new Date(baseTime + 100000).toISOString(), type, data };
      plugin.events.get('session/event')(session, event);
    };
    emit('turn/start', { turn: 3 });
    emit('user/message', {
      turn: 3,
      source: { kind: 'user' },
      message: { role: 'user', content: [{ type: 'text', text: '第三问' }] },
    });
    emit('assistant/message', {
      turn: 3,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: '第三答' }] },
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    });
    emit('turn/end', { turn: 3, reason: 'completed' });
    await plugin.controller.drain();
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(sink.requests.length, 3, 'two history turns and the new turn are uploaded exactly once');
    const turns = sink.requests.map(payload => {
      const span = rootSpan(payload);
      const metadata = spanAttribute(span, 'langfuse.trace.metadata.turn_number');
      return {
        turn: JSON.parse(metadata),
        input: observation(span, 'langfuse.observation.input')?.content,
        output: observation(span, 'langfuse.observation.output')?.content,
      };
    }).sort((left, right) => left.turn - right.turn);
    assert.deepEqual(turns.map(item => item.turn), [1, 2, 3]);
    assert.equal(turns[0].input, '历史问题一');
    assert.equal(turns[0].output, '历史回答一');
    assert.equal(turns[1].input, '历史问题二');
    assert.equal(turns[1].output, '历史回答二');
    assert.equal(turns[2].input, '第三问');
    assert.equal(turns[2].output, '第三答');

    const audit = fs.readFileSync(path.join(dir, 'control-events.jsonl'), 'utf8');
    assert.match(audit, /"event":"history-staged".*"turns":2/);
    assert.equal((audit.match(/"event":"sent"/g) || []).length, 3);
    plugin.controller.dispose();
    delete globalThis[Symbol.for('dsh.langfuse.voluntary')];
  } finally {
    await sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uploader: /lf on without --history still uploads only new turns', uploaderTest, async () => {
  const sink = await startSink();
  const dir = prepareUploader(sink.url);
  try {
    const plugin = await bootPlugin(path.join(dir, 'dsh-langfuse-voluntary.mjs'));
    const { events, seq, baseTime } = buildHistory();
    const session = {
      id: 'session-offline-no-history',
      seq,
      header: { config: { model: 'offline-model' } },
      snapshotEvents(from, toExclusive) {
        return events.slice(from, toExclusive);
      },
    };
    const response = plugin.command.handler({ rawInput: 'on', agent: { session } });
    assert.equal(response.kind, 'success');
    assert.doesNotMatch(response.text, /历史轮次/);

    let liveSeq = seq;
    const emit = (type, data) => {
      const event = { seq: liveSeq++, time: new Date(baseTime + 100000).toISOString(), type, data };
      plugin.events.get('session/event')(session, event);
    };
    emit('turn/start', { turn: 3 });
    emit('user/message', {
      turn: 3,
      source: { kind: 'user' },
      message: { role: 'user', content: [{ type: 'text', text: '只看新轮次' }] },
    });
    emit('assistant/message', {
      turn: 3,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: '新轮次回答' }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    emit('turn/end', { turn: 3, reason: 'completed' });
    await plugin.controller.drain();
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(sink.requests.length, 1);
    const span = rootSpan(sink.requests[0]);
    assert.equal(JSON.parse(spanAttribute(span, 'langfuse.trace.metadata.turn_number')), 3);
    assert.equal(observation(span, 'langfuse.observation.input')?.content, '只看新轮次');

    const audit = fs.readFileSync(path.join(dir, 'control-events.jsonl'), 'utf8');
    assert.doesNotMatch(audit, /history-staged/);
    assert.equal((audit.match(/"event":"sent"/g) || []).length, 1);
    plugin.controller.dispose();
    delete globalThis[Symbol.for('dsh.langfuse.voluntary')];
  } finally {
    await sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uploader: unknown flag is rejected without changing state', uploaderTest, async () => {
  const sink = await startSink();
  const dir = prepareUploader(sink.url);
  try {
    const plugin = await bootPlugin(path.join(dir, 'dsh-langfuse-voluntary.mjs'));
    const { events, seq } = buildHistory();
    const session = { id: 'session-offline-flags', seq, snapshotEvents: (from, to) => events.slice(from, to) };
    const response = plugin.command.handler({ rawInput: 'on --bogus', agent: { session } });
    assert.equal(response.kind, 'error');
    assert.match(response.text, /--history/);
    const state = plugin.controller.diagnostics().sessions.find(item => item.id === session.id);
    assert.equal(state, undefined, 'no session state was enabled');
    assert.equal(sink.requests.length, 0);
    plugin.controller.dispose();
    delete globalThis[Symbol.for('dsh.langfuse.voluntary')];
  } finally {
    await sink.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
