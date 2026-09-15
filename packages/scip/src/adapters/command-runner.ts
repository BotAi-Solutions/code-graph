import { spawn } from 'node:child_process';

/**
 * The seam that keeps SCIP execution out of the rest of the application.
 * Indexers depend on this interface, so tests substitute a fake runner and
 * never touch a real process.
 */

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra variables merged over the inherited environment. */
  env?: Record<string, string>;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CommandRunner {
  run(command: string, args: string[], options: RunOptions): Promise<CommandResult>;
}

/** Cap captured output so a chatty indexer cannot exhaust memory. */
const MAX_CAPTURED_BYTES = 256 * 1024;

export class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: RunOptions): Promise<CommandResult> {
    const startedAt = Date.now();

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const append = (current: string, chunk: Buffer): string =>
        current.length >= MAX_CAPTURED_BYTES ? current : current + chunk.toString('utf8');

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGKILL');
            }, options.timeoutMs)
          : undefined;

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
