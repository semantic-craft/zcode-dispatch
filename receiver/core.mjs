/**
 * zcode-dispatch receiver core (plain node, unit-testable): validation, Bearer
 * auth, job store and the headless runner (`bin/zcode-run -p ... --cwd ~/Projects/<p>`).
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { denyProjectsRe, projectsRoot, readConfigFile, resolveNetConfig } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/netconfig.mjs';
import { checkTransport, expandHome, peerForUrl, respond as transportRespond } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/transport.mjs';
import { resolveZcode } from '../lib/zcode-protocol.mjs';
import { ModelError, defaultModel, resolveModel } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/models.mjs';

const HOME = os.homedir();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULTS = {
  // env > ~/.config/zcode-dispatch/config.json > tailscale discovery (netconfig.mjs); lazy, never 0.0.0.0
  get host() { return resolveNetConfig().host; },
  get port() { return resolveNetConfig().port; },
  get allowedIps() { return resolveNetConfig().allowedIps; },   // Grok box tailnet IP(s)
  keyFile: path.join(HOME, '.config', 'zcode-dispatch', 'key'),
  stateDir: path.join(HOME, '.local', 'state', 'zcode-dispatch'),
  get projectsRoot() { return projectsRoot(); },   // ZCODE_DISPATCH_PROJECTS_ROOT / config projectsRoot / ~/Projects
  // env ZCODE_DISPATCH_RUNNER > config "runner" > bin/zcode-dispatch-run (app session -> CLI -> headless)
  get runner() { return expandHome(process.env.ZCODE_DISPATCH_RUNNER || readConfigFile().runner) || path.join(REPO, 'bin', 'zcode-dispatch-run'); },
  mode: 'yolo',
  get defaultModel() { return defaultModel(); },   // GLM-5.3 Flash unless ZCODE_DISPATCH_DEFAULT_MODEL / config defaultModel
  maxConcurrent: 2,
  defaultTimeoutSeconds: 1800,
  maxTimeoutSeconds: 7200,
  maxTextChars: 20000,
  maxResultChars: 100000,
};

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TAG_RE = /^\s*\[Project: ([^\]\n]+)\]/;
const JOB_RE = /^[0-9a-f]{16}$/;
const MODES = ['plan', 'edit', 'build', 'guarded', 'yolo'];
const SOURCES = ['grok-bot', 'yobiru', 'dsh', 'local', 'zcode'];

export class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

export function loadKey(file) {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`key file ${file} must be chmod 600`);
  const key = fs.readFileSync(file, 'utf8').trim();
  if (key.length < 32) throw new Error('key too short');
  return Buffer.from(key);
}
export function checkAuth(header, key) {
  const m = /^Bearer (\S+)$/.exec(header || '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  return got.length === key.length && timingSafeEqual(got, key);
}
export const normalizeIp = (ip) => (ip || '').replace(/^::ffff:/, '');

/** Resolve ~/Projects/<project> safely; throws HttpError. */
export function projectDir(cfg, project) {
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) throw new HttpError(400, 'project must be a plain folder name under ~/Projects');
  if (denyProjectsRe().test(project)) throw new HttpError(403, 'project not allowed');
  const root = fs.realpathSync(cfg.projectsRoot);
  let cwd;
  try { cwd = fs.realpathSync(path.join(root, project)); } catch { throw new HttpError(404, `no such project folder ~/Projects/${project}`); }
  if (path.dirname(cwd) !== root || !fs.statSync(cwd).isDirectory() || denyProjectsRe().test(cwd)) throw new HttpError(403, 'project folder must be a direct child of ~/Projects');
  return cwd;
}

