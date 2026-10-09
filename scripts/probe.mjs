#!/usr/bin/env node
// Smoke test: start the server over stdio, list its tools, and optionally call one.
//
//   npm run probe                     -> list tools only
//   npm run probe -- codex_web '{"request":"https://example.com"}'
//
// Exits non-zero on any protocol error or tool error, so it can gate a commit.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'server.mjs');

const [toolName, rawArgs] = process.argv.slice(2);

const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function die(message) {
  console.error(`FAIL: ${message}`);
  child.kill();
  process.exit(1);
}

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '1' },
});
if (init.error) die(`initialize: ${JSON.stringify(init.error)}`);
notify('notifications/initialized');

const listed = await request('tools/list', {});
if (listed.error) die(`tools/list: ${JSON.stringify(listed.error)}`);

console.log(`server: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
for (const tool of listed.result.tools) {
  const params = Object.keys(tool.inputSchema?.properties ?? {}).join(', ');
  console.log(`  ${tool.name}(${params})`);
}

if (toolName) {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  console.log(`\ncalling ${toolName}...`);
  const started = Date.now();
  const called = await request('tools/call', { name: toolName, arguments: args });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (called.error) die(`tools/call: ${JSON.stringify(called.error)}`);
  const text = called.result.content.map((c) => c.text).join('\n');
  console.log(`(${seconds}s)\n${text}`);
  if (called.result.isError) die('tool reported an error');
}

child.kill();
process.exit(0);
