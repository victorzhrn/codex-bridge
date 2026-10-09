#!/usr/bin/env bash
# Starts hotchpotch/openai-api-server-via-codex, a third-party OpenAI-compatible
# server (https://github.com/hotchpotch/openai-api-server-via-codex) that talks
# directly to the Codex backend and supports real function/tool calling —
# something codex exec itself does not do. Not vendored here: run via `uvx`
# straight from PyPI on every start.
#
# Compat patch: this tool requires a top-level "auth_mode": "chatgpt" field in
# ~/.codex/auth.json. The Codex CLI build this machine uses (bundled with
# ChatGPT.app, 0.147.0-alpha as of 2026-08) does not write that field, so the
# server refuses to start against the real file unmodified (confirmed
# 2026-08-12: "Expected Codex auth_mode 'chatgpt', got None"). Rather than
# edit the real credentials file, this script copies it — fresh on every
# start, so token refreshes are picked up — into this project's own
# CODEX_HOME (~/.codex-bridge-home, already used by server.mjs/http-server.mjs)
# with that one field added, and points the server at the copy.
set -euo pipefail

BRIDGE_HOME="${CODEX_BRIDGE_HOME:-$HOME/.codex-bridge-home}"
REAL_AUTH="$HOME/.codex/auth.json"
PATCHED_AUTH="$BRIDGE_HOME/openai-api-auth.json"

mkdir -p "$BRIDGE_HOME"
python3 -c "
import json
with open('$REAL_AUTH') as f:
    data = json.load(f)
data['auth_mode'] = 'chatgpt'
with open('$PATCHED_AUTH', 'w') as f:
    json.dump(data, f)
"
chmod 600 "$PATCHED_AUTH"

exec uvx openai-api-server-via-codex serve \
  --host 127.0.0.1 \
  --port "${CODEX_OPENAI_API_PORT:-18080}" \
  --auth-json "$PATCHED_AUTH" \
  "$@"
