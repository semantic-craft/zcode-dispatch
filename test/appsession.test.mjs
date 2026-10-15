import { BOX_IP, GROK_PEER } from './helpers/net-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { enqueue, extractTags, loadMap, resolveJob, resultText, summaryTitle, withSource } from '../lib/appsession.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '../marketplace/plugins/zcode-grokbot-dispatch/hooks/stop-report.mjs');

function initFakeTasksDb(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE automations (
      automation_id TEXT PRIMARY KEY, title TEXT, cron_expr TEXT, prompt TEXT,
      model TEXT, provider TEXT, model_selection TEXT, workspace_key TEXT, workspace_path TEXT,
      location_kind TEXT, recurring INTEGER, max_runs INTEGER, enabled INTEGER,
      lifecycle_status TEXT, next_run_at INTEGER, running INTEGER, dispatch_status TEXT,
      dispatch_attempts INTEGER, last_error TEXT, mode TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE automation_runs (
      run_id TEXT PRIMARY KEY, automation_id TEXT, dispatch_status TEXT,
      outcome TEXT, session_id TEXT, error TEXT, created_at INTEGER
    );
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, title TEXT, task_status TEXT, searchable_text TEXT
    );
  `);
  db.close();
}

test('withSource inserts source and optional job_id after project tag once', () => {
  assert.equal(withSource('[Project: a] do x', 'grok-bot'), '[Project: a] [来源: grok-bot] do x');
  assert.equal(withSource('[Project: a] [来源: y] do x', 'grok-bot'), '[Project: a] [来源: y] do x');
  assert.equal(
    withSource('[Project: a] do x', 'grok-bot', '0123456789abcdef'),
    '[Project: a] [来源: grok-bot] [job: 0123456789abcdef] do x'
  );
  assert.equal(
    withSource('[Project: a] [来源: grok-bot] [job: 0123456789abcdef] do x', 'grok-bot', '0123456789abcdef'),
    '[Project: a] [来源: grok-bot] [job: 0123456789abcdef] do x'
  );
});

test('summaryTitle and extractTags', () => {
  assert.equal(summaryTitle('[Project: a] do x', 'yobiru'), '[yobiru] do x');
  assert.equal(summaryTitle('[Project: a] do x', 'grok-bot', '0123456789abcdef'), '[grok-bot #0123456789abcdef] do x');
  const tags = extractTags('[Project: demo] [来源: grok-bot] [job: 0123456789abcdef] hello');
  assert.deepEqual(tags, { project: 'demo', source: 'grok-bot', jobId: '0123456789abcdef' });
});

test('resultText strips prompt', () => {
  assert.equal(resultText({ searchable_text: 'P\nANS' }, 'P'), 'ANS');
});

test('app session job_id mapping -> UserPromptSubmit -> Stop hook auto-reports via Yobiru without env job_id', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-app-'));
  const stateDir = path.join(tmp, 'state');
  const pluginData = path.join(tmp, 'plugin-data');
  const dbPath = path.join(tmp, 'tasks-index.sqlite');
  const yobiruLog = path.join(tmp, 'yobiru.log');
  const yobiruStub = path.join(tmp, 'yobiru-stub.sh');
  fs.writeFileSync(yobiruStub, `#!/bin/sh\necho "$@" >> "${yobiruLog}"\necho "sent fedcba9876543210"\n`, { mode: 0o755 });
  initFakeTasksDb(dbPath);

  const jobId = '89abcdef01234567';
  const sessionId = 'sess_11111111-2222-3333-4444-555555555555';
  const autoId = enqueue({
    cwd: '/Users/example/Projects/zcode-dispatch',
    text: '[Project: zcode-dispatch] verify stop hook',
    mode: 'yolo',
    source: 'grok-bot',
    jobId,
    notifyPeer: GROK_PEER,
    stateDir,
    dbPath,
  });
  assert.ok(autoId.startsWith('automation-zcode-dispatch-'));

  const env = {
    ...process.env,
    ZCODE_DISPATCH_STATE_DIR: stateDir,
    ZCODE_PLUGIN_DATA: pluginData,
    ZCODE_TASKS_DB: dbPath,
    YOBIRU_BIN: yobiruStub,
  };
  delete env.ZCODE_DISPATCH_JOB_ID;
  delete env.ZCODE_DISPATCH_SOURCE;

  // 1. UserPromptSubmit hook binds session_id <-> job_id from prompt tag
  const promptText = withSource('[Project: zcode-dispatch] verify stop hook', 'grok-bot', jobId);
  const up = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: promptText, cwd: '/tmp' }) + '\n',
    env,
    encoding: 'utf8',
  });
  assert.equal(up.status, 0);
  assert.equal(up.stdout, '');

  const mapAfterPrompt = loadMap({ stateDir, pluginDataDir: pluginData });
  assert.equal(mapAfterPrompt.sessions[sessionId], jobId);

  // 2. Stop hook resolves job_id by session_id from persistent mapping and sends Yobiru report
  const st = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: sessionId,
      cwd: '/Users/example/Projects/zcode-dispatch',
      last_assistant_message: 'Task finished with exact verification.',
    }) + '\n',
    env,
    encoding: 'utf8',
  });
  assert.equal(st.status, 0);
  assert.equal(st.stdout, '');

  const reportFile = path.join(stateDir, 'reports', `${jobId}.json`);
  assert.ok(fs.existsSync(reportFile));
  const rep = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(rep.job_id, jobId);
  assert.equal(rep.session_id, sessionId);
  assert.equal(rep.source, 'grok-bot');
  assert.equal(rep.yobiru_reported, true);
  assert.equal(rep.text, 'Task finished with exact verification.');

  const sentArgs = fs.readFileSync(yobiruLog, 'utf8');
  assert.ok(sentArgs.includes(`send ${GROK_PEER} [ZCode report 89abcdef01234567] Task finished with exact verification.`), sentArgs);
});

