/**
 * ZCode dispatch adapter — the ONE module that knows ZCode specifics (see docs/ZCODE-SURFACES.md).
 *
 * Task execution: official headless CLI `zcode -p … --output-format stream-json [--resume sess_…]`
 *   (standalone Prompt CLI; owns its login via `zcode login bigmodel`; model = the CLI's selected default,
 *   e.g. account:bigmodel-individual-coding-plan/GLM-5.3). Session id from the first stream event.
 * Compat probe: `zcode app-server --stdio` (documented ZCode Protocol, zai-org/ZCode
 *   apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md) — `session/create` must report
 *   {name:"ZCode Protocol",version:1}. app-server is NOT used for turns: it is the desktop's private agent
 *   server and gets account config + per-request auth from its host (ZCode.app), which we are not.
 * Bundle layout (unavoidable, only in resolveZcode()): Contents/Resources/glm/zcode.cjs plus
 *   ZCODE_BUILTIN_PROVIDER_CONFIG_FILE / ZCODE_PERSONAL_PROVIDER_CONFIG_FILE (approach as in
 *   william0wang/zcode-acp src/backend/resolve.ts, Apache-2.0). Never reads credential files.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SUPPORTED_PROTOCOL = { name: 'ZCode Protocol', versions: [1] };

export class ZCodeCompatError extends Error {
  constructor(msg, detail) { super(`[zcode-dispatch] ZCode compatibility check failed: ${msg}`); this.detail = detail; }
}

/** Locate the CLI: ZCODE_BIN > `zcode` on PATH > app bundle. Returns {cmd, args, env}. */
export function resolveZcode(env = process.env) {
  const app = env.ZCODE_APP || '/Applications/ZCode.app';
  let bin = env.ZCODE_BIN;
  if (!bin) { try { bin = execFileSync('/usr/bin/which', ['zcode'], { encoding: 'utf8' }).trim() || null; } catch { bin = null; } }
  if (!bin) bin = path.join(app, 'Contents/Resources/glm/zcode.cjs');
  if (!fs.existsSync(bin)) throw new ZCodeCompatError(`zcode CLI not found (tried ZCODE_BIN, PATH, ${bin})`);
  const extra = {};
  if (/\.(c|m)?js$/.test(bin)) {
    const dir = path.dirname(bin);
    const table = [path.join(dir, 'provider/zcode-builtin.json'), path.join(dir, '../config/provider/zcode-builtin.json')].find(f => fs.existsSync(f));
    if (table) {
      extra.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = table;
      extra.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(os.homedir(), '.zcode/v2/provider_config.json');
    }
    const node = env.ZCODE_NODE || process.execPath;
    return { cmd: node, args: [bin], env: extra, bin };
  }
  return { cmd: bin, args: [], env: extra, bin };
}

export function cliVersion(z = resolveZcode()) {
  try { return execFileSync(z.cmd, [...z.args, '--version'], { encoding: 'utf8', env: { ...process.env, ...z.env }, timeout: 20000 }).trim(); }
  catch { return null; }
}

