/**
 * Uploader consent-persistence tests (1.0.3+).
 *
 * The uploader remembers per-session consent in `session-consent.json` so a
 * DSH restart / uploader reload restores the switch state. These tests use a
 * throw-away copy of the installed uploader plus a local OTLP sink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UPLOADER_PATH = process.env.LANGFUSE_UPLOADER_PATH
  || path.join(os.homedir(), '.dsh', 'langfuse-voluntary', 'dsh-langfuse-voluntary-2.0.0.mjs');
const uploaderAvailable = fs.existsSync(UPLOADER_PATH);
const uploaderTest = { skip: uploaderAvailable ? false : `uploader not found at ${UPLOADER_PATH}` };

function startSink() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { requests.push({ malformed: true }); }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

function prepare(sinkUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-consent-'));
  const modulePath = path.join(dir, 'dsh-langfuse-voluntary.mjs');
  fs.copyFileSync(UPLOADER_PATH, modulePath);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    baseUrl: sinkUrl,
    publicKey: 'pk-lf-consent-test',
    secretKey: 'sk-lf-consent-test',
    userId: 'j00000000',
    maxChars: 20000,
  }, null, 2), 'utf8');
  return { dir, modulePath, consentPath: path.join(dir, 'session-consent.json') };
}

function boot(modulePath) {
  const state = { events: new Map(), command: null };
  const ctx = {
    on(name, callback) { state.events.set(name, callback); },
    commands: { register(definition) { state.command = definition; return () => {}; } },
    effect(generator) {
      const iterator = generator();
      if (iterator && typeof iterator.next === 'function') {
        let step = iterator.next();
        while (!step.done) step = iterator.next();
      }
    },
  };
  return import(`${pathToFileURL(modulePath).href}?persist=${Date.now()}-${Math.random()}`).then(module => {
    module.apply(ctx);
    state.module = module;
    state.controller = globalThis[Symbol.for('dsh.langfuse.voluntary')].controller;
    return state;
  });
}

function fakeSession(id) {
  return {
    id,
    seq: 10,
    header: { config: { model: 'offline-model' } },
    snapshotEvents: () => [],
  };
}

function emit(plugin, session, seq, type, turn, data = {}) {
  plugin.events.get('session/event')(session, { seq, time: new Date().toISOString(), type, data: { turn, ...data } });
}

function stop(plugin) {
  plugin.controller.dispose();
  delete globalThis[Symbol.for('dsh.langfuse.voluntary')];
}

test('consent survives a fresh uploader instance and restores on the next turn', uploaderTest, async () => {
  const sink = await startSink();
  const env = prepare(sink.url);
  try {
    const sessionId = 'session-consent-restart';
    const first = await boot(env.modulePath);
    const session = fakeSession(sessionId);
    const on = first.command.handler({ rawInput: 'on', agent: { session } });
    assert.equal(on.kind, 'success');
    const written = JSON.parse(fs.readFileSync(env.consentPath, 'utf8'));
    assert.deepEqual(written.sessions, [sessionId]);
    stop(first);

    // A new module instance simulates an uploader reload / DSH restart.
    const second = await boot(env.modulePath);
    try {
      const status = second.controller.diagnostics();
      const remembered = status.sessions.find(row => row.id === sessionId);
      assert.ok(remembered, 'remembered session is reported before any event');
      assert.equal(remembered.enabled, true);
      assert.equal(remembered.restorePending, true);

      const live = fakeSession(sessionId);
      live.seq = 20;
      emit(second, live, 20, 'turn/start', 1);
      emit(second, live, 21, 'user/message', 1, { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: '恢复后的新问题' }] } });
      emit(second, live, 22, 'assistant/message', 1, { step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '恢复后的新回答' }] } });
      emit(second, live, 23, 'turn/end', 1, { reason: 'completed' });
      await second.controller.drain();
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(sink.requests.length, 1, 'the restored session uploads its next turn');
      const audit = fs.readFileSync(path.join(env.dir, 'control-events.jsonl'), 'utf8');
      assert.match(audit, /"event":"restored"/);
      assert.match(audit, /"event":"sent"/);
      const off = second.command.handler({ rawInput: 'off', agent: { session: live } });
      assert.equal(off.kind, 'success');
      assert.deepEqual(JSON.parse(fs.readFileSync(env.consentPath, 'utf8')).sessions, []);
    } finally {
      stop(second);
    }
  } finally {
    await sink.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test('off-all clears the remembered consent file', uploaderTest, async () => {
  const sink = await startSink();
  const env = prepare(sink.url);
  try {
    const plugin = await boot(env.modulePath);
    const session = fakeSession('session-consent-offall');
    plugin.command.handler({ rawInput: 'on', agent: { session } });
    assert.deepEqual(JSON.parse(fs.readFileSync(env.consentPath, 'utf8')).sessions, ['session-consent-offall']);
    plugin.command.handler({ rawInput: 'off-all', agent: { session } });
    assert.deepEqual(JSON.parse(fs.readFileSync(env.consentPath, 'utf8')).sessions, []);
    stop(plugin);
  } finally {
    await sink.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});
