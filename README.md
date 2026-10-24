# OpenCode Kiro Auth

Use the models in your AWS Kiro (CodeWhisperer) plan from OpenCode and Claude Code. The
project ships two parts that share one account store and one request pipeline:

- **Local server.** An HTTP server on `127.0.0.1` that speaks the OpenAI Chat Completions
  API and the Anthropic Messages API. Point Claude Code, OpenCode, or any compatible
  client at it. Your client's own system prompt and tools reach Kiro unchanged.
- **OpenCode plugin.** Registers a `kiro` provider inside OpenCode, with no server to run.

Pick the server for Claude Code, or if you want one endpoint for several tools. Pick the
plugin if you only use OpenCode and want the least setup.

## Features

- **Two APIs on one port**: OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`,
  including streaming, tool use, images, and `count_tokens`.
- **Claude, GPT-5.6, Kimi K3 and open-weight models**, with `-thinking` variants for the
  models that accept an effort level.
- **Multiple auth methods**: AWS Builder ID, IAM Identity Center (custom Start URL), and
  Kiro Desktop (CLI-based) sign-in.
- **Auto-sync with Kiro CLI**: imports and refreshes your session from the local
  `kiro-cli` database.
- **Silent token refresh** after idle, with no browser prompt.
- **Account rotation** by lowest available quota, with backoff on rate limits.
- **Gradual context truncation** on retries, to avoid error 400.
- **Native reasoning**: Kiro's reasoning stream is shown in the client's thinking block.
- **Opt-in stable conversation IDs** to lower credit usage (see
  [Reducing credit usage](#reducing-credit-usage)).

## Requirements

- A Kiro account and [Kiro CLI](https://kiro.dev/docs/cli/) signed in with
  `kiro-cli login`.
- [Bun](https://bun.sh) 1.x to run the server. The plugin build also needs Node.js.
- Linux was used for all testing. macOS and Windows paths are listed where they differ,
  but the server and the service setup have not been tested there.

## Local server

### 1. Install

```bash
git clone <repository-url> opencode-kiro-auth
cd opencode-kiro-auth
bun install
```

### 2. Sign in to Kiro

```bash
kiro-cli login
```

The server reads the same account database as the plugin
(`~/.config/opencode/kiro.db`) and syncs your session from Kiro CLI on startup. If you
use IAM Identity Center, run `kiro-cli profile` once and pick a profile.

### 3. Choose an API key and start the server

The server requires an API key and refuses to start without one. Clients send it as
`Authorization: Bearer <key>` or `x-api-key: <key>`. Generate one:

```bash
openssl rand -hex 32
```

```bash
export KIRO_AUTH_API_KEY=<your-key>
bun run serve
```

| Variable                      | Required | Default | Meaning                                        |
| ----------------------------- | -------- | ------- | ---------------------------------------------- |
| `KIRO_AUTH_API_KEY`           | yes      | none    | Key clients must send.                         |
| `KIRO_AUTH_PORT`              | no       | `8001`  | Port to listen on.                             |
| `KIRO_STABLE_CONVERSATION_ID` | no       | off     | Set to `1` to enable stable conversation IDs.  |

The server binds to `127.0.0.1` only, and there is no option to change that. Do not put
it behind a public proxy. Anyone who can reach the port and knows the key can spend your
Kiro credits.

Check that it is up:

```bash
curl http://127.0.0.1:8001/health
```

### 4. Run it in the background (Linux, systemd user service)

Create `~/.config/kiro-auth-server/env` with mode `600`:

```bash
mkdir -p ~/.config/kiro-auth-server
install -m 600 /dev/null ~/.config/kiro-auth-server/env
printf 'KIRO_AUTH_API_KEY=<your-key>\nKIRO_AUTH_PORT=8001\n' >> ~/.config/kiro-auth-server/env
```

Create `~/.config/systemd/user/kiro-auth-server.service`, adjusting the two paths:

```ini
[Unit]
Description=Kiro Auth Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/opencode-kiro-auth
ExecStart=/path/to/bun run src/server/index.ts
EnvironmentFile=%h/.config/kiro-auth-server/env
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kiro-auth-server
```

The service starts at login. To keep it running when you are logged out, also run
`loginctl enable-linger "$USER"`.

### Endpoints

| Endpoint                       | Auth | Notes                                                  |
| ------------------------------ | ---- | ------------------------------------------------------ |
| `GET /health`                  | no   | Liveness check.                                        |
| `GET /v1/models`               | yes  | Lists the models below.                                |
| `POST /v1/chat/completions`    | yes  | OpenAI format. Streams when `stream` is `true`.        |
| `POST /v1/messages`            | yes  | Anthropic format. Streams when `stream` is `true`.     |
| `POST /v1/messages/count_tokens` | yes | A local estimate, not a count from Kiro.              |

### Use it with Claude Code (CLI)

Claude Code reads environment variables from the `env` block of its settings file.
Edit `~/.claude/settings.json` to apply the change to every project, or
`.claude/settings.local.json` inside one project to apply it there only:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8001",
    "ANTHROPIC_API_KEY": "<your-key>",
    "ANTHROPIC_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-5-5"
  }
}
```

