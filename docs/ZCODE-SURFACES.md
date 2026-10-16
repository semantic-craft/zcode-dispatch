# ZCode surfaces zcode-dispatch depends on

## Path order (and why)

1. **ZCode.app running → app scheduler (`lib/appsession.mjs`)** — PRIMARY. Jobs must be *visible* ZCode.app sessions that run on the
   desktop's own login and model (user requirement). ZCode exposes no public "create visible session" API to plugins, so this uses
   the app's automation scheduler tables. All of that lives in `lib/appsession.mjs`; `checkSchema()` verifies the columns we touch
   before every enqueue and in `bin/zcode-probe` (exit 4). A schema change, or the app not claiming the job within 90 s, logs
   `[zcode-dispatch] FALLBACK: …` and moves on. Once the app has run the job, its outcome is final (no double execution).
   Resume requests skip this path (the scheduler cannot resume a session).
2. **ZCode.app not running (or app path broken) → official CLI `-p --output-format stream-json`** (`lib/zcode-protocol.mjs`). Session id from
   the first event, final reply from the `result` line, `--resume` supported. Uses the CLI's own login (`zcode login bigmodel`),
   not visible in the app sidebar.
3. **→ plain headless `bin/zcode-run`.**

`ZCODE_DISPATCH_PATH=app|protocol|headless` forces one path with no fallback. Routing lives in `lib/route.mjs`.

Checked against ZCode.app 3.15.3 / bundled CLI `zcode 0.16.9`. CLI path (fallback when the app is not running) = official headless CLI
`zcode -p … --output-format stream-json [--resume]` (`lib/zcode-protocol.mjs`, the only module that knows ZCode
specifics); the app-server is used only as a protocol/version compat probe. Run `bin/zcode-probe --live` (part of
your local self-check) after every ZCode update: exit 0 usable, 3 = no usable model (needs CLI login), 2 = incompatible.

| Surface | Used for | Source / status | Stability |
|---|---|---|---|
| `zcode -p`, `--cwd`, `--mode`, `--resume <sess_…>` | run a turn / resume | `zcode --help` | **High** (public CLI flags) |
| `--output-format stream-json` | NDJSON events, every line has `sessionId` (first line precedes the model call); last line `{"type":"result",sessionId,turnId,response}` | Accepted values `text\|json\|stream-json` in the CLI option parser; not yet listed in `--help` | **Medium** — probe exits 2 with a clear message if the flag is rejected; `--json` (documented, final object only) is the drop-in fallback |
| CLI login (`zcode login bigmodel`) | standalone Prompt CLI owns its Coding Plan login; model = CLI default chosen at login (`account:bigmodel-individual-coding-plan/GLM-5.3`) | `auth-login.md` | High |

### App-server (compat probe only)


