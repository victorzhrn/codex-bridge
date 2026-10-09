# codex-bridge

An MCP server that lends Claude Code five things the Codex CLI can do and Claude Code cannot do as well: generate an image, edit an image, hand off a coding task, get a second-opinion review, and fetch a page over a different network stack.

Each tool is deliberately narrow. Codex's own MCP mode (`codex mcp-server`) exposes one generic `codex` tool whose description is "Run a Codex session" — a model looking at that has no idea when to press it. Here the tool name *is* the use case, so it gets called at the right moment.

## Install

```bash
git clone https://github.com/victorzhrn/codex-bridge.git
cd codex-bridge
npm install
```

Then register it with Claude Code:

```bash
claude mcp add codex-bridge -s user -- node "$(pwd)/server.mjs"
```

Restart Claude Code and the five tools appear.

## Tools

| Tool | What it does |
|---|---|
| `codex_generate_image` | Text prompt → PNG at a path you choose. Square, landscape or portrait; optional transparent background. |
| `codex_edit_image` | Change one thing about an existing image and keep the rest identical. Recolor, swap text, remove an element. |
| `codex_code` | Hand a self-contained implementation task to the Codex agent, which edits files directly. Returns a job id immediately; the run continues in the background. |
| `codex_job` | Read a `codex_code` job — what Codex has done so far while it runs, the summary once it finishes. |
| `codex_review` | Read-only second-opinion review of uncommitted changes or a branch diff. |
| `codex_web` | Fetch a URL or run a search through Codex. Use when the built-in WebFetch hits a TLS error, a 403, or a bot wall — this path fails differently. |

## Slash commands

Three commands in `~/.claude/commands/` wrap these tools with the surrounding work, so a one-liner does the whole job:

| Command | What it does beyond calling the tool |
|---|---|
| `/codex-review [focus]` | Finds the repo root, picks uncommitted-vs-branch automatically, then judges each finding against context Codex doesn't have. |
| `/codex-image <brief> [-> path]` | Chooses generate vs edit, turns a loose request into a specific visual brief, picks the aspect ratio, and reads the result back so the image is actually seen. |
| `/codex-do <task>` | Checks the tree is clean first, writes a proper brief, then reads the resulting `git diff` — Codex's summary is treated as a claim, not evidence. |

They live outside this repo because that is where Claude Code looks for user-level commands. Copies are in `commands/` here for version control.

`/codex-review` and `/codex-image` can also fire on their own when Claude judges them relevant — ask for an OG image and you get one without typing the command. `/codex-do` is deliberately marked `disable-model-invocation: true`: it writes files, and choosing to delegate an edit should be your call, not a conclusion Claude reaches by itself.

## Choosing a model and an effort level

Two separate models are involved and they are worth keeping straight. The Claude model running a slash command does the orchestration — parsing the request, writing the brief, checking the result — and follows the session model unless a command pins one with `model:` in its frontmatter. The Codex model does the actual work: `gpt-6.1-sol` at `medium` effort unless a call names others (`DEFAULT_MODEL` and `DEFAULT_EFFORT` in `lib/codex-core.mjs`). Both are passed on every run, so `~/.codex/config.toml` — tuned for interactive use, currently `xhigh` effort — no longer leaks into bridge calls.

`codex_code`, `codex_review` and `codex_web` each accept `model` and `effort` to override that per call. Both are constrained to an enum, so the calling model sees the menu rather than having to already know it, and a typo is rejected in milliseconds instead of at the API.

The house preference is a strong model thinking briefly over a weak model straining, so the default is right for nearly everything and the interesting lever is `effort`:

