/**
 * Host bridge tests.
 *
 * The first half exercises the pure bridge contract with fake uploaders. The
 * second half imports the *installed* voluntary uploader (read-only) and drives
 * a real `VoluntaryCollector` through the bridge, proving that the bridge uses
 * the uploader's own consent state machine and that only turns starting after
 * the switch are uploaded (no transcript scan, no backlog resend).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UPLOADER_SYMBOL,
  apply,
  createBridge,
  locateUploader,
  readState,
  ROUTE_SET,
  ROUTE_STATE,
  ROUTE_SCAN,
  ROUTE_MIGRATE,
} from '../index.js';

const UPLOADER_PATH = process.env.DSH_LANGFUSE_UPLOADER
  || path.join(os.homedir(), '.dsh', 'langfuse-voluntary', 'dsh-langfuse-voluntary-1.0.1.mjs');

/** Build a session object shaped like the Host Session used by the uploader. */
function session(id, seq = 10) {
  return { id, seq, header: { id }, events: [] };
}

/** A fake uploader controller with scripted command results. */
function fakeController({ sessions = [], ready = true, command = () => ({ kind: 'success', text: 'ok' }) } = {}) {
  return {
    calls: [],
    command(invocation) {
      this.calls.push(invocation);
      return command(invocation);
    },
    diagnostics() {
      return { version: '9.9.9', defaultUpload: false, ready, sessions };
    },
  };
}

test('locateUploader fails closed without the uploader diagnostic', () => {
  assert.equal(locateUploader({}), null);
  assert.equal(locateUploader({ [UPLOADER_SYMBOL]: undefined }), null);
  assert.equal(locateUploader({ [UPLOADER_SYMBOL]: { controller: {} } }), null);
  assert.equal(locateUploader({ [UPLOADER_SYMBOL]: { controller: { command() {}, diagnostics() {} } } }).diagnostics instanceof Function, true);
});

test('readState reports untracked sessions as off and ready uploaders truthfully', () => {
  const controller = fakeController({
    ready: true,
    sessions: [{
      id: 's1',
      enabled: true,
      fromSeq: 7,
      sent: 3,
      failed: 1,
      last: { at: '2026-01-01T00:00:00.000Z', ok: false, error: 'receiver_timeout', traceId: 'secret-trace' },
    }],
  });
  const tracked = readState(controller, 's1');
  assert.equal(tracked.enabled, true);
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.sent, 3);
  assert.equal(tracked.failed, 1);
  assert.equal(tracked.last.error, 'receiver_timeout');
  assert.equal('traceId' in tracked.last, false, 'internal trace ids are not forwarded to the browser');
  const untracked = readState(controller, 's2');
  assert.equal(untracked.enabled, false);
  assert.equal(untracked.tracked, false);
  assert.equal(untracked.uploader.ready, true);
});

test('state fails closed for missing uploader, bad ids, and unknown sessions', () => {
  const bridge = createBridge({ locate: () => null, lookupSession: () => undefined });
  assert.equal(bridge.state('s1').error.code, 'uploader_unavailable');

  const controller = fakeController();
  const sessions = new Map([['s1', session('s1')]]);
  const live = createBridge({ locate: () => controller, lookupSession: id => sessions.get(id) });
  assert.equal(live.state(123).error.code, 'bad_request');
  assert.equal(live.state('').error.code, 'bad_request');
  assert.equal(live.state('x'.repeat(201)).error.code, 'bad_request');
  assert.equal(live.state('missing').error.code, 'session_not_found');
  const result = live.state('s1');
  assert.equal(result.ok, true);
  assert.equal(result.value.enabled, false);
  assert.equal(controller.calls.length, 0, 'a query never issues a control command');
});

