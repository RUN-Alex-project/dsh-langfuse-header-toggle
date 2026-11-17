/**
 * Upload-hook inventory and migration helpers.
 *
 * These tests cover the text-level contract the migration relies on. They
 * never touch the real profile: every case runs on in-memory patch text or a
 * throw-away temp directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyHook,
  readEnvConfig,
  removeAutoRows,
  residualAutoRows,
  scanHooks,
  stripManagedBlock,
  toFileUrl,
  upsertManagedBlock,
  MANAGED_BEGIN,
  MANAGED_END,
  VOLUNTARY_ROW_ID,
  migrateHooks,
} from '../index.js';

const AUTO_INSERT = [
  '- insert:',
  '    - id: dsh-langfuse',
  '      name: "file:///C:/Users/example/.dsh/dsh-langfuse-plugin.js"',
  '',
].join('\n');

function samplePatch() {
  return [
    '# DSH desktop profile patch',
    AUTO_INSERT,
    '- insert:',
    '    - id: include:unrelated-plugin',
    '      name: "@deepseek-ai/dsh-unrelated"',
    '',
    '- id: dsh-langfuse-telemetry',
    '  disabled: true',
    '',
  ].join('\n');
}

test('classifyHook recognises the switch, the voluntary and the automatic hooks', () => {
  assert.equal(classifyHook('include:dsh-langfuse-header-toggle', '@local/dsh-langfuse-header-toggle'), 'switch');
  assert.equal(classifyHook('include:dsh-langfuse-voluntary-1-0-1', 'file:///C:/x/dsh-langfuse-voluntary-1.0.1.mjs'), 'voluntary');
  assert.equal(classifyHook('include:dsh-langfuse', 'file:///C:/x/dsh-langfuse-plugin.js'), 'auto');
  assert.equal(classifyHook('include:dsh-langfuse-telemetry', 'some-package'), 'auto');
  assert.equal(classifyHook('include:dsh-langfuse', '@scope/dsh-langfuse-plugin'), 'auto');
  assert.equal(classifyHook('include:other', '@scope/other-langfuse-tool'), 'other');
  assert.equal(classifyHook('include:unrelated', '@deepseek-ai/dsh-demo'), null);
});

test('toFileUrl produces file URLs for Windows and POSIX paths', () => {
  assert.equal(toFileUrl('C:\\Users\\A\\.dsh\\langfuse-voluntary\\x.mjs'), 'file:///C:/Users/A/.dsh/langfuse-voluntary/x.mjs');
  assert.equal(toFileUrl('/home/a/.dsh/x.mjs'), 'file:///home/a/.dsh/x.mjs');
});

test('removeAutoRows removes automatic collectors and keeps everything else', () => {
  const original = samplePatch();
  const { content, removed } = removeAutoRows(original);
  assert.deepEqual(removed.sort(), ['dsh-langfuse', 'dsh-langfuse-telemetry']);
  assert.equal(residualAutoRows(content).length, 0);
  assert.ok(content.includes('include:unrelated-plugin'), 'unrelated rows survive');
  assert.equal(content.includes('dsh-langfuse-plugin.js'), false);
  assert.ok(content.includes('# DSH desktop profile patch'));
});

test('removeAutoRows is a no-op when only the voluntary rows exist', () => {
  const voluntary = [
    '- insert:',
    `    - id: ${VOLUNTARY_ROW_ID}`,
    '      name: "file:///C:/x/dsh-langfuse-voluntary-1.0.1.mjs"',
    '',
  ].join('\n');
  const { content, removed } = removeAutoRows(voluntary);
  assert.deepEqual(removed, []);
  assert.equal(content, voluntary);
});

test('upsertManagedBlock appends one managed block and is idempotent', () => {
  const url = 'file:///C:/Users/A/.dsh/langfuse-voluntary/dsh-langfuse-voluntary-1.0.1.mjs';
  const once = upsertManagedBlock(samplePatch(), url);
  assert.ok(once.startsWith('# DSH desktop profile patch'));
  const starts = once.split(MANAGED_BEGIN).length - 1;
  assert.equal(starts, 1, 'exactly one managed block');
  assert.equal(once.split(MANAGED_END).length - 1, 1);
  assert.ok(once.includes(`- id: ${VOLUNTARY_ROW_ID}`));
  assert.ok(once.includes(JSON.stringify(url)));
  assert.ok(once.includes('include:unrelated-plugin'));

  const twice = upsertManagedBlock(once, url);
  assert.equal(twice, once, 'a second apply changes nothing');

  const emptyFlow = upsertManagedBlock('# template\n[]\n', url);
  assert.equal(/^\s*\[\]\s*$/m.test(emptyFlow), false, 'bare [] is dropped so the YAML stays a single array');
  assert.ok(emptyFlow.includes(MANAGED_BEGIN));
});

test('stripManagedBlock restores the text before the managed block existed', () => {
  const url = 'file:///C:/x/dsh-langfuse-voluntary-1.0.1.mjs';
  const withBlock = upsertManagedBlock(samplePatch(), url);
  const stripped = stripManagedBlock(withBlock);
  assert.equal(stripped.includes(MANAGED_BEGIN), false);
  assert.equal(stripped.includes(VOLUNTARY_ROW_ID), false);
});

test('migrateHooks refuses without confirmation and before touching files', async () => {
  const fakeCtx = { get: () => undefined };
  const denied = await migrateHooks(fakeCtx, {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'confirmation_required');
});

test('migrateHooks rewrites a temp profile and reports restart when nothing reloads', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toggle-migrate-'));
  const profileDir = path.join(home, 'profiles', 'desktop');
  const voluntaryDir = path.join(home, 'langfuse-voluntary');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(voluntaryDir, { recursive: true });
  fs.writeFileSync(path.join(voluntaryDir, 'config.json'), JSON.stringify({
    baseUrl: 'http://langfuse.invalid',
    publicKey: 'pk-test',
    secretKey: 'sk-test',
    userId: 'j00000',
  }), 'utf8');
  const homePatch = path.join(home, 'cordis.patch.yml');
  const homeOriginal = samplePatch();
  fs.writeFileSync(homePatch, homeOriginal, 'utf8');
  const profilePatch = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(profilePatch, '# desktop profile patch\n[]\n', 'utf8');
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE_DIR;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE_DIR = profileDir;
  try {
    const result = await migrateHooks({ get: () => undefined }, { confirm: true, reloadTimeoutMs: 50 });
    assert.equal(result.ok, false, 'nothing reloads in the test process');
    assert.equal(result.status, 'restart_required');
    assert.equal(result.restartRequired, true);
    const writtenHome = fs.readFileSync(homePatch, 'utf8');
    assert.equal(residualAutoRows(writtenHome).length, 0);
    assert.equal(writtenHome.includes('include:unrelated-plugin'), true, 'unrelated rows survive');
    const writtenProfile = fs.readFileSync(profilePatch, 'utf8');
    assert.ok(writtenProfile.includes(MANAGED_BEGIN));
    assert.ok(writtenProfile.includes(VOLUNTARY_ROW_ID));
    for (const backup of result.backups) {
      assert.equal(fs.existsSync(backup), true, `backup exists: ${backup}`);
    }
    assert.equal(result.backups.length, 2, 'both changed patch files were backed up');
    assert.equal(fs.existsSync(path.join(voluntaryDir, 'dsh-langfuse-voluntary-1.0.2.mjs')), true,
      'the vendored uploader is installed when missing');
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('migrateHooks fails closed when the voluntary config is missing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toggle-home-'));
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const original = samplePatch();
  fs.writeFileSync(patchPath, original, 'utf8');
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE_DIR;
  const savedEnv = saveLangfuseEnv();
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE_DIR = profileDir;
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    const result = await migrateHooks({ get: () => undefined }, { confirm: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'config_missing');
    assert.equal(fs.readFileSync(patchPath, 'utf8'), original, 'the patch is untouched');
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = savedProfile;
    restoreLangfuseEnv(savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// First-install bootstrap: the original collector reads LANGFUSE_* env, so the
// Host can create the voluntary config from it without sending keys to the UI.
// ---------------------------------------------------------------------------

const ENV_KEYS = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASEURL', 'LANGFUSE_HOST', 'LANGFUSE_USER_ID'];

function saveLangfuseEnv() {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreLangfuseEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function setLangfuseEnv() {
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test-bootstrap';
  process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test-bootstrap';
  process.env.LANGFUSE_BASEURL = 'https://langfuse.example.com';
  process.env.LANGFUSE_USER_ID = 'j60000000';
}

test('readEnvConfig requires the same fields the original collector reads', () => {
  assert.equal(readEnvConfig({}).complete, false);
  assert.equal(readEnvConfig({ LANGFUSE_PUBLIC_KEY: 'pk-lf-a', LANGFUSE_SECRET_KEY: 'sk-lf-a' }).complete, false, 'userId is required');
  const good = readEnvConfig({
    LANGFUSE_PUBLIC_KEY: 'pk-lf-a',
    LANGFUSE_SECRET_KEY: 'sk-lf-a',
    LANGFUSE_HOST: 'https://langfuse.example.com',
    LANGFUSE_USER_ID: 'j60000000',
  });
  assert.equal(good.complete, true);
  assert.equal(good.baseUrlHost, 'langfuse.example.com');
  assert.equal(good.value.userId, 'j60000000');
  const badUser = readEnvConfig({
    LANGFUSE_PUBLIC_KEY: 'pk-lf-a',
    LANGFUSE_SECRET_KEY: 'sk-lf-a',
    LANGFUSE_BASEURL: 'https://langfuse.example.com',
    LANGFUSE_USER_ID: 'not-a-work-number',
  });
  assert.equal(badUser.complete, false);
  assert.equal(badUser.userId, false);
});

test('scanHooks reports env bootstrap without leaking key values', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toggle-scan-'));
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE_DIR;
  const savedEnv = saveLangfuseEnv();
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE_DIR = profileDir;
  setLangfuseEnv();
  try {
    const autoHook = {
      id: 'include:dsh-langfuse',
      options: { name: 'file:///C:/Users/A/.dsh/dsh-langfuse-plugin.js' },
      fiber: {},
      disabled: false,
    };
    const scan = scanHooks({ get: name => (name === 'loader' ? { entries: () => [autoHook] } : undefined) });
    assert.equal(scan.auto.length, 1);
    assert.equal(scan.voluntary.configPresent, false);
    assert.equal(scan.voluntary.configSource, 'env');
    assert.equal(scan.migration.canCreateConfig, true);
    assert.equal(scan.migration.configSource, 'env');
    assert.equal(scan.migration.available, true);
    assert.deepEqual(scan.migration.missingEnv, []);
    const serialized = JSON.stringify(scan);
    assert.equal(serialized.includes('sk-lf-'), false, 'secret key never reaches the browser payload');
    assert.equal(serialized.includes('pk-lf-'), false, 'public key value is not exposed either');
    assert.equal(scan.migration.env.baseUrlHost, 'langfuse.example.com');
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = savedProfile;
    restoreLangfuseEnv(savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('migrateHooks creates config.json from env on first install and never returns the keys', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toggle-env-'));
  const profileDir = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), samplePatch(), 'utf8');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# desktop patch\n[]\n', 'utf8');
  const savedHome = process.env.DSH_HOME;
  const savedProfile = process.env.DSH_PROFILE_DIR;
  const savedEnv = saveLangfuseEnv();
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE_DIR = profileDir;
  setLangfuseEnv();
  try {
    const result = await migrateHooks({ get: () => undefined }, { confirm: true, reloadTimeoutMs: 50 });
    const configPath = path.join(home, 'langfuse-voluntary', 'config.json');
    assert.equal(result.configCreated, configPath);
    assert.equal(fs.existsSync(configPath), true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.userId, 'j60000000');
    assert.equal(config.publicKey, 'pk-lf-test-bootstrap');
    assert.equal(config.baseUrl, 'https://langfuse.example.com');
    assert.equal(JSON.stringify(result).includes('sk-lf-'), false, 'migration result never carries the secret');
    assert.equal(JSON.stringify(result).includes('pk-lf-'), false);
    assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8').includes(MANAGED_BEGIN), true);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = savedProfile;
    restoreLangfuseEnv(savedEnv);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

