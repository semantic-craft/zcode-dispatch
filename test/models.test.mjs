import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { BUILTIN_DEFAULT_MODEL, availableModels, resolveModel, sameModel } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/models.mjs';
import { enqueue } from '../lib/appsession.mjs';
import { dispatch } from '../lib/route.mjs';
import { runTask } from '../lib/zcode-protocol.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const env = { ...process.env, ZCODE_PROVIDER_CATALOG: path.join(FX, 'zcode-builtin.json'), ZCODE_PROVIDER_CONFIG: path.join(FX, 'provider_config.json'), ZCODE_DISPATCH_DEFAULT_MODEL: '' };

test('default is GLM-5.3 Flash with ZCode\'s exact id, even though ZCode\'s own default is GLM-5.3', () => {
  assert.equal(BUILTIN_DEFAULT_MODEL, 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash');
  const m = resolveModel(undefined, { env });
  assert.equal(m.id, BUILTIN_DEFAULT_MODEL); assert.equal(m.modelId, 'GLM-5.3-Flash'); assert.equal(m.explicit, false);
});

test('explicit model wins only when named', () => {
  assert.equal(resolveModel('account:bigmodel-individual-coding-plan/GLM-5.3', { env }).id, 'account:bigmodel-individual-coding-plan/GLM-5.3');
});

test('unknown or user-disabled model is a hard error (no fallback)', () => {
  assert.throws(() => resolveModel('account:bigmodel-individual-coding-plan/GLM-9', { env }), /not offered.*Not falling back/);
  assert.throws(() => resolveModel('account:bigmodel-start-plan/GLM-5.3-Flash', { env }), /not offered/);
  assert.throws(() => resolveModel('GLM-5.3-Flash', { env }), /not a ZCode model id/);
  assert.throws(() => resolveModel(undefined, { env: { ...env, ZCODE_PROVIDER_CATALOG: '/nonexistent' } }), /cannot read ZCode provider catalog/);
  assert.ok(!availableModels(env).includes('account:bigmodel-start-plan/GLM-5.3-Flash'));
});

test('sameModel ignores ZCode reasoning suffix ($max)', () => {
  assert.ok(sameModel('account:bigmodel-individual-coding-plan/GLM-5.3-Flash$max', BUILTIN_DEFAULT_MODEL));
  assert.ok(!sameModel('account:bigmodel-individual-coding-plan/GLM-5.3$max', BUILTIN_DEFAULT_MODEL));
});

test('app path writes model_selection {providerId, modelId} instead of null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-m-')); const dbPath = path.join(dir, 't.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE automations (automation_id TEXT, title TEXT, cron_expr TEXT, prompt TEXT, model TEXT, provider TEXT, model_selection TEXT, workspace_key TEXT, workspace_path TEXT, location_kind TEXT, recurring INT, max_runs INT, enabled INT, lifecycle_status TEXT, next_run_at INT, running INT, dispatch_status TEXT, dispatch_attempts INT, mode TEXT, created_at INT, updated_at INT)`);
  db.close();
  const id = enqueue({ cwd: dir, text: '[Project: x] hi', model: BUILTIN_DEFAULT_MODEL, source: 'grok-bot', dbPath, stateDir: dir });
  const row = new DatabaseSync(dbPath).prepare('SELECT model_selection FROM automations WHERE automation_id=?').get(id);
  assert.deepEqual(JSON.parse(row.model_selection), { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash' });
});

test('headless path refuses when a model is required (cannot select/verify it)', async () => {
  const out = []; const calls = [];
  const code = await dispatch({ cwd: '/w', text: 't', mode: 'yolo', source: 's', jobId: '0123456789abcdef', model: BUILTIN_DEFAULT_MODEL, forced: 'headless',
    deps: { runHeadless: () => { calls.push('headless'); return 0; } }, emit: (o) => out.push(o), warn: () => {} });
  assert.equal(code, 1); assert.deepEqual(calls, []); assert.match(out.at(-1).error, /cannot select or verify model/);
});

test('CLI path stops on a model mismatch instead of running another model', async () => {
  const r = await runTask({ cwd: os.tmpdir(), text: 'x', model: BUILTIN_DEFAULT_MODEL,
    spawnSpec: { cmd: process.execPath, args: [path.join(FX, 'stub-zcode-cli.mjs')], env: {} } });
  assert.equal(r.outcome, 'failed'); assert.match(r.error, /model mismatch on CLI path: requested .*GLM-5.3-Flash, ZCode CLI started .*GLM-5.3\b/);
});
