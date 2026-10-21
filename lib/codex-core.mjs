// Shared plumbing for running `codex exec` non-interactively. Both transports
// (the MCP server in ../server.mjs and the local HTTP API in ../http-server.mjs)
// import from here so the process-spawning, binary resolution, and worktree
// logic exists exactly once.

import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, readFile, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

// The npm-global `codex` on PATH is often an old build without the image_gen
// tool. The copy bundled in the ChatGPT desktop app tracks the newest release,
// so prefer it unless CODEX_BIN says otherwise.
const CODEX_CANDIDATES = [
  process.env.CODEX_BIN,
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', // where the app keeps it since its October 2026 update
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  'codex',
].filter(Boolean);

// What a call runs on when it names no model or effort. Passed explicitly on every run: left unset,
// codex falls back to ~/.codex/config.toml, which is tuned for interactive use (xhigh effort) and
// made every bridge call, image calls included, think at the maximum.
export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_EFFORT = 'medium';

export const DEFAULT_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_TIMEOUT_MS ?? 420_000);

// The interactive ChatGPT app's ~/.codex/config.toml carries ~13 enabled
// plugins (github, supabase, vercel, chrome, computer-use, sites, ...) plus
// a dozen external mcp_servers for interactive use. `codex exec`
// loads and describes every one of those on every single call regardless of
// whether the task touches it — measured at ~4x the latency of a stripped
// config for the same task (112s vs 28s to write one file). None of this
// bridge's tools use those connectors, so every call here runs against its
// own minimal CODEX_HOME instead: same auth (symlinked, so token refreshes
// stay in sync) and the same top-level scalars (model, effort, service_tier)
// mirrored fresh from the real config on every server start, but zero
// plugins or mcp_servers.
export const BRIDGE_HOME = process.env.CODEX_BRIDGE_HOME ?? path.join(homedir(), '.codex-bridge-home');

export async function ensureBridgeHome() {
  await mkdir(BRIDGE_HOME, { recursive: true });

  const authLink = path.join(BRIDGE_HOME, 'auth.json');
  const realAuth = path.join(homedir(), '.codex', 'auth.json');
  try {
    await access(authLink);
  } catch {
    await symlink(realAuth, authLink);
  }

  const realConfig = await readFile(path.join(homedir(), '.codex', 'config.toml'), 'utf8');
  const lines = realConfig.split('\n');
  const firstTableIdx = lines.findIndex((line) => line.trim().startsWith('['));
  const scalars = (firstTableIdx === -1 ? lines : lines.slice(0, firstTableIdx)).join('\n').trim();
  await writeFile(path.join(BRIDGE_HOME, 'config.toml'), scalars + '\n');
}

let cachedBin;

export async function resolveCodexBin() {
  if (cachedBin) return cachedBin;
  for (const candidate of CODEX_CANDIDATES) {
    if (candidate.includes('/')) {
      try {
        await access(candidate, constants.X_OK);
        cachedBin = candidate;
        return cachedBin;
      } catch {
        continue;
      }
    }
    cachedBin = candidate; // bare name, let PATH resolve it
    return cachedBin;
  }
  throw new Error('No codex binary found. Set CODEX_BIN to its absolute path.');
}

/**
 * Spawn one non-interactive Codex turn and stream its structured event log to
 * `logPath` (JSONL, one event per line — thread.started, item.started,
 * item.completed, turn.completed). The events are what makes an in-flight run
 * observable; without them a caller can only wait and hope.
 *
 * Returns immediately with a handle. `completed` resolves to the final
 * assistant message plus the thread id, which a later call can resume from.
 */