test('resolveJob falls back to tasks-index.sqlite automation_runs when hook fires before mapping is bound', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-dbfb-'));
  const stateDir = path.join(tmp, 'state');
  const dbPath = path.join(tmp, 'tasks-index.sqlite');
  initFakeTasksDb(dbPath);

  const jobId = 'fedcba9876543210';
  const sessionId = 'sess_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const autoId = enqueue({
    cwd: '/Users/example/Projects/zcode-dispatch',
    text: '[Project: zcode-dispatch] fallback test',
    source: 'yobiru',
    jobId,
    stateDir,
    dbPath,
  });

  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO automation_runs (run_id, automation_id, dispatch_status, outcome, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('run-1', autoId, 'dispatched', 'running', sessionId, Date.now());
  db.close();

  const resolved = resolveJob({ sessionId, stateDir, dbPath, env: {} });
  assert.equal(resolved?.job_id, jobId);
  assert.equal(resolved?.session_id, sessionId);
  assert.equal(loadMap({ stateDir }).sessions[sessionId], jobId);
});

test('Stop hook reports once per job and leaves yobiru-sourced jobs to the adapter', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-once-'));
  const stateDir = path.join(tmp, 'state');
  const yobiruLog = path.join(tmp, 'yobiru.log');
  const stub = path.join(tmp, 'y.sh');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${yobiruLog}"\n`, { mode: 0o755 });
  const env = { ...process.env, ZCODE_DISPATCH_STATE_DIR: stateDir, ZCODE_TASKS_DB: path.join(tmp, 'none.sqlite'), YOBIRU_BIN: stub };
  delete env.ZCODE_PLUGIN_DATA; delete env.ZCODE_DISPATCH_NOTIFY;
  const hook = (e, msg) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess_a', last_assistant_message: msg }), env: { ...env, ...e }, encoding: 'utf8' });
  assert.equal(hook({ ZCODE_DISPATCH_JOB_ID: '1111111111111111', ZCODE_DISPATCH_SOURCE: 'grok-bot' }, 'first').status, 0);
  assert.equal(hook({ ZCODE_DISPATCH_JOB_ID: '1111111111111111', ZCODE_DISPATCH_SOURCE: 'grok-bot' }, 'follow-up chat').status, 0);
  assert.equal(fs.readFileSync(yobiruLog, 'utf8').trim().split('\n').length, 1);
  assert.equal(hook({ ZCODE_DISPATCH_JOB_ID: '2222222222222222', ZCODE_DISPATCH_SOURCE: 'yobiru' }, 'done').status, 0);
  assert.equal(fs.readFileSync(yobiruLog, 'utf8').trim().split('\n').length, 1);
  assert.ok(fs.existsSync(path.join(stateDir, 'reports', '2222222222222222.json')));
});

