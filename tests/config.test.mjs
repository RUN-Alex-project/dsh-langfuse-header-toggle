/**
 * First-install connection config tests.
 *
 * These exercise the `/config` route body directly against a throw-away DSH
 * home: validation is reported per field, key material is never echoed, the
 * write is atomic, the managed install is idempotent and backed up, and no code
 * path ever calls the uploader's `command()` control surface. The real profile
 * under `~/.dsh` is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apply,
  configAction,
  installUploader,
  readConfigStatus,
  ROUTE_CONFIG,
  ROUTE_MIGRATE,
  UPLOADER_SYMBOL,
  VENDORED_UPLOADER_VERSION,
  MANAGED_BEGIN,
  VOLUNTARY_ROW_ID,
} from '../index.js';

/** A complete, valid save payload. */
const VALID_SAVE = Object.freeze({
  action: 'save',
  baseUrl: 'https://langfuse.example.com/',
  publicKey: 'pk-lf-1234567890abcd',
  secretKey: 'sk-lf-9876543210wxyz',
  userId: 'j60000000',
  maxChars: 5000,
});

/**
 * Create an isolated DSH home and point the plugin at it.
 * @returns {object} paths, a fake Host context, and an idempotent cleanup.
 */
function createHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toggle-config-'));
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE_DIR;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE_DIR = profileDir;
  const voluntaryDir = path.join(home, 'langfuse-voluntary');
  const environment = {
    home,
    profileDir,
    voluntaryDir,
    configPath: path.join(voluntaryDir, 'config.json'),
    profilePatch: path.join(profileDir, 'cordis.patch.yml'),
    ctx: { get: () => undefined },
    cleanup() {
      if (savedHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedHome;
      if (savedProfile === undefined) delete process.env.DSH_PROFILE_DIR;
      else process.env.DSH_PROFILE_DIR = savedProfile;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  return environment;
}

/** List leftover atomic-write temporary files. */
function temporaryFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
}

/** A fake uploader that records every control command it receives. */
function spyUploader() {
  const calls = [];
  const controller = {
    calls,
    command(invocation) {
      calls.push(invocation);
      return { kind: 'success', text: 'ok' };
    },
    diagnostics() {
      return { version: '9.9.9', defaultUpload: false, ready: true, sessions: [] };
    },
  };
  return controller;
}

test('get reports a missing config without inventing credentials', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const result = await configAction(env.ctx, { action: 'get' });
  assert.equal(result.ok, true);
  const status = result.value;
  assert.equal(status.path, env.configPath);
  assert.equal(status.exists, false);
  assert.equal(status.valid, false);
  assert.equal(status.ready, false);
  assert.equal(status.baseUrl, null);
  assert.equal(status.userId, null);
  assert.equal(status.maxChars, 20000, 'the default limit is reported before a file exists');
  assert.equal(status.publicKeySet, false);
  assert.equal(status.secretKeySet, false);
  assert.equal(status.publicKeyHint, null);
  assert.equal(status.defaultOff, true);
  assert.deepEqual(status.uploader, { installed: false, active: false, ready: false, version: null });

  assert.equal((await configAction(env.ctx, null)).error.code, 'bad_request');
  assert.equal((await configAction(env.ctx, {})).error.code, 'bad_request');
  assert.equal((await configAction(env.ctx, { action: 'open' })).error.code, 'bad_request');
});