export function validateDispatch(cfg, body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON object body required');
  const { project, text } = body;
  const cwd = projectDir(cfg, project);
  if (typeof text !== 'string' || !text.trim() || text.length > cfg.maxTextChars) throw new HttpError(400, `text required (max ${cfg.maxTextChars} chars)`);
  const tag = TAG_RE.exec(text);
  if (!tag || tag[1] !== project) throw new HttpError(400, `text must start with "[Project: ${project}]"`);
  const timeoutSeconds = body.timeout_seconds ?? cfg.defaultTimeoutSeconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > cfg.maxTimeoutSeconds) throw new HttpError(400, `timeout_seconds must be 10..${cfg.maxTimeoutSeconds}`);
  const mode = body.mode ?? cfg.mode;
  if (!MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${MODES.join(', ')}`);
  const source = body.source ?? 'grok-bot';
  if (!SOURCES.includes(source)) throw new HttpError(400, `source must be one of ${SOURCES.join(', ')}`);
  const jobId = body.job_id == null ? undefined : String(body.job_id);
  if (jobId !== undefined && !JOB_RE.test(jobId)) throw new HttpError(400, 'job_id must be 16 lowercase hex chars');
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const callbackPeer = str(body.callback_peer); const callbackUrl = str(body.callback_url);
  // Never POST results to arbitrary URLs: callback_url must point at a configured peer (its key is used).
  if (callbackUrl && !peerForUrl(callbackUrl)) throw new HttpError(400, 'callback_url must start with a configured peer url (config.json peers)');
  if (body.model != null && (typeof body.model !== 'string' || !body.model.trim())) throw new HttpError(400, 'model must be a ZCode model id string');
  let model;
  try { model = resolveModel(body.model, { available: cfg.availableModels?.() }).id; } catch (e) { throw new HttpError(400, e.message); }
  return { project, cwd, text, timeoutSeconds, mode, source, jobId, callbackPeer, callbackUrl, model };
}

/** Best-effort final text from `zcode -p --json` stdout (last JSON line with a text-ish field, else raw tail). */
export function extractResult(stdout) {
  const lines = stdout.trim().split('\n').reverse();
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    for (const k of ['result', 'text', 'final', 'output', 'message', 'content']) {
      const v = e?.[k];
      if (typeof v === 'string' && v.trim()) return { result: v, sessionId: e.sessionId ?? e.session_id ?? null };
    }
  }
  const sid = /sess_[0-9a-f-]{36}/.exec(stdout)?.[0] ?? null;
  return { result: stdout.trim() || null, sessionId: sid };
}

/** `model` from the runner's final JSON line (ZCode's own report of the session model), if any. */
export function finalModel(stdout) {
  for (const l of stdout.trim().split('\n').reverse()) { try { const e = JSON.parse(l); if (e?.type === 'final') return e.model ?? null; } catch {} }
  return null;
}

export class JobStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = path.join(cfg.stateDir, 'jobs');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.running = new Map();
  }
  file(id) { return path.join(this.dir, `${id}.json`); }
  save(job) { const t = this.file(job.id) + '.tmp'; fs.writeFileSync(t, JSON.stringify(job, null, 2), { mode: 0o600 }); fs.renameSync(t, this.file(job.id)); }
  get(id) { if (!JOB_RE.test(id || '')) return null; try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; } }
  reconcile() {
    for (const n of fs.readdirSync(this.dir)) {
      if (!n.endsWith('.json')) continue;
      const job = this.get(n.slice(0, -5));
      if (job?.state === 'running') { Object.assign(job, { state: 'failed', error: 'receiver restarted while job was running', finished_at: new Date().toISOString() }); this.save(job); }
    }
  }
}

export function startJob(store, spec, logger = console) {
  const cfg = store.cfg;
  if (spec.jobId) { const existing = store.get(spec.jobId); if (existing) return existing; }
  if (store.running.size >= cfg.maxConcurrent) throw new HttpError(429, `busy: ${store.running.size} jobs running`);
  const id = spec.jobId || randomBytes(8).toString('hex');
  const job = { id, project: spec.project, cwd: spec.cwd, mode: spec.mode, source: spec.source, timeout_seconds: spec.timeoutSeconds,
    state: 'running', created_at: new Date().toISOString(), text: spec.text, model: spec.model,
    ...(spec.callbackPeer ? { callback_peer: spec.callbackPeer } : {}), ...(spec.callbackUrl ? { callback_url: spec.callbackUrl } : {}) };
  store.save(job);
  const env = { ...process.env, ZCODE_DISPATCH_JOB_ID: id, ZCODE_DISPATCH_SOURCE: spec.source, ZCODE_DISPATCH_TIMEOUT: String(spec.timeoutSeconds), ...(spec.model ? { ZCODE_DISPATCH_MODEL: spec.model } : {}) };
  const child = spawn(cfg.runner, ['-p', spec.text, '--cwd', spec.cwd, '--mode', spec.mode, ...(spec.model ? ['--model', spec.model] : []), '--json', '--surface', 'terminal'],
    { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  store.running.set(id, child);
  let out = ''; let err = '';
  child.stdout.on('data', d => { if (out.length < 4e6) out += d; });
  child.stderr.on('data', d => { if (err.length < 2e5) err += d; });
  const timer = setTimeout(() => { job.timed_out = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, spec.timeoutSeconds * 1000);
  const finish = (code, signal, e) => {
    clearTimeout(timer); store.running.delete(id);
    fs.writeFileSync(path.join(store.dir, `${id}.stdout`), out, { mode: 0o600 });
    const { result, sessionId } = extractResult(out);
    const reportedModel = finalModel(out);
    const ok = !e && code === 0 && !job.timed_out;
    Object.assign(job, { ...(reportedModel ? { session_model: reportedModel } : {}), state: ok ? 'completed' : 'failed', exit_code: code, signal: signal ?? null, session_id: sessionId,
      finished_at: new Date().toISOString(), result: result == null ? null : String(result).slice(0, cfg.maxResultChars),
      error: ok ? null : e ? String(e.message) : job.timed_out ? 'timeout' : (err.trim() || out.trim()).split('\n').slice(-5).join('\n').slice(0, 2000) || `exit ${code}` });
    store.save(job);
    if (job.callback_peer || job.callback_url) {
      // Push (direct HTTP callback); GET /v1/jobs/<id> polling keeps working either way.
      const payload = { type: 'zcode-job-report-v1', job_id: id, session_id: job.session_id, project: job.project, source: job.source,
        state: job.state, result: job.result, error: job.error, finished_at: job.finished_at };
      transportRespond(job, payload).then((r) => {
        Object.assign(job, { reported: Boolean(r.method), report_method: r.method, report_error: r.error ?? null }); store.save(job);
        logger.info?.(`job ${id} callback ${r.method ? `sent (${r.method} -> ${r.peer})` : `FAILED: ${r.error}`}`);
      });
    }
    logger.info?.(`job ${id} ${job.state} exit=${code}${job.state === 'failed' ? ` error=${JSON.stringify(String(job.error).slice(0, 300))}` : ''}`);
  };
  child.on('error', e => finish(null, null, e));
  child.on('close', (c, s) => finish(c, s));
  return job;
}

export function publicJob(job) { const { text, cwd, ...rest } = job; return { ...rest, text_preview: text.slice(0, 200) }; }

/** Startup compatibility check -> {ok, transport, errors[], warnings[]}; logged at start and served on /health. */
export function checkCompat(cfg, { zcode = () => resolveZcode() } = {}) {
  const errors = []; const warnings = [];
  try { loadKey(cfg.keyFile); } catch (e) { errors.push(`key: ${e.code === 'ENOENT' ? `missing ${cfg.keyFile} (openssl rand -hex 32 > it; chmod 600)` : e.message}`); }
  if (!cfg.host) errors.push('host: no bind host (set "host" in ~/.config/zcode-dispatch/config.json or DISPATCH_HOST; tailscale discovery found none)');
  if (!cfg.allowedIps?.length) errors.push('allowedIps: empty, every caller is refused (set "allowedIps" or DISPATCH_ALLOWED_IPS)');
  try { fs.accessSync(cfg.projectsRoot); } catch { errors.push(`projectsRoot: ${cfg.projectsRoot} does not exist`); }
  try { fs.accessSync(cfg.runner, fs.constants.X_OK); } catch { errors.push(`runner: ${cfg.runner} not executable`); }
  if (!process.env.ZCODE_DISPATCH_RUNNER && !readConfigFile().runner) {
    try { zcode(); } catch (e) { errors.push(`zcode: ${e.message.replace(/^\[zcode-dispatch\] /, '')} (install ZCode or set ZCODE_BIN / ZCODE_APP)`); }
  }
  try { const m = resolveModel(undefined, { available: cfg.availableModels?.() }); if (m.id !== cfg.defaultModel) warnings.push(`model: default resolved to ${m.id}`); }
  catch (e) { errors.push(`model: ${e.message.replace(/^\[zcode-dispatch\] /, '')}`); }
  const t = checkTransport();
  errors.push(...t.errors); warnings.push(...t.warnings);
  return { ok: errors.length === 0, transport: t.transport, defaultModel: cfg.defaultModel, errors, warnings };
}
