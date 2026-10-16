// Regression suite for the isolated verification clone.
//
// The bug: a shared developer checkout accumulates unpublished local refs, so the unchanged
// `gitleaks git --log-opts=--all` inside `verify-local.sh` scans them too and fails on findings
// that belong to work in progress. The fix runs the task in a fresh clone of the project origin,
// which holds every published branch and tag plus the exact reviewed commit and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDirective, originUrl, publicationClone, refInventory } from '../marketplace/plugins/zcode-grokbot-dispatch/lib/verification-clone.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'marketplace', 'plugins', 'zcode-grokbot-dispatch', 'mcp', 'server.mjs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const reachable = (dir) => git(dir, 'rev-list', '--all').split('\n').filter(Boolean);

// `origin.git` stands in for GitHub: it only ever holds published refs. `dev` is a developer
// checkout of it that later accumulates an unpublished local branch, exactly like ~/Projects/<p>.
// Every clone in these tests is directed at the fixture directory so nothing escapes to os.tmpdir().
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zdc-verify-'));
  const remote = path.join(tmp, 'origin.git');
  const dev = path.join(tmp, 'dev');
  git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(tmp, 'clone', '--quiet', remote, dev);
  git(dev, 'config', 'user.email', 'test@example.test');
  git(dev, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dev, 'README.md'), 'main\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '--quiet', '-m', 'main');
  git(dev, 'push', '--quiet', 'origin', 'main');
  git(dev, 'tag', 'v1');
  git(dev, 'push', '--quiet', 'origin', 'v1');
  git(dev, 'checkout', '--quiet', '-b', 'feature');
  fs.writeFileSync(path.join(dev, 'feature.txt'), 'feature\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '--quiet', '-m', 'feature');
  git(dev, 'push', '--quiet', 'origin', 'feature');
  const reviewed = git(dev, 'rev-parse', 'HEAD');
  git(dev, 'checkout', '--quiet', 'main');
  // Unpublished work an agent left in the shared checkout: pushed nowhere, invisible to GitHub.
  git(dev, 'checkout', '--quiet', '-b', 'research/local-only');
  fs.writeFileSync(path.join(dev, 'local.txt'), 'local\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '--quiet', '-m', 'unpublished');
  const localOnly = git(dev, 'rev-parse', 'HEAD');
  git(dev, 'checkout', '--quiet', 'main');
  return { tmp, remote, dev, reviewed, localOnly };
}

function withFixture(body) {
  const f = fixture();
  try { body(f); } finally { fs.rmSync(f.tmp, { recursive: true, force: true }); }
}

test('shared checkout --all includes unpublished local work (the bug)', () => {
  withFixture(({ dev, localOnly, reviewed }) => {
    assert.ok(reachable(dev).includes(localOnly), 'fixture must reproduce a shared-checkout-only ref');
    assert.ok(reachable(dev).includes(reviewed));
  });
});

test('publicationClone keeps every published ref and drops the unpublished ones', () => {
  withFixture(({ tmp, dev, reviewed, localOnly }) => {
    const clone = publicationClone({ project: 'demo', projectDir: dev, commit: reviewed, tmpBase: tmp });

    // Exact reviewed commit, verified by object id.
    assert.equal(clone.inventory.head, reviewed);
    assert.equal(git(clone.path, 'rev-parse', 'HEAD'), reviewed);
    assert.equal(clone.url, originUrl(dev));
    assert.ok(clone.path.startsWith(tmp));

    // Every published ref survived (origin/HEAD is the clone's own symbolic ref)...
    assert.deepEqual(clone.inventory.remoteBranches.filter((r) => r !== 'refs/remotes/origin/HEAD').sort(),
      ['refs/remotes/origin/feature', 'refs/remotes/origin/main']);
    assert.deepEqual(clone.inventory.tags, ['refs/tags/v1']);
    // ...and the clone has exactly one local branch: no --single-branch, no local-only refs.
    assert.equal(clone.inventory.localBranches.length, 1);
    assert.equal(clone.inventory.stashes.length, 0);
    assert.ok(reachable(clone.path).includes(reviewed));
    // The whole point: another agent's unpublished ref is not in the cloned object database.
    assert.ok(!reachable(clone.path).includes(localOnly));
    assert.ok(clone.inventory.commitsAllRefs < reachable(dev).length);
  });
});

test('publicationClone fetches a commit that no published branch reaches', () => {
  withFixture(({ tmp, remote, dev, reviewed }) => {
    // Simulate an open PR head that only exists under refs/pull/<n>/head on the remote.
    const copy = path.join(tmp, 'prhead');
    git(tmp, 'clone', '--quiet', '--no-local', remote, copy);
    git(copy, 'config', 'user.email', 'test@example.test');
    git(copy, 'config', 'user.name', 'test');
    git(copy, 'checkout', '--quiet', '--detach', reviewed);
    fs.writeFileSync(path.join(copy, 'pr.txt'), 'pr\n');
    git(copy, 'add', '-A');
    git(copy, 'commit', '--quiet', '-m', 'pr head');
    const prHead = git(copy, 'rev-parse', 'HEAD');
    git(copy, 'push', '--quiet', remote, `${prHead}:refs/pull/271/head`);
    assert.ok(!reachable(dev).includes(prHead), 'PR head must not be in the shared checkout to make this meaningful');

    const clone = publicationClone({ project: 'demo', projectDir: dev, commit: prHead, ref: 'refs/pull/271/head', tmpBase: tmp });
    assert.equal(clone.inventory.head, prHead);
    assert.equal(clone.ref, 'refs/pull/271/head');
    assert.ok(reachable(clone.path).includes(prHead));
  });
});

test('publicationClone rejects bad input and leaves no half-built clone', () => {
  withFixture(({ tmp, dev, reviewed }) => {
    const leftovers = () => fs.readdirSync(tmp).filter((n) => n.startsWith('zcode-verify-'));
    assert.throws(() => publicationClone({ project: '../escape', projectDir: dev, commit: reviewed, tmpBase: tmp }), /invalid project/);
    assert.throws(() => publicationClone({ project: 'demo', projectDir: dev, tmpBase: tmp }), /invalid commit/);
    assert.throws(() => publicationClone({ project: 'demo', projectDir: `${dev}-missing`, commit: reviewed, tmpBase: tmp }), /failed/);
    assert.throws(() => publicationClone({ project: 'demo', projectDir: dev, commit: 'dead'.repeat(10), tmpBase: tmp }), /failed/);
    assert.deepEqual(leftovers(), []);
  });
});

test('refInventory and cloneDirective describe what was scanned', () => {
  withFixture(({ tmp, dev, reviewed }) => {
    const clone = publicationClone({ project: 'demo', projectDir: dev, commit: reviewed, tmpBase: tmp });
    const inv = refInventory(clone.path);
    assert.equal(inv.head, reviewed);
    assert.match(inv.tree, /^[0-9a-f]{40}$/);
    assert.equal(inv.commitsAllRefs, reachable(clone.path).length);

    const directive = cloneDirective(clone);
    assert.ok(directive.includes(clone.path));
    assert.ok(directive.includes(reviewed));
    assert.match(directive, /shared developer checkout/);
  });
});

test('MCP dispatch_to_dsh exposes the isolated verification options', () => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';
  const out = spawnSync(process.execPath, [SERVER], { input, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const replies = out.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.find((m) => m.id === 1).result.serverInfo.version, '0.4.0');
  const tool = replies.find((m) => m.id === 2).result.tools.find((t) => t.name === 'dispatch_to_dsh');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(),
    ['commit', 'isolated', 'project', 'ref', 'text', 'timeout_seconds']);
});