test('save rejects every invalid field with a field-scoped code and no key echo', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const cases = [
    { field: 'baseUrl', patch: { baseUrl: '' }, reason: 'missing' },
    { field: 'baseUrl', patch: { baseUrl: 'not a url' }, reason: 'unparsable' },
    { field: 'baseUrl', patch: { baseUrl: 'ftp://langfuse.example.com/' }, reason: 'not_http' },
    { field: 'baseUrl', patch: { baseUrl: 'https://user:secret@langfuse.example.com/' }, reason: 'has_credentials' },
    { field: 'baseUrl', patch: { baseUrl: 'https://langfuse.example.com/api' }, reason: 'not_origin' },
    { field: 'publicKey', patch: { publicKey: 'sk-lf-wrong-prefix' }, reason: 'prefix' },
    { field: 'publicKey', patch: { publicKey: '' }, reason: 'missing' },
    { field: 'secretKey', patch: { secretKey: 'pk-lf-wrong-prefix' }, reason: 'prefix' },
    { field: 'secretKey', patch: { secretKey: '' }, reason: 'missing' },
    { field: 'userId', patch: { userId: 'admin' }, reason: 'pattern' },
    { field: 'userId', patch: { userId: '' }, reason: 'missing' },
    { field: 'maxChars', patch: { maxChars: 'abc' }, reason: 'not_number' },
    { field: 'maxChars', patch: { maxChars: 0 }, reason: 'out_of_range' },
  ];
  for (const item of cases) {
    const result = await configAction(env.ctx, { ...VALID_SAVE, ...item.patch });
    assert.equal(result.ok, false, `${item.field}/${item.reason} must be rejected`);
    assert.equal(result.error.code, 'invalid_config');
    assert.equal(result.error.details.field, item.field);
    assert.equal(result.error.details.reason, item.reason);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('9876543210wxyz'), false, 'the failure never echoes the secret');
    assert.equal(serialized.includes('1234567890abcd'), false, 'the failure never echoes the public key');
  }
  assert.equal(fs.existsSync(env.configPath), false, 'rejected saves never create the file');
});

test('save writes only the uploader fields atomically and reports redacted status', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const result = await configAction(env.ctx, {
    ...VALID_SAVE,
    baseUrl: 'https://langfuse.example.com/?ignored=1',
    extra: 'must be dropped',
  });
  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.defaultOff, true);
  assert.equal(result.value.valid, true);
  assert.equal(result.value.ready, false);
  assert.equal(result.value.defaultOff, true);

  const written = JSON.parse(fs.readFileSync(env.configPath, 'utf8'));
  assert.deepEqual(written, {
    baseUrl: 'https://langfuse.example.com',
    publicKey: VALID_SAVE.publicKey,
    secretKey: VALID_SAVE.secretKey,
    userId: VALID_SAVE.userId,
    maxChars: VALID_SAVE.maxChars,
  }, 'the file keeps only the five uploader fields and normalizes the origin');
  assert.equal(fs.readFileSync(env.configPath, 'utf8').endsWith('\n'), true);
  assert.deepEqual(temporaryFiles(env.voluntaryDir), [], 'the temporary file was renamed away');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(env.configPath).mode & 0o777, 0o600);
  }

  const status = (await configAction(env.ctx, { action: 'get' })).value;
  assert.equal(status.valid, true);
  assert.equal(status.publicKeySet, true);
  assert.equal(status.secretKeySet, true);
  assert.equal(status.publicKeyHint, 'pk-lf-…abcd');
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('1234567890abcd'), false, 'the full public key never reaches the browser');
  assert.equal(serialized.includes('9876543210wxyz'), false, 'the secret key never reaches the browser');
});

test('save keeps stored keys when the key inputs are blank and clamps maxChars', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  assert.equal((await configAction(env.ctx, VALID_SAVE)).ok, true);

  const updated = await configAction(env.ctx, {
    action: 'save',
    baseUrl: VALID_SAVE.baseUrl,
    userId: 'j60000001',
    maxChars: '25000',
  });
  assert.equal(updated.ok, true);
  const written = JSON.parse(fs.readFileSync(env.configPath, 'utf8'));
  assert.equal(written.baseUrl, 'https://langfuse.example.com');
  assert.equal(written.userId, 'j60000001');
  assert.equal(written.publicKey, VALID_SAVE.publicKey, 'a blank public key keeps the stored value');
  assert.equal(written.secretKey, VALID_SAVE.secretKey, 'a blank secret key keeps the stored value');
  assert.equal(written.maxChars, 20000, 'the uploader cap is applied');
  assert.equal(updated.value.maxChars, 20000);
});

