// A tiny in-memory registry for Codex runs that outlive a single tool call.
//
// `codex_code` can run for minutes. Blocking the caller for that long means it
// can neither see what Codex is doing nor do anything else meanwhile, so the
// MCP tool starts a job and returns an id immediately; `codex_job` reads the
// progress or the result afterwards.
//
// Jobs live in this process. If the MCP server restarts, in-flight runs die
// with it and their ids stop resolving — which is why lookupJob() says so
// explicitly rather than returning a bare "not found".
//
// The one exception is the terminal state, which is written to a file so that
// something outside this process can be told a run ended. See
// recordTerminalState() for why that is worth the single write.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BRIDGE_HOME } from './codex-core.mjs';

const jobs = new Map();
const JOB_DIR = path.join(BRIDGE_HOME, 'jobs');

export async function createJob(meta) {
  await mkdir(JOB_DIR, { recursive: true });
  const id = `job_${randomUUID().slice(0, 8)}`;
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  // Nothing awaits `done` in the fire-and-forget path, and an unobserved
  // rejection would take the whole server down.
  done.catch(() => {});

  const job = {
    id,
    ...meta,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    threadId: null,
    logPath: path.join(JOB_DIR, `${id}.jsonl`),
    done,
    settle,
  };
  jobs.set(id, job);
  return job;
}

// The one thing about a job that anything outside this process can see.
//
// A caller that starts a job has no way to be told when it ends: the registry
// is in memory and the JSONL stream just goes quiet, which is indistinguishable
// from a job that is merely thinking. So callers poll, and a caller that gets
// busy forgets to — a finished run then sits unread for as long as it takes
// someone to ask about it.
//
// Writing the terminal state to a file makes the end observable. A watcher is
// then one line, and in a harness whose background commands notify on exit,
// that turns "remember to check" into a push:
//
//     until [ -f ~/.codex-bridge-home/jobs/<id>.status.json ]; do sleep 10; done
//
// Written only on settle, so the file's existence is itself the signal.
async function recordTerminalState(job) {
  try {
    await writeFile(
      path.join(JOB_DIR, `${job.id}.status.json`),
      JSON.stringify({
        id: job.id,
        status: job.status,
        elapsedSeconds: elapsedSeconds(job),
        threadId: job.threadId,
        error: job.error,
        finishedAt: new Date(job.finishedAt).toISOString(),
      }, null, 2)
    );
  } catch {
    // A job that finished is still finished if this write fails; the caller
    // can always fall back to polling codex_job.
  }
}

export function finishJob(job, { result, threadId }) {
  job.status = 'done';
  job.finishedAt = Date.now();
  job.result = result;
  job.threadId = threadId ?? job.threadId;
  void recordTerminalState(job);
  job.settle.resolve(result);
}

export function failJob(job, err) {
  job.status = 'failed';
  job.finishedAt = Date.now();
  job.error = err.message ?? String(err);
  void recordTerminalState(job);
  job.settle.reject(err);
}

export function lookupJob(id) {
  const job = jobs.get(id);
  if (job) return job;
  throw new Error(
    `no job ${id}. Either the id is wrong or this MCP server restarted since it was started ` +
    `(jobs are in-memory and do not survive a restart). Known jobs: ${[...jobs.keys()].join(', ') || 'none'}.`
  );
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function elapsedSeconds(job) {
  return Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000);
}