test('set validates the decision, forwards on/off intent, and confirms the readback', () => {
  const controller = fakeController({
    command: () => ({ kind: 'error', text: 'refused by test' }),
  });
  const sessions = new Map([['s1', session('s1')]]);
  const bridge = createBridge({ locate: () => controller, lookupSession: id => sessions.get(id) });
  assert.equal(bridge.set('s1', 'on').error.code, 'bad_request');
  assert.equal(bridge.set('missing', true).error.code, 'session_not_found');
  const refused = bridge.set('s1', true);
  assert.equal(refused.error.code, 'uploader_refused');
  assert.match(refused.error.message, /refused by test/);

  // A command that "succeeds" but leaves the state unchanged must not be
  // reported as success.
  const lying = fakeController({
    command: () => ({ kind: 'success', text: 'ok' }),
    sessions: [],
  });
  const lyingBridge = createBridge({ locate: () => lying, lookupSession: id => sessions.get(id) });
  const mismatch = lyingBridge.set('s1', true);
  assert.equal(mismatch.error.code, 'state_not_confirmed');

  // The confirmed path flips the uploaded state snapshot.
  const stateful = fakeController();
  let enabled = false;
  stateful.command = function command(invocation) {
    this.calls.push(invocation);
    enabled = invocation.rawInput === 'on';
    return { kind: 'success', text: 'ok' };
  };
  stateful.diagnostics = () => ({
    version: '9.9.9',
    defaultUpload: false,
    ready: true,
    sessions: [{ id: 's1', enabled, sent: 0, failed: 0, last: null }],
  });
  const okBridge = createBridge({ locate: () => stateful, lookupSession: id => sessions.get(id) });
  const on = okBridge.set('s1', true);
  assert.equal(on.ok, true);
  assert.equal(on.value.enabled, true);
  assert.equal(stateful.calls[0].rawInput, 'on');
  assert.equal(stateful.calls[0].agent.session, sessions.get('s1'), 'the uploader receives the exact live Session object');
  const off = okBridge.set('s1', false);
  assert.equal(off.ok, true);
  assert.equal(off.value.enabled, false);
});

test('handle rejects unknown endpoints and malformed payloads', () => {
  const bridge = createBridge({ locate: () => fakeController(), lookupSession: id => (id === 's1' ? session('s1') : undefined) });
  assert.equal(bridge.handle('nope', {}).error.code, 'not_found');
  assert.equal(bridge.handle('set', null).error.code, 'bad_request');
  assert.equal(bridge.handle('set', { sessionId: 's1' }).error.code, 'bad_request');
  assert.equal(bridge.handle('state', 'oops').error.code, 'bad_request');
});