The file holds your key, so keep it at mode `600`. Start a new `claude` session after
saving, because running sessions keep the values they started with. Run `/status` to
confirm the base URL.

Model ids:

- Use the ids in the [model table](#models). Dated ids (`claude-haiku-4-5-20251001`),
  `-latest`, dotted ids (`claude-haiku-4.5`) and the `[1m]` suffix are accepted.
- An unknown `claude-*` id falls back to its family: Haiku to `claude-haiku-5-5`,
  Sonnet to `claude-sonnet-5-5`, Opus to `claude-opus-5-5`, and Fable to `auto`. Kiro has
  no Fable model.
- To add Kiro's Auto model to the `/model` picker, add these to the same `env` block:

  ```json
  "ANTHROPIC_CUSTOM_MODEL_OPTION": "auto",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "Auto",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Kiro Auto"
  ```

  To make the `fable` alias use it too, set `"ANTHROPIC_DEFAULT_FABLE_MODEL": "auto"`.

To try the server without touching your settings, pass a throwaway settings file:

```bash
claude --settings ./kiro-overlay.json
```

Values in `~/.claude/settings.json` override variables you export in your shell, so the
overlay approach is the reliable way to test.

### Use it with Claude Code (desktop app)

Claude's docs say the desktop app does not use `ANTHROPIC_BASE_URL` from your shell or
from `settings.json` for local sessions. It takes gateway settings from its own
third-party inference configuration instead:

1. In the desktop app, open **Help, Troubleshooting, Enable Developer Mode**. The app
   restarts with a Developer menu.
2. Open **Developer, Configure Third-Party Inference** and enter
   `http://127.0.0.1:8001` as the gateway base URL, along with your key.

The desktop app has not been tested against this server. Check the form's fields against
Anthropic's current
[LLM gateway documentation](https://code.claude.com/docs/en/llm-gateway-connect.md).
Cloud and SSH sessions run on other machines and cannot reach a server bound to your
`127.0.0.1`. The CLI above is the tested path.

### Use it with OpenCode (CLI)

Add a provider to `~/.config/opencode/opencode.json` or `opencode.jsonc` (Windows:
`%APPDATA%\opencode`). This uses OpenCode's OpenAI-compatible provider:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "kiro-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro Local",
      "options": {
        "baseURL": "http://127.0.0.1:8001/v1",
        "apiKey": "{env:KIRO_AUTH_API_KEY}"
      },
      "models": {
        "claude-sonnet-5-5": {
          "name": "Claude Sonnet 5.5",
          "attachment": true,
          "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "limit": { "context": 1000000, "output": 64000 }
        },
        "gpt-5.6-luna": {
          "name": "GPT-5.6 Luna",
          "attachment": true,
          "tool_call": true,
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "limit": { "context": 1000000, "output": 64000 }
        }
      }
    }
  }
}
```

`{env:KIRO_AUTH_API_KEY}` reads the key from your environment, so it stays out of the
file. Export it in the shell that launches OpenCode. If you prefer, paste the key in
directly and keep the file at mode `600`.

Add one entry under `models` for each id you want from the [model table](#models), using
the same context limits. Run `/models` in OpenCode and pick `Kiro Local`.

### Use it with OpenCode (desktop app)

OpenCode's configuration docs say settings in this file apply across the TUI, the CLI
(`opencode run`), the desktop app, and the GitHub Action. So the provider above should
appear in the desktop app after a restart. The desktop app has not been tested with this
server. Because
`{env:...}` reads the environment of the app process, a desktop app started from a
launcher may not see variables you exported in a terminal. If the key comes back empty,
put the key in the file instead.

### Other clients

Any OpenAI-compatible client can use base URL `http://127.0.0.1:8001/v1` with your key
as the API key. Any Anthropic SDK client can use `http://127.0.0.1:8001` as its base URL.

