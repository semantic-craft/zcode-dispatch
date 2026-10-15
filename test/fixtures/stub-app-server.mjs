// Stub `zcode app-server --stdio` speaking the ZCode Protocol v1 subset we use.
// STUB_MODELS=json array, STUB_PROTO_VERSION=n, STUB_FAIL=1 makes the turn fail.
import readline from 'node:readline';
const models = JSON.parse(process.env.STUB_MODELS ?? '[{"id":"account:bigmodel-individual-coding-plan/GLM-5.3","name":"GLM-5.3"},{"id":"account:bigmodel-individual-coding-plan/GLM-5.3-Flash","name":"GLM-5.3-Flash"}]');
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const sessions = new Map(); let n = 0; let rid = 1000;
const snap = (sid) => ({ protocol: { name: 'ZCode Protocol', version: Number(process.env.STUB_PROTO_VERSION || 1) }, session: { sessionId: sid, status: 'idle' }, settings: { model: { available: models, current: models[0] ?? null } }, messages: sessions.get(sid).messages, projection: { status: sessions.get(sid).status } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method == null) return; // reply to our server request
  const p = m.params || {};
  switch (m.method) {
    case 'session/create': { const sid = `sess_stub${++n}`; sessions.set(sid, { messages: [], status: 'idle', model: null }); out({ id: rid++, method: 'session/requestRuntimePreferences', params: { sessionId: sid } }); return out({ id: m.id, result: snap(sid) }); }
    case 'session/resume': { if (!sessions.has(p.sessionId)) return out({ id: m.id, error: { code: -32004, message: 'not found' } }); return out({ id: m.id, result: snap(p.sessionId) }); }
    case 'session/setModel': sessions.get(p.sessionId).model = p.model; return out({ id: m.id, result: { ok: true } });
    case 'session/close': return out({ id: m.id, result: {} });
    case 'session/send': {
      const s = sessions.get(p.sessionId);
      out({ id: m.id, result: { accepted: true, sessionId: p.sessionId } });
      out({ method: 'state.updated', params: { sessionId: p.sessionId, patch: { status: 'running' }, reason: 'prompt_started' } });
      setTimeout(() => {
        s.messages.push({ info: { role: 'user' }, parts: [{ type: 'text', text: p.content }] });
        if (process.env.STUB_FAIL) { s.status = 'error'; out({ method: 'state.updated', params: { sessionId: p.sessionId, patch: { status: 'error', lastError: { code: 'CONFIGURATION_ERROR', message: 'Select a model before continuing' } }, reason: 'prompt_failed' } }); return; }
        const tok = (p.content.match(/ACP-OK-\w+|E2E-\w+/) || ['OK'])[0];
        s.messages.push({ info: { role: 'assistant' }, parts: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: `${tok} via ${s.model}` }] });
        out({ method: 'state.updated', params: { sessionId: p.sessionId, patch: { status: 'idle' }, reason: 'prompt_completed' } });
      }, 30);
      return;
    }
    case 'session/read': { const s = sessions.get(p.sessionId); return out({ id: m.id, result: { projection: { status: s.status }, messages: s.messages } }); }
    default: return out({ id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
