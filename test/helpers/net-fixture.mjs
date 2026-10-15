// Test-only network config: temp config.json with RFC 2606/5737 placeholders, discovery off,
// so tests never read the real ~/.config, ~/Projects or call tailscale. Child processes inherit it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GROK_PEER = 'grok-box.example.test/grok';
export const BOX_IP = '192.0.2.10';
export const HOST_IP = '192.0.2.20';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-dispatch-cfg-'));
export const CONFIG_PATH = path.join(dir, 'config.json');
// transport "yobiru": the v0.2 suites pin the exact Yobiru argv (regression proof for existing Yobiru deployments).
fs.writeFileSync(CONFIG_PATH, JSON.stringify({ transport: 'yobiru', host: HOST_IP, grokPeer: GROK_PEER, allowedIps: [BOX_IP], allowedPeers: ['grok-box.example.test'] }));
process.env.ZCODE_DISPATCH_CONFIG = CONFIG_PATH;
process.env.ZCODE_DISPATCH_DISCOVERY = '0';
for (const k of ['DISPATCH_HOST', 'DISPATCH_PORT', 'DISPATCH_ALLOWED_IPS', 'ZCODE_DISPATCH_GROK_PEER', 'ZCODE_DISPATCH_PEER', 'ZCODE_ALLOWED_PEERS', 'ZCODE_DISPATCH_TRANSPORT', 'ZCODE_DISPATCH_RUNNER']) delete process.env[k];
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
