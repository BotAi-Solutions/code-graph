import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The server as a local MCP client actually launches it: a real process,
 * speaking JSON-RPC over stdin and stdout.
 *
 * The in-memory suite next door proves the tool behaves; this proves the
 * process is usable at all. The two failures it exists to catch are invisible
 * to every other test here:
 *
 * 1. **A log line on stdout.** stdout is the transport. One `console.log`
 *    anywhere in this app — or a logger left on its default destination —
 *    lands between two JSON-RPC frames and the client's parser gives up. The
 *    symptom is a session that dies on connect with nothing useful said.
 * 2. **A server that will not start.** Config is read at startup, so a bad
 *    default fails here rather than at the first tool call.
 */

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSX = path.join(WORKSPACE_ROOT, 'node_modules/.bin/tsx');

interface Session {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Runs one MCP handshake against a freshly spawned server and returns what each
 * stream carried.
 *
 * The API is pointed at a port nothing listens on: starting up and answering
 * `tools/list` must not require the API to be running, because a client may
 * launch this process long before anyone asks it anything.
 */
async function handshake(frames: unknown[]): Promise<Session> {
  const child = spawn(TSX, [SERVER], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      MCP_API_BASE_URL: 'http://127.0.0.1:1',
      LOG_LEVEL: 'info',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

  for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);

  // Long enough for tsx to compile and the server to answer; the process is
  // killed rather than waited on, so this is a ceiling and not a sleep.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  child.kill('SIGTERM');

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });

  return { stdout, stderr, exitCode };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '0.0.0' },
  },
};

const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

describe('the server over stdio', () => {
  it('completes a handshake and lists its tool, writing nothing but JSON-RPC to stdout', async () => {
    const session = await handshake([INITIALIZE, INITIALIZED, LIST_TOOLS]);

    const lines = session.stdout.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    // Every single line, not just the ones we expect to find: a stray log line
    // is only a problem because it sits *between* valid frames.
    const parsed = lines.map((line) => {
      let value: unknown;
      expect(() => (value = JSON.parse(line))).not.toThrow();
      return value as { jsonrpc?: string; id?: number; result?: unknown };
    });
    for (const frame of parsed) expect(frame.jsonrpc).toBe('2.0');

    const initialize = parsed.find((frame) => frame.id === 1);
    expect(initialize?.result).toMatchObject({ serverInfo: { name: 'code-knowledge-graph' } });

    const tools = parsed.find((frame) => frame.id === 2)?.result as
      | { tools: { name: string }[] }
      | undefined;
    expect(tools?.tools.map((tool) => tool.name)).toEqual([
      'resolve_project',
      'get_index_status',
      'index_project',
      'search_graph',
      'get_node',
      'trace_path',
      'search_code',
      'get_source',
    ]);
  }, 20_000);

  it('logs to stderr instead', async () => {
    const session = await handshake([INITIALIZE, INITIALIZED]);

    expect(session.stderr).toContain('MCP server ready');
    // The same line must not have leaked the other way.
    expect(session.stdout).not.toContain('MCP server ready');
  }, 20_000);

  it('starts without the API running, so a client can launch it at any time', async () => {
    const session = await handshake([INITIALIZE, INITIALIZED, LIST_TOOLS]);

    expect(session.stderr).not.toMatch(/Invalid environment configuration/);
    expect(session.stdout).toContain('resolve_project');
  }, 20_000);
});