| Surface | Used for | Source / status | Stability |
|---|---|---|---|
| `zcode app-server --stdio` (NDJSON `{id,method,params}`, no `jsonrpc` key) | spawn backend | Documented: zai-org/ZCode `apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md`; it is the transport ZCode.app itself uses | **High** — desktop depends on it; protocol carries `{name:"ZCode Protocol",version:1}` which we check |
| v1 methods `session/create`, `send`, `read`, `messages`, `resume`, `close`, `setModel` | session lifecycle | Listed under "v1 方法" in the same doc | **High** (versioned) |
| Notification `state.updated` (`patch.status`, `reason`) | turn completion | Doc: "server-owned model state mutation 的 `state.updated` 通知" | Medium-high; we also re-read `session/read` so a missed event only costs the timeout |
| Server request `session/requestRuntimePreferences` | must be answered or create blocks | Observed + zcode-acp | Medium — unknown future server requests get a JSON-RPC error, not a hang |
| `create.settings.model.available` | must be an array (shape check only) | — | High |
| `zcode login bigmodel` | one-time CLI OAuth so a standalone app-server is entitled to the Coding Plan | Documented: `apps/zcode-cli/docs/design/v2/auth-login.md`; shares `~/.zcode/v2/credentials.json` with desktop. We never read that file | High (official CLI command) |
| Bundle layout `Contents/Resources/glm/zcode.cjs` + `config/provider/zcode-builtin.json`, env `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`/`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | locate CLI outside PATH | Not documented (same approach as william0wang/zcode-acp, Apache-2.0). `ZCODE_BIN` overrides | **Low-medium** — isolated in `resolveZcode()`; probe exits 2 with a clear message if it moves |
| Plugin hooks (`Stop`, `UserPromptSubmit`) + `.zcode-plugin/plugin.json` | completion report via Yobiru (`hooks/stop-report.mjs`) | Official plugin format | High |
| **Primary when the app runs:** `~/.zcode/v2/tasks-index.sqlite` `automations`/`automation_runs`/`tasks` (`lib/appsession.mjs`) | visible session in ZCode.app on the desktop login/model | Internal tables (no public API exists) | **Low** — guarded by `checkSchema()` + probe exit 4 + automatic loud fallback to the CLI path. Sessions land in the app's `cron` task group (automation runs), not under the Projects list |

## Why turns do not run through app-server

In zai-org/ZCode `process-provider-registry-runtime.ts` the `standalone` account runtime (own credential store) is enabled only for the "Standalone Prompt CLI / TUI"; `app-server` never enables it, so its model list is fed solely by the host (`provider/updateAccountConfig` + `interaction/requestProviderRuntimeHeaders`). Even after `zcode login`, a host-less app-server reports `model.available: []` (verified 2026-10-15). Hence the CLI path.

## Why the desktop login does not carry over

ZCode.app brokers Coding-Plan auth per request: the backend asks its host
(`interaction/requestProviderRuntimeHeaders`) and the desktop host mints a short-lived Project Access Token from
its OAuth login. A separately spawned app-server has no such host, so its model list is empty until the CLI has
its own login (`account-provider:<id>:identity` / `auth-source` markers written by `zcode login`). Re-implementing
the desktop's token minting would mean decrypting the user's OAuth token — explicitly out of scope.

## Projects placement (left sidebar "项目" view)

- The Projects view lists only workspaces in `~/.zcode/v2/setting.json` `recentProjects`;
  every task of a registered workspace is shown under it, including scheduler runs.
- Scheduler runs are additionally filed into the system group `zcode-default-group-cron`
  (host `ensureCronGroupMembership`, fired the first time a task's meta gains
  `cronAutomationId`). That only affects the "分组" (groups) view; we leave it untouched.
- So `runInApp` first calls `ensureProjectRegistered(cwd)`: if the workspace is not in
  `recentProjects`, it opens ZCode's official deep link `zcode://workspace/open?path=<abs>`
  (same URL as the Finder "Open in ZCode" service). ZCode shows a one-time
  "Open this folder in ZCode?" confirmation that the user must accept; we never click it.
  Dispatch proceeds regardless.
- Internal read: only the `recentProjects` key (array of strings or `{path}`). If the
  shape changes we warn and skip; set `ZCODE_DISPATCH_REGISTER_PROJECT=0` to disable.

## Model selection (user decision 2026-10-16)

Every dispatch in both directions (Grok Bot -> ZCode receiver, and ZCode plugin -> Grok Bot / DSH) runs
**GLM-5.3 Flash** unless the dispatch explicitly names another model (`model` in the JSON body / MCP tool, `--model` on
`bin/zcode-dispatch-run`). The id is ZCode's own: `account:bigmodel-individual-coding-plan/GLM-5.3-Flash`
(`providerId/modelId`, as ZCode reports it in `automation_runs.model_selection`, `tasks.model`, and CLI stream `payload`).

Before this, the app path wrote `model_selection = 'null'` ("follow workspace default") and ZCode's desktop default
(`~/.zcode/v2/provider_config.json` `defaultModelSelection`) is `GLM-5.3`, so every dispatched session ran GLM-5.3.

| Surface | Use | Stability guard |
|---|---|---|
| ZCode provider catalog `~/.zcode/v2/runtime/provider/**/zcode-builtin.json` `providerRules[].config.builtinModelIds` minus `provider_config.json` `enabled:false` rules | ZCode's self-reported model list; receiver start-up check + per-job check | Unreadable/changed format = compat error on `/health`, job rejected with 400; no fallback |
| `automations.model_selection` JSON `{providerId, modelId}` | app path picks the model per job | session `tasks.model` read back; mismatch fails the job |
| CLI stream `payload.providerId/modelId` | CLI path has no per-run model flag | mismatch with the requested model kills the run and fails loudly |
| bare headless `zcode-run` | cannot select or report a model | refused whenever a model is required |

Override the default with `ZCODE_DISPATCH_DEFAULT_MODEL` or `"defaultModel"` in `~/.config/zcode-dispatch/config.json`.
