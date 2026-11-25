#!/usr/bin/env bash
# Restart kiro-auth-server when the active kiro-cli account changes.
#
# kiro-cli stores its login in ~/.local/share/kiro-cli/data.sqlite3. The server
# imports those accounts only at startup, so a `kiro-cli logout` + `kiro-cli
# login` needs a service restart. This script compares a fingerprint of the
# account identity (SSO client id, profile ARN, start URL) before and after a
# database change. Token refreshes and ordinary CLI use rewrite the database but
# keep the identity, so they do not cause a restart; a login, logout, or
# `kiro-cli profile` switch does.
#
# Install as ~/.local/bin/kiro-auth-cli-watch and trigger it from
# kiro-auth-server-watch.path.
set -euo pipefail

DB="${KIROCLI_DB_PATH:-$HOME/.local/share/kiro-cli/data.sqlite3}"
[ -r "$DB" ] || exit 0

STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/kiro-auth-server"
STATE="$STATE_DIR/kiro-cli-identity"

BUN="${BUN_BIN:-}"
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  BUN="$(command -v bun 2>/dev/null || true)"
fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  BUN="$HOME/.bun/bin/bun"
fi
[ -x "$BUN" ] || exit 0

# kiro-cli writes the token first and the profile state moments later. Wait
# until the database stops changing (max ~12s) so one login produces one
# restart with the complete identity.
last=""
for ((i = 0; i < 24; i++)); do
  now="$(stat -c %Y "$DB" 2>/dev/null || echo 0)"
  if [ -n "$last" ] && [ "$now" = "$last" ]; then
    break
  fi
  last="$now"
  sleep 0.5
done

fp="$(KIRO_WATCH_DB="$DB" "$BUN" -e '
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const db = new Database(process.env.KIRO_WATCH_DB, { readonly: true });
const parts = [];
let tokens = 0;

for (const row of db.prepare("SELECT key, value FROM auth_kv ORDER BY key").all()) {
  const key = String(row.key);
  if (key.endsWith(":token")) {
    const v = JSON.parse(row.value);
    tokens += 1;
    parts.push([
      "token", key,
      v.profile_arn ?? v.profileArn ?? "",
      v.start_url ?? v.startUrl ?? "",
      v.region ?? "",
      v.oauth_flow ?? ""
    ].join("|"));
  } else if (key.includes("device-registration")) {
    const v = JSON.parse(row.value);
    parts.push(["registration", key, v.client_id ?? "", v.region ?? ""].join("|"));
  } else {
    parts.push(["other", key].join("|"));
  }
}

for (const key of ["api.codewhisperer.profile", "auth.idc.start-url", "auth.idc.region"]) {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key);
  if (!row) continue;
  let v = row.value;
  try { v = JSON.parse(v); } catch {}
  if (key === "api.codewhisperer.profile" && typeof v === "object" && v !== null) {
    parts.push(["profile", v.arn ?? "", v.profile_name ?? ""].join("|"));
  } else if (typeof v === "string" && v) {
    parts.push([key, v].join("|"));
  }
}

db.close();
if (tokens === 0) process.exit(3);
process.stdout.write(createHash("sha256").update(parts.join("\n")).digest("hex"));
' 2>/dev/null)" || exit 0

prev=""
if [ -f "$STATE" ]; then
  prev="$(cat "$STATE" 2>/dev/null || true)"
fi

if [ "$fp" = "$prev" ]; then
  echo "kiro-cli account unchanged"
  exit 0
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [ "${KIRO_WATCH_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$fp" > "$STATE"
  chmod 600 "$STATE"
  echo "kiro-cli account changed (dry run)"
  exit 0
fi

# restart blocks until systemd has started the new unit, so state is only
# recorded once the restart succeeded; a failed restart is retried on the
# next database change.
systemctl --user restart kiro-auth-server
printf '%s\n' "$fp" > "$STATE"
chmod 600 "$STATE"
echo "kiro-cli account changed; restarted kiro-auth-server"
