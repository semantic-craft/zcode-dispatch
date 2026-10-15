import { BOX_IP, GROK_PEER } from './helpers/net-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../lib/route.mjs';

function harness(over = {}) {
  const calls = []; const out = []; const warns = [];
  const deps = {
    appRunning: () => true,
    checkSchema: () => true,
    runInApp: async () => { calls.push('app'); return { sessionId: 'sess_app', outcome: 'succeeded', result: 'A' }; },
    runTask: async ({ onSession }) => { calls.push('protocol'); onSession({ sessionId: 'sess_cli' }); return { sessionId: 'sess_cli', model: 'm', outcome: 'succeeded', result: 'P' }; },
    runHeadless: () => { calls.push('headless'); return 0; },
    upsertJob: () => {}, bindSession: () => {},
    ...over,
  };
  const run = (extra = {}) => dispatch({ cwd: '/w', text: 't', mode: 'yolo', source: 'yobiru', jobId: '0123456789abcdef', timeoutSeconds: 5, forced: '', deps, emit: (o) => out.push(o), warn: (m) => warns.push(m), ...extra });
  return { run, calls, out, warns };
}

test('app running -> app path is primary (visible session)', async () => {
  const h = harness(); assert.equal(await h.run(), 0);
  assert.deepEqual(h.calls, ['app']); assert.equal(h.out.at(-1).via, 'app'); assert.equal(h.out.at(-1).session_id, 'sess_app');
});

test('app NOT running (simulated) -> CLI path before headless', async () => {
  const h = harness({ appRunning: () => false }); assert.equal(await h.run(), 0);
  assert.deepEqual(h.calls, ['protocol']); assert.equal(h.out.at(-1).via, 'protocol');
});

test('scheduler schema change -> loud fallback to CLI', async () => {
  const h = harness({ checkSchema: () => { throw new Error('ZCode.app scheduler schema changed (missing: automations.mode)'); } });
  assert.equal(await h.run(), 0); assert.deepEqual(h.calls, ['protocol']);
  assert.match(h.warns.join('\n'), /FALLBACK: app-scheduler path failed: .*schema changed/);
});

test('app does not pick up -> loud fallback to CLI', async () => {
  const h = harness({ runInApp: async () => ({ outcome: 'not_picked_up', error: 'no pickup' }) });
  await h.run(); assert.deepEqual(h.calls, ['protocol']); assert.match(h.warns[0], /FALLBACK: ZCode.app did not pick up/);
});

test('app and CLI both fail -> headless last', async () => {
  const h = harness({ appRunning: () => false, runTask: async () => { throw new Error('no usable model'); } });
  assert.equal(await h.run(), 0); assert.deepEqual(h.calls, ['headless']); assert.match(h.warns[0], /FALLBACK: CLI stream-json path failed/);
});

test('app failure is final for the job when it ran (no double execution)', async () => {
  let ran = 0; const h = harness({ runInApp: async () => { ran++; return { sessionId: 's', outcome: 'failed', error: 'x' }; } });
  assert.equal(await h.run(), 1); assert.equal(ran, 1); assert.deepEqual(h.calls, []); assert.equal(h.out.at(-1).via, 'app');
});

test('forced path does not fall back', async () => {
  const h = harness({ appRunning: () => false }); assert.equal(await h.run({ forced: 'app' }), 1); assert.deepEqual(h.calls, []);
  const h2 = harness(); await h2.run({ forced: 'protocol' }); assert.deepEqual(h2.calls, ['protocol']);
});

test('resume skips app (scheduler cannot resume) and uses CLI', async () => {
  const h = harness(); await h.run({ resumeSessionId: 'sess_x' }); assert.deepEqual(h.calls, ['protocol']);
});
