#!/usr/bin/env node
// MCP server exposing a handful of narrow Codex CLI capabilities to Claude Code.
//
// Every tool boils down to: build a prompt -> run `codex exec` -> return only the
// final assistant message. The actual work happens in lib/tools.mjs, shared with
// the local HTTP API in http-server.mjs; this file only adapts those functions to
// the MCP protocol (tool schemas, ok/fail content wrapping).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ensureBridgeHome } from './lib/codex-core.mjs';
import { generateImage, editImage, startCodeTask, jobReport, reviewDiff, webFetch } from './lib/tools.mjs';

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function fail(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: `codex-bridge error: ${err.message ?? String(err)}` }],
  };
}

// Shared knobs for the text-model tools. The descriptions are the only thing
// the calling model ever sees, so they carry the routing rules: which model for
// which shape of task, and — the bigger lever — how hard it should think.
const MODEL_PARAM = z.enum([
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'codex-auto-review',
]).optional().describe(
  'Which Codex model does the work. Omit it for the default, gpt-6.1-sol, the latest workhorse, which is right for almost everything. ' +
  'Name one only when the task shape clearly calls for it. ' +
  'gpt-6-astra — the frontier model: the hardest reasoning, wide refactors, and anything touching money, auth, or data correctness; slower. ' +
  'gpt-6-sol — the previous workhorse: worth calling when a Codex run earlier in this session already tried this and came back wrong, since a genuinely different model beats the same one trying again. ' +
  'gpt-6-luna — fastest and cheapest: high-volume or trivial edits, mechanical renames, boilerplate, an obvious test. ' +
  'codex-auto-review — built specifically for reading a diff; only meaningful for codex_review. ' +
  'Tie-break: when a task is both trivial and repetitive, name gpt-6-luna rather than running the default at low effort.'
);

const EFFORT_PARAM = z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe(
  'How long the model thinks before it answers. This is the dominant cost and latency lever — a bigger one than model choice — so tune it before reaching for a different model. ' +
  'Omit it for the default, medium, which suits most tasks. ' +
  'low — mechanical work whose answer is already known: renaming, moving a file, adding an obvious test. ' +
  'high — subtle logic, concurrency, or a bug you could not find yourself. ' +
  'xhigh — reserve it for code that ships straight to production and is expensive to get wrong (payments, credits, auth, migrations); it roughly doubles the wait. ' +
  'Note that every call pays a fixed ~10s session startup regardless, so dropping to low to shave a short task buys little.'
);

const server = new McpServer({ name: 'codex-bridge', version: '0.1.0' });

