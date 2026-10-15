// transport.mjs: direct HTTP (default) vs yobiru (opt-in), dispatch_to_dsh over HTTP, compat check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-transport-'));
const CONFIG = path.join(dir, 'config.json');
const KEY = path.join(dir, 'peer.key');
fs.writeFileSync(KEY, 'k'.repeat(64), { mode: 0o600 });
fs.mkdirSync(path.join(dir, 'Projects', 'demo'), { recursive: true });
process.env.ZCODE_DISPATCH_CONFIG = CONFIG;
process.env.ZCODE_DISPATCH_DISCOVERY = '0';
process.env.ZCODE_DISPATCH_PROJECTS_ROOT = path.join(dir, 'Projects');
for (const k of ['ZCODE_DISPATCH_TRANSPORT', 'ZCODE_DISPATCH_GROK_PEER', 'DISPATCH_HOST', 'DISPATCH_ALLOWED_IPS', 'ZCODE_DISPATCH_RUNNER', 'DSH_BIN']) delete process.env[k];
const writeCfg = (c) => fs.writeFileSync(CONFIG, JSON.stringify(c));

const T = await import('../marketplace/plugins/zcode-dispatch/lib/transport.mjs');
const D = await import('../marketplace/plugins/zcode-dispatch/lib/dispatch.mjs');
const { checkCompat, validateDispatch, HttpError } = await import('../receiver/core.mjs');

function peerServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(req.method === 'POST' && req.url === '/v1/jobs' ? 202 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.startsWith('/v1/jobs/') ? { id: req.url.slice(9), state: 'completed', result: 'remote done' } : { id: body?.job_id ?? 'x', state: 'running' }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('transport defaults to direct; "yobiru" opt-in; invalid rejected', () => {
  writeCfg({}); assert.equal(T.transportName(), 'direct');
  writeCfg({ transport: 'yobiru' }); assert.equal(T.transportName(), 'yobiru');
  writeCfg({ transport: 'x' }); assert.throws(() => T.transportName(), /direct" or "yobiru/);
});

test('dispatch_to_dsh: HTTP to peers.dsh /v1/jobs when configured, then status pulls from DSH', async () => {
  const p = await peerServer();
  writeCfg({ peers: { dsh: { url: p.url, keyFile: KEY } }, selfName: 'zcode' });
  const out = await D.toDsh({ project: 'demo', text: 'say hi', timeout_seconds: 60 });
  assert.equal(out.via, 'http');
  assert.deepEqual(p.seen[0], { method: 'POST', url: '/v1/jobs', auth: `Bearer ${'k'.repeat(64)}`,
    body: { project: 'demo', text: '[Project: demo] say hi', timeout_seconds: 60, source: 'zcode', job_id: out.job_id, callback_peer: 'zcode' } });
  const st = await D.status({ id: out.job_id });
  assert.equal(st.state, 'completed'); assert.equal(st.result, 'remote done');
  assert.equal(p.seen[1].url, `/v1/jobs/${out.job_id}`);
  p.srv.close();
});

test('dispatch_to_dsh stays local (detached dsh) without peers.dsh; refuses clearly when dsh is missing', async () => {
  writeCfg({ dshBin: '/nonexistent/dsh' });
  assert.equal(D.CFG.dshVia, 'local');
  await assert.rejects(D.toDsh({ project: 'demo', text: 'x' }), /dsh not found/);
  writeCfg({ dshBin: '/bin/true' });
  assert.equal(D.CFG.dsh, '/bin/true');
});

test('yobiru: dispatch_to_grokbot argv is unchanged from v0.2', async () => {
  const log = path.join(dir, 'y.log'); const stub = path.join(dir, 'yobiru.sh');
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho 'sent request 0123456789abcdef'\n`, { mode: 0o755 });
  process.env.YOBIRU_BIN = stub; process.env.TAILMSG_HOME = path.join(dir, 'tm');
  writeCfg({ transport: 'yobiru', grokPeer: 'grok-box.example.test/grok' });
  const out = await D.toGrokBot({ project: 'demo', text: 'do x', timeout_seconds: 99 });
  assert.equal(out.request_id, '0123456789abcdef');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
    ['--home', path.join(dir, 'tm'), 'request', 'send', 'grok-box.example.test/grok', '[Project: demo] do x', '--as', 'zcode', '--wake', 'now', '--timeout-seconds', '99']);
  delete process.env.YOBIRU_BIN; delete process.env.TAILMSG_HOME;
});

test('direct respond: callback_peer -> /v1/callbacks; callback_url only to configured peers', async () => {
  const p = await peerServer();
  writeCfg({ peers: { dsh: { url: p.url, keyFile: KEY } } });
  const payload = { job_id: 'aaaaaaaaaaaaaaaa', state: 'completed', result: 'r' };
  assert.equal((await T.respond({ callback_peer: 'dsh' }, payload)).method, 'http-callback');
  assert.equal(p.seen.at(-1).url, '/v1/callbacks'); assert.deepEqual(p.seen.at(-1).body, payload);
  assert.equal((await T.respond({ callback_url: `${p.url}/hook` }, payload)).method, 'http-callback');
  const n = p.seen.length;
  assert.equal((await T.respond({ callback_url: 'http://192.0.2.99/x' }, payload)).method, null);
  assert.equal(p.seen.length, n);
  const cfg = { projectsRoot: path.join(dir, 'Projects'), maxTextChars: 1000, defaultTimeoutSeconds: 60, maxTimeoutSeconds: 100, mode: 'yolo' };
  const body = { project: 'demo', text: '[Project: demo] x', job_id: 'bbbbbbbbbbbbbbbb', callback_peer: 'dsh' };
  assert.deepEqual(validateDispatch(cfg, body).jobId, 'bbbbbbbbbbbbbbbb');
  assert.throws(() => validateDispatch(cfg, { ...body, callback_url: 'http://evil.example/' }), HttpError);
  p.srv.close();
});

test('checkCompat reports every missing prerequisite', () => {
  writeCfg({ transport: 'yobiru' });
  process.env.TAILMSG_HOME = path.join(dir, 'none');
  const bad = checkCompat({ keyFile: path.join(dir, 'nokey'), host: null, allowedIps: [], projectsRoot: '/nonexistent', runner: '/nonexistent/run' },
    { zcode: () => { throw new Error('zcode CLI not found'); } });
  delete process.env.TAILMSG_HOME;
  assert.equal(bad.ok, false);
  for (const re of [/^key: missing/, /^host:/, /^allowedIps:/, /^projectsRoot:/, /^runner:/, /^zcode:/, /^yobiru: no Yobiru CLI/]) assert.ok(bad.errors.some((e) => re.test(e)), String(re));
  writeCfg({});
  const good = checkCompat({ keyFile: KEY, host: '127.0.0.1', allowedIps: ['127.0.0.1'], projectsRoot: dir, runner: '/bin/true' }, { zcode: () => ({}) });
  assert.equal(good.ok, true, JSON.stringify(good)); assert.equal(good.transport, 'direct');
});
