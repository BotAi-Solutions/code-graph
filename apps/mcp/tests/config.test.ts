import { describe, expect, it } from 'vitest';
import { loadMcpConfig } from '../src/config.js';

/**
 * Where the MCP server thinks the API is.
 *
 * Worth its own tests because getting it wrong produces the least helpful
 * possible failure — every tool call reporting "could not be reached" — and
 * because the default is derived rather than written down.
 */

describe('loadMcpConfig', () => {
  it('follows the API’s own PORT when no base URL is set', () => {
    const config = loadMcpConfig({ PORT: '3001' });

    expect(config.mcp.apiBaseUrl).toBe('http://localhost:3001');
  });

  it('falls back to the API’s default port when nothing is set at all', () => {
    expect(loadMcpConfig({}).mcp.apiBaseUrl).toBe('http://localhost:3000');
  });

  it('prefers an explicit base URL over the port', () => {
    const config = loadMcpConfig({
      PORT: '3001',
      MCP_API_BASE_URL: 'http://graph.internal:8080',
    });

    expect(config.mcp.apiBaseUrl).toBe('http://graph.internal:8080');
  });

  it('strips a trailing slash so paths concatenate cleanly', () => {
    // `${base}/api/projects/resolve` with a trailing slash would request
    // `//api/...`, which some servers route and others do not.
    expect(loadMcpConfig({ MCP_API_BASE_URL: 'http://localhost:3000/' }).mcp.apiBaseUrl).toBe(
      'http://localhost:3000',
    );
  });

  it('ignores HOST, which is a bind address and not somewhere to connect', () => {
    const config = loadMcpConfig({ HOST: '0.0.0.0', PORT: '3001' });

    expect(config.mcp.apiBaseUrl).toBe('http://localhost:3001');
  });

  it('fails at startup on a malformed base URL, naming the variable', () => {
    expect(() => loadMcpConfig({ MCP_API_BASE_URL: 'localhost:3000' })).toThrowError(
      /MCP_API_BASE_URL/,
    );
  });

  it('rejects a non-numeric port with the variable name and not its value', () => {
    expect(() => loadMcpConfig({ PORT: 'not-a-port' })).toThrowError(/PORT/);
  });

  it('defaults the request timeout and accepts an override', () => {
    expect(loadMcpConfig({}).mcp.MCP_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(loadMcpConfig({ MCP_REQUEST_TIMEOUT_MS: '500' }).mcp.MCP_REQUEST_TIMEOUT_MS).toBe(500);
  });

  it('needs no database credentials', () => {
    // The property that keeps this app an adapter: it cannot reach the database
    // even if a tool tried to, because it was never given a way to.
    expect(() => loadMcpConfig({})).not.toThrow();
    expect(JSON.stringify(loadMcpConfig({}))).not.toContain('DATABASE');
  });
});