test('Stop hook only notifies Grok for Grok-dispatched jobs; dsh/local/zcode and ZCODE_DISPATCH_NOTIFY=none write report only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-grok-only-'));
  const stateDir = path.join(tmp, 'state');
  const dbPath = path.join(tmp, 'tasks-index.sqlite');
  const yobiruLog = path.join(tmp, 'yobiru.log');
  const stub = path.join(tmp, 'y.sh');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${yobiruLog}"\necho "sent"\n`, { mode: 0o755 });
  initFakeTasksDb(dbPath);

  const baseEnv = { ...process.env, ZCODE_DISPATCH_STATE_DIR: stateDir, ZCODE_TASKS_DB: dbPath, YOBIRU_BIN: stub };
  delete baseEnv.ZCODE_PLUGIN_DATA;
  delete baseEnv.ZCODE_DISPATCH_NOTIFY;
  delete baseEnv.ZCODE_DISPATCH_JOB_ID;
  delete baseEnv.ZCODE_DISPATCH_SOURCE;
  delete baseEnv.ZCODE_DISPATCH_PEER;

  const runStop = (sessionId, extraEnv = {}, msg = 'completed') =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: msg }),
      env: { ...baseEnv, ...extraEnv },
      encoding: 'utf8',
    });

  // 1. dsh / local / zcode / default enqueue -> report saved on disk, never sent to Grok
  for (const [idx, src] of ['dsh', 'local', 'zcode', undefined].entries()) {
    const jid = `333333333333330${idx}`;
    const sid = `sess_non_grok_${idx}`;
    enqueue({ cwd: '/tmp', text: '[Project: demo] task', source: src, jobId: jid, stateDir, dbPath });
    const mapped = loadMap({ stateDir }).jobs[jid];
    assert.notEqual(mapped.notify, 'grok');
    assert.equal(runStop(sid, { ZCODE_DISPATCH_JOB_ID: jid, ...(src ? { ZCODE_DISPATCH_SOURCE: src } : {}) }).status, 0);
    const rep = JSON.parse(fs.readFileSync(path.join(stateDir, 'reports', `${jid}.json`), 'utf8'));
    assert.equal(rep.yobiru_reported, false);
  }
  assert.equal(fs.existsSync(yobiruLog), false);

  // 2. source==='grok' -> notifies Grok
  const grokJob = '4444444444444401';
  enqueue({ cwd: '/tmp', text: '[Project: demo] grok task', source: 'grok', jobId: grokJob, stateDir, dbPath });
  assert.equal(loadMap({ stateDir }).jobs[grokJob].notify, 'grok');
  assert.equal(runStop('sess_grok_1', { ZCODE_DISPATCH_JOB_ID: grokJob, ZCODE_DISPATCH_SOURCE: 'grok' }, 'grok reply').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'reports', `${grokJob}.json`), 'utf8')).yobiru_reported, true);
  assert.equal(fs.readFileSync(yobiruLog, 'utf8').trim().split('\n').length, 1);

  // 3. Yobiru inbound from the Grok box node -> Grok-dispatched, but answered by the adapter's request respond (no Stop-hook send)
  const yobiruGrokJob = '4444444444444402';
  enqueue({
    cwd: '/tmp',
    text: '[Project: demo] yobiru grok task',
    source: 'yobiru',
    notifyPeer: GROK_PEER,
    jobId: yobiruGrokJob,
    stateDir,
    dbPath,
  });
  assert.equal(loadMap({ stateDir }).jobs[yobiruGrokJob].notify, 'grok');
  assert.equal(
    runStop('sess_grok_2', {
      ZCODE_DISPATCH_JOB_ID: yobiruGrokJob,
      ZCODE_DISPATCH_SOURCE: 'yobiru',
      ZCODE_DISPATCH_PEER: GROK_PEER,
    }, 'yobiru grok reply').status,
    0
  );
  const yRep = JSON.parse(fs.readFileSync(path.join(stateDir, 'reports', `${yobiruGrokJob}.json`), 'utf8'));
  assert.equal(yRep.yobiru_reported, false);
  assert.equal(yRep.yobiru_skipped, 'adapter-responds');
  assert.equal(fs.readFileSync(yobiruLog, 'utf8').trim().split('\n').length, 1);

  // 4. Explicit ZCODE_DISPATCH_NOTIFY=none disables notification even for Grok-dispatched job
  const mutedGrokJob = '4444444444444403';
  enqueue({ cwd: '/tmp', text: '[Project: demo] muted grok', source: 'grok', jobId: mutedGrokJob, stateDir, dbPath });
  assert.equal(
    runStop('sess_grok_3', {
      ZCODE_DISPATCH_JOB_ID: mutedGrokJob,
      ZCODE_DISPATCH_SOURCE: 'grok',
      ZCODE_DISPATCH_NOTIFY: 'none',
    }, 'muted reply').status,
    0
  );
  const mutedRep = JSON.parse(fs.readFileSync(path.join(stateDir, 'reports', `${mutedGrokJob}.json`), 'utf8'));
  assert.equal(mutedRep.yobiru_reported, false);
  assert.equal(mutedRep.yobiru_skipped, 'notify-disabled');
  assert.equal(fs.readFileSync(yobiruLog, 'utf8').trim().split('\n').length, 1);
});

