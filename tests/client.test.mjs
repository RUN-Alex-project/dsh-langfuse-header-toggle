/**
 * Client half tests.
 *
 * The browser bundle cannot render without the host page, so these tests load
 * the bundle factory with a stand-in `window.__ModuleLoader__` and verify the
 * pieces that decide correctness: the session-scoped registration wiring, the
 * locale dictionaries, and the pure stale-answer guard / result normalization
 * that the component actually uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded.push(spec);
    },
  },
};

const clientUrl = new URL('../client.js', import.meta.url);
await import(clientUrl.href);

const spec = loaded[0];

/** Stand-in for the browser module table: the factory only stores these. */
function fakeRequire(name) {
  if (name === 'react') return { createElement: () => null };
  if (name === 'react-dom') return { createPortal: () => null };
  throw new Error(`unexpected require ${name}`);
}

const plugin = spec.factory(fakeRequire);
const internals = plugin.__internals;

test('bundle registers one lazy factory under the package name', () => {
  assert.equal(loaded.length, 1);
  assert.equal(spec.id, '@local/dsh-langfuse-header-toggle');
  assert.equal(fileURLToPath(clientUrl).endsWith('client.js'), true);
  assert.deepEqual(plugin.inject, ['slots', 'connection', 'locale']);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply registers the header cell and both locale dictionaries', async () => {
  const calls = { locale: [], slotKeys: [], registrations: [], effects: [], generationListeners: 0, fetches: [] };
  let injected;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (route, init) => {
    calls.fetches.push({ route, init });
    return new Response(JSON.stringify({ ok: true, value: { enabled: false } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const ctx = {
    effect(execute, label) {
      const result = execute();
      calls.effects.push({ label, result });
      return () => {};
    },
    locale: {
      register(ns, dictionaries) {
        calls.locale.push({ ns, dictionaries });
        return () => {};
      },
    },
    connection: {
      generation: {
        subscribe(listener) {
          calls.generationListeners += 1;
          calls.fireGeneration = listener;
          return () => {};
        },
      },
    },
    slots: {
      inject(key, callback) {
        calls.slotKeys.push(key);
        calls.registrationDispose = callback();
      },
      register(options, component) {
        calls.registrations.push({ options, component });
        return () => {};
      },
    },
  };

  try {
    plugin.apply(ctx);

    assert.deepEqual(calls.slotKeys, ['conversation.session.header.actions']);
    assert.equal(calls.registrations.length, 1);
    const registration = calls.registrations[0].options;
    assert.equal(registration.name, 'conversation.session.header.actions');
    assert.equal(registration.id, 'langfuse-upload');
    assert.equal(registration.order, 0);
    assert.equal(registration.locale, 'langfuseUpload');
    assert.equal(typeof calls.registrations[0].component, 'function');

    const dictionaries = calls.locale[0].dictionaries;
    assert.ok(dictionaries.zh && dictionaries.en, 'both baseline locales are registered');
    assert.equal(dictionaries.zh['label.title'], '本会话上传');
    assert.equal(dictionaries.zh['state.on'], '开');
    assert.equal(dictionaries.zh['state.off'], '关');
    assert.equal(dictionaries.zh['state.unknown'], '状态未知');
    assert.ok(dictionaries.zh['details.aria'].includes('不会切换'));
    assert.equal(dictionaries.zh['label.on'], '本会话上传：开');
    assert.equal(dictionaries.zh['label.off'], '本会话上传：关');
    assert.equal(dictionaries.zh['label.unknown'], '本会话上传：状态未知');
    assert.equal(dictionaries.zh['label.offShort'], '会话上传：关', 'the narrow label keeps the per-session qualifier');
    assert.ok(dictionaries.zh['aria.switch'].includes('Langfuse'));
    assert.ok(dictionaries.zh.hint.includes('已上传内容无法撤回'));
    assert.ok(dictionaries.zh.hint.includes('Langfuse'), 'the tooltip names the destination');
    assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());

    injected = registration.inject();
    assert.equal(typeof injected.queryUpload, 'function');
    assert.equal(typeof injected.setUpload, 'function');
    assert.equal(typeof injected.subscribeConnection, 'function');

    const answer = await injected.queryUpload('session-1');
    assert.equal(answer.ok, true);
    assert.equal(calls.fetches[0].route, 'api/dsh-langfuse-toggle/state');
    assert.equal(calls.fetches[0].init.method, 'POST');
    assert.equal(calls.fetches[0].init.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(calls.fetches[0].init.body), { sessionId: 'session-1' });

    await injected.setUpload('session-1', true);
    assert.equal(calls.fetches[1].route, 'api/dsh-langfuse-toggle/set');
    assert.deepEqual(JSON.parse(calls.fetches[1].init.body), { sessionId: 'session-1', enabled: true });

    // A new Connection generation must poke every mounted header.
    let poked = 0;
    const stop = injected.subscribeConnection(() => { poked += 1; });
    calls.fireGeneration();
    assert.equal(poked, 1);
    stop();
    calls.fireGeneration();
    assert.equal(poked, 1, 'unsubscribed listeners are removed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('answer gate drops answers for another session', () => {
  const gate = internals.createAnswerGate('A');
  const token = gate.beginQuery('A');
  assert.notEqual(token, 0);
  assert.equal(gate.acceptQuery('A', token), true);
  // A late answer for A must not paint B.
  gate.setSession('B');
  assert.equal(gate.session, 'B');
  assert.equal(gate.acceptQuery('A', token), false);
  const bToken = gate.beginQuery('B');
  assert.equal(gate.acceptQuery('B', bToken), true);
});

test('answer gate drops superseded queries and refuses stale mutations', () => {
  const gate = internals.createAnswerGate('A');
  const first = gate.beginQuery('A');
  const second = gate.beginQuery('A');
  assert.equal(gate.acceptQuery('A', first), false);
  assert.equal(gate.acceptQuery('A', second), true);

  const mutation = gate.beginMutation('A');
  assert.notEqual(mutation, 0);
  assert.equal(gate.acceptQuery('A', second), false, 'a query in flight cannot overwrite a mutation');
  assert.equal(gate.busy, true);
  assert.equal(gate.beginMutation('A'), 0, 'double activation is refused while one is in flight');
  assert.equal(gate.beginQuery('A'), 0);
  assert.equal(gate.acceptMutation('A', mutation), true);
  gate.endMutation('A', mutation);
  assert.equal(gate.busy, false);

  const after = gate.beginMutation('A');
  gate.setSession('B');
  assert.equal(gate.acceptMutation('A', after), false, 'a late mutation answer cannot paint another session');
});

test('answer gate dispose invalidates pending answers', () => {
  const gate = internals.createAnswerGate('A');
  const token = gate.beginQuery('A');
  gate.dispose();
  assert.equal(gate.acceptQuery('A', token), false);
});

test('normalizeResult never invents an off state', () => {
  assert.deepEqual(internals.normalizeResult({ ok: true, value: { enabled: true } }), {
    kind: 'ready', enabled: true, detail: { enabled: true },
  });
  const empty = internals.normalizeResult({ ok: true, value: {} });
  assert.equal(empty.kind, 'unknown');
  assert.equal(empty.enabled, false);
  const failed = internals.normalizeResult({ ok: false, error: { code: 'uploader_unavailable', message: 'x' } });
  assert.equal(failed.kind, 'unknown');
  assert.equal(failed.detail.error.code, 'uploader_unavailable');
  const thrown = internals.normalizeResult(undefined);
  assert.equal(thrown.kind, 'unknown');
  assert.equal(thrown.detail.error.code, 'transport');
});

test('postJson rejects unauthenticated and malformed answers instead of guessing', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    await assert.rejects(() => internals.postJson(internals.ROUTES.state, { sessionId: 's1' }), /unauthorized/);
    globalThis.fetch = async () => new Response('boom', { status: 500 });
    await assert.rejects(() => internals.postJson(internals.ROUTES.set, {}), /HTTP 500/);
    globalThis.fetch = async () => new Response('[]', { status: 200 });
    await assert.rejects(() => internals.postJson(internals.ROUTES.state, {}), /malformed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('errorText maps failure codes to localized copy', () => {
  const seen = [];
  const t = key => {
    seen.push(key);
    return key;
  };
  assert.equal(internals.errorText({ error: { code: 'uploader_unavailable' } }, t), 'error.uploader');
  assert.equal(internals.errorText({ error: { code: 'session_not_found' } }, t), 'error.session');
  assert.equal(internals.errorText({ error: { code: 'state_not_confirmed' } }, t), 'error.unconfirmed');
  assert.equal(internals.errorText({ error: { code: 'auth' } }, t), 'error.auth');
  assert.equal(internals.errorText({ error: { code: 'weird' } }, t), 'error.generic');
  assert.equal(internals.errorText(undefined, t), 'error.generic');
  assert.deepEqual(seen, ['error.uploader', 'error.session', 'error.unconfirmed', 'error.auth', 'error.generic', 'error.generic']);
  assert.equal(internals.ROUTES.state, 'api/dsh-langfuse-toggle/state');
  assert.equal(internals.ROUTES.set, 'api/dsh-langfuse-toggle/set');
});

test('failureDetail distinguishes authentication from transport', () => {
  assert.deepEqual(internals.failureDetail(new Error('unauthorized')), {
    error: { code: 'auth', message: 'unauthorized' },
  });
  assert.deepEqual(internals.failureDetail(new Error('HTTP 502')), {
    error: { code: 'transport', message: 'HTTP 502' },
  });
  assert.deepEqual(internals.failureDetail(undefined), {
    error: { code: 'transport', message: '' },
  });
});
