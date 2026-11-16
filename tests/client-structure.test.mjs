/**
 * Split-control structure / behavior tests.
 *
 * The installed page cannot be rendered headlessly (no DOM/React in Node), so
 * this test loads the browser bundle with a minimal React stand-in and a
 * one-shot render. It locks the interaction the user asked for:
 *
 * - the LEFT label is a details trigger and never calls the Host mutation;
 * - the RIGHT switch is the only target that can change consent;
 * - the right switch exposes switch semantics only for a Host-confirmed state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: spec => { loaded.push(spec); } } };
await import(new URL('../client.js', import.meta.url).href);

const spec = loaded[0];

/** Minimal React stand-in: one render, no re-render, effects not executed. */
function createFakeReact() {
  const Fragment = Symbol('Fragment');
  return {
    Fragment,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) };
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useRef(initial) {
      return { current: initial };
    },
    useId() {
      return 'lfh-test-id';
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
  };
}

const fakeReact = createFakeReact();
const plugin = spec.factory(name => {
  if (name === 'react') return fakeReact;
  if (name === 'react-dom') return { createPortal: element => element };
  throw new Error(`unexpected require ${name}`);
});

const DICT = {
  'label.title': '本会话上传',
  'label.titleShort': '上传',
  'state.on': '开',
  'state.off': '关',
  'state.loading': '查询中',
  'state.saving': '处理中',
  'state.unknown': '状态未知',
  'details.aria': '查看本会话上传说明（不会切换开关）',
  'label.on': '本会话上传：开',
  'label.off': '本会话上传：关',
  'label.loading': '本会话上传：查询中',
  'label.saving': '本会话上传：处理中',
  'label.unknown': '本会话上传：状态未知',
  'aria.switch': '本会话上传到团队 Langfuse',
  'aria.unknown': '本会话上传到团队 Langfuse，状态未知，按下重新查询',
  hint: '开启后会上传到团队 Langfuse；已上传内容无法撤回。',
  scope: '仅对当前会话生效。',
  receipt: '开表示已授权。',
  sendStats: '已确认 {sent} 轮；失败 {failed} 轮。',
  lastError: '最近一次发送未完成：{error}',
  retry: '点击按钮重新查询。',
  'error.generic': '操作失败。',
};

const t = (key, params) => {
  let text = DICT[key] ?? key;
  if (params && typeof params === 'object') {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
};

/** Flatten a rendered tree into an array of nodes. */
function flatten(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

function render(initialView, overrides = {}) {
  const calls = { setUpload: [], queryUpload: [], setTipPinnedSeen: 0 };
  const tree = plugin.__internals.UploadToggle({
    sessionId: 'session-split-test',
    t,
    queryUpload: async sessionId => {
      calls.queryUpload.push(sessionId);
      return { ok: true, value: { enabled: false, sent: 0, failed: 0, last: null } };
    },
    setUpload: async (sessionId, enabled) => {
      calls.setUpload.push({ sessionId, enabled });
      return { ok: true, value: { enabled, sent: 0, failed: 0, last: null } };
    },
    subscribeConnection: () => () => {},
    __initialView: initialView,
    ...overrides,
  });
  return { tree, calls, nodes: flatten(tree) };
}

test('control is split into a details label and a dedicated switch', () => {
  const { nodes } = render({ kind: 'ready', enabled: false, detail: { enabled: false, sent: 0, failed: 0, last: null } });
  const labels = nodes.filter(node => node.props?.className === 'lfh-label');
  const switches = nodes.filter(node => node.props?.className === 'lfh-switch');
  assert.equal(labels.length, 1, 'exactly one details label');
  assert.equal(switches.length, 1, 'exactly one switch');
  assert.notEqual(labels[0], switches[0], 'the two targets are separate elements');
  assert.equal(labels[0].props.role, undefined, 'the label is not switch-semantic');
  assert.equal(labels[0].props['aria-label'], DICT['details.aria']);
  assert.equal(switches[0].props.role, 'switch');
  assert.equal(switches[0].props['aria-checked'], 'false');
});

test('clicking the left label only opens details and never mutates consent', async () => {
  const { nodes, calls } = render({ kind: 'ready', enabled: false, detail: { enabled: false, sent: 0, failed: 0, last: null } });
  const label = nodes.find(node => node.props?.className === 'lfh-label');
  label.props.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.setUpload.length, 0, 'label click must not call /set');
  assert.equal(calls.queryUpload.length, 0, 'label click must not issue a query either');
  assert.equal(label.props['aria-expanded'], 'false');
});

test('clicking the right switch requests the opposite Host-confirmed state', async () => {
  const off = render({ kind: 'ready', enabled: false, detail: { enabled: false, sent: 0, failed: 0, last: null } });
  const offSwitch = off.nodes.find(node => node.props?.className === 'lfh-switch');
  offSwitch.props.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(off.calls.setUpload, [{ sessionId: 'session-split-test', enabled: true }]);

  const on = render({ kind: 'ready', enabled: true, detail: { enabled: true, sent: 1, failed: 0, last: null } });
  const onSwitch = on.nodes.find(node => node.props?.className === 'lfh-switch');
  assert.equal(onSwitch.props['aria-checked'], 'true');
  assert.ok(flatten(on.tree).some(node => node.props?.className === 'lfh-state' && node.children[0] === '开'));
  onSwitch.props.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(on.calls.setUpload, [{ sessionId: 'session-split-test', enabled: false }]);
});

test('unknown state never exposes switch semantics and the switch only re-queries', async () => {
  const { nodes, calls } = render({ kind: 'unknown', enabled: false, detail: { error: { code: 'transport', message: '' } } });
  const sw = nodes.find(node => node.props?.className === 'lfh-switch');
  assert.equal(sw.props.role, 'button', 'unknown state is not announced as an unchecked switch');
  assert.equal(sw.props['aria-checked'], undefined);
  assert.match(sw.props['aria-label'], /状态未知/);
  sw.props.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.setUpload.length, 0, 'an unknown state click must never grant consent');
  assert.equal(calls.queryUpload.length, 1, 'it retries the query instead');
});
