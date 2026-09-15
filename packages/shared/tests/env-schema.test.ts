import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_CODE_STATUS,
  apiEnvSchema,
  databaseEnvSchema,
  graphQuerySchema,
  parseEnv,
  runtimeEnvSchema,
  workerEnvSchema,
} from '@ckg/shared';

describe('environment validation', () => {
  it('applies defaults so a minimal .env still boots', () => {
    expect(parseEnv(runtimeEnvSchema, {})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
  });

  it('coerces numeric variables, which always arrive as strings', () => {
    expect(parseEnv(apiEnvSchema, { PORT: '8080' }).PORT).toBe(8080);
    expect(parseEnv(workerEnvSchema, { WORKER_CONCURRENCY: '4' }).WORKER_CONCURRENCY).toBe(4);
  });

  it('accepts boolean-ish strings for flags', () => {
    expect(parseEnv(workerEnvSchema, { WORKER_RUN_ONCE: 'true' }).WORKER_RUN_ONCE).toBe(true);
    expect(parseEnv(workerEnvSchema, { WORKER_RUN_ONCE: '1' }).WORKER_RUN_ONCE).toBe(true);
    expect(parseEnv(workerEnvSchema, { WORKER_RUN_ONCE: 'no' }).WORKER_RUN_ONCE).toBe(false);
  });

  it('fails fast when a required variable is missing', () => {
    expect(() => parseEnv(databaseEnvSchema, {})).toThrow(/DATABASE_URL/);
  });

  it('names the offending variable without echoing its value', () => {
    let message = '';
    try {
      parseEnv(apiEnvSchema, { PORT: '99999' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('PORT');
    expect(message).not.toContain('99999');
  });

  it('rejects an out-of-range port rather than defaulting silently', () => {
    expect(() => parseEnv(apiEnvSchema, { PORT: '0' })).toThrow(/PORT/);
  });
});

describe('graph query schema', () => {
  it('applies a small default depth so a request never walks a whole repository', () => {
    const parsed = graphQuerySchema.parse({});

    expect(parsed.depth).toBe(2);
    expect(parsed.limit).toBe(500);
    expect(parsed.rootNodeId).toBeUndefined();
  });

  it('accepts filters as CSV or as repeated parameters', () => {
    expect(graphQuerySchema.parse({ nodeTypes: 'class,method' }).nodeTypes).toEqual([
      'class',
      'method',
    ]);
    expect(graphQuerySchema.parse({ nodeTypes: ['class', 'method'] }).nodeTypes).toEqual([
      'class',
      'method',
    ]);
  });

  it('treats an absent filter as "no filter" rather than an empty list', () => {
    expect(graphQuerySchema.parse({ nodeTypes: '' }).nodeTypes).toBeUndefined();
  });

  it('rejects an unknown node type', () => {
    expect(() => graphQuerySchema.parse({ nodeTypes: 'wombat' })).toThrow();
  });

  it('caps depth so a client cannot ask for the whole graph', () => {
    expect(() => graphQuerySchema.parse({ depth: '99' })).toThrow();
  });
});

describe('error codes', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_CODE_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('keeps code identifiers and their keys in step', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });
});
