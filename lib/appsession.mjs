/**
 * Visible-session runner: hands a job to the running ZCode.app through its own
 * automation scheduler (tasks-index.sqlite `automations`, one-shot row). The app's
 * scheduler (polls every 20 s, BEGIN IMMEDIATE claims) forwards it to the Host, which runs
 * zcodeTaskService.createTask({workspacePath, model, mode}) + sendPrompt — i.e. a normal
 * left-sidebar session, attached to the project, using the desktop's own login/model
 * with model_selection = {providerId, modelId} of the resolved dispatch model (default GLM-5.3 Flash,
 * lib/models.mjs; the same JSON shape ZCode writes into automation_runs.model_selection), mode yolo.
 * After pickup the session's own tasks.model is compared with the requested id; a mismatch fails the job.
 *
 * To support Stop-hook auto-reporting (since ZCode.app sessions do not inherit runner env vars),
 * enqueue() embeds `[job: <16-hex>]` in both the prompt and session/automation title and persists
 * `session_id <-> job_id` in `session-jobs.json` (via job-map.mjs).
 *
 * Source refs (zai-org/ZCode@aac4755): desktop/src/scheduler/index.ts,
 * desktop/src/host/index.ts dispatchCronRun, services/src/session/automationRepo.ts create().
 * We never read credentials.
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNetConfig } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/netconfig.mjs';
import { parseModel, sameModel } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/models.mjs';
import {
  JOB_ID_RE,
  bindSession,
  defaultStateDir,
  extractTags,
  isGrokDispatched,
  isGrokPeer,
  loadMap,
  resolveJob,
  summaryTitle,
  upsertJob,
  withSource,
} from '../marketplace/plugins/zcode-grokbot-dispatch/lib/job-map.mjs';

export { bindSession, extractTags, isGrokDispatched, isGrokPeer, loadMap, resolveJob, summaryTitle, upsertJob, withSource };

export const DB_PATH = process.env.ZCODE_TASKS_DB || path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
const MODES = new Set(['default', 'yolo', 'guarded', 'plan', 'edit', 'build']);

export function appRunning() {
  if (process.env.ZCODE_DISPATCH_FORCE_HEADLESS === '1') return false;
  try { execFileSync('/usr/bin/pgrep', ['-x', 'ZCode'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function open(dbPath = process.env.ZCODE_TASKS_DB || DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function enqueue({ cwd, text, mode = 'yolo', model, source, jobId, notify, notifyPeer, now = Date.now(), stateDir, dbPath }) {
  if (!MODES.has(mode)) throw new Error(`mode ${mode} not allowed`);
  const id = `automation-zcode-dispatch-${randomUUID()}`;
  const d = new Date(now);
  const cron = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
  const rawJob = jobId ?? process.env.ZCODE_DISPATCH_JOB_ID ?? extractTags(text).jobId ?? null;
  const effectiveJobId = JOB_ID_RE.test(rawJob || '') ? rawJob : null;
  const prompt = withSource(text, source, effectiveJobId);
  const title = summaryTitle(text, source, effectiveJobId);
  const sel = model ? (({ providerId, modelId }) => JSON.stringify({ providerId, modelId }))(parseModel(model)) : 'null';
  const db = open(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO automations (automation_id,title,cron_expr,prompt,model,provider,model_selection,
        workspace_key,workspace_path,location_kind,recurring,max_runs,enabled,lifecycle_status,next_run_at,
        running,dispatch_status,dispatch_attempts,mode,created_at,updated_at)
        VALUES (?,?,?,?,NULL,NULL,?,?,?,'local',0,1,1,'active',?,0,'idle',0,?,?,?)`)
        .run(id, title, cron, prompt, sel, cwd, cwd, now, mode, now, now);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }

  if (effectiveJobId) {
    const tags = extractTags(text);
    const effectiveSource = source || tags.source || process.env.ZCODE_DISPATCH_SOURCE || 'dispatch';
    const inboundPeer = notifyPeer || process.env.ZCODE_DISPATCH_PEER || null;
    const rawNotify = notify ?? process.env.ZCODE_DISPATCH_NOTIFY ?? null;
    const grokDispatched = isGrokDispatched(
      { source: effectiveSource, notify: rawNotify, notify_peer: inboundPeer },
      process.env
    );
    const effectiveNotify =
      rawNotify === 'none' || rawNotify === '0' || rawNotify === 'false'
        ? 'none'
        : grokDispatched
          ? 'grok'
          : null;
    upsertJob({
      job_id: effectiveJobId,
      automation_id: id,
      project: tags.project || (cwd ? path.basename(cwd) : null),
      cwd: cwd || null,
      source: effectiveSource,
      notify: effectiveNotify,
      notify_peer:
        effectiveNotify === 'grok'
          ? (inboundPeer || resolveNetConfig().grokPeer)
          : inboundPeer,
      created_at: new Date(now).toISOString(),
    }, { stateDir });
  }
  return id;
}

export function poll(id, dbPath) {
  const db = open(dbPath);
  try {
    const a = db.prepare('SELECT lifecycle_status,dispatch_status,last_error,dispatch_attempts FROM automations WHERE automation_id=?').get(id);
    const r = db.prepare('SELECT dispatch_status,outcome,session_id,error,model_selection FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC LIMIT 1').get(id);
    let task = null;
    if (r?.session_id) task = db.prepare('SELECT title,task_status,searchable_text,model FROM tasks WHERE task_id=?').get(r.session_id) ?? null;
    return { automation: a ?? null, run: r ?? null, task };
  } finally { db.close(); }
}

/** Drop our finished one-shot row (app keeps max 20 automations); the session itself stays. */
export function cleanup(id, dbPath) {
  if (!id.startsWith('automation-zcode-dispatch-')) return;
  const db = open(dbPath);
  try { db.prepare("DELETE FROM automations WHERE automation_id=? AND running=0 AND lifecycle_status!='active'").run(id); } finally { db.close(); }
}

