# Working on codex-bridge

- Two `codex` binaries can exist on this machine (the copy bundled with ChatGPT.app vs. an
  npm-global install). Always resolve through `resolveCodexBin()`'s priority order — do not
  hardcode `codex` on PATH, the global one is often stale enough to predate `image_gen`.
- Every call this server makes runs against its own `~/.codex-bridge-home` (`CODEX_HOME`
  override), not `~/.codex/config.toml`. Only the top-level scalars (model, effort,
  service_tier) are mirrored in; zero plugins, zero mcp_servers. If a change to the real
  config.toml doesn't seem to take effect here, this is why.
- `effort` is the dominant latency lever, not model choice. Measured on this repo: the same
  review ran 113s at `high` vs. 63s at `low`. Don't default a new tool call to `high`. There is
  also a fixed 7-14s session-startup floor on every call, so `low` buys little on short tasks.
- `model` and `effort` are enums, and their `.describe()` text is the entire routing policy —
  it is the only thing the calling model ever sees. Changing the menu means changing that text,
  not just the enum. Keep the menu to what `codex debug models` lists at the top; the `gpt-5.x`
  family was dropped once the catalog marked it "older generation". Defaults (`DEFAULT_MODEL`,
  `DEFAULT_EFFORT` in lib/codex-core.mjs) are passed on every run: never let ~/.codex/config.toml's
  interactive settings (xhigh effort) decide a bridge call.
- The image tools run codex with the output file's own folder as the workspace: newer codex
  sandboxes only allow writes inside the workspace, so any other cwd makes the save fail.
- `codex_code` is asynchronous: it returns a job id and the run continues in the MCP server
  process. Jobs are in-memory by design — don't add persistence without a reason, but do keep
  `lookupJob()`'s "the server may have restarted" message, since that is the failure people hit.
- `codex exec resume` accepts a narrower flag set than a fresh `exec` — no `--sandbox`, no `-C`.
  The sandbox goes in as `-c sandbox_mode=` there. Adding a flag to `spawnCodexRun` means
  checking it against `codex exec resume --help`, not just `codex exec --help`.
- Jobs are meant to run in parallel, so anything shared between them has to be per-job: the event
  log path, the worktree, the scratch dir. `collisionWarning()` catches the one case parallelism
  actually breaks — two non-worktree jobs in the same checkout — and warns rather than blocking,
  since a caller may have a good reason.
- Every `codex_code` brief carries `SCOPE_CONTRACT` because Codex cannot see the calling repo's
  CLAUDE.md and otherwise builds the thorough version. Don't strip it to shorten the prompt.
- The third-party tool-calling proxy (`hotchpotch/openai-api-server-via-codex`, port 18080) was
  evaluated and deliberately dropped — see the README's "Real tool calling" section for the
  account-ban evidence. Don't reintroduce it just to get real OpenAI-style function calling.
- The HTTP API binds `127.0.0.1` only with no auth token — it's a local code-execution endpoint.
  Never widen the bind address without adding an auth check first.
- No test suite exists (`npm run probe` only lists tool names, doesn't call anything). If you
  add tests that exercise `codex_code`/`codex_review`, they spend real ChatGPT subscription
  usage — don't wire them into a CI loop that runs unattended.
