import { BOX_IP, GROK_PEER } from './helpers/net-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { CHECKOUT_POLICY, DEFAULTS, JobStore, checkAuth, extractResult, startJob, validateDispatch, withCheckoutPolicy } from '../receiver/core.mjs';
import { route, status } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/dispatch.mjs';
import { upsertJob } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/job-map.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-'));
fs.mkdirSync(path.join(tmp, 'Projects', 'demo'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'Projects', 'Finance'), { recursive: true });
const stub = path.join(tmp, 'stub.sh');
fs.writeFileSync(stub, '#!/bin/sh\necho "{\\"result\\":\\"done $ZCODE_DISPATCH_JOB_ID\\"}"\n', { mode: 0o755 });
const cfg = { ...DEFAULTS, projectsRoot: path.join(tmp, 'Projects'), stateDir: path.join(tmp, 'state'), runner: stub };

test('auth', () => {
  const k = Buffer.from('a'.repeat(64));
  assert.ok(checkAuth('Bearer ' + 'a'.repeat(64), k));
  assert.ok(!checkAuth('Bearer ' + 'b'.repeat(64), k));
  assert.ok(!checkAuth(undefined, k));
});
test('validate', () => {
  assert.equal(validateDispatch(cfg, { project: 'demo', text: '[Project: demo] hi' }).mode, 'yolo');
  assert.throws(() => validateDispatch(cfg, { project: 'demo', text: 'hi' }), /must start/);
  assert.throws(() => validateDispatch(cfg, { project: 'Finance', text: '[Project: Finance] x' }), /not allowed/);
  assert.throws(() => validateDispatch(cfg, { project: '../x', text: '[Project: ../x] x' }), /plain folder/);
  assert.throws(() => validateDispatch(cfg, { project: 'nope', text: '[Project: nope] x' }), /no such/);
});
test('extractResult', () => {
  assert.equal(extractResult('noise\n{"result":"R","sessionId":"s"}\n').result, 'R');
  assert.equal(extractResult('plain').result, 'plain');
});
test('job runs with stub runner and concurrency cap', async () => {
  const store = new JobStore({ ...cfg, maxConcurrent: 1 });
  const job = startJob(store, validateDispatch(cfg, { project: 'demo', text: '[Project: demo] hi' }), {});
  assert.throws(() => startJob(store, validateDispatch(cfg, { project: 'demo', text: '[Project: demo] 2' }), {}), /busy/);
  for (let i = 0; i < 50 && store.running.size; i++) await new Promise(r => setTimeout(r, 100));
  const done = store.get(job.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.result, `done ${job.id}`);
});
test('checkout policy appends only for git checkouts', () => {
  const gitDir = path.join(tmp, 'Projects', 'gitproj');
  fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
  const wtDir = path.join(tmp, 'Projects', 'wtproj');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /elsewhere\n');   // linked-worktree form
  const text = '[Project: gitproj] verify please';
  assert.match(withCheckoutPolicy(gitDir, text), /checkout-policy/);
  assert.ok(withCheckoutPolicy(gitDir, text).endsWith(CHECKOUT_POLICY));
  assert.match(withCheckoutPolicy(wtDir, text), /checkout-policy/);
  assert.equal(withCheckoutPolicy(path.join(tmp, 'Projects', 'demo'), text), text);
});
test('startJob hands the checkout policy to the runner for git projects; stored text stays clean', async () => {
  const argvLog = path.join(tmp, 'argv.log');
  const argvStub = path.join(tmp, 'argv-stub.sh');
  fs.writeFileSync(argvStub, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argvLog}'\necho '{"result":"ok"}'\n`, { mode: 0o755 });
  const gitDir = path.join(tmp, 'Projects', 'gitproj');
  const store = new JobStore({ ...cfg, runner: argvStub });
  const spec = validateDispatch(cfg, { project: 'gitproj', text: '[Project: gitproj] verify please' });
  const job = startJob(store, spec, {});
  for (let i = 0; i < 50 && store.running.size; i++) await new Promise(r => setTimeout(r, 100));
  assert.match(fs.readFileSync(argvLog, 'utf8'), /checkout-policy/);
  assert.ok(!store.get(job.id).text.includes('checkout-policy'));
});
test('outbound route tags text', () => {
  // temp-dir projects root (was the real ~/Projects)
  process.env.ZCODE_DISPATCH_PROJECTS_ROOT = path.join(tmp, 'Projects');
  const p = 'demo';
  assert.equal(route(p, 'do x').text, `[Project: ${p}] do x`);
  assert.throws(() => route('Finance', 'x'), /Finance/);
  assert.throws(() => route('other', `[Project: ${p}] x`), /tagged/);
});
test('dispatch status returns running inbound job mapping before falling back to yobiru request status', async () => {
  const stDir = path.join(tmp, 'status-state');
  const yobiruLog = path.join(tmp, 'status-yobiru.log');
  const yobiruStub = path.join(tmp, 'status-yobiru.sh');
  fs.writeFileSync(
    yobiruStub,
    `#!/bin/sh\necho "$@" >> "${yobiruLog}"\necho '{"id":"'"$4"'","state":"from-yobiru"}'\n`,
    { mode: 0o755 }
  );

  const prevState = process.env.ZCODE_DISPATCH_STATE_DIR;
  const prevYobiru = process.env.YOBIRU_BIN;
  process.env.ZCODE_DISPATCH_STATE_DIR = stDir;
  process.env.YOBIRU_BIN = yobiruStub;
  try {
    const runningId = 'abcdef0123456789';
    upsertJob({ job_id: runningId, source: 'grok-bot', project: 'demo', session_id: 'sess_run1' }, { stateDir: stDir });

    const runningRes = await status({ id: runningId });
    assert.equal(runningRes.job_id, runningId);
    assert.equal(runningRes.state, 'running');
    assert.equal(runningRes.mapping?.session_id, 'sess_run1');
    assert.equal(runningRes.report, null);
    assert.equal(fs.existsSync(yobiruLog), false);

    // Unknown 16-hex id falls back to yobiru request status
    const unknownId = '9876543210fedcba';
    const fallbackRes = await status({ id: unknownId });
    assert.equal(fallbackRes.state, 'from-yobiru');
    assert.match(fs.readFileSync(yobiruLog, 'utf8'), /request status 9876543210fedcba --refresh --json/);
  } finally {
    if (prevState === undefined) delete process.env.ZCODE_DISPATCH_STATE_DIR;
    else process.env.ZCODE_DISPATCH_STATE_DIR = prevState;
    if (prevYobiru === undefined) delete process.env.YOBIRU_BIN;
    else process.env.YOBIRU_BIN = prevYobiru;
  }
});