export function resultText(task, prompt) {
  if (!task?.searchable_text) return null;
  let s = task.searchable_text;
  const i = s.indexOf(prompt.trim());
  if (i >= 0) s = s.slice(i + prompt.trim().length);
  return s.trim() || null;
}

function readStopReportText(jobId, stateDir = defaultStateDir()) {
  if (!JOB_ID_RE.test(jobId || '')) return null;
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(stateDir, 'reports', `${jobId}.json`), 'utf8'));
    return typeof rep?.text === 'string' && rep.text.trim() ? rep.text.trim() : null;
  } catch { return null; }
}

/**
 * Projects placement. ZCode's left "Projects" view lists only workspaces in setting.json
 * `recentProjects`; any task whose workspace is registered there (including scheduler/cron
 * runs) is shown under that project. So instead of touching task-group membership we
 * register the workspace through ZCode's own official deep link
 * `zcode://workspace/open?path=<abs>` (the same URL its Finder "Open in ZCode" service uses).
 * ZCode asks the user once per folder ("Open this folder in ZCode?"); we never click it.
 * Only the `recentProjects` key is read from setting.json; if its shape is unrecognised we
 * warn and skip (dispatch still proceeds, the session lands in the automation group).
 */
export const SETTINGS_PATH = process.env.ZCODE_SETTINGS || path.join(os.homedir(), '.zcode', 'v2', 'setting.json');
export function projectRegistered(cwd, settingsPath = SETTINGS_PATH) {
  let rp;
  try { rp = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).recentProjects; } catch { return null; }
  if (!Array.isArray(rp)) return null;
  const paths = rp.map(e => (typeof e === 'string' ? e : (e && typeof e.path === 'string' ? e.path : null)));
  if (paths.some(p => p === null)) return null;
  const want = path.resolve(cwd);
  return paths.some(p => path.resolve(p) === want);
}
export function projectDeepLink(cwd) { return `zcode://workspace/open?path=${encodeURIComponent(path.resolve(cwd))}`; }
export function ensureProjectRegistered(cwd, { settingsPath, opener = (url) => execFileSync('/usr/bin/open', [url], { stdio: 'ignore' }), warn = (m) => process.stderr.write(m + '\n') } = {}) {
  if (process.env.ZCODE_DISPATCH_REGISTER_PROJECT === '0') return 'disabled';
  const r = projectRegistered(cwd, settingsPath);
  if (r === true) return 'registered';
  if (r === null) { warn('[zcode-dispatch] WARNING: ZCode setting.json recentProjects shape not recognised; skipping Projects registration (session will show under Automation).'); return 'unknown-schema'; }
  try { opener(projectDeepLink(cwd)); } catch (e) { warn(`[zcode-dispatch] WARNING: could not open ZCode deep link (${e.message}); session will show under Automation.`); return 'open-failed'; }
  warn(`[zcode-dispatch] Registering ${cwd} in ZCode Projects via ${projectDeepLink(cwd)} — confirm "Open folder" once in ZCode.`);
  return 'requested';
}