test('upsertJob and bindSession serialize concurrent multi-process writes and clean up stale locks', async () => {
  const { spawn } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-lock-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // Plant a stale lock file (mtime 30s in the past) to verify stale-lock recovery
  const lockFile = path.join(stateDir, 'session-jobs.lock');
  fs.writeFileSync(lockFile, '999999 0\n', { mode: 0o600 });
  const past = new Date(Date.now() - 30000);
  fs.utimesSync(lockFile, past, past);

  const jobMapUrl = new URL('../marketplace/plugins/zcode-grokbot-dispatch/lib/job-map.mjs', import.meta.url).href;
  const workerScript = `
    import { bindSession, upsertJob } from ${JSON.stringify(jobMapUrl)};
    const [stateDir, prefix] = process.argv.slice(1);
    for (let i = 0; i < 5; i++) {
      const jobId = prefix + String(i).padStart(8, '0');
      const sessionId = 'sess_' + jobId;
      upsertJob({ job_id: jobId, source: 'grok-bot', project: 'demo' }, { stateDir });
      bindSession({ sessionId, jobId, cwd: '/tmp/demo' }, { stateDir });
    }
  `;

  const prefixes = ['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004'];
  await Promise.all(
    prefixes.map(
      (p) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript, '--', stateDir, p], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let err = '';
          child.stderr.on('data', (d) => (err += d));
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${p} exit ${code}: ${err}`))));
        })
    )
  );

  const finalMap = loadMap({ stateDir });
  for (const p of prefixes) {
    for (let i = 0; i < 5; i++) {
      const jobId = p + String(i).padStart(8, '0');
      const sessionId = 'sess_' + jobId;
      assert.equal(finalMap.jobs[jobId]?.job_id, jobId);
      assert.equal(finalMap.jobs[jobId]?.session_id, sessionId);
      assert.equal(finalMap.sessions[sessionId], jobId);
    }
  }
  assert.equal(Object.keys(finalMap.jobs).length, prefixes.length * 5);
  assert.equal(fs.existsSync(lockFile), false);
});



test('Yobiru request from Grok is answered only by the adapter (no duplicate Stop-hook send)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-yob-grok-'));
  const stateDir = path.join(tmp, 'state');
  const yobiruLog = path.join(tmp, 'yobiru.log');
  const stub = path.join(tmp, 'y.sh');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${yobiruLog}"\n`, { mode: 0o755 });
  const env = { ...process.env, ZCODE_DISPATCH_STATE_DIR: stateDir, ZCODE_TASKS_DB: path.join(tmp, 'none.sqlite'), YOBIRU_BIN: stub,
    ZCODE_DISPATCH_JOB_ID: '5555555555555501', ZCODE_DISPATCH_SOURCE: 'yobiru', ZCODE_DISPATCH_PEER: GROK_PEER };
  delete env.ZCODE_PLUGIN_DATA; delete env.ZCODE_DISPATCH_NOTIFY;
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess_y', last_assistant_message: 'done' }), env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(yobiruLog), false);
  const rep = JSON.parse(fs.readFileSync(path.join(stateDir, 'reports', '5555555555555501.json'), 'utf8'));
  assert.equal(rep.yobiru_skipped, 'adapter-responds');
});