### Limits of the server

- Only client-side tools reach Kiro. Server-side Anthropic tools such as web search have
  no equivalent in Kiro and are dropped from the request.
- Only base64 images are supported. Document blocks are replaced with a short notice.
- Models may still say they are "Kiro" when asked who they are, even though the request
  carries no such text.

## OpenCode plugin

The plugin registers a `kiro` provider inside OpenCode. It needs no server and no API
key of its own.

```bash
git clone <repository-url> opencode-kiro-auth
cd opencode-kiro-auth
npm install
npm run build
```

Then point OpenCode at the clone in `~/.config/opencode/opencode.json` or
`opencode.jsonc`:

```json
{
  "plugin": ["/absolute/path/to/opencode-kiro-auth"]
}
```

That is the whole configuration. The plugin advertises every model Kiro exposes,
including a `-thinking` companion for each model that supports reasoning effort. Run
`/models` to pick one. OpenCode loads the compiled `dist/` folder, so run
`npm run build` and restart OpenCode after every update.

The plugin and the server can be used side by side. They share
`~/.config/opencode/kiro.db`.

### Authentication

1. **Kiro CLI (recommended)**
   - Run `kiro-cli login` in a terminal.
   - The plugin creates a minimal `kiro` placeholder in OpenCode's `auth.json` when it
     detects the Kiro CLI database, then imports and syncs your session on startup.
   - For AWS IAM Identity Center (SSO), the plugin imports both the token and the device
     registration (OIDC client credentials).
2. **Direct sign-in**
   - Run `opencode auth login`, choose `Other`, type `kiro`, and press enter.
   - You are asked for an **IAM Identity Center Start URL** and **region**. Leave the
     Start URL blank to use AWS Builder ID. Enter your company's Start URL
     (for example `https://your-company.awsapps.com/start`) to use SSO.
   - The TUI `/connect` flow does not run plugin OAuth prompts, so use
     `opencode auth login` for Identity Center.
   - IAM Identity Center usually also needs a **profile ARN**. If `kiro-cli` is
     installed and you have run `kiro-cli profile` once, the plugin detects it.
     Otherwise set `idc_profile_arn` in `~/.config/opencode/kiro.json`.
   - A browser opens to the AWS verification page. If it does not, copy the URL and
     enter the code that OpenCode prints.
   - You can preset defaults with `idc_start_url` and `idc_region` in
     `~/.config/opencode/kiro.json`.

Accounts are stored in `~/.config/opencode/kiro.db`.

## Models

| Model ID                                                                    | Context   | Rate       | Thinking variant | `xhigh` |
| --------------------------------------------------------------------------- | --------- | ---------- | ---------------- | ------- |
| `claude-opus-5-5`                                                           | 1M        | 2.0x       | yes              | yes     |
| `claude-opus-5`                                                             | 1M        | 2.2x       | yes              | yes     |
| `claude-opus-4-8`, `claude-opus-4-7`                                        | 1M        | 2.2x       | yes              | yes     |
| `claude-opus-4-6`                                                           | 1M        | 2.2x       | yes              | no      |
| `claude-opus-4-5`                                                           | 200K      | 2.2x       | yes              | no      |
| `claude-sonnet-5-5`                                                         | 1M        | 1.3x       | yes              | yes     |
| `claude-sonnet-5`                                                           | 1M        | 1.3x       | yes              | yes     |
| `claude-sonnet-4-6`                                                         | 1M        | 1.3x       | yes              | no      |
| `claude-sonnet-4-5`                                                         | 200K      | 1.3x       | yes              | no      |
| `claude-haiku-5-5`                                                          | 1M        | 0.06x\*\*  | yes              | yes     |
| `claude-haiku-4-5`                                                          | 200K      | 0.4x       | no               | no      |
| `gpt-5.6-sol`                                                               | 1M        | 4.4x       | yes              | yes     |
| `gpt-5.6-terra`                                                             | 1M        | 2.2x       | yes              | yes     |
| `gpt-5.6-luna`                                                              | 1M        | 0.6x       | yes              | yes     |
| `kimi-k3`                                                                   | 1M        | 2.4x       | no               | no      |
| `deepseek-3.2`, `glm-5`, `minimax-m2.5`, `minimax-m2.1`, `qwen3-coder-next` | 128K–256K | 0.05x–0.5x | no               | no      |
| `auto`                                                                      | 1M\*      | 1.0x       | no               | no      |