test('save refuses to inherit stored keys onto a different origin', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  assert.equal((await configAction(env.ctx, VALID_SAVE)).ok, true);

  const rejected = await configAction(env.ctx, {
    action: 'save',
    baseUrl: 'https://langfuse-2.example.com',
    userId: 'j60000001',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'invalid_config');
  assert.equal(rejected.error.details.field, 'secretKey');
  assert.equal(rejected.error.details.reason, 'required_for_new_host');
  assert.equal(
    JSON.parse(fs.readFileSync(env.configPath, 'utf8')).baseUrl,
    'https://langfuse.example.com',
    'the refused save leaves the stored origin untouched',
  );

  const accepted = await configAction(env.ctx, {
    action: 'save',
    baseUrl: 'https://langfuse-2.example.com',
    publicKey: VALID_SAVE.publicKey,
    secretKey: VALID_SAVE.secretKey,
    userId: 'j60000001',
  });
  assert.equal(accepted.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(env.configPath, 'utf8')).baseUrl, 'https://langfuse-2.example.com');
});

test('save failure cleans the temporary file and reports write_failed', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  fs.mkdirSync(env.configPath, { recursive: true });
  const result = await configAction(env.ctx, VALID_SAVE);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'write_failed');
  assert.deepEqual(temporaryFiles(env.voluntaryDir), []);
});

test('install copies the vendored module, backs up the patch, and never calls command()', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const originalPatch = [
    '# desktop profile patch',
    '- insert:',
    '    - id: include:unrelated-plugin',
    '      name: "@deepseek-ai/dsh-unrelated"',
    '',
  ].join('\n');
  fs.writeFileSync(env.profilePatch, originalPatch, 'utf8');

  const controller = spyUploader();
  globalThis[UPLOADER_SYMBOL] = { controller, version: '9.9.9' };
  try {
    const saved = await configAction(env.ctx, VALID_SAVE);
    assert.equal(saved.ok, true);
    assert.equal(saved.defaultOff, true);
    assert.equal(controller.calls.length, 0, 'save never calls command()');
    const configBeforeInstall = fs.readFileSync(env.configPath, 'utf8');

    const result = await installUploader(env.ctx, { reloadTimeoutMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.defaultOff, true);
    assert.equal(result.copied, true);
    assert.equal(result.alreadyInstalled, false);
    assert.equal(result.restartRequired, false, 'the scripted uploader is already loaded');
    assert.equal(controller.calls.length, 0, 'install never grants consent through command()');
    assert.equal(fs.readFileSync(env.configPath, 'utf8'), configBeforeInstall, 'install never rewrites the config');
    assert.equal(result.status.valid, true);
    assert.equal(result.status.uploader.installed, true);
    assert.equal(result.status.uploader.active, true);
    assert.equal(result.status.uploader.version, '9.9.9');

    const installed = path.join(env.voluntaryDir, `dsh-langfuse-voluntary-${VENDORED_UPLOADER_VERSION}.mjs`);
    assert.equal(fs.existsSync(installed), true);
    const vendored = fileURLToPath(new URL(`../vendor/dsh-langfuse-voluntary-${VENDORED_UPLOADER_VERSION}.mjs`, import.meta.url));
    assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(vendored, 'utf8'),
      'the vendored copy is byte-identical');
    const patch = fs.readFileSync(env.profilePatch, 'utf8');
    assert.ok(patch.includes(MANAGED_BEGIN));
    assert.ok(patch.includes(`- id: ${VOLUNTARY_ROW_ID}`));
    assert.ok(patch.includes('include:unrelated-plugin'), 'unrelated rows survive');

    assert.equal(result.backups.length, 1, 'only the changed existing file is backed up');
    assert.equal(fs.readFileSync(result.backups[0], 'utf8'), originalPatch);

    const second = await installUploader(env.ctx, { reloadTimeoutMs: 0 });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyInstalled, true);
    assert.equal(second.copied, false);
    assert.deepEqual(second.changed, []);
    assert.deepEqual(second.backups, [], 'an idempotent install writes no new backup');
    assert.equal(controller.calls.length, 0, 'a repeated install still never calls command()');
  } finally {
    delete globalThis[UPLOADER_SYMBOL];
  }
});

