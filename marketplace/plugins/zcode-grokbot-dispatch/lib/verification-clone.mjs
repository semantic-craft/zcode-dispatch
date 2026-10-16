/**
 * Fresh clone for verification ("verify-local" class) tasks.
 *
 * Why this exists
 * ---------------
 * `scripts/ci/verify-local.sh` runs `scripts/ci/scan-secrets.sh`, which scans history with
 *   gitleaks git --log-opts=--all
 * i.e. *every ref in the repository's own object database*. A developer checkout that hosts
 * several agents also holds their unpublished local branches, stashes and archive refs, so the
 * gate reports findings that belong to someone's work in progress rather than to the commit
 * under review. The run then fails for a reason the reviewer cannot act on.
 *
 * The owning repository already decided how to handle that (responsay-macos
 * `docs/operations/ci.md`, "Local remotes and preserved work"): keep the unpublished refs
 * intact, add no scanner exceptions, and run the unchanged verification script in a fresh
 * GitHub clone that holds every published branch and tag plus the exact reviewed commit.
 *
 * This module performs that clone. It is deliberately *not* `--single-branch`: a single-branch
 * clone would omit the other published refs, which the same policy forbids. Because the clone's
 * object database is created from the GitHub remote alone, `--all` there means "all published
 * refs plus the reviewed commit" and never another agent's local work.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_TIMEOUT_MS = 15 * 60 * 1000;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A git object name: full or abbreviated sha, or any rev. Kept permissive because callers pass
// branch names and PR refs (`refs/pull/271/head`) as well as raw object ids.
const REV_RE = /^[A-Za-z0-9][A-Za-z0-9._/@^-]{0,199}$/;

/** Run git and return trimmed stdout; throws with stderr attached on failure. */
export function defaultRun(cmd, args, { cwd } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS }).trim();
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

/** `origin` URL of the shared checkout; this is what a fresh publication clone must come from. */
export function originUrl(projectDir, run = defaultRun) {
  const url = run('git', ['-C', projectDir, 'remote', 'get-url', 'origin']);
  if (!url) throw new Error(`no origin remote in ${projectDir}`);
  return url;
}

/** Count + identity inventory, so a run can record what it actually scanned. */
export function refInventory(dir, run = defaultRun) {
  const refs = (pattern) => run('git', ['-C', dir, 'for-each-ref', pattern, '--format=%(refname)'])
    .split('\n').filter(Boolean);
  return {
    head: run('git', ['-C', dir, 'rev-parse', 'HEAD']),
    tree: run('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}']),
    localBranches: refs('refs/heads/'),
    remoteBranches: refs('refs/remotes/origin/'),
    tags: refs('refs/tags/'),
    stashes: refs('refs/stash'),
    commitsAllRefs: Number(run('git', ['-C', dir, 'rev-list', '--all', '--count'])),
  };
}

/**
 * Clone `project` from its GitHub origin into a throwaway directory and check out `commit`.
 *
 * @param {object}   o
 * @param {string}   o.project     project folder name (used only to name the temp directory)
 * @param {string}   o.projectDir  the shared checkout, used to read the `origin` URL
 * @param {string}   o.commit      exact reviewed commit to check out
 * @param {string}   [o.ref]       ref to fetch when `commit` is not reachable from a published
 *                                 branch (e.g. `refs/pull/271/head`); defaults to `commit`
 * @param {string}   [o.tmpBase]   parent directory for the clone (or ZCODE_VERIFY_TMP)
 * @param {Function} [o.run]       git runner, injectable for tests
 * @param {Function} [o.log]       progress sink
 * @returns {{path: string, url: string, commit: string, ref: string|null, inventory: object}}
 */
export function publicationClone({ project, projectDir, commit, ref, tmpBase, run = defaultRun, log = () => {} }) {
  if (!project || !PROJECT_RE.test(project)) throw new Error(`invalid project "${project ?? ''}"`);
  if (!projectDir) throw new Error('projectDir is required');
  if (!commit || !REV_RE.test(String(commit))) throw new Error(`invalid commit/ref "${commit ?? ''}"`);
  const base = tmpBase || process.env.ZCODE_VERIFY_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });

  const url = originUrl(projectDir, run);
  const dir = fs.mkdtempSync(path.join(base, `zcode-verify-${project}-`));
  try {
    // Every published branch (as remote-tracking refs) and tag, from the remote only, with a
    // private object database: nothing is shared with the developer checkout.
    log(`cloning ${url} -> ${dir}`);
    run('git', ['clone', '--no-local', '--quiet', url, dir]);
    if (!present(run, dir, commit)) {
      const source = ref || commit;
      log(`fetching reviewed commit via ${source}`);
      run('git', ['-C', dir, 'fetch', '--quiet', 'origin', source]);
    }
    run('git', ['-C', dir, 'checkout', '--quiet', '--detach', commit]);
    const inventory = refInventory(dir, run);
    return { path: dir, url, commit, ref: ref || null, inventory };
  } catch (e) {
    // Do not leave a half-built clone behind as if it were a usable checkout.
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

function present(run, dir, commit) {
  try {
    run('git', ['-C', dir, 'cat-file', '-e', `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Directive prepended to a dispatched task so the receiver works in the clone, not the shared checkout. */
export function cloneDirective({ path: clonePath, commit }) {
  return [
    `[verification-clone] ${clonePath}`,
    `Run the verification for ${commit} inside that fresh clone only.`,
    'Do not run it in the shared developer checkout: its object database also holds unpublished',
    'local refs, so an all-ref secret scan there reports findings that do not belong to this commit.',
  ].join('\n');
}