Rates and context sizes come from `kiro-cli chat --list-models` and Kiro's model page,
and Kiro changes them over time. Run that command to see the current values for your
plan.

\*\* Two-tier pricing, per Kiro's model page: Haiku 5.5 requests up to 100K tokens use the
listed 0.06x rate, and requests over 100K tokens are billed at 0.3x. GPT-5.6 has a similar
split at 272K tokens (double the listed rate). Long agentic sessions can cross these lines.

\* Kiro does not publish a context size for Auto. 1M is what has been observed in use.
If Auto routes a request to a smaller model, a client may compact late and hit a
context-overflow error.

Defining `provider.kiro.models` yourself replaces the plugin's registry entirely. Only
do that to rename or restrict models, and see below if any of them are `-thinking`
models.

### Thinking effort

Every effort-capable model gets a `-thinking` companion that already carries the
reasoning flags and an effort ladder as variants. Pick a `-thinking` model and cycle its
variants to change reasoning depth. Each entry declares two fields OpenCode needs to
render reasoning:

```json
{
  "reasoning": true,
  "interleaved": { "field": "reasoning_content" }
}
```

Both are required. `reasoning` declares the capability, and `interleaved.field` tells
OpenCode that reasoning arrives in the non-standard `reasoning_content` delta. If either
is missing, OpenCode silently drops every reasoning chunk. If you override
`provider.kiro.models`, copy both fields onto any `-thinking` model you define.

Variants set `thinkingConfig.thinkingBudget`, which maps to Kiro's native effort level:

| OpenCode budget | Kiro effort |
| --------------- | ----------- |
| `<= 16384`      | `low`       |
| `<= 32768`      | `medium`    |
| `<= 65536`      | `high`      |
| `<= 98304`      | `xhigh`     |
| `> 98304`       | `max`       |

`xhigh` exists only on opus-4.7, opus-4.8, opus-5, opus-5.5, sonnet-5, sonnet-5.5,
haiku-5.5 and the three GPT-5.6 tiers. Those models get a five-variant ladder. The others get four, and a
budget in the `xhigh` band is clamped to `max`.

Claude models receive the effort as `output_config.effort`. GPT-5.6 models receive it as
`reasoning.effort`, because each family rejects the other's field with a 400. The field
is chosen from the model ID, so the same variants work for both.

## Reducing credit usage

Credits are billed per request at the model's rate, and agentic clients re-send the
system prompt, tool schemas and history on every turn. Some things that help:

- **Pick the model by task.** `gpt-5.6-luna` (0.6x) or `auto` (1.0x) cost less per
  request than Sonnet (1.3x) or Opus (2.0x to 2.2x). Use `-thinking` variants only when
  you need them.
- **Stable conversation IDs.** By default each request gets a random conversation ID.
  With `KIRO_STABLE_CONVERSATION_ID=1`, every turn of one session shares an ID, derived
  from the first user message and a prefix of the system prompt with digits removed. In a
  6-turn test on `gpt-5.6-luna`, this used about 2.6 times fewer credits (0.25 against
  0.65 per run, over three runs each). The test was small, and the reason Kiro charges
  less is unknown, so measure your own workload. Leave it off if it does not help you.
- **Keep context small.** Trim unused MCP servers, keep `CLAUDE.md` short, and compact or
  restart long sessions.

## Plugin settings

Edit `~/.config/opencode/kiro.json` (Windows: `%APPDATA%\opencode\kiro.json`):

```json
{
  "auto_sync_kiro_cli": true,
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "idc_start_url": "https://your-company.awsapps.com/start",
  "idc_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 20,
  "request_timeout_ms": 120000,
  "token_expiry_buffer_ms": 120000,
  "usage_sync_max_retries": 3,
  "usage_tracking_enabled": true,
  "auto_effort_mapping": true,
  "enable_log_api_request": false
}
```