test('install refuses an automatic collector row and points at the migrate flow', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const patch = [
    '- insert:',
    '    - id: dsh-langfuse',
    '      name: "file:///C:/Users/example/.dsh/dsh-langfuse-plugin.js"',
    '',
  ].join('\n');
  fs.writeFileSync(env.profilePatch, patch, 'utf8');
  const result = await installUploader(env.ctx, { reloadTimeoutMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'auto_collector_present');
  assert.equal(result.error.details.migrate, ROUTE_MIGRATE);
  assert.ok(result.error.details.rows.includes('dsh-langfuse'));
  assert.equal(result.defaultOff, true);
  assert.equal(fs.readFileSync(env.profilePatch, 'utf8'), patch, 'the patch is untouched');
  assert.equal(fs.existsSync(path.join(env.voluntaryDir, `dsh-langfuse-voluntary-${VENDORED_UPLOADER_VERSION}.mjs`)), false,
    'nothing is installed when the auto collector is still present');
});

test('install also refuses when the automatic collector is only a Loader row', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const autoRow = {
    id: 'include:dsh-langfuse-telemetry',
    options: { name: 'file:///C:/x/dsh-langfuse-telemetry.js' },
    fiber: {},
    disabled: false,
  };
  const ctx = {
    get: name => (name === 'loader' ? { entries: () => [autoRow] } : undefined),
  };
  const result = await installUploader(ctx, { reloadTimeoutMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'auto_collector_present');
  assert.deepEqual(result.error.details.rows, ['include:dsh-langfuse-telemetry']);
  assert.equal(fs.existsSync(env.configPath), false);
});

test('install reports restart_required when the new module does not load in time', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const result = await installUploader(env.ctx, { reloadTimeoutMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.status.uploader.installed, true);
  assert.equal(result.status.uploader.active, false);
  assert.equal(result.status.ready, false);
});

test('the /config route dispatches get, save, and rejects unknown actions', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  const routes = [];
  const ctx = {
    get: () => undefined,
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
        effect(execute) {
          execute();
          return () => {};
        },
      });
    },
  };
  apply(ctx);
  const route = routes.find(candidate => candidate.path === ROUTE_CONFIG);
  assert.ok(route, 'the config route is registered');
  const call = payload => route.fetch(new Request(`http://127.0.0.1${ROUTE_CONFIG}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })).then(response => response.json());

  const getBody = await call({ action: 'get' });
  assert.equal(getBody.ok, true);
  assert.equal(getBody.value.defaultOff, true);
  const saveBody = await call(VALID_SAVE);
  assert.equal(saveBody.ok, true);
  assert.equal(saveBody.defaultOff, true);
  const badBody = await call({ action: 'launch' });
  assert.equal(badBody.ok, false);
  assert.equal(badBody.error.code, 'bad_request');
});

test('scan status redacts a malformed file that still holds a secret', async t => {
  const env = createHome();
  t.after(() => env.cleanup());
  fs.mkdirSync(env.voluntaryDir, { recursive: true });
  fs.writeFileSync(env.configPath, JSON.stringify({
    baseUrl: 'not a url',
    publicKey: 'pk-lf-LEAKPUBLIC9999',
    secretKey: 'sk-lf-LEAKSECRET9999',
    userId: 'admin',
  }), 'utf8');
  const status = readConfigStatus(env.ctx);
  assert.equal(status.exists, true);
  assert.equal(status.valid, false);
  assert.equal(status.publicKeySet, true);
  assert.equal(status.secretKeySet, true);
  assert.equal(status.publicKeyHint, 'pk-lf-…9999');
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('LEAKSECRET9999'), false);
  assert.equal(serialized.includes('LEAKPUBLIC9999'), false);
});
