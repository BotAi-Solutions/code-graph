import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@ckg/shared/logger';

/**
 * The logging contract from docs/architecture.md: NDJSON, application logs on
 * stdout, errors on stderr, and never a secret.
 */
interface Capture {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

/**
 * Captures the process streams, keeping only the logger's own NDJSON lines —
 * the test runner writes to the same streams, and those writes are not what is
 * under test.
 */
function captureStreams(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const collect = (into: string[]) => (chunk: unknown): boolean => {
    const text = String(chunk);
    if (text.startsWith('{') && text.includes('"module"')) into.push(text);
    return true;
  };

  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(collect(stdout));
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(collect(stderr));

  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe('createLogger', () => {
  it('writes application logs to stdout with the required fields', () => {
    const streams = captureStreams();
    try {
      const logger = createLogger({ module: 'worker', base: { service: 'worker' } });
      logger.info({ jobId: 'job-1', projectId: 'project-1' }, 'analysis completed');

      expect(streams.stderr).toHaveLength(0);
      const line = JSON.parse(streams.stdout[0] as string) as Record<string, unknown>;

      expect(line).toMatchObject({
        level: 'info',
        module: 'worker',
        service: 'worker',
        jobId: 'job-1',
        projectId: 'project-1',
        msg: 'analysis completed',
      });
      expect(typeof line.time).toBe('string');
    } finally {
      streams.restore();
    }
  });

  it('routes errors to stderr, not stdout', () => {
    const streams = captureStreams();
    try {
      createLogger({ module: 'api' }).error('indexing failed');

      expect(streams.stdout).toHaveLength(0);
      expect(JSON.parse(streams.stderr[0] as string)).toMatchObject({
        level: 'error',
        msg: 'indexing failed',
      });
    } finally {
      streams.restore();
    }
  });

  it('redacts secrets that reach it by accident', () => {
    const streams = captureStreams();
    try {
      createLogger({ module: 'api' }).info(
        { token: 'ghp_realtoken', config: { DATABASE_URL: 'postgresql://user:pw@host/db' } },
        'starting',
      );

      const rendered = streams.stdout.join('');
      expect(rendered).not.toContain('ghp_realtoken');
      expect(rendered).not.toContain('user:pw');
      expect(rendered).toContain('[redacted]');
    } finally {
      streams.restore();
    }
  });

  it('honours the configured level', () => {
    const streams = captureStreams();
    try {
      createLogger({ module: 'api', level: 'warn' }).debug('noisy');
      expect(streams.stdout).toHaveLength(0);
    } finally {
      streams.restore();
    }
  });
});
