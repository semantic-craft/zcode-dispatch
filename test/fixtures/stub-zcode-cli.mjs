// Stub `zcode -p … --output-format stream-json [--resume sid]`. STUB_FAIL=1 -> no result, exit 1.
const a = process.argv.slice(2); const get = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
if (get('--output-format') !== 'stream-json') { console.error('error: unknown --output-format'); process.exit(2); }
const text = get('-p'); const sid = get('--resume') || 'sess_stubcli1';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
out({ seq: 1, sessionId: sid, payload: { title: text } });
if (process.env.STUB_FAIL) { console.error('Error: Model creation failed (traceId: x)'); process.exit(1); }
out({ seq: 2, sessionId: sid, payload: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' } });
const tok = (text.match(/(ACP-OK|E2E|PROBE)-\w+/) || ['OK'])[0];
out({ type: 'result', sessionId: sid, turnId: 'turn_1', response: `${tok}${get('--resume') ? ' (resumed)' : ''}` });