- `auto_sync_kiro_cli`: sync sessions from Kiro CLI (default `true`).
- `account_selection_strategy`: `sticky`, `round-robin` or `lowest-usage`.
- `default_region`: AWS region (`us-east-1`, `us-west-2`).
- `idc_start_url`: default IAM Identity Center Start URL. Leave blank for Builder ID.
- `idc_region`: IAM Identity Center (SSO OIDC) region. Defaults to `us-east-1`.
- `rate_limit_retry_delay_ms`: delay between rate-limit retries (1000-60000).
- `rate_limit_max_retries`: maximum rate-limit retries (0-10).
- `max_request_iterations`: loop cap to prevent hangs (10-1000).
- `request_timeout_ms`: request timeout (60000-600000).
- `token_expiry_buffer_ms`: token refresh buffer (30000-300000).
- `usage_sync_max_retries`: usage sync retries (0-5).
- `usage_tracking_enabled`: usage tracking and toast notifications.
- `auto_effort_mapping`: map thinking budgets to Kiro effort levels (default `true`). A
  top-level `effort` setting overrides effort for all supported models.
- `enable_log_api_request`: detailed request logging. Logs include the resolved
  `additionalModelRequestFields`, so this is how you confirm which effort level went out.
- `auth_server_port_start`, `auth_server_port_range`: legacy and ignored.

## Troubleshooting

### Status: 403 (AccessDeniedException / User is not authorized)

With **IAM Identity Center**, the CodeWhisperer APIs usually need a **profile ARN**. The
plugin and server read the active profile ARN from the `kiro-cli` database and send it as
`profileArn`.

1. Run `kiro-cli profile` and select a profile (for example `QDevProfile-us-east-1`).
2. Retry, or restart OpenCode or the server so it re-syncs.

A 403 about an invalid bearer token means the stored access token expired. Make any
normal Kiro request, or restart the server, and it refreshes.

### No accounts

The account database `~/.config/opencode/kiro.db` is empty.

1. Make sure `kiro-cli login` succeeds.
2. Make sure `auto_sync_kiro_cli` is `true` in `kiro.json`.
3. Retry. The plugin and server try a Kiro CLI sync when they find no accounts.

### The server exits immediately

`KIRO_AUTH_API_KEY is required` means the variable is not set in the environment the
server starts in. For a systemd service, check the `EnvironmentFile` path. If the port is
taken, set `KIRO_AUTH_PORT`.

### Claude Code ignores the new base URL

Start a new session. Settings-file values take precedence over variables exported in
your shell, so an old value in `~/.claude/settings.json` wins.

### Kiro CLI sign-in with Google or GitHub

OpenCode needs a stored `kiro` auth entry before it calls the plugin loader. The plugin
creates that placeholder when it detects the Kiro CLI database, so restart OpenCode
after `kiro-cli login`. The placeholder values are never used for API calls. If bootstrap
is skipped because `auth.json` is malformed, fix the JSON first. The plugin will not
overwrite a malformed file, because it may hold other providers' credentials.

### `/connect` and `opencode auth login`

For provider-specific OAuth values such as the Identity Center Start URL and region, use
`opencode auth login`. The TUI `/connect` flow does not show plugin prompts.

For IDC/SSO, the plugin may create an account with a placeholder email if it cannot
fetch the real one during sync (for example offline). It replaces the placeholder once
the lookup succeeds.

## Storage

**Linux and macOS**

- Database: `~/.config/opencode/kiro.db`
- Plugin config: `~/.config/opencode/kiro.json`
- Server environment file (if you use the service above):
  `~/.config/kiro-auth-server/env`

**Windows**

- Database: `%APPDATA%\opencode\kiro.db`
- Plugin config: `%APPDATA%\opencode\kiro.json`

## Development

```bash
bun test           # unit tests
npm run typecheck  # tsc --noEmit
npm run build      # compile the plugin to dist/
npm run serve      # run the server from source
```

After `npm run build`, restart OpenCode to load the new plugin code. The server runs
straight from `src/`, so restart it after changing code.

## Acknowledgements

Thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for the
foundational Kiro authentication logic and request patterns.

## Disclaimer

This software is provided strictly for learning and educational purposes. It is an
independent implementation and is not affiliated with, endorsed by, or supported by
Amazon Web Services (AWS) or Anthropic. Use it at your own risk.

Feel free to open a PR to improve it.