test('Host plugin registers four authenticated /api routes and removes them on unload', async () => {
  const controller = fakeController({ command: () => ({ kind: 'error', text: 'refused by test' }) });
  globalThis[UPLOADER_SYMBOL] = { controller, version: '9.9.9' };
  try {
    const sessions = new Map([['s1', session('s1')]]);
    const routes = [];
    const effects = [];
    const hooks = [{ id: 'include:dsh-langfuse-voluntary-1-0-1', options: { name: 'file:///tmp/dsh-langfuse-voluntary-1.0.1.mjs' }, fiber: {}, disabled: false }];
    const ctx = {
      get(name) {
        if (name === 'sessions') return { get: id => sessions.get(id) };
        if (name === 'loader') return { entries: () => hooks };
        return undefined;
      },
      inject(deps, callback) {
        assert.deepEqual(deps, ['connection']);
        callback({
          connection: {
            fetch: {
              register(route) {
                routes.push(route);
                return () => Promise.resolve();
              },
            },
          },
          effect(execute, label) {
            effects.push({ label, cleanup: execute() });
            return () => {};
          },
        });
      },
    };
    apply(ctx);
    assert.deepEqual(routes.map(route => route.path), [ROUTE_STATE, ROUTE_SET, ROUTE_SCAN, ROUTE_MIGRATE]);
    assert.ok(ROUTE_STATE.startsWith('/api/'));
    assert.ok(ROUTE_SCAN.startsWith('/api/'));
    for (const route of routes) {
      assert.deepEqual(route.methods, ['POST']);
      assert.equal(route.requestBody, 'buffered');
    }
    assert.equal(effects.length, 4, 'every route is tied to the plugin fiber');

    const request = new Request(`http://127.0.0.1${ROUTE_STATE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    });
    const response = await routes[0].fetch(request);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.value.enabled, false);

    const setRequest = new Request(`http://127.0.0.1${ROUTE_SET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', enabled: true }),
    });
    const setResponse = await routes[1].fetch(setRequest);
    const setBody = await setResponse.json();
    assert.equal(setBody.error.code, 'uploader_refused');

    const badRequest = new Request(`http://127.0.0.1${ROUTE_SET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const badBody = await (await routes[1].fetch(badRequest)).json();
    assert.equal(badBody.error.code, 'bad_request');

    // Scan never mutates anything and reports the voluntary hook + switch.
    const scanResponse = await routes[2].fetch(new Request(`http://127.0.0.1${ROUTE_SCAN}`, { method: 'POST' }));
    const scanBody = await scanResponse.json();
    assert.equal(scanBody.voluntary.runtime, true, 'the running uploader is detected');
    assert.equal(scanBody.voluntary.version, '9.9.9');
    assert.equal(scanBody.hooks.some(hook => hook.kind === 'voluntary' && hook.entryId.includes('dsh-langfuse-voluntary')), true);
    assert.equal(scanBody.switch.controllable, true);
    assert.equal(scanBody.migration.available, false, 'nothing to migrate when the voluntary uploader runs');

    // Migration requires an explicit confirmation and cannot be triggered by a scan.
    const migrateResponse = await routes[3].fetch(new Request(`http://127.0.0.1${ROUTE_MIGRATE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    const migrateBody = await migrateResponse.json();
    assert.equal(migrateBody.ok, false);
    assert.equal(migrateBody.error.code, 'confirmation_required');
  } finally {
    delete globalThis[UPLOADER_SYMBOL];
  }
});

// ---------------------------------------------------------------------------
// Real uploader integration (read-only import of the installed 1.0.1 module)
// ---------------------------------------------------------------------------

const uploaderAvailable = fs.existsSync(UPLOADER_PATH);
const uploaderTest = { skip: uploaderAvailable ? false : `installed uploader not found at ${UPLOADER_PATH}` };

/** Fake transport recording every OTLP payload instead of posting it. */
function recordingTransport() {
  const calls = [];
  return {
    calls,
    transport: async (_config, payload, signal) => {
      if (signal?.aborted) throw new Error('cancelled');
      calls.push(payload);
      return { status: 200 };
    },
  };
}

/** Build one event for the real collector. */
function event(type, seq, turn, data = {}) {
  return { type, seq, time: new Date().toISOString(), data: { turn, ...data } };
}

test('real uploader: bridge drives its consent state and only uploads later turns', uploaderTest, async () => {
  const module = await import(pathToFileURL(UPLOADER_PATH).href);
  assert.equal(typeof module.VoluntaryCollector, 'function');
  assert.equal(module.VERSION, '1.0.1');

  const recorder = recordingTransport();
  const collector = new module.VoluntaryCollector({
    // Fake transport means the fake keys are never used for network access.
    config: { baseUrl: 'http://127.0.0.1:1', publicKey: 'pk-verified-placeholder', secretKey: 'sk-verified-placeholder', userId: 'j00000000', maxChars: 20000 },
    transport: recorder.transport,
  });
  const sessions = new Map();
  const a = session('session-a', 5);
  const b = session('session-b', 5);
  sessions.set(a.id, a);
  sessions.set(b.id, b);
  const bridge = createBridge({ locate: () => collector, lookupSession: id => sessions.get(id) });

  // Default: off, and no command has ever been issued for this session.
  const initial = bridge.state('session-a');
  assert.equal(initial.ok, true);
  assert.equal(initial.value.enabled, false);

  // A turn already in progress when consent is granted must not be uploaded.
  collector.handle(a, event('turn/start', 4, 1));
  collector.handle(a, event('user/message', 4, 1, { message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }] }, source: { kind: 'user' } }));

  const on = bridge.set('session-a', true);
  assert.equal(on.ok, true);
  assert.equal(on.value.enabled, true);
  assert.equal(on.value.tracked, true);

  // Store isolation: B stays off while A is on.
  assert.equal(bridge.state('session-b').value.enabled, false);

  // Tail of the in-progress turn: no buffer was created before enabling.
  collector.handle(a, event('assistant/message', 10, 1, {
    step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }, usage: { inputTokens: 1, outputTokens: 1 },
  }));
  collector.handle(a, event('turn/end', 11, 1, { reason: 'completed' }));
  await collector.drain();
  assert.equal(recorder.calls.length, 0, 'an in-progress turn never uploads');

  // New turn after enabling: uploaded exactly once through the existing transport.
  collector.handle(a, event('turn/start', 12, 2));
  collector.handle(a, event('user/message', 13, 2, { message: { role: 'user', content: [{ type: 'text', text: 'new prompt' }] }, source: { kind: 'user' } }));
  collector.handle(a, event('assistant/message', 14, 2, {
    step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] }, usage: { inputTokens: 10, outputTokens: 5 },
  }));
  collector.handle(a, event('tool/call', 15, 2, { callId: 'c1', name: 'read', arguments: { path: 'x' } }));
  collector.handle(a, event('tool/result', 16, 2, { callId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } }));
  collector.handle(a, event('turn/end', 17, 2, { reason: 'completed' }));
  await collector.drain();
  assert.equal(recorder.calls.length, 1, 'the new turn is uploaded');
  const spans = recorder.calls[0].resourceSpans[0].scopeSpans[0].spans;
  assert.ok(spans.length >= 3, 'root + generation + tool spans are exported');
  const serialized = JSON.stringify(recorder.calls[0]);
  assert.match(serialized, /new prompt/);
  assert.match(serialized, /new answer/);
  assert.doesNotMatch(serialized, /old prompt/, 'pre-consent content is never scanned or sent');

  // Idempotent re-enable keeps one state row and the same fromSeq semantics.
  const again = bridge.set('session-a', true);
  assert.equal(again.ok, true);
  assert.equal(again.value.enabled, true);

  // Turning off clears consent; later turns stop uploading.
  const off = bridge.set('session-a', false);
  assert.equal(off.ok, true);
  assert.equal(off.value.enabled, false);
  collector.handle(a, event('turn/start', 20, 3));
  collector.handle(a, event('assistant/message', 21, 3, {
    step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'after off' }] }, usage: { inputTokens: 1, outputTokens: 1 },
  }));
  collector.handle(a, event('turn/end', 22, 3, { reason: 'completed' }));
  await collector.drain();
  assert.equal(recorder.calls.length, 1, 'no upload after disabling');

  // `/lf off-all` continues to control the same state the header reads.
  assert.equal(bridge.set('session-a', true).ok, true);
  assert.equal(bridge.set('session-b', true).ok, true);
  const offAll = collector.command({ rawInput: 'off-all', agent: { session: a } });
  assert.equal(offAll.kind, 'success');
  assert.equal(bridge.state('session-a').value.enabled, false);
  assert.equal(bridge.state('session-b').value.enabled, false);

  // A session without a valid log position cannot be enabled (fail closed).
  const bad = { id: 'session-bad', seq: undefined, header: {} };
  sessions.set(bad.id, bad);
  const refused = bridge.set(bad.id, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'uploader_refused');

  collector.dispose();
});

test('real uploader: reloaded uploader instance is picked up per request', uploaderTest, async () => {
  const module = await import(pathToFileURL(UPLOADER_PATH).href);
  const recorder = recordingTransport();
  const config = { baseUrl: 'http://127.0.0.1:1', publicKey: 'pk-verified-placeholder', secretKey: 'sk-verified-placeholder', userId: 'j00000000', maxChars: 20000 };
  const first = new module.VoluntaryCollector({ config, transport: recorder.transport });
  const second = new module.VoluntaryCollector({ config, transport: recorder.transport });
  let current = first;
  const sessions = new Map([['s1', session('s1', 5)]]);
  const bridge = createBridge({ locate: () => current, lookupSession: id => sessions.get(id) });
  assert.equal(bridge.set('s1', true).ok, true);

  // Simulate the uploader plugin reloading: a new controller starts with no
  // consent, so the header must read it as off again.
  current = second;
  const afterReload = bridge.state('s1');
  assert.equal(afterReload.ok, true);
  assert.equal(afterReload.value.enabled, false);
  first.dispose();
  second.dispose();
});