| `model` | When it is the right pick |
|---|---|
| `gpt-6.1-sol` (default) | The latest workhorse, listed first in Codex's own model catalog. Right for nearly everything. |
| `gpt-6-astra` | The frontier model: the hardest reasoning, wide refactors, anything touching money, auth or data correctness. Slower. |
| `gpt-6-sol` | The previous workhorse — worth calling when a run already tried and was wrong, since a different model beats the same one retrying. |
| `gpt-6-luna` | Fastest and cheapest: high-volume or trivial edits, mechanical renames, boilerplate, an obvious test. When a task is both trivial and repetitive, name luna rather than running the default at low effort. |
| `codex-auto-review` | Purpose-built for reading a diff; only meaningful for `codex_review`. |

The `gpt-5.6` family was dropped from the menu when Codex's catalog started labelling it "older generation" (October 2026); `gpt-6-luna` covers the fast lane. `codex debug models` prints the current catalog. The image tools take no model parameter: the image model is chosen by Codex's own imagegen skill, and they run at `low` effort because the work is one tool call and a file save.

**`effort` is the dominant speed lever, more than model choice.** Measured on this repo, the same review ran 113s at `high` and 63s at `low`. Use `low` for mechanical work whose answer is already known, `medium` (the default) for most things, `high` for subtle logic, and `xhigh` only for code that ships straight to production and is expensive to get wrong. Note that a model's own default is often lower than what config.toml imposes, so a global `model_reasoning_effort = "high"` roughly doubles every call's latency.

Every call also pays a fixed session-startup cost — measured at 7–14s for a prompt that only says "reply OK" — so dropping to `low` to shave a short task buys very little.

Rough timings, all measured: web fetch 25s, delegated code task 45-60s, image generation 60s, image edit 110s, review 60-115s depending on effort.

## Delegated tasks run in the background

`codex_code` used to block until Codex finished, which could be minutes during which the caller could neither see what was happening nor do anything else. It now starts the run and returns a job id straight away.

While a job runs, `codex_job` reports what Codex has actually done — the commands it ran, the files it touched, its latest message — read from the JSONL event stream `codex exec --json` emits. Once the job finishes, the same tool returns the summary plus the thread id.

Jobs also run in parallel, which is the main remaining speedup: work that splits into independent parts finishes in the time of its slowest part rather than the sum of all of them. The catch is that two unsupervised agents editing the same checkout corrupt each other, so every job in a parallel batch that shares a repo needs `worktree: true`. Starting a second job in a checkout another running job is already editing returns a warning at the moment it can still be acted on, rather than leaving the mess to be diagnosed later.

That thread id is worth keeping. Passing it back as `resume_thread` on the next `codex_code` call continues the same Codex session instead of paying for a cold context again, so a follow-up can be as short as "the test you added fails on empty input, fix it". (`codex exec resume` accepts a narrower flag set than a fresh `exec` — no `--sandbox` — so the sandbox goes in as a `-c sandbox_mode=` override instead.)

Jobs live in the MCP server process and are not persisted: if the server restarts, in-flight runs die with it and their ids stop resolving. `codex_job` says so explicitly rather than reporting a bare "not found".

The exception is the moment a job ends. Nothing outside the server can be told
that: the registry is in memory and the JSONL stream simply goes quiet, which
looks the same as a job still thinking. So callers poll — and a caller busy with
something else forgets to, leaving a finished run unread until someone asks.
Each job now writes `jobs/<id>.status.json` under the bridge home when it
settles, so the end is observable and a watcher is one line:

```bash
until [ -f ~/.codex-bridge-home/jobs/job_xxxxxxxx.status.json ]; do sleep 10; done
```

In a harness that notifies when a background command exits, that turns "remember
to check on it" into being told.

## Keeping Codex from over-building

Left to its own defaults, Codex builds the thorough version — an extra abstraction, a config flag for a case nobody asked about, a compatibility branch beside the new path. Every `codex_code` brief therefore carries an explicit scope contract (simplest thing that satisfies the task, no speculative abstraction, no backward-compatibility shims, touch only what the task requires, stop and say so rather than designing around an ambiguity). Codex cannot see the calling repo's own CLAUDE.md, so these rules have to travel with the prompt.

## Why this saves context