/** Run to completion. Returns {automationId, jobId, sessionId, result, outcome, error}. */
export async function runInApp({ cwd, text, mode, model, source, jobId, notify, notifyPeer, timeoutSeconds = 1800, pickupSeconds = 90, pollMs = 1000, stateDir, dbPath, onProgress = () => {}, registerProject = ensureProjectRegistered }) {
  const rawJob = jobId ?? process.env.ZCODE_DISPATCH_JOB_ID ?? extractTags(text).jobId ?? null;
  const effectiveJobId = JOB_ID_RE.test(rawJob || '') ? rawJob : null;
  const placement = registerProject(cwd);
  onProgress({ projectPlacement: placement });
  const id = enqueue({ cwd, text, mode, model, source, jobId: effectiveJobId, notify, notifyPeer, stateDir, dbPath });
  const prompt = withSource(text, source, effectiveJobId);
  const t0 = Date.now(); let sid = null;
  for (;;) {
    await new Promise(r => setTimeout(r, pollMs));
    const s = poll(id, dbPath);
    if (s.run?.session_id && s.run.session_id !== sid) {
      sid = s.run.session_id;
      if (effectiveJobId) bindSession({ sessionId: sid, jobId: effectiveJobId, automationId: id, source, cwd }, { stateDir });
      onProgress({ automationId: id, jobId: effectiveJobId, sessionId: sid });
    }
    if (model && s.task?.model && !sameModel(s.task.model, model)) {
      // ZCode ran the session on another model than requested: report loudly, never pass it off as the requested one.
      if (sid && effectiveJobId) bindSession({ sessionId: sid, jobId: effectiveJobId, automationId: id, source, cwd }, { stateDir });
      return { automationId: id, jobId: effectiveJobId, sessionId: sid, model: s.task.model, outcome: 'failed', result: null,
        error: `[zcode-dispatch] model mismatch: requested ${model}, ZCode session ${sid} reports ${s.task.model} (session left running in ZCode.app; stop it there if unwanted)` };
    }
    if (s.run?.outcome && s.run.outcome !== 'running') {
      if (sid && effectiveJobId) bindSession({ sessionId: sid, jobId: effectiveJobId, automationId: id, source, cwd }, { stateDir });
      cleanup(id, dbPath);
      const ok = s.run.outcome === 'succeeded';
      const extracted = resultText(s.task, prompt) || readStopReportText(effectiveJobId, stateDir);
      return {
        automationId: id,
        jobId: effectiveJobId,
        sessionId: sid,
        model: s.task?.model ?? null,
        outcome: s.run.outcome,
        result: extracted,
        error: ok ? null : (s.run.error || s.automation?.last_error || s.run.outcome),
      };
    }
    const age = (Date.now() - t0) / 1000;
    if (!s.run && age > pickupSeconds) {
      const db = open(dbPath);
      try { db.prepare("DELETE FROM automations WHERE automation_id=? AND running=0 AND dispatch_attempts=0 AND NOT EXISTS (SELECT 1 FROM automation_runs WHERE automation_id=?)").run(id, id); } finally { db.close(); }
      return { automationId: id, jobId: effectiveJobId, sessionId: null, outcome: 'not_picked_up', result: null, error: 'ZCode.app scheduler did not pick up the job' };
    }
    if (age > timeoutSeconds) return { automationId: id, jobId: effectiveJobId, sessionId: sid, outcome: 'timeout', result: null, error: 'timeout (session keeps running in ZCode.app)' };
  }
}

/**
 * Compat check for the scheduler internals this adapter writes/reads (ZCode.app 3.15.x layout).
 * Throws AppSchemaError with the missing pieces so the router can fall back loudly.
 */
export const REQUIRED_SCHEMA = {
  automations: ['automation_id', 'title', 'cron_expr', 'prompt', 'model', 'provider', 'model_selection', 'workspace_key', 'workspace_path',
    'location_kind', 'recurring', 'max_runs', 'enabled', 'lifecycle_status', 'next_run_at', 'running', 'dispatch_status', 'dispatch_attempts',
    'mode', 'created_at', 'updated_at', 'last_error'],
  automation_runs: ['automation_id', 'dispatch_status', 'outcome', 'session_id', 'error', 'created_at', 'model_selection'],
  tasks: ['task_id', 'title', 'task_status', 'searchable_text', 'model'],
};
export class AppSchemaError extends Error {}
export function checkSchema(dbPath) {
  const p = dbPath || process.env.ZCODE_TASKS_DB || DB_PATH;
  if (!fs.existsSync(p)) throw new AppSchemaError(`[zcode-dispatch] ZCode tasks index not found at ${p}; app-scheduler path unavailable`);
  const db = open(p);
  try {
    const missing = [];
    for (const [t, cols] of Object.entries(REQUIRED_SCHEMA)) {
      const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
      if (!have.size) { missing.push(`table ${t}`); continue; }
      for (const c of cols) if (!have.has(c)) missing.push(`${t}.${c}`);
    }
    if (missing.length) throw new AppSchemaError(`[zcode-dispatch] ZCode.app scheduler schema changed (missing: ${missing.join(', ')}). Update lib/appsession.mjs; falling back.`);
    return true;
  } finally { db.close(); }
}