export function spawnCodexRun(prompt, {
  cwd,
  sandbox = 'read-only',
  model,
  effort,
  outputSchema,
  resumeThread,
  logPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let child;
  let killedByTimeout = false;

  const completed = (async () => {
    const bin = await resolveCodexBin();
    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-bridge-'));
    const lastMessagePath = path.join(scratch, 'last-message.txt');

    const args = ['exec'];
    // `codex exec resume <id> [prompt]` continues an existing thread instead of
    // paying for a cold context again. It takes a narrower flag set than a fresh
    // exec — notably no --sandbox — so the sandbox goes in as a config override,
    // which resume does accept.
    if (resumeThread) args.push('resume', resumeThread);
    args.push('--json', '--skip-git-repo-check', '-o', lastMessagePath);
    if (resumeThread) args.push('-c', `sandbox_mode=${sandbox}`);
    else args.push('--sandbox', sandbox);
    // Write tasks routinely deploy (vercel, Cloudflare API); without network they stall.
    if (sandbox === 'workspace-write') args.push('-c', 'sandbox_workspace_write.network_access=true');
    args.push('--model', model ?? DEFAULT_MODEL);
    // Codex does not validate this value locally — a typo sails through here and
    // only misbehaves at the API. Callers constrain it to an enum so a bad
    // string cannot reach this point.
    args.push('-c', `model_reasoning_effort=${effort ?? DEFAULT_EFFORT}`);
    if (outputSchema) {
      // Codex enforces this itself (verified: a run given {answer, confidence}
      // came back as exactly {"answer":"Paris.","confidence":1}, nothing else) —
      // this is not prompt-engineering, the CLI has a real --output-schema flag.
      const schemaPath = path.join(scratch, 'output-schema.json');
      await writeFile(schemaPath, JSON.stringify(outputSchema));
      args.push('--output-schema', schemaPath);
    }
    args.push(prompt);

    try {
      const { code, stderr } = await new Promise((resolve, reject) => {
        child = spawn(bin, args, {
          cwd: cwd ? path.resolve(cwd) : process.cwd(),
          stdio: ['ignore', logPath ? 'pipe' : 'ignore', 'pipe'],
          env: { ...process.env, CODEX_HOME: BRIDGE_HOME },
        });

        if (logPath && child.stdout) {
          // Straight to disk rather than held in memory: a long run emits a lot
          // of events, and the progress reader parses the file on demand.
          child.stdout.pipe(createWriteStream(logPath));
        }

        let stderrBuf = '';
        child.stderr.on('data', (chunk) => {
          // Keep only the tail; a failing run can print a lot.
          stderrBuf = (stderrBuf + chunk.toString()).slice(-4000);
        });

        const timer = setTimeout(() => {
          killedByTimeout = true;
          child.kill('SIGKILL');
        }, timeoutMs);

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (exitCode) => {
          clearTimeout(timer);
          if (killedByTimeout) reject(new Error(`Codex timed out after ${timeoutMs}ms`));
          else resolve({ code: exitCode, stderr: stderrBuf });
        });
      });

      let finalMessage = '';
      try {
        finalMessage = (await readFile(lastMessagePath, 'utf8')).trim();
      } catch {
        // fall through to the error below
      }

      if (!finalMessage) {
        throw new Error(
          `Codex exited with code ${code} and produced no final message.` +
          (stderr ? `\nstderr tail:\n${stderr}` : '')
        );
      }
      return { finalMessage, threadId: logPath ? await readThreadId(logPath) : null };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  })();

  return {
    completed,
    cancel() {
      if (child) child.kill('SIGKILL');
    },
  };
}

/** Run one turn and return just the final message. The synchronous shape. */
export async function runCodex(prompt, opts = {}) {
  const { finalMessage } = await spawnCodexRun(prompt, opts).completed;
  return finalMessage;
}

async function readEvents(logPath) {
  let raw = '';
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // The last line can be a partial write while the run is still streaming.
    }
  }
  return events;
}

async function readThreadId(logPath) {
  const started = (await readEvents(logPath)).find((e) => e.type === 'thread.started');
  return started?.thread_id ?? null;
}

/**
 * Turn the raw event log into something worth putting in front of a model:
 * what Codex has actually done so far, not every token it thought.
 */
