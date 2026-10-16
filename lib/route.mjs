/**
 * Path order (user decision 2026-10-15):
 *   1. ZCode.app running -> app scheduler (lib/appsession.mjs): VISIBLE app session, desktop login + model.
 *   2. app not running, or app path broken by a ZCode change -> official CLI stream-json (lib/zcode-protocol.mjs).
 *   3. -> plain headless bundled CLI (bin/zcode-run) — only when no model is required (it cannot select/verify one).
 * Model (user decision 2026-10-16): every path runs the resolved model (default GLM-5.3 Flash, lib/models.mjs)
 * or fails loudly; a path never silently runs a different model.
 * ZCODE_DISPATCH_PATH=app|protocol|headless forces a single path (no fallback).
 * Every fallback is announced on stderr ("[zcode-dispatch] FALLBACK …").
 */
export async function dispatch({ cwd, text, mode, source, jobId, model, timeoutSeconds, resumeSessionId, forced = process.env.ZCODE_DISPATCH_PATH || '', deps, emit, warn = (m) => console.error(m) }) {
  const { appRunning, checkSchema, runInApp, runTask, runHeadless, upsertJob, bindSession } = deps;
  const final = (via, r) => { emit({ type: 'final', via, job_id: jobId, session_id: r.sessionId ?? null, sessionId: r.sessionId ?? null, ...(r.model ? { model: r.model } : {}), outcome: r.outcome, result: r.result ?? '', error: r.error ?? null }); return r.outcome === 'succeeded' ? 0 : 1; };
  const order = forced ? [forced] : ['app', 'protocol', 'headless'];
  for (const via of order) {
    if (via === 'app') {
      if (!forced && resumeSessionId) { warn('[zcode-dispatch] resume requested; app scheduler cannot resume, skipping to CLI path'); continue; }
      if (!appRunning()) { if (forced) { warn('[zcode-dispatch] ZCode.app not running'); return 1; } continue; }
      try {
        checkSchema();
        const r = await runInApp({ cwd, text, mode, source, jobId, model, timeoutSeconds, onProgress: (p) => emit({ type: 'progress', via: 'app', job_id: jobId, ...p }) });
        if (r.outcome !== 'not_picked_up') return final('app', r);
        warn(`[zcode-dispatch] FALLBACK: ZCode.app did not pick up the job (${r.error}); trying CLI path`);
      } catch (e) {
        warn(`[zcode-dispatch] FALLBACK: app-scheduler path failed: ${e.message}`);
      }
      if (forced) return 1;
      continue;
    }
    if (via === 'protocol') {
      try {
        const r = await runTask({ cwd, text, mode, model, timeoutSeconds, resumeSessionId, log: (m) => warn(`[protocol] ${m}`),
          onSession: ({ sessionId }) => {
            upsertJob({ job_id: jobId, cwd, source, via: 'protocol', created_at: new Date().toISOString() });
            bindSession({ sessionId, jobId, source, cwd });
            emit({ type: 'progress', via: 'protocol', job_id: jobId, session_id: sessionId });
          } });
        return final('protocol', r);
      } catch (e) {
        warn(`[zcode-dispatch] FALLBACK: CLI stream-json path failed: ${e.message}`);
        if (forced) return 1;
        continue;
      }
    }
    if (via === 'headless') {
      // The bare headless CLI has no per-run model switch and reports no model; refusing beats running on an unverified model.
      if (model) { const msg = `[zcode-dispatch] headless path cannot select or verify model ${model}; refusing (no silent model fallback)`; warn(msg); return final('headless', { outcome: 'failed', error: msg }); }
      return runHeadless();
    }
  }
  return 1;
}