import { checkSchema as _checkSchema } from '../lib/appsession.mjs';
import { DatabaseSync as _Db } from 'node:sqlite';
import _os from 'node:os'; import _path from 'node:path'; import _fs from 'node:fs';
test('checkSchema flags a changed scheduler schema', () => {
  const p = _path.join(_fs.mkdtempSync(_path.join(_os.tmpdir(), 'zd-')), 'x.sqlite');
  const db = new _Db(p); db.exec('CREATE TABLE automations (automation_id TEXT); CREATE TABLE automation_runs (automation_id TEXT); CREATE TABLE tasks (task_id TEXT)'); db.close();
  assert.throws(() => _checkSchema(p), /schema changed \(missing: automations\.title/);
});

import { projectRegistered as _pr, ensureProjectRegistered as _epr, projectDeepLink as _pdl } from '../lib/appsession.mjs';
import { mkdtempSync as _mk, writeFileSync as _wf } from 'node:fs';
import { tmpdir as _td } from 'node:os';
import { join as _j } from 'node:path';
test('Projects placement: registered workspace is left alone', () => {
  const f = _j(_mk(_j(_td(), 'zs-')), 'setting.json'); _wf(f, JSON.stringify({ recentProjects: ['/Users/example/Projects/a'], other: 1 }));
  const opened = []; assert.equal(_pr('/Users/example/Projects/a', f), true);
  assert.equal(_epr('/Users/example/Projects/a', { settingsPath: f, opener: u => opened.push(u), warn: () => {} }), 'registered'); assert.deepEqual(opened, []);
});
test('Projects placement: unregistered workspace opens the official deep link once', () => {
  const f = _j(_mk(_j(_td(), 'zs-')), 'setting.json'); _wf(f, JSON.stringify({ recentProjects: [{ path: '/Users/example/Projects/a' }] }));
  const opened = []; assert.equal(_epr('/Users/example/Projects/b c', { settingsPath: f, opener: u => opened.push(u), warn: () => {} }), 'requested');
  assert.deepEqual(opened, ['zcode://workspace/open?path=%2FUsers%2Fexample%2FProjects%2Fb%20c']); assert.equal(_pdl('/a'), 'zcode://workspace/open?path=%2Fa');
});
test('Projects placement: unknown settings shape warns and skips', () => {
  const f = _j(_mk(_j(_td(), 'zs-')), 'setting.json'); _wf(f, JSON.stringify({ recentProjects: 'x' }));
  const w = []; assert.equal(_epr('/a', { settingsPath: f, opener: () => { throw new Error('no'); }, warn: m => w.push(m) }), 'unknown-schema'); assert.match(w[0], /not recognised/);
});
