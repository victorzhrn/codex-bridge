#!/usr/bin/env node
// Local-only HTTP wrapper around the same Codex capabilities server.mjs exposes
// over MCP. Exists for callers that are not Claude Code — shell scripts, cron
// jobs, other local processes — that want a plain POST/JSON call instead of
// speaking the MCP protocol.
//
// Binds to 127.0.0.1 only, no auth: reachable only from this machine, same
// trust boundary as any other local dev server. Do not change the bind address
// without adding an auth check first — codex_code and the image tools write
// files, so this is a local code-execution endpoint, not a read-only API.
//
// Read README.md's "HTTP API" section before pointing production request paths
// at this — it exists for batch/background jobs, not live user-facing traffic.

import http from 'node:http';

import { ensureBridgeHome } from './lib/codex-core.mjs';
import { generateImage, editImage, codeTask, reviewDiff, webFetch, generateText } from './lib/tools.mjs';

const PORT = Number(process.env.CODEX_BRIDGE_HTTP_PORT ?? 8787);
const HOST = '127.0.0.1';

const ROUTES = {
  '/v1/generate': generateText,
  '/v1/generate-image': generateImage,
  '/v1/edit-image': editImage,
  '/v1/code': codeTask,
  '/v1/review': reviewDiff,
  '/v1/web': webFetch,
};

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('request body must be valid JSON');
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

await ensureBridgeHome();

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, routes: Object.keys(ROUTES) });
  }

  const handler = req.method === 'POST' ? ROUTES[req.url] : undefined;
  if (!handler) {
    return send(res, 404, {
      error: `no route for ${req.method} ${req.url}`,
      routes: Object.keys(ROUTES).map((r) => `POST ${r}`).concat('GET /health'),
    });
  }

  const started = Date.now();
  try {
    const body = await readJsonBody(req);
    const result = await handler(body);
    send(res, 200, { result, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
  } catch (err) {
    send(res, 500, { error: err.message ?? String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-bridge HTTP API on http://${HOST}:${PORT}`);
  console.log(`Routes: ${Object.keys(ROUTES).map((r) => `POST ${r}`).join(', ')}, GET /health`);
});