server.registerTool(
  'codex_generate_image',
  {
    title: 'Generate an image with Codex',
    description:
      'Create a raster image (PNG) from a text description and save it to a path you choose. ' +
      'This is the only image generation available — use it whenever the task calls for a picture, ' +
      'icon, illustration, OG image, banner, mockup, or texture. Takes 30-90 seconds. ' +
      'Returns the absolute path of the written file, which you can then read.',
    inputSchema: {
      prompt: z.string().describe('What the image should show. Be specific about style, composition, palette, and any text that must appear.'),
      output_path: z.string().describe('Where to write the PNG, e.g. ./public/og-image.png. Relative paths resolve against working_dir.'),
      size: z.enum(['square', 'landscape', 'portrait']).optional().describe('Aspect ratio. Defaults to square (1024x1024).'),
      transparent: z.boolean().optional().describe('Request a transparent background instead of an opaque one.'),
      working_dir: z.string().optional().describe('Directory to run in. Defaults to the server process cwd.'),
    },
  },
  async (args) => {
    try {
      return ok(await generateImage(args));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'codex_edit_image',
  {
    title: 'Edit an existing image with Codex',
    description:
      'Modify an existing image while keeping everything you did not ask to change. ' +
      'Use for recoloring, swapping text, removing or adding an element, restyling, or extending a background. ' +
      'Prefer this over regenerating from scratch whenever an image already exists. ' +
      'Takes 30-90 seconds. Returns the absolute path of the written file.',
    inputSchema: {
      source_path: z.string().describe('Path to the existing image to edit.'),
      instruction: z.string().describe('What to change. State the invariants explicitly, e.g. "change only the button color to #1B4DB1; keep layout, text and size identical".'),
      output_path: z.string().describe('Where to write the edited PNG.'),
      working_dir: z.string().optional().describe('Directory to run in. Defaults to the server process cwd.'),
    },
  },
  async (args) => {
    try {
      return ok(await editImage(args));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'codex_code',
  {
    title: 'Delegate a coding task to Codex',
    description:
      'Hand a self-contained implementation task to the Codex agent, which edits files directly in working_dir. ' +
      'Use this to offload bulk or mechanical work — scaffolding, wide refactors, test writing, migrations — ' +
      'or to get a second implementation from a different model. ' +
      'This returns a job id right away and Codex keeps working in the background, so do something useful ' +
      'instead of waiting: read codex_job when you next need the result, or when you want to see what it has done so far. ' +
      'Jobs run in parallel, and that is the main way to make a big piece of work finish sooner: when it splits into parts that ' +
      'do not depend on each other, start them all in one go and collect the results afterwards, rather than running one, waiting, ' +
      'and then starting the next. Two jobs in the same repository will overwrite each other unless you pass worktree: true, ' +
      'which gives each one its own branch and checkout — so use it for every job in a parallel batch that shares a repo. ' +
      'Splitting only pays when the parts are genuinely independent; sequential steps that each need the last one\'s output ' +
      'should stay one task, or continue the same job with resume_thread. ' +
      'Only the final summary comes back, never the reasoning, so it is cheap to call. ' +
      'Inspect the resulting git diff yourself afterwards; the summary is a claim, not evidence.',
    inputSchema: {
      task: z.string().describe('The task, written as if briefing a competent engineer who cannot see this conversation. Include file paths, constraints, and what "done" means.'),
      working_dir: z.string().describe('Repository or directory the task applies to.'),
      writable: z.boolean().optional().describe('Allow file edits (default true). Set false for read-only analysis.'),
      worktree: z.boolean().optional().describe(
        'Isolate the task on a new branch in <repo>/.claude/worktrees/ instead of editing working_dir directly — ' +
        'use this for anything you want Codex to run unsupervised, since the branch actually checked out in ' +
        'working_dir is never touched. Built off working_dir\'s current HEAD, not its uncommitted changes ' +
        '(those only exist in the primary checkout, so commit first if Codex needs them). The worktree is ' +
        'auto-removed if Codex made no changes; otherwise its path and branch come back in the result for ' +
        'you to review and merge yourself.'
      ),
      resume_thread: z.string().optional().describe(
        'Continue an earlier Codex run instead of starting cold. Pass the thread id that the finished job reported. ' +
        'Use this for follow-ups and corrections on work Codex just did — it keeps the earlier context, so the ' +
        'task text can be as short as "the test you added fails on empty input, fix it".'
      ),
      model: MODEL_PARAM,
      effort: EFFORT_PARAM,
    },
  },
  async (args) => {
    try {
      const job = await startCodeTask(args);
      return ok(
        `Started ${job.id}. Codex is working in the background — carry on with something else and read ` +
        `codex_job with job_id "${job.id}" when you want the progress or the result.` +
        (job.warning ? `\n\n${job.warning}` : '')
      );
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'codex_job',
  {
    title: 'Check on a delegated Codex task',
    description:
      'Read a codex_code job. While it runs you get what Codex has actually done so far — the commands it ran, ' +
      'the files it touched, its latest message — and once it finishes you get the summary and the thread id ' +
      'for follow-ups. Omit job_id to list this session\'s jobs. ' +
      'Prefer doing other work between checks over polling this in a tight loop; a real task takes minutes. ' +
      'With several jobs in flight, list them first and then read the ones that have finished.',
    inputSchema: {
      job_id: z.string().optional().describe('The id codex_code returned. Omit to list all jobs from this session.'),
    },
  },
  async ({ job_id }) => {
    try {
      return ok(await jobReport(job_id));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'codex_review',
  {
    title: 'Get a second-opinion code review from Codex',
    description:
      'Have a different model review changes in a repository and report problems it finds. ' +
      'Use before shipping something risky, or when you want an independent check on your own work. ' +
      'Read-only — it never edits files.',
    inputSchema: {
      working_dir: z.string().describe('Repository to review.'),
      target: z.string().optional().describe('What to review: "uncommitted" (default), a base branch like "main", or a commit sha.'),
      focus: z.string().optional().describe('Optional angle to emphasise, e.g. "payment correctness" or "N+1 queries".'),
      model: MODEL_PARAM,
      effort: EFFORT_PARAM,
    },
  },
  async (args) => {
    try {
      return ok(await reviewDiff(args));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  'codex_web',
  {
    title: 'Fetch or search the web via Codex',
    description:
      'Retrieve a web page or run a search using Codex\'s own network stack. ' +
      'Use this as the fallback when the built-in WebFetch or WebSearch fails — TLS errors, 403s, ' +
      'bot walls, or empty results — since this path fails differently. ' +
      'Also useful for pages that need a real browser to render.',
    inputSchema: {
      request: z.string().describe('A URL to fetch, or a search query.'),
      extract: z.string().optional().describe('What to pull out of the page, so only the relevant part comes back.'),
      model: MODEL_PARAM,
      effort: EFFORT_PARAM,
    },
  },
  async (args) => {
    try {
      return ok(await webFetch(args));
    } catch (err) {
      return fail(err);
    }
  }
);

await ensureBridgeHome();

const transport = new StdioServerTransport();
await server.connect(transport);
