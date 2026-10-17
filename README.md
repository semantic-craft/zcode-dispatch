# zcode-dispatch

Two-way task dispatch between **ZCode** (Zhipu's coding client; tested with ZCode.app 3.15.3, bundled CLI `zcode 0.16.9`) and other agents — DeepSeek Harness via [`dsh-grokbot-dispatch`](https://github.com/semantic-craft/dsh-grokbot-dispatch), Grok Bot, or anything that speaks the small HTTP API below.

## Prerequisites

- ZCode (desktop app for visible sessions, or the `zcode` CLI: `ZCODE_BIN` / `zcode` on `PATH` / `ZCODE_APP` bundle) logged in once; Node `>=22.5` (`node:sqlite`).
- Project folders under `projectsRoot` (default `~/Projects/<project>`); names matching `denyProjects` (default `finance`) are refused.
- A network path from callers to the receiver's `host:port` (LAN, VPN, Tailscale, SSH tunnel…). The receiver is **plain HTTP** protected by a source-IP allowlist plus a shared Bearer key, no TLS: keep it on a trusted network or front it with a TLS proxy/tunnel.
- **Not required**: Yobiru / tailmsg, Tailscale, macOS / launchd (all optional, see below).

## Feature × dependency

| Feature | Default (`transport: "direct"`) | Optional `transport: "yobiru"` |
|---|---|---|
| Inbound: caller → receiver `POST /v1/jobs` → ZCode session | `node receiver/server.mjs` + key file + `host` + `allowedIps` | same (plus an optional Yobiru wake adapter from your own deploy docs/mesh) |
| Result pull: receiver `GET /v1/jobs/<id>` | ✅ | ✅ |
| Result push on completion | receiver `POST`s to `callback_url` / `<peers[callback_peer].url>/v1/callbacks` | Stop hook `send` to `grokPeer` (Grok-dispatched jobs) / adapter `request respond` |
| `dispatch_to_dsh` (`/dispatch-dsh`) | `peers.dsh` set → HTTP `POST <dsh>/v1/jobs` (any machine); else local `dsh` on `PATH` | same |
| `dispatch_to_grokbot` (`/dispatch-grok`) | `peers.grok-bot` `{url, keyFile}` | Yobiru `request send <grokPeer>` |
| `dispatch_status` | local job files / callback results, or pulls `GET <peer>/v1/jobs/<id>` | + `yobiru request status` |
| Host / allowlist discovery | optional: `tailscale status --json` if installed | same |
| Visible ZCode.app sessions | macOS ZCode.app (non-public internals, see below); otherwise CLI/headless | same |

## Minimal working config (direct)

```sh
umask 077; mkdir -p ~/.config/zcode-dispatch
openssl rand -hex 32 > ~/.config/zcode-dispatch/key          # callers send "Authorization: Bearer <key>"
cp /path/from/dsh-host/key ~/.config/zcode-dispatch/dsh.key   # the peer's own inbound key, chmod 600
```

`~/.config/zcode-dispatch/config.json`:

```json
{
  "host": "192.168.1.30",
  "port": 7791,
  "allowedIps": ["192.168.1.20"],
  "selfName": "zcode",
  "peers": {
    "dsh": { "url": "http://192.168.1.20:7790", "keyFile": "~/.config/zcode-dispatch/dsh.key" }
  }
}
```

Run the receiver (any OS; it ships in this repo next to the plugin, keep it running with whatever supervisor you like):

```sh
npm start            # = node receiver/server.mjs
curl -s http://<host>:7791/health   # {ok, transport, checks:{errors,warnings}}
```

Install the ZCode plugin from this checkout: `zcode plugins marketplace add $PWD/marketplace && zcode plugins install zcode-dispatch@zcode-dispatch` (or ZCode UI `设置 -> 插件 -> 创建 -> 添加插件市场` → `marketplace/`). The plugin (MCP tools + hooks) works without the receiver for outbound dispatch; the receiver is what accepts inbound jobs.

On start the receiver logs a **compat check** — key present and `chmod 600`, `host` / `allowedIps` non-empty, `projectsRoot` exists, runner executable, ZCode CLI found, transport prerequisites (direct: every `peers.*.keyFile`; yobiru: a Yobiru CLI) — and `/health` returns the same. With no key or no host it exits non-zero with the reason; nothing fails silently.

A peer that should push results back needs **you** in its `peers` under your `selfName` (or the request carries `callback_url` that starts with one of the receiver's configured peer URLs). Other `callback_url`s are refused with 400.

`transport: "yobiru"` is **optional**, for meshes already on Yobiru/tailmsg: add `"transport": "yobiru"` and `"grokPeer": "<node>/grok"`. All Yobiru CLI calls are in `marketplace/plugins/zcode-dispatch/lib/transport.mjs`. The Yobiru wake adapter and host notes are private deploy config and not in this repository; macOS launchd and self-check are under **Operate**.

## Pieces

| Dir | What |
|---|---|
| `marketplace/` | Local ZCode personal plugin marketplace (`marketplace.json`) with plugin `zcode-dispatch` (`0.3.0`) |
| `marketplace/plugins/zcode-dispatch/` | **Official ZCode plugin package.** `.zcode-plugin/plugin.json`, `.mcp.json` (stdio MCP server with `dispatch_to_grokbot`, `dispatch_to_dsh`, `dispatch_status`), slash commands `/dispatch-grok`, `/dispatch-dsh`, `/dispatch-status`, `UserPromptSubmit` + `Stop` hooks, `lib/transport.mjs` (the only place that talks to other agents), `lib/netconfig.mjs` (settings) |
| `receiver/` | **Outside → ZCode (HTTP).** `node receiver/server.mjs`; IP allowlist + Bearer; runs `bin/zcode-dispatch-run -p <text> --cwd <projectsRoot>/<project> --mode yolo --json` (override: `runner` / `ZCODE_DISPATCH_RUNNER`), max 2 concurrent |
| `bin/zcode-dispatch-run` + `lib/appsession.mjs` | Runner: ZCode.app running → visible app session; else CLI stream-json; else `bin/zcode-run` (headless) |
| `client/zcode-dispatch.sh` | curl client for the receiver |

## Configuration (no hosts, IPs or user paths in code)

Order: **env > `~/.config/zcode-dispatch/config.json` (`ZCODE_DISPATCH_CONFIG`) > tailscale discovery (if installed) > default**.

| Setting | Env | config.json | When unset |
|---|---|---|---|
| receiver bind host | `DISPATCH_HOST` | `host` | this node's tailnet IPv4 if Tailscale is installed; never `0.0.0.0` — receiver exits with an error |
| port | `DISPATCH_PORT` | `port` | 7791 |
| receiver allowed IPs | `DISPATCH_ALLOWED_IPS` | `allowedIps` | tailnet IPs of the `grokPeer` node (Tailscale only), else empty = everyone refused |
| transport | `ZCODE_DISPATCH_TRANSPORT` | `transport` | `direct` |
| direct peers | — | `peers` `{name: {url, keyFile}}` (`dsh`, `grok-bot`, …) | none |
| our name for callbacks | — | `selfName` | `zcode` |
| explicit callback URL | — | `callbackUrl` | none (send `callback_peer: selfName`) |
| DSH dispatch mode | — | `dshVia` (`http`/`local`) | `http` if `peers.dsh` exists, else `local` |
| dsh binary (local mode) | `DSH_BIN` | `dshBin` | `dsh` on `PATH` |
| receiver runner | `ZCODE_DISPATCH_RUNNER` | `runner` | `bin/zcode-dispatch-run` |
| projects root / denied | `ZCODE_DISPATCH_PROJECTS_ROOT` | `projectsRoot` / `denyProjects` (regex) | `~/Projects` / `finance` |
| Grok peer (yobiru) | `ZCODE_DISPATCH_GROK_PEER` | `grokPeer` | none |
| Yobiru allowed peers (yobiru) | `ZCODE_ALLOWED_PEERS` | `allowedPeers` | Yobiru's `allow` list |
| Yobiru CLI (yobiru) | `YOBIRU_BIN` / `TAILMSG_HOME` | — | `~/.tailmsg/tailmsg.py`, else newest `~/.codex/plugins/cache/yobiru/…/scripts/yobiru` |

## Dispatch paths (order, `lib/route.mjs`)

1. **ZCode.app running → visible app session** via the app scheduler (`lib/appsession.mjs`, desktop login + model). Schema-checked; on failure or no pickup it logs `[zcode-dispatch] FALLBACK: …`.
2. **App not running / app path broken → official CLI** `zcode -p … --output-format stream-json [--resume]` (`lib/zcode-protocol.mjs`; CLI's own login, one-time `bin/zcode-run login bigmodel`).
3. **→ headless** `bin/zcode-run`. Force one path with `ZCODE_DISPATCH_PATH=app|protocol|headless`. Check with `bin/zcode-probe [--live]` (exit 0 ok, 2 incompatible CLI, 3 no CLI login, 4 scheduler schema changed). Details: `docs/ZCODE-SURFACES.md`.

## Routing rule

Every task text starts with `[Project: <name>]`; `<name>` must be a direct child folder of `projectsRoot` (default `~/Projects`; `denyProjects`, default `finance`, refused). The outbound tools add the tag if missing and refuse a mismatching tag.

## ZCode → outside (outbound slash commands & MCP tools)

- `/dispatch-grok <project> <task>` → `dispatch_to_grokbot {project, text, timeout_seconds?}` → direct: `POST <peers.grok-bot.url>/v1/jobs`; yobiru: `yobiru request send <grokPeer> "<text>" --as zcode --wake now`; returns the request/job id.
- `/dispatch-dsh <project> <task>` → `dispatch_to_dsh {project, text, timeout_seconds?}` → `http` (default when `peers.dsh` is set): `POST <peers.dsh.url>/v1/jobs` with `job_id` + `callback_peer`, DSH pushes the result to the receiver's `/v1/callbacks`; `local`: detached `dsh --profile headless --json "<text>"` (`DSH_PERMISSION_MODE=danger-full-access`). Job file: `~/.local/state/zcode-dispatch/outgoing/<id>.json`.
- `/dispatch-status <id>` → `dispatch_status {id}` → queries the outbound job file (pulling `GET <dsh>/v1/jobs/<id>` while an HTTP job has no callback yet), `session-jobs.json` / `reports/<id>.json` (by 16-hex job id or `sess_...` session id), else the transport's status (`yobiru request status <id> --refresh --json` in yobiru mode).

After editing: bump `version` in **both** `marketplace/marketplace.json` and `marketplace/plugins/zcode-dispatch/.zcode-plugin/plugin.json`, then:
```sh
bin/zcode-run plugins marketplace update zcode-dispatch
bin/zcode-run plugins update zcode-dispatch@zcode-dispatch
```

## Outside → ZCode

HTTP API (same shape as dsh-grokbot-dispatch):

| Route | Body / result |
|---|---|
| `GET /health` | `{ok, running, runner, transport, checks:{errors,warnings}}` (IP check only) |
| `POST /v1/jobs` | `{project, text, timeout_seconds?, mode?: plan\|edit\|build\|guarded\|yolo, source?: grok-bot\|yobiru\|dsh\|local\|zcode, job_id?, callback_peer?, callback_url?}` → `202 {id, state:"running"}` |
| `POST /v1/callbacks` | a peer pushes `{job_id, state, result, error, session_id}` for a job we dispatched to it → `outgoing/<id>.json` |
| `GET /v1/jobs/<id>` | `{state, exit_code, session_id, result, error, reported?, report_method?, ...}` |

- Allowlist: `DISPATCH_ALLOWED_IPS` / config `allowedIps` (see Configuration). Key: `~/.config/zcode-dispatch/key` on the receiver host (0600, 32 random bytes hex). Callers: `ZCODE_DISPATCH_URL`, `ZCODE_DISPATCH_KEY` for `client/zcode-dispatch.sh`.
- Yobiru (optional; wake adapter lives in your private deploy docs/mesh): `yobiru request send <this host>/zcode "[Project: X] ..." --wake now`. Peers: receiver allowlist **and** `ZCODE_ALLOWED_PEERS` / config `allowedPeers` (default: Yobiru's own `allow` list in `~/.tailmsg/config.json`). State: `~/.tailmsg/adapters/zcode-state/`.
- Both runners set `ZCODE_DISPATCH_JOB_ID` (+ `ZCODE_DISPATCH_SOURCE`) for the ZCode process.

## Visible app sessions & non-public interface risk

> **Not a public ZCode interface.** Private ZCode files are read in two places only: `lib/appsession.mjs` (writes/reads `~/.zcode/v2/tasks-index.sqlite`, reads `recentProjects` from `~/.zcode/v2/setting.json`) and, read-only, the Stop-hook fallback lookup in `marketplace/plugins/zcode-dispatch/lib/job-map.mjs` (`tasks-index.sqlite`; the plugin package cannot import the repo's `lib/`). If they break, dispatch falls back to the CLI / headless path.

Source: official open-source client [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0, commit aac4755). ZCode plugins (official format: `.zcode-plugin/plugin.json`, commands/skills/agents/hooks/.mcp.json) run as child processes of the agent and get **no public in-app session creation API**; the only external in-app entry points are deep links (`zcode://workspace/open`, with a manual confirm gate) and built-in cloud bots (Feishu/Telegram/WeChat, hard-coded endpoints). So for inbound visible sessions we use the app's **own automation scheduler** (`~/.zcode/v2/tasks-index.sqlite`):

1. `lib/appsession.mjs` inserts a one-shot row into `~/.zcode/v2/tasks-index.sqlite` `automations` (same columns/values as `AutomationRepo.create`, `BEGIN IMMEDIATE`, `recurring=0,max_runs=1,next_run_at=now`, `mode='yolo'`, `model_selection='{"providerId":…,"modelId":…}'` = the resolved dispatch model), embedding `[来源: <source>] [job: <job_id>]` in the prompt head and `[<source> #<job_id>]` in the automation title.
2. The app's scheduler utility process (`desktop/src/scheduler`, 20 s poll) claims it and the Host runs `zcodeTaskService.createTask({workspacePath, model, mode})` + `sendPrompt` (`desktop/src/host/index.ts`).
3. Result: a normal left-sidebar session in project `~/Projects/<p>`, title = prompt head (`[Project: p] [来源: grok-bot] [job: <id>] …`), session mode `yolo` (no approvals), live progress in the app, click in to keep chatting. It runs on the **desktop's own login**, with the model set per job: default **GLM-5.3 Flash** (`account:bigmodel-individual-coding-plan/GLM-5.3-Flash`), another model only when the dispatch names one (`model` field); see docs/ZCODE-SURFACES.md "Model selection"; no credential file is ever read or decrypted.
4. The runner polls `automation_runs` (`session_id`, `outcome`) and the `tasks` row for the reply, binds `session_id <-> job_id`, then deletes its finished one-shot automation row (app cap: 20 automations); the visible session stays.

Fallback: if `ZCode` is not running (or the app does not claim the job within 90 s) the headless CLI runs instead (`ZCODE_DISPATCH_FORCE_HEADLESS=1` forces headless).
Upgrade risk: because `automations` / `automation_runs` / `tasks` in `~/.zcode/v2/tasks-index.sqlite` are internal ZCode tables rather than a versioned plugin API, a future ZCode major upgrade that changes the `automations` schema could break visible-session enqueueing until `lib/appsession.mjs` is updated (and will automatically fall back to headless after `pickupSeconds`).

## Automatic completion reports (`session_id <-> job_id` mapping + Stop hook)

Because ZCode.app's Host spawns desktop sessions without inheriting `ZCODE_DISPATCH_JOB_ID`, `zcode-dispatch` bridges the gap with a 4-layer mapping in `marketplace/plugins/zcode-dispatch/lib/job-map.mjs` and `hooks/stop-report.mjs`:

1. **Enqueue time (`lib/appsession.mjs`)**: embeds `[job: <16-hex>]` into both the task prompt and session/automation title, and records `jobs[<job_id>]` (with `automation_id`, `source`, `project`, `notify_peer`) in `~/.local/state/zcode-dispatch/session-jobs.json` (synced with `${ZCODE_PLUGIN_DATA}/session-jobs.json`).
2. **Turn start (`UserPromptSubmit` hook) & runner poll (`runInApp`)**: extracts `[job: <16-hex>]` from `input.prompt` (and `automation_runs.session_id`) and binds `sessions[<session_id>] = <job_id>` in `session-jobs.json`.
3. **Turn end (`Stop` hook, `hooks/stop-report.mjs`)**: looks up `session_id` in `session-jobs.json` (with fallback to `ZCODE_DISPATCH_JOB_ID`, `transcript_path`, and read-only `tasks-index.sqlite` `automation_runs`/`tasks`) and always writes `~/.local/state/zcode-dispatch/reports/<job>.json` + `reports.jsonl` (and `${ZCODE_PLUGIN_DATA}/reports/<job>.json`). By default it does **not** notify Yobiru; it only sends `[ZCode report <job>] <text>` to Grok (`grokPeer`, via Yobiru `--as zcode --wake none`) when the job mapping indicates the task was dispatched by Grok (`source` is `grok`/`grok-bot`, `notify` is `grok` from a Grok inbound path, or an inbound Yobiru request from the `grokPeer` node / `grok` agent). Tasks from `dsh`, `zcode`, or local/manual sessions never notify Grok, and explicit `ZCODE_DISPATCH_NOTIFY=none` disables Grok notification even for Grok-dispatched jobs. It never blocks the stop (`exit 0`, empty stdout). Yobiru-sourced jobs additionally answer through `request respond`. **This Yobiru notification only happens with `transport: "yobiru"`**; with the default direct transport the receiver pushes the result itself (HTTP callback) and the hook only records (`yobiru_skipped: "transport-direct"`).

## Operate

```sh
npm start                     # receiver (foreground); any supervisor (launchd/systemd/pm2) may wrap it
curl -s http://<host>:7791/health
npm test
bin/check                     # local literal-IP guard (no network, no GitHub Actions)
ZCODE_DISPATCH_URL=http://<host>:7791 ZCODE_DISPATCH_KEY=... client/zcode-dispatch.sh send myproj "[Project: myproj] Reply with exactly OK"   # then: wait <id>
```

Optional macOS helpers (no secrets; host comes from env / `config.json` / tailscale, as above):

```sh
bin/install-launchd.sh        # render launchd/dev.semantic-craft.zcode-dispatch.plist.template into ~/Library/LaunchAgents (prints, does not run, the launchctl commands)
bin/selfcheck.sh [N]          # launchd state, zcode-probe --live, /health, last N log lines and jobs, Stop-hook reports
```

The Yobiru wake adapter is private deploy config and not in this repository.

Logs: `~/.local/state/zcode-dispatch/logs/dispatch.log` (2 MB rotate), `launchd.log` (if launchd is used); jobs in `.../jobs/`; mapping in `.../session-jobs.json`; Stop-hook reports in `.../reports/`.