/** Minimal NDJSON client for `zcode app-server --stdio`. */
export class ZCodeProtocolClient {
  constructor({ spawnSpec, env = process.env, log = () => {} } = {}) {
    this.spec = spawnSpec || (() => { const z = resolveZcode(env); return { cmd: z.cmd, args: [...z.args, 'app-server', '--stdio'], env: { ...env, ...z.env } }; })();
    this.log = log; this.nextId = 1; this.pending = new Map(); this.listeners = new Set(); this.buf = ''; this.stderr = '';
  }
  start() {
    const s = this.spec;
    this.proc = spawn(s.cmd, s.args, { env: s.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', d => this.#onData(d));
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-8000); });
    this.exited = new Promise(r => this.proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) p.reject(new Error(`app-server exited (${code ?? sig})`));
      this.pending.clear(); r({ code, sig });
    }));
    return this;
  }
  #write(o) { this.proc.stdin.write(JSON.stringify(o) + '\n'); }
  #onData(d) {
    this.buf += d; let n;
    while ((n = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, n); this.buf = this.buf.slice(n + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { this.log(`non-JSON frame: ${line.slice(0, 120)}`); continue; }
      if (m.id != null && !m.method) {
        const p = this.pending.get(m.id); if (!p) continue; this.pending.delete(m.id);
        m.error ? p.reject(Object.assign(new Error(m.error.message || 'protocol error'), { code: m.error.code, data: m.error.data })) : p.resolve(m.result);
      } else if (m.method && m.id != null) this.#serverRequest(m);
      else if (m.method) for (const l of this.listeners) l(m);
    }
  }
  #serverRequest(m) {
    if (m.method === 'session/requestRuntimePreferences') {
      return this.#write({ id: m.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true } });
    }
    if (m.method === 'interaction/requestProviderRuntimeHeaders') {
      // We are not the desktop host and hold no credentials; the CLI's own login must cover this.
      return this.#write({ id: m.id, result: { headersApplied: false, errorMessage: 'zcode-dispatch host does not supply provider auth; run `zcode login bigmodel` once' } });
    }
    this.log(`unhandled server request ${m.method}`);
    this.#write({ id: m.id, error: { code: -32601, message: `zcode-dispatch does not handle ${m.method}` } });
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.#write({ id, method, params });
    });
  }
  onNotification(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async close() { if (!this.proc) return; try { this.proc.stdin.end(); } catch {} const t = setTimeout(() => this.proc.kill('SIGTERM'), 2500); await this.exited; clearTimeout(t); }
}

export function workspace(cwd) { return { workspacePath: cwd, workspaceKey: cwd }; }

/** Validate a session/create (or resume) snapshot against what this module understands. */
export function checkCompat(snap) {
  const proto = snap?.protocol;
  if (!proto || proto.name !== SUPPORTED_PROTOCOL.name || !SUPPORTED_PROTOCOL.versions.includes(proto.version)) {
    throw new ZCodeCompatError(`unsupported protocol ${JSON.stringify(proto)}; expected ${SUPPORTED_PROTOCOL.name} v${SUPPORTED_PROTOCOL.versions.join('/')}. Update lib/zcode-protocol.mjs.`, proto);
  }
  if (!snap.session?.sessionId) throw new ZCodeCompatError('session/create returned no session.sessionId', Object.keys(snap || {}));
  if (!Array.isArray(snap.settings?.model?.available)) throw new ZCodeCompatError('session/create returned no settings.model.available list', snap.settings);
  return true;
}

export function noModelsError(detail = '') {
  return new ZCodeCompatError('the zcode CLI has no usable model (' + (detail || 'not logged in') + '). ' +
    'Desktop logins are brokered by ZCode.app and are not shared with the standalone CLI. ' +
    'Fix (once, interactive): run `zcode login bigmodel` (bundled CLI: bin/zcode-run login bigmodel) on the ZCode host.');
}

/** Text of the last visible assistant message. */
export function finalText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.info?.role !== 'assistant') continue;
    if (m.info.semantics?.transcriptVisibility === 'hidden') continue;
    const t = (m.parts || []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('').trim();
    if (t) return t;
  }
  return null;
}

/**
 * Startup / selfcheck probe. Always: CLI version + app-server protocol identity (no prompt).
 * live=true additionally runs a one-line prompt through the CLI path to prove entitlement
 * (the only backend-owned answer a standalone CLI gives; app-server model lists are host-fed).
 */
