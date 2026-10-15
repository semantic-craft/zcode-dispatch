import { BOX_IP, GROK_PEER } from './helpers/net-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peerIPs, readConfigFile, resolveNetConfig, yobiruBin } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/netconfig.mjs';
import { isGrokPeer } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/job-map.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUS = {
  Self: { DNSName: 'zc-host.tailnet.example.test.', TailscaleIPs: ['192.0.2.20'] },
  Peer: { a: { DNSName: 'grok-box.tailnet.example.test.', HostName: 'grok-box', TailscaleIPs: ['192.0.2.10', 'fd7a::10'] } },
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zd-netcfg-'));

test('discovery: host = self tailnet IPv4; allowedIps = grokPeer node IPs; port default 7791', () => {
  const r = resolveNetConfig({ env: {}, file: { grokPeer: 'grok-box.tailnet.example.test/grok' }, status: () => STATUS });
  assert.deepEqual(r, { host: '192.0.2.20', port: 7791, allowedIps: ['192.0.2.10'], grokPeer: 'grok-box.tailnet.example.test/grok' });
});

test('env > config > discovery; nothing resolvable -> null host, empty allowlist, no grok peer', () => {
  const file = { host: '198.51.100.1', allowedIps: '198.51.100.9', grokPeer: 'f.example.test/grok' };
  assert.equal(resolveNetConfig({ env: {}, file, status: () => STATUS }).host, '198.51.100.1');
  const env = { DISPATCH_HOST: '203.0.113.1', DISPATCH_ALLOWED_IPS: '203.0.113.5,203.0.113.6', ZCODE_DISPATCH_GROK_PEER: 'e.example.test/grok', DISPATCH_PORT: '7000' };
  assert.deepEqual(resolveNetConfig({ env, file, status: () => STATUS }), { host: '203.0.113.1', port: 7000, allowedIps: ['203.0.113.5', '203.0.113.6'], grokPeer: 'e.example.test/grok' });
  assert.deepEqual(resolveNetConfig({ env: {}, file: {}, status: () => null }), { host: null, port: 7791, allowedIps: [], grokPeer: null });
  assert.deepEqual(peerIPs(STATUS, 'grok-box'), ['192.0.2.10']);
});

test('receiver DEFAULTS and plugin CFG read the local config file (temp dir fixture)', async () => {
  const { DEFAULTS } = await import('../receiver/core.mjs');
  const { CFG } = await import('../marketplace/plugins/zcode-grokbot-dispatch/lib/dispatch.mjs');
  assert.equal(DEFAULTS.host, '192.0.2.20');
  assert.deepEqual(DEFAULTS.allowedIps, [BOX_IP]);
  assert.equal(CFG.grokPeer, GROK_PEER);
  const d = tmp();
  try { fs.writeFileSync(path.join(d, 'bad.json'), '{'); assert.deepEqual(readConfigFile(path.join(d, 'bad.json')), {}); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('isGrokPeer follows the configured grokPeer node, not a hardcoded name', () => {
  assert.equal(isGrokPeer('grok-box.example.test/grok'), true);
  assert.equal(isGrokPeer('grok-box.example.test/zcode', GROK_PEER), true);
  assert.equal(isGrokPeer('other.example.test/zcode', GROK_PEER), false);
  assert.equal(isGrokPeer('anything/grok', null), true);
  assert.equal(isGrokPeer('other.example.test', null), false);
});

test('yobiruBin picks the newest installed version (temp home), YOBIRU_BIN wins', () => {
  const home = tmp();
  try {
    for (const v of ['0.5.0', '0.5.1', '0.10.0']) { const d = path.join(home, '.codex/plugins/cache/yobiru/yobiru', v, 'scripts'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'yobiru'), ''); }
    assert.equal(yobiruBin({}, home), path.join(home, '.codex/plugins/cache/yobiru/yobiru/0.10.0/scripts/yobiru'));
    assert.equal(yobiruBin({ YOBIRU_BIN: '/x/yobiru' }, home), '/x/yobiru');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('python adapter: allowed peers from env > config > Yobiru allow list; short entries match first label', () => {
  const home = tmp();
  try {
    const tm = path.join(home, '.tailmsg'); fs.mkdirSync(tm, { recursive: true });
    fs.writeFileSync(path.join(tm, 'config.json'), JSON.stringify({ allow: ['grok-box', 'peer2.tailnet.example.test'] }));
    const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('za', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({'allowed': sorted(m.ALLOWED_PEERS), 'short': m.peer_allowed('grok-box.tailnet.example.test'), 'full': m.peer_allowed('peer2.tailnet.example.test'),
  'other': m.peer_allowed('evil.tailnet.example.test'), 'grok': m.grok_node(), 'env': sorted(m.allowed_peers({'ZCODE_ALLOWED_PEERS': 'a.example.test, b.example.test'}))}))`;
    const env = { PATH: process.env.PATH, HOME: home, TAILMSG_HOME: tm, ZCODE_DISPATCH_CONFIG: path.join(home, 'none.json'), ZCODE_DISPATCH_GROK_PEER: 'grok-box.tailnet.example.test/grok' };
    const r = spawnSync('python3', ['-c', code, path.join(HERE, '..', 'deploy', 'semantic-craft', 'zcode_adapter.py')], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { allowed: ['grok-box', 'peer2.tailnet.example.test'], short: true, full: true, other: false, grok: 'grok-box.tailnet.example.test', env: ['a.example.test', 'b.example.test'] });
    fs.writeFileSync(path.join(home, 'cfg.json'), JSON.stringify({ allowedPeers: ['only.example.test'] }));
    const r2 = spawnSync('python3', ['-c', code, path.join(HERE, '..', 'deploy', 'semantic-craft', 'zcode_adapter.py')], { env: { ...env, ZCODE_DISPATCH_CONFIG: path.join(home, 'cfg.json') }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r2.stdout).allowed, ['only.example.test']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
