# Grok Bot Dispatch for ZCode (zcode-grokbot-dispatch)

> Plugin id: `zcode-grokbot-dispatch` (renamed from the pre-release id `zcode-dispatch`). Runtime paths are unchanged (`~/.config/zcode-dispatch/`, `~/.local/state/zcode-dispatch/`, `ZCODE_DISPATCH_*` env), so existing config keeps working; if you installed the old `zcode-dispatch` build, uninstall it and install `zcode-grokbot-dispatch`.


Bidirectional task dispatch between the ZCode desktop app and DSH (DeepSeek Harness) / Grok Bot, with `[Project: X]` routing, persistent session↔job mapping and automatic result reporting (direct HTTP by default, Yobiru optional).

## Components
- **Commands**: `/dispatch-dsh <project> <task>`, `/dispatch-grok <project> <task>`, `/dispatch-status <id>`
- **MCP server** (stdio, `node mcp/server.mjs`): tools `dispatch_to_dsh` (accepts `isolated`, `commit`, `ref` — see below), `dispatch_to_grokbot`, `dispatch_status`
- **Hooks**: `UserPromptSubmit` (records session↔job mapping) and `Stop` (reports the finished session's result to the dispatching peer)

## Install
1. ZCode → Settings → Plugins → `zcode-plugins-official` → install **zcode-grokbot-dispatch**.
2. Requires Node.js ≥ 22.5 on PATH. `/dispatch-dsh` also requires the `dsh` CLI (override with `DSH_BIN`).
3. Configure peers in `~/.config/zcode-dispatch/config.json` or env vars (env wins), e.g.:
   ```json
   { "transport": "direct", "peers": { "dsh": { "url": "http://<peer-host>:<port>", "keyFile": "~/.config/zcode-dispatch/dsh.key" } } }
   ```
   Relevant env: `ZCODE_DISPATCH_CONFIG`, `ZCODE_DISPATCH_TRANSPORT` (direct|yobiru), `ZCODE_DISPATCH_GROK_PEER`, `ZCODE_DISPATCH_PROJECTS_ROOT` (default `~/Projects`), `ZCODE_DISPATCH_DISCOVERY=0` (disable Tailscale discovery), `DSH_BIN`, `DSH_PROFILE`.
   No endpoint is built in; nothing is sent until you configure a peer.

## Isolated verification runs

A project's local gate may scan history with `gitleaks git --log-opts=--all`, i.e. *every ref in the
checkout's own object database*. A shared developer checkout also holds the other agents' unpublished
local branches, stashes and archive refs, so that scan fails on findings that belong to work in
progress rather than to the commit under review — and the reviewer cannot act on them.

Pass `isolated: true` (with `commit`, and `ref` when the reviewed commit is not reachable from a
published branch, e.g. `refs/pull/271/head`) to `dispatch_to_dsh` to run the task in a throwaway
clone instead:

1. `git clone --no-local <origin-url> <temp-dir>` — a fresh object database built from the project's
   GitHub `origin`, holding every published branch and tag.
2. Fetch `ref` (or the commit itself) when the reviewed commit is not among them, then check out the
   exact commit detached.
3. Hand the worker that directory as its cwd and prepend a `[verification-clone]` directive, so the
   receiver never touches the shared checkout.

The clone is deliberately **not** `--single-branch`: that would omit the other published refs. It also
must come from the remote URL — cloning the shared checkout, even with `--no-local`, copies its
unpublished local refs and reproduces the original failure.

`isolated` requires a local `dsh`; with `dshVia: "http"` the job runs on the peer, which must prepare
its own clone. The clone path and the remote/ref inventory are returned and recorded in the job file.

## Side effects / privacy
- **Network**: the `Stop` hook and the dispatch tools send task text and up to ~3000 chars of the session's final result to the peer **you configured** — by HTTP (default, authenticated with your key file) or, if `transport` is `yobiru`, via the `yobiru` CLI (`yobiru send <peer> ...`). Sessions not started by a dispatch are not reported.
- **Commands executed**: `dsh --profile headless --json <task>` (for `/dispatch-dsh`), `yobiru` (only when transport is yobiru), `tailscale status` for optional peer discovery (disable with `ZCODE_DISPATCH_DISCOVERY=0`), and — only when `isolated: true` — `git clone`/`git fetch`/`git checkout` against the project's configured `origin` URL.
- **Files written**: job/session mapping and reports under `~/.local/state/zcode-dispatch/` (and the plugin data dir), mode 0600/0700; plus a temporary verification clone under `$TMPDIR` (override with `ZCODE_VERIFY_TMP`) when `isolated: true`, removed if the clone cannot be prepared. Reads config/key files under `~/.config/zcode-dispatch/`.
- **Hooks**: runs on every `UserPromptSubmit` and `Stop` (timeouts 10s/20s); exits quietly when the session is not a dispatched job.
- No telemetry, no third-party services beyond the peer/Yobiru you configure.

## Third-party code
None bundled; uses only Node.js built-in modules.

## License
MIT © semantic-craft — source: https://github.com/semantic-craft/zcode-dispatch
