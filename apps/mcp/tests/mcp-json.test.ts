import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The repository's `.mcp.json`: what Claude Code launches when it is opened
 * here.
 *
 * Checked because a wrong path in it fails silently from this side — the
 * client just shows a server that will not connect — and because it is a file
 * people copy into their own configuration, so a secret in it would travel.
 */

const WORKSPACE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

interface McpJson {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

const config = JSON.parse(readFileSync(path.join(WORKSPACE_ROOT, '.mcp.json'), 'utf8')) as McpJson;
const mcpPackage = JSON.parse(
  readFileSync(path.join(WORKSPACE_ROOT, 'apps/mcp/package.json'), 'utf8'),
) as { main: string; bin: Record<string, string> };

describe('.mcp.json', () => {
  it('declares exactly one server, this one', () => {
    expect(Object.keys(config.mcpServers)).toEqual(['code-graph']);
  });

  it('launches the MCP app’s own built entry point with node', () => {
    const server = config.mcpServers['code-graph'];
    expect(server?.command).toBe('node');

    const entry = server?.args?.[0] ?? '';
    // Relative to the project root however Claude Code expands the variable.
    const relative = entry.replace('${CLAUDE_PROJECT_DIR:-.}/', '');
    expect(relative).toBe(path.posix.join('apps/mcp', mcpPackage.main.replace(/^\.\//, '')));
    expect(Object.values(mcpPackage.bin)).toContain(`./${path.posix.relative('apps/mcp', relative)}`);
  });

  it('anchors the path to the project root rather than the client’s working directory', () => {
    expect(config.mcpServers['code-graph']?.args?.[0]).toMatch(/^\$\{CLAUDE_PROJECT_DIR:-\.\}\//);
  });

  it('carries no environment and so no secrets: configuration comes from the workspace .env', () => {
    const server = config.mcpServers['code-graph'];
    expect(server?.env).toBeUndefined();
    expect(JSON.stringify(config)).not.toMatch(/DATABASE_URL|postgres(ql)?:\/\/|password|token|secret/i);
  });

  it('points at the build of the server the stdio suite exercises', () => {
    const source = path.join(WORKSPACE_ROOT, 'apps/mcp/src/server.ts');
    expect(readFileSync(source, 'utf8')).toContain('createMcpServer');
  });
});
