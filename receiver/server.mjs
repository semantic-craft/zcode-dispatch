#!/usr/bin/env node
/**
 * zcode-dispatch HTTP receiver: GET /health, POST /v1/jobs, GET /v1/jobs/<id>, POST /v1/callbacks.
 * Start it on any OS with `node receiver/server.mjs` (or `npm start`); launchd/systemd are optional wrappers.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, HttpError, JobStore, checkAuth, checkCompat, loadKey, normalizeIp, publicJob, startJob, validateDispatch } from './core.mjs';

const cfg = { ...DEFAULTS };
const logDir = path.join(cfg.stateDir, 'logs'); fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logFile = path.join(logDir, 'dispatch.log');
const log = (lvl, msg) => {
  try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.1'); } catch {}
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${lvl} ${msg}\n`, { mode: 0o600 });
  if (lvl !== 'INFO' || process.env.ZCODE_DISPATCH_LOG_STDERR) process.stderr.write(`[zcode-dispatch] ${lvl} ${msg}\n`);
};
const logger = { info: m => log('INFO', m), warn: m => log('WARN', m), error: m => log('ERROR', m) };

const checks = checkCompat(cfg);
for (const e of checks.errors) logger.error(`compat check FAILED: ${e}`);
for (const w of checks.warnings) logger.warn(`compat check: ${w}`);
logger.info(`compat check ${checks.ok ? 'ok' : 'FAILED'} transport=${checks.transport} runner=${cfg.runner}`);
let key;
try { key = loadKey(cfg.keyFile); } catch (e) { logger.error(`cannot start without a key: ${e.message}`); process.exit(1); }
const store = new JobStore(cfg); store.reconcile();
const outgoing = path.join(cfg.stateDir, 'outgoing');

const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req, limit) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', d => { raw += d; if (raw.length > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'invalid JSON')); } });
});
const health = () => { const c = checkCompat(cfg); return { ok: c.ok, running: store.running.size, runner: 'zcode-app-session (headless fallback)', transport: c.transport, checks: { errors: c.errors, warnings: c.warnings } }; };

const server = http.createServer(async (req, res) => {
  const ip = normalizeIp(req.socket.remoteAddress);
  const self = ip === cfg.host || ip === '127.0.0.1';
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health' && req.method === 'GET' && (self || cfg.allowedIps.includes(ip))) return send(res, 200, health());
  if (!cfg.allowedIps.includes(ip)) { logger.warn(`forbidden ip ${ip} ${req.method} ${url.pathname}`); return send(res, 403, { error: 'forbidden' }); }
  if (!checkAuth(req.headers.authorization, key)) { logger.warn(`auth failed from ${ip}`); return send(res, 401, { error: 'unauthorized' }); }
  try {
    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      const job = startJob(store, validateDispatch(cfg, await readBody(req, 100000)), logger);
      logger.info(`job ${job.id} received project=${job.project} source=${job.source} from ${ip}`);
      return send(res, 202, publicJob(job));
    }
    // Direct-transport push: a peer (e.g. DSH) reports the result of a job we dispatched to it (dispatch_to_dsh via http).
    if (req.method === 'POST' && url.pathname === '/v1/callbacks') {
      const r = await readBody(req, 400000);
      const id = r?.job_id;
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'job_id (16 hex) required');
      const f = path.join(outgoing, `${id}.json`);
      let prev = {}; try { prev = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
      fs.mkdirSync(outgoing, { recursive: true, mode: 0o700 });
      const next = { id, ...prev, state: r.state === 'completed' ? 'completed' : 'failed', result: r.result ?? null, error: r.error ?? null,
        remote_session_id: r.session_id ?? null, callback_received_at: new Date().toISOString() };
      fs.writeFileSync(f, JSON.stringify(next, null, 2), { mode: 0o600 });
      logger.info(`callback received for job ${id} state=${next.state} from ${ip}`);
      return send(res, 200, { ok: true, job_id: id });
    }
    const m = /^\/v1\/jobs\/([0-9a-f]{16})$/.exec(url.pathname);
    if (req.method === 'GET' && m) { const job = store.get(m[1]); return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: 'not found' }); }
    send(res, 404, { error: 'not found' });
  } catch (e) { if (e.code !== 404) logger.warn(`rejected: ${e.message}`); send(res, e instanceof HttpError ? e.code : 500, { error: e.message }); }
});
if (!cfg.host) {
  // No configured/discovered bind host: never bind 0.0.0.0. Exit non-zero (a supervisor such as launchd may retry).
  logger.error('no bind host (set DISPATCH_HOST or "host" in ~/.config/zcode-dispatch/config.json, or bring tailscale up); exiting');
  setTimeout(() => process.exit(1), Number(process.env.ZCODE_DISPATCH_EXIT_DELAY_MS ?? 30000));
} else server.listen(cfg.port, cfg.host, () => logger.info(`listening ${cfg.host}:${cfg.port} allowed=${cfg.allowedIps.join(',')}`));
server.on('error', e => { logger.error(`listen error ${e.code}`); setTimeout(() => process.exit(1), Number(process.env.ZCODE_DISPATCH_EXIT_DELAY_MS ?? 30000)); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { logger.info('stopping'); server.close(); process.exit(0); });