export async function summariseProgress(logPath) {
  const events = await readEvents(logPath);
  if (!events.length) return { threadId: null, steps: 0, lines: ['Codex has not reported anything yet (still starting up).'] };

  const lines = [];
  const counts = new Map();
  let lastCommand = null;
  let lastMessage = null;
  let usage = null;
  let threadId = null;

  for (const event of events) {
    if (event.type === 'thread.started') threadId = event.thread_id ?? threadId;
    if (event.type === 'turn.completed') usage = event.usage ?? usage;
    if (event.type !== 'item.completed') continue;
    const item = event.item ?? {};
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    if (item.type === 'command_execution') lastCommand = item.command;
    if (item.type === 'agent_message') lastMessage = item.text;
  }

  const steps = [...counts.values()].reduce((a, b) => a + b, 0);
  if (counts.size) {
    lines.push('Done so far: ' + [...counts].map(([type, n]) => `${n}x ${type}`).join(', '));
  }
  if (lastMessage) lines.push(`Latest from Codex: ${truncate(lastMessage, 400)}`);
  if (lastCommand) lines.push(`Latest command: ${truncate(lastCommand, 200)}`);
  if (usage) {
    lines.push(`Tokens: ${usage.input_tokens ?? 0} in (${usage.cached_input_tokens ?? 0} cached), ${usage.output_tokens ?? 0} out.`);
  }
  return { threadId, steps, lines };
}

function truncate(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export async function assertReadable(file, label) {
  try {
    await access(path.resolve(file), constants.R_OK);
  } catch {
    throw new Error(`${label} not found or unreadable: ${file}`);
  }
}

export async function fileStamp(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Confirm Codex really wrote the image this run. Checking existence alone is not
 * enough: if a file was already sitting at output_path and Codex silently did
 * nothing, a plain existence check reads as success. That case is not exotic —
 * an edit whose output_path equals its source_path hits it every time.
 */
export async function assertFreshlyWritten(resolvedPath, before, codexReply) {
  const after = await fileStamp(resolvedPath);
  if (!after || after.size === 0) {
    throw new Error(`no image was written to ${resolvedPath}. Codex replied: ${codexReply}`);
  }
  if (before && after.mtimeMs <= before.mtimeMs) {
    throw new Error(
      `the file at ${resolvedPath} is unchanged from before this run, so Codex wrote nothing. ` +
      `Codex replied: ${codexReply}`
    );
  }
}

/**
 * Worktree isolation for codex_code: run Codex against a disposable branch
 * instead of working_dir directly, so an unsupervised task can't touch the
 * branch actually checked out there. Mirrors Claude Code's own worktree
 * convention (<repo>/.claude/worktrees/<name>, excluded via .git/info/exclude)
 * so the two don't collide and don't need separate gitignore handling.
 */
async function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || stdout).trim()}`));
      else resolve(stdout.trim());
    });
  });
}

async function ensureWorktreesExcluded(repoRoot) {
  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  let contents = '';
  try {
    contents = await readFile(excludePath, 'utf8');
  } catch {
    // no exclude file yet — appendFile below creates it
  }
  if (contents.includes('.claude/worktrees/')) return;
  await appendFile(excludePath, (contents && !contents.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n');
}

/**
 * Create a fresh worktree + branch off the current HEAD of working_dir's repo
 * (not off its uncommitted changes — those live only in the primary checkout)
 * and return the directory Codex should actually run in, preserving any
 * monorepo subpath working_dir pointed at.
 */
export async function createTaskWorktree(workingDir) {
  const absWorkingDir = path.resolve(workingDir);
  const repoRoot = await runGit(['rev-parse', '--show-toplevel'], absWorkingDir);
  const relSubpath = path.relative(repoRoot, absWorkingDir);

  const slug = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const branch = `codex/${slug}`;
  const worktreePath = path.join(repoRoot, '.claude', 'worktrees', slug);

  await ensureWorktreesExcluded(repoRoot);
  await runGit(['worktree', 'add', worktreePath, '-b', branch], repoRoot);

  return {
    repoRoot,
    worktreePath,
    branch,
    codexCwd: relSubpath ? path.join(worktreePath, relSubpath) : worktreePath,
  };
}

export async function worktreeHasChanges(worktreePath) {
  const status = await runGit(['status', '--porcelain'], worktreePath);
  return status.length > 0;
}

export async function removeTaskWorktree({ repoRoot, worktreePath, branch }) {
  try {
    await runGit(['worktree', 'remove', worktreePath, '--force'], repoRoot);
  } catch {
    // best effort — leaving a stray worktree is harmless, just clutter
  }
  try {
    await runGit(['branch', '-D', branch], repoRoot);
  } catch {
    // best effort, same reasoning
  }
}