export async function probe({ cwd = os.tmpdir(), client, live = false, spawnSpec, log } = {}) {
  const c = client || new ZCodeProtocolClient({ log }).start();
  let protocol;
  try {
    const snap = await c.request('session/create', { workspace: workspace(cwd), mode: 'yolo' }, 30000);
    checkCompat(snap); protocol = snap.protocol;
    await c.request('session/close', { sessionId: snap.session.sessionId }, 10000).catch(() => {});
  } finally { if (!client) await c.close(); }
  if (!live) return { ok: true, protocol };
  const tok = 'PROBE-' + Math.random().toString(36).slice(2, 8);
  const r = await runTask({ cwd, text: `Do not use any tools. Reply with exactly: ${tok}`, timeoutSeconds: 120, spawnSpec });
  return { ok: r.outcome === 'succeeded' && (r.result || '').includes(tok), protocol, model: r.model, sessionId: r.sessionId, error: r.error };
}

/**
 * Run one task through the official headless CLI: `zcode -p TEXT --cwd DIR --mode M
 * --output-format stream-json [--resume sess_...]`. This is the "standalone Prompt CLI" that owns its
 * own account login (`zcode login`), unlike `app-server`, which is a private agent server that
 * expects its host (ZCode.app) to supply account config + per-request auth (see docs/ZCODE-SURFACES.md).
 * Every stream line carries `sessionId`, so the session id is known from the first event (before the
 * model call); the final line is `{"type":"result", sessionId, response, ...}`.
 */
export function cliArgs({ cwd, text, mode = 'yolo', resumeSessionId }) {
  const a = ['-p', text, '--cwd', cwd, '--mode', mode, '--output-format', 'stream-json'];
  if (resumeSessionId) a.push('--resume', resumeSessionId);
  return a;
}

export function runTask({ cwd, text, mode = 'yolo', timeoutSeconds = 1800, resumeSessionId, onSession = () => {}, onEvent = () => {}, spawnSpec, env = process.env, log = () => {} }) {
  const z = spawnSpec || resolveZcode(env);
  const args = [...(z.args || []), ...cliArgs({ cwd, text, mode, resumeSessionId })];
  return new Promise((resolve, reject) => {
    const child = spawn(z.cmd, args, { cwd, env: { ...env, ...(z.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let stderr = ''; let sessionId = null; let model = null; let result = null; let errorEv = null; let sawJson = false;
    const timer = setTimeout(() => { log('timeout; killing CLI'); child.kill('SIGTERM'); }, timeoutSeconds * 1000);
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
    child.stdout.on('data', d => {
      buf += d; let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).trim(); buf = buf.slice(n + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { log(`non-JSON stdout: ${line.slice(0, 120)}`); continue; }
        sawJson = true;
        if (ev.sessionId && !sessionId) { sessionId = ev.sessionId; try { onSession({ sessionId }); } catch (e) { log(`onSession: ${e.message}`); } }
        const pl = ev.payload || {};
        if (pl.providerId && pl.modelId) model = `${pl.providerId}/${pl.modelId}`;
        if (ev.type === 'result') result = ev;
        if (ev.type === 'error' || pl.kind === 'turn.failed' || ev.type === 'turn.failed') errorEv = ev;
        onEvent(ev);
      }
    });
    child.on('error', e => { clearTimeout(timer); reject(new ZCodeCompatError(`cannot spawn zcode CLI: ${e.message}`)); });
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (!result && code !== 0) {
        const msg = stderr.trim().split('\n').slice(-3).join(' | ');
        if (!sawJson && /output-format/i.test(msg)) return reject(new ZCodeCompatError(`CLI rejected --output-format stream-json (${msg}). Update lib/zcode-protocol.mjs.`));
        if (/Model creation failed|Select a model|login/i.test(msg)) return reject(noModelsError(msg));
      }
      const response = typeof result?.response === 'string' ? result.response.trim() : null;
      const ok = code === 0 && !!response;
      resolve({
        sessionId: result?.sessionId || sessionId, model, outcome: ok ? 'succeeded' : (sig ? 'timeout' : 'failed'), result: response,
        error: ok ? null : (errorEv?.message || errorEv?.payload?.message || stderr.trim().split('\n').slice(-3).join(' | ') || `exit ${code ?? sig}`),
        turnId: result?.turnId ?? null,
      });
    });
  });
}