`codex exec` prints its reasoning, every shell command it runs, and every file it touches. Streaming all of that back would cost more context than doing the work in Claude directly.

So the server sends Codex's stdout to `/dev/null` and instead passes `-o <tmpfile>`, which makes Codex write only its final assistant message to a file. That file is what comes back. A run that burned 30,000 tokens inside Codex returns as one line — a file path, or a paragraph of summary.

## Which codex binary

Resolved in this order:

1. `$CODEX_BIN`
2. `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` — the copy bundled with the desktop app, the newest build (0.159 in October 2026). The app moved it here in its October 2026 update; when the bridge suddenly fails with `unexpected argument '-o'`, it has fallen through to the old npm copy and the app has moved its binary again.
3. `/Applications/ChatGPT.app/Contents/Resources/codex` — where the app kept it before that update
4. `codex` on `PATH`

The npm-global `codex` is frequently far behind and may predate the `image_gen` tool entirely, which is why it is last. Check what you have with `codex features list | grep image_generation` — it needs to read `stable true`.

Authentication is whatever Codex already has in `~/.codex/auth.json`. If that is a ChatGPT subscription login, these tools draw on the subscription and no OpenAI API key is involved.

## HTTP API

`server.mjs` only speaks MCP, which means only Claude Code can call it. `http-server.mjs` exposes the same five capabilities (plus a sixth, plain-text one) as a local REST API for anything else — shell scripts, cron jobs, other local processes.

```bash
npm run api
# codex-bridge HTTP API on http://127.0.0.1:8787
```

Binds to `127.0.0.1` only, no auth token. Do not change the bind address without adding an auth check first — `/v1/code` and the image routes write files on this machine, so this is a local code-execution endpoint, not a read-only API.

| Route | Body | Maps to |
|---|---|---|
| `POST /v1/generate` | `{prompt, model?, effort?, schema?}` | Plain text completion — no working_dir, no file writes. The one MCP doesn't expose (Claude Code doesn't need to ask Codex to just write text). |
| `POST /v1/generate-image` | same as `codex_generate_image` | `lib/tools.mjs#generateImage` |
| `POST /v1/edit-image` | same as `codex_edit_image` | `lib/tools.mjs#editImage` |
| `POST /v1/code` | same as `codex_code` | `lib/tools.mjs#codeTask` |
| `POST /v1/review` | same as `codex_review` | `lib/tools.mjs#reviewDiff` |
| `POST /v1/web` | same as `codex_web` | `lib/tools.mjs#webFetch` |
| `GET /health` | — | liveness + route list |

Every route replies `{result, seconds}` on success or `{error}` (HTTP 500, or 404 for an unknown route) on failure.

```bash
curl -s http://127.0.0.1:8787/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Write a 1-sentence product tagline for a diagram tool.", "effort": "low"}'
```

Pass `schema` (a JSON Schema object) to `/v1/generate` for structured output — this is Codex's own `--output-schema` flag, verified to actually constrain the model's final message (tested: `{answer, confidence}` schema came back as exactly `{"answer":"Paris.","confidence":1}`, nothing else). `result` is then the parsed object, not a string:

```bash
curl -s http://127.0.0.1:8787/v1/generate -H 'Content-Type: application/json' -d '{
  "prompt": "Extract: the sky is blue and grass is green.",
  "schema": {"type":"object","properties":{"sky_color":{"type":"string"},"grass_color":{"type":"string"}},"required":["sky_color","grass_color"],"additionalProperties":false}
}'
# {"result":{"sky_color":"blue","grass_color":"green"},"seconds":5}
```

There is no equivalent here for OpenAI-style multi-function tool calling (the model choosing among several caller-defined functions and returning which one plus arguments). `codex exec` has no such mode — it only ever runs its own fixed toolset (shell, apply_patch, web fetch, image gen) and returns one final message. `--output-schema` covers "I need structured data back," not "let the model pick a function for me." For that, see **Real tool calling** below.

## Real tool calling (third-party, optional)

