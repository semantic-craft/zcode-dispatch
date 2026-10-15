import { BOX_IP, GROK_PEER } from './helpers/net-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZCodeProtocolClient, checkCompat, cliArgs, finalText, probe, runTask } from '../lib/zcode-protocol.mjs';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-app-server.mjs');
const client = (env = {}) => new ZCodeProtocolClient({ spawnSpec: { cmd: process.execPath, args: [STUB], env: { ...process.env, ...env } } }).start();

test('checkCompat fails loudly on protocol drift', () => {
  assert.throws(() => checkCompat({ protocol: { name: 'ZCode Protocol', version: 2 }, session: { sessionId: 's' }, settings: { model: { available: [] } } }), /compatibility check failed.*unsupported protocol/);
  assert.throws(() => checkCompat({ protocol: { name: 'ZCode Protocol', version: 1 }, session: {} }), /no session.sessionId/);
});

test('finalText skips hidden and non-text parts', () => {
  assert.equal(finalText([{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'A' }] }, { info: { role: 'assistant', semantics: { transcriptVisibility: 'hidden' } }, parts: [{ type: 'text', text: 'H' }] }]), 'A');
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-zcode-cli.mjs');
const cli = { cmd: process.execPath, args: [CLI], env: {} };

test('cliArgs uses official flags', () => {
  assert.deepEqual(cliArgs({ cwd: '/w', text: 't', resumeSessionId: 'sess_1' }), ['-p', 't', '--cwd', '/w', '--mode', 'yolo', '--output-format', 'stream-json', '--resume', 'sess_1']);
});

test('runTask: session id from first event (before result), model + final reply from stream', async () => {
  const order = [];
  const r = await runTask({ cwd: '/tmp', text: 'Reply with ACP-OK-abc', spawnSpec: cli, onSession: s => order.push(['session', s.sessionId]), onEvent: e => e.type === 'result' && order.push(['result']) });
  assert.deepEqual(order[0], ['session', 'sess_stubcli1']); assert.deepEqual(order.at(-1), ['result']);
  assert.equal(r.outcome, 'succeeded'); assert.equal(r.result, 'ACP-OK-abc');
  assert.equal(r.model, 'account:bigmodel-individual-coding-plan/GLM-5.3');
});

test('runTask: missing login -> clear instruction', async () => {
  await assert.rejects(runTask({ cwd: '/tmp', text: 'x', spawnSpec: cli, env: { ...process.env, STUB_FAIL: '1' } }), /zcode login bigmodel/);
});

test('runTask: resume keeps the session id', async () => {
  const r = await runTask({ cwd: '/tmp', text: 'E2E-two', spawnSpec: cli, resumeSessionId: 'sess_prev' });
  assert.equal(r.sessionId, 'sess_prev'); assert.equal(r.result, 'E2E-two (resumed)');
});

test('probe: protocol identity via app-server stub', async () => {
  const c = client();
  assert.deepEqual(await probe({ client: c }), { ok: true, protocol: { name: 'ZCode Protocol', version: 1 } }); await c.close();
});
