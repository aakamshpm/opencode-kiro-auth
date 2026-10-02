# OpenCode Kiro Auth Plugin

OpenCode plugin for AWS Kiro (CodeWhisperer). It gives OpenCode access to the Claude,
GPT-5.6 and open-weight models in your Kiro plan.

> This is a personal fork of
> [tickernelz/opencode-kiro-auth](https://github.com/tickernelz/opencode-kiro-auth).
> It follows upstream v2.0.0 and adds the following:
>
> - **GPT-5.6 Sol, Terra and Luna**, with `-thinking` variants. Effort is sent as
>   `reasoning.effort`, because GPT models reject Claude's `output_config.effort`.
> - **Claude Opus 5.5 and Sonnet 5.5**, with the full `low`–`max` effort ladder.
> - **Silent token refresh after idle.** When an access token has expired, the plugin
>   refreshes it and sends the request with the new token. Upstream sent the old
>   token, which could open the AWS browser login after an idle period.
> - **Safer startup cleanup.** The startup database sweep removes only accounts that
>   have been unhealthy for a long time. It no longer deletes placeholder accounts
>   that the Kiro CLI sync creates on purpose.
>
> This fork is not published to npm. Install it from a local clone (see
> [Installation](#installation)).

## Features

- **Multiple Auth Methods**: Supports AWS Builder ID (IDC), IAM Identity Center (custom
  Start URL), and Kiro Desktop (CLI-based) authentication.
- **Auto-Sync Kiro CLI**: Automatically imports and synchronizes active sessions from
  your local `kiro-cli` SQLite database.
- **Gradual Context Truncation**: Intelligently prevents error 400 by reducing context
  size dynamically during retries.
- **Intelligent Account Rotation**: Prioritizes multi-account usage based on lowest
  available quota.
- **High-Performance Storage**: Efficient account and usage management using native Bun
  SQLite.
- **Native Thinking Mode**: Streams Kiro's native reasoning to OpenCode's thinking
  block, with the reasoning flags declared on every thinking model, so it renders
  without any model configuration.
- **Kiro Effort Mapping**: Maps OpenCode thinking budgets to Kiro's native effort
  levels automatically, across the full `low`–`max` ladder.
- **Automated Recovery**: Exponential backoff for rate limits and automated token
  refresh.

## Installation

Clone and build the fork:

```bash
git clone https://github.com/aakamshpm/opencode-kiro-auth.git
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

That is the whole configuration. The plugin registers the `kiro` provider and
advertises every model Kiro exposes, including a `-thinking` companion for each
model that supports reasoning effort. Run `/models` to pick one.

OpenCode loads the compiled `dist/` folder, so run `npm run build` and restart
OpenCode after every `git pull`. Switching branches without rebuilding does not
change what OpenCode runs.

### Models

| Model ID                                                                    | Context   | Rate        | Thinking variant | `xhigh` |
| --------------------------------------------------------------------------- | --------- | ----------- | ---------------- | ------- |
| `claude-opus-5-5`                                                           | 1M        | 2.0x        | yes              | yes     |
| `claude-opus-5`                                                             | 1M        | 2.2x        | yes              | yes     |
| `claude-opus-4-8`, `claude-opus-4-7`                                        | 1M        | 2.2x        | yes              | yes     |
| `claude-opus-4-6`                                                           | 1M        | 2.2x        | yes              | no      |
| `claude-opus-4-5`                                                           | 200K      | 2.2x        | yes              | no      |
| `claude-sonnet-5-5`                                                         | 1M        | 1.3x        | yes              | yes     |
| `claude-sonnet-5`                                                           | 1M        | 1.3x        | yes              | yes     |
| `claude-sonnet-4-6`                                                         | 1M        | 1.3x        | yes              | no      |
| `claude-sonnet-4-5`                                                         | 200K      | 1.3x        | yes              | no      |
| `claude-sonnet-4`, `claude-haiku-4-5`                                       | 200K      | 1.3x / 0.4x | no               | no      |
| `gpt-5.6-sol`                                                               | 1M        | 4.4x        | yes              | yes     |
| `gpt-5.6-terra`                                                             | 1M        | 2.2x        | yes              | yes     |
| `gpt-5.6-luna`                                                              | 1M        | 0.6x        | yes              | yes     |
| `deepseek-3.2`, `glm-5`, `minimax-m2.5`, `minimax-m2.1`, `qwen3-coder-next` | 128K–256K | 0.05x–0.5x  | no               | no      |
| `auto`                                                                      | 200K      | 1.0x        | no               | no      |

Rates and context sizes come from `kiro-cli chat --list-models`, and Kiro changes
them over time. Run that command to see the current values for your plan.

Defining `provider.kiro.models` yourself replaces the plugin's registry entirely.
Only do that to rename or restrict models, and see the reasoning flags below if
any of them are `-thinking` models.

### Thinking Effort Configuration

Every effort-capable Claude model gets a `-thinking` companion, already carrying
the reasoning flags and an effort ladder as variants. Nothing to configure: pick a
`-thinking` model and cycle its variants to change reasoning depth.

Each `-thinking` entry declares two fields that OpenCode needs in order to render
reasoning:

```json
{
  "reasoning": true,
  "interleaved": { "field": "reasoning_content" }
}
```

Both are required. `reasoning` declares the capability, and `interleaved.field`
tells OpenCode that reasoning arrives in the non-standard `reasoning_content`
delta this plugin emits. If either is missing, OpenCode silently drops every
reasoning chunk and no thinking block appears.

If you override `provider.kiro.models` in your own config, you replace the
plugin's registry wholesale — copy both fields onto any `-thinking` model you
define, or reasoning will stop rendering.

Reasoning itself comes from the API: Kiro streams `reasoningContentEvent` on
thinking models, and the plugin forwards each one as a `reasoning_content` delta.
Nothing needs to be enabled for that. Models that instead inline reasoning as
`<thinking>` tags in their answer are still handled, via a fallback scraper.

Variants set `thinkingConfig.thinkingBudget`, which the plugin maps to Kiro's
native `effort` field. Bands are scaled to Kiro's real thinking ceiling
(1024-128000 on opus-4.8/opus-5), so every effort level including `xhigh` is
reachable from a budget alone:

| OpenCode budget | Kiro effort |
| --------------- | ----------- |
| `<= 16384`      | `low`       |
| `<= 32768`      | `medium`    |
| `<= 65536`      | `high`      |
| `<= 98304`      | `xhigh`     |
| `> 98304`       | `max`       |

`xhigh` is only available on opus-4.7, opus-4.8, opus-5, opus-5.5, sonnet-5,
sonnet-5.5 and the three GPT-5.6 tiers. Those models get a five-variant ladder. The other models get
four variants, and a budget in the `xhigh` band is clamped to `max`.

Claude models receive the effort level as `output_config.effort`. GPT-5.6 models
receive it as `reasoning.effort`, because each family rejects the other's field
with a 400 ValidationException. The plugin chooses the field from the model ID,
so the same variants work for both.

Use `~/.config/opencode/kiro.json` for plugin-wide behavior such as auth sync,
account selection, retry limits, and `auto_effort_mapping`. A top-level `effort`
setting is a global override for all supported models, not a per-model setting.

## Setup

1. **Authentication via Kiro CLI (Recommended)**:
   - Perform login directly in your terminal using `kiro-cli login`.
   - The plugin automatically bootstraps a minimal `kiro` placeholder in
     OpenCode's `auth.json` when it detects the Kiro CLI database, then imports
     and synchronizes your active session on startup.
   - For AWS IAM Identity Center (SSO/IDC), the plugin imports both the token and device
     registration (OIDC client credentials) from the `kiro-cli` database.
2. **Direct Authentication**:
   - Run `opencode auth login`.
   - Select `Other`, type `kiro`, and press enter.
   - You'll be prompted for your **IAM Identity Center Start URL** and **IAM Identity
     Center region** (`sso_region`).
     - Leave it blank to sign in with **AWS Builder ID**.
     - Enter your company's Start URL (e.g. `https://your-company.awsapps.com/start`) to
       use **IAM Identity Center (SSO)**.
   - Note: the TUI `/connect` flow currently does **not** run plugin OAuth prompts
     (Start URL / region), so Identity Center logins may fall back to Builder ID unless
     you use `opencode auth login` (or preconfigure defaults in
     `~/.config/opencode/kiro.json`).
   - For **IAM Identity Center**, you may also need a **profile ARN** (`profileArn`).
     - If `kiro-cli` is installed and you've selected a profile once
       (`kiro-cli profile`), the plugin auto-detects it.
     - Otherwise, set `idc_profile_arn` in `~/.config/opencode/kiro.json`.
   - A browser window will open directly to AWS' verification URL (no local auth
     server). If it doesn't, copy/paste the URL and enter the code printed by OpenCode.
   - You can also pre-configure defaults in `~/.config/opencode/kiro.json` via
     `idc_start_url` and `idc_region`.
3. Configuration will be automatically managed at `~/.config/opencode/kiro.db`.

## Development

```bash
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit
bun test           # unit tests
```

After `npm run build`, restart OpenCode to load the new code.

### Syncing with upstream

```bash
git remote add upstream https://github.com/tickernelz/opencode-kiro-auth.git  # once
git fetch upstream
git switch -c integrate-upstream
git merge upstream/master
```

Resolve conflicts, run the tests, then fast-forward `main`. The fork's own additions
are listed at the top of this README. Check each of them after a merge, because
upstream often changes the same files (the model registry, effort, and the SDK
client).

## Troubleshooting

### Error: Status: 403 (AccessDeniedException / User is not authorized)

If you're using **IAM Identity Center** (a custom Start URL), the Q Developer /
CodeWhisperer APIs typically require a **profile ARN**.

This plugin reads the active profile ARN from your local `kiro-cli` database
(`state.key = api.codewhisperer.profile`) and sends it as `profileArn`.

Fix:

1. Run `kiro-cli profile` and select a profile (e.g. `QDevProfile-us-east-1`).
2. Retry `opencode auth login` (or restart OpenCode so it re-syncs).

### Error: No accounts

This happens when the plugin has no records in `~/.config/opencode/kiro.db`.

1. Ensure `kiro-cli login` succeeds.
2. Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro.json`.
3. Retry the request; the plugin will attempt a Kiro CLI sync when it detects zero
   accounts.

### Note: `/connect` vs `opencode auth login`

If you need to enter provider-specific values for an OAuth login (like IAM Identity
Center Start URL / region), use `opencode auth login`. The current TUI `/connect` flow
may not display plugin OAuth prompts, so it can’t collect those inputs.

Note for IDC/SSO (ODIC): the plugin may temporarily create an account with a placeholder
email if it cannot fetch the real email during sync (e.g. offline).
It will replace it with the real email once usage/email lookup succeeds.

### Kiro CLI (Google/GitHub OAuth) users: plugin sync does not start

If you authenticated via `kiro-cli login` using Google or GitHub OAuth (not AWS Builder
ID or IAM Identity Center), OpenCode still needs a stored `kiro` auth entry before it
will call the plugin loader.

The plugin now creates that minimal placeholder automatically when it detects the local
Kiro CLI database. Restart OpenCode after `kiro-cli login`; the loader should then run
and sync your actual tokens into `kiro.db`. The placeholder values are not used for API
calls.

If bootstrap is skipped because `auth.json` is malformed, fix the JSON first. The plugin
will not overwrite malformed auth files because they may contain other provider
credentials.

**Important:** Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro.json`
and that `kiro-cli login` succeeds.

The plugin supports extensive configuration options.
Edit `~/.config/opencode/kiro.json`:

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

### Configuration Options

- `auto_sync_kiro_cli`: Automatically sync sessions from Kiro CLI (default: `true`).
- `account_selection_strategy`: Account rotation strategy (`sticky`, `round-robin`,
  `lowest-usage`).
- `default_region`: AWS region (`us-east-1`, `us-west-2`).
- `idc_start_url`: Default IAM Identity Center Start URL (e.g.
  `https://your-company.awsapps.com/start`). Leave unset/blank to default to AWS Builder
  ID.
- `idc_region`: IAM Identity Center (SSO OIDC) region (`sso_region`). Defaults to
  `us-east-1`.
- `rate_limit_retry_delay_ms`: Delay between rate limit retries (1000-60000ms).
- `rate_limit_max_retries`: Maximum retry attempts for rate limits (0-10).
- `max_request_iterations`: Maximum loop iterations to prevent hangs (10-1000).
- `request_timeout_ms`: Request timeout in milliseconds (60000-600000ms).
- `token_expiry_buffer_ms`: Token refresh buffer time (30000-300000ms).
- `usage_sync_max_retries`: Retry attempts for usage sync (0-5).
- `auth_server_port_start`: Legacy/ignored (no local auth server).
- `auth_server_port_range`: Legacy/ignored (no local auth server).
- `usage_tracking_enabled`: Enable usage tracking and toast notifications.
- `auto_effort_mapping`: Automatically map OpenCode thinking budgets to Kiro effort
  levels for supported models (default: `true`).
- `enable_log_api_request`: Enable detailed API request logging. Request logs
  include the resolved `additionalModelRequestFields`, so this is how you confirm
  which effort level actually went out on the wire.

## Storage

**Linux/macOS:**

- SQLite Database: `~/.config/opencode/kiro.db`
- Plugin Config: `~/.config/opencode/kiro.json`

**Windows:**

- SQLite Database: `%APPDATA%\opencode\kiro.db`
- Plugin Config: `%APPDATA%\opencode\kiro.json`

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) for
providing the foundational Kiro authentication logic and request patterns.

## Disclaimer

This plugin is provided strictly for learning and educational purposes.
It is an independent implementation and is not affiliated with, endorsed by, or
supported by Amazon Web Services (AWS) or Anthropic.
Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.