`codex exec`'s limitation above is specific to the CLI's own agent loop — the actual backend it talks to (`chatgpt.com/backend-api/codex`) is a real Responses-API-shaped endpoint that does support function calling, because that's how ChatGPT's own tool use is implemented. [`hotchpotch/openai-api-server-via-codex`](https://github.com/hotchpotch/openai-api-server-via-codex) (Apache 2.0, PyPI) talks to that backend directly instead of shelling out to the CLI, and exposes standard `POST /v1/chat/completions` / `POST /v1/responses` with genuine `tools` in, `tool_calls` out.

```bash
npm run api:tools
# server on http://127.0.0.1:18080
```

**Compat note (found 2026-08-12, still true as of package v0.1.5):** this tool requires a top-level `"auth_mode": "chatgpt"` field in `~/.codex/auth.json` that the Codex CLI build this machine runs (bundled with ChatGPT.app, `0.147.0-alpha`) does not write — starting it against the real file as-is fails with `Expected Codex auth_mode 'chatgpt', got None`. `scripts/start-openai-api-tools.sh` (what `npm run api:tools` calls) works around this by copying `~/.codex/auth.json` into this project's own `~/.codex-bridge-home` with that one field added, fresh on every start so token refreshes stay current — the real credentials file is never modified. Not vendored: this runs the published package straight from PyPI via `uvx` on every start, so it can change out from under you; pin a version with `uvx openai-api-server-via-codex==0.1.5 serve ...` if that becomes a problem.

Verified round-trip (2026-08-12): a request with a `get_weather` tool came back `finish_reason: "tool_calls"` with `{"city":"Tokyo"}` as arguments; sending that back as a `role: "tool"` message in a follow-up request returned `"Tokyo is currently 29°C and sunny."` as normal assistant text — the full OpenAI tool-calling handshake, not just the first half.

**Using either of these to replace metered OpenAI API calls with the ChatGPT subscription — read before wiring either into a product:**

- **Latency is 5-100+ seconds per call for `/v1/generate` et al** (a fresh sandboxed `codex exec` process every time); the third-party tool-calling server above is faster since it skips the CLI subprocess, but is still going through a subscription backend, not a dedicated inference API — don't assume completions-API latency. Fine for a batch job; will visibly stall any live user-facing generation path (adds noticeable latency to user-facing flows).
- **The ChatGPT subscription has its own usage caps** (session/weekly limits on Codex specifically), shared with your own interactive Claude Code / ChatGPT app usage on the same account. Routing meaningful product volume through either path risks rate-limiting your own daily use, and there is no visibility into how close you are to the cap until a call fails.
- **This is very likely outside what a personal ChatGPT subscription's terms permit** — it's priced and positioned for individual use, not as a backend for a paid multi-user SaaS product. The third-party tool-calling server is a further step out on this axis than the CLI-shelling approach above: it replicates the CLI's own calls to an undocumented, unpublished backend endpoint rather than running the actual sanctioned `codex` binary, so it's more exposed to both "OpenAI changes the endpoint and this breaks" and "this reads as more clearly outside normal CLI use." Both paths are intended for personal use only, matching the third-party tool's own README ("do not use to evade limits, share account access, resell access, or power third-party services").
- **What this is actually good for**: your own local scripts and background jobs where a person isn't waiting synchronously and volume is low — e.g. a one-off content-generation script, an ad-hoc backfill, testing a prompt or a tool-calling flow before wiring it into a paid API. Not a drop-in replacement for a product's live inference path.

## Testing

```bash
npm run probe
```

lists the tools without calling anything. To exercise one for real:

```bash
npm run probe -- codex_web '{"request":"https://example.com"}'
```

The probe exits non-zero if the server fails to start, the protocol errors, or the tool reports an error.

## Timeouts

Image generation takes 30–110 seconds; a delegated coding task can run for minutes. The default ceiling is 7 minutes, overridable with `CODEX_BRIDGE_TIMEOUT_MS`.
