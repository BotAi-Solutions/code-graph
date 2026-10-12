import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandResult, CommandRunner, RunOptions } from './command-runner.js';

/**
 * A `CommandRunner` that also measures what the child process used.
 *
 * Node cannot read a child's resource usage, so the command runs under the
 * operating system's `time` utility, which reads it with `wait4()` when the
 * child exits and writes it to a file. A file rather than stderr, so the
 * child's own diagnostics are not mixed with the measurement.
 *
 * - **BSD `time -l`** (macOS): peak resident set size in bytes, user and
 *   system CPU time.
 * - **GNU `time -v`** (Linux, when installed): the same, peak RSS in kilobytes.
 *
 * What it covers: the indexer process. CPU time includes children it waited
 * for; peak RSS is the indexer's own, not the sum of any children it spawned.
 *
 * The child runs in its own process group, so a timeout or an abort kills the
 * indexer and not only the `time` wrapper. A killed run has no report: the
 * measurement is then null with a reason, never zeros.
 */

export interface ProcessResourceUsage {
  /** Wall-clock time from spawn to exit, measured by this runner (ms). */
  wallMs: number;
  /** CPU time as the operating system accounted it (ms). */
  userCpuMs: number;
  systemCpuMs: number;
  /** Peak resident set size of the process (bytes). */
  peakRssBytes: number;
  /** Which utility measured it. */
  method: 'bsd-time' | 'gnu-time';
}

export interface MeasuredCommandResult extends CommandResult {
  /** Null when no measurement could be read; `measurementError` says why. */
  resourceUsage: ProcessResourceUsage | null;
  measurementError?: string;
}

export type TimeFlavor = 'bsd' | 'gnu';

export interface MeasuringCommandRunnerOptions {
  /** Path of the `time` utility. Defaults to `/usr/bin/time`. */
  timeBinary?: string;
  /** Output format. Defaults to BSD on macOS and the BSDs, GNU elsewhere. */
  flavor?: TimeFlavor;
}

const MAX_CAPTURED_BYTES = 256 * 1024;

export class MeasuringCommandRunner implements CommandRunner {
  private readonly timeBinary: string;
  private readonly flavor: TimeFlavor;
  /** The most recent run's result, kept even when the caller threw on it. */
  last: MeasuredCommandResult | null = null;

  constructor(options: MeasuringCommandRunnerOptions = {}) {
    this.timeBinary = options.timeBinary ?? '/usr/bin/time';
    this.flavor = options.flavor ?? defaultFlavor(process.platform);
  }

  async run(command: string, args: string[], options: RunOptions): Promise<MeasuredCommandResult> {
    const reportDirectory = await mkdtemp(path.join(tmpdir(), 'ckg-time-'));
    const reportFile = path.join(reportDirectory, 'report.txt');
    const timeArgs = [this.flavor === 'bsd' ? '-l' : '-v', '-o', reportFile, command, ...args];

    try {
      const result = await this.spawn(timeArgs, options);
      let resourceUsage: ProcessResourceUsage | null = null;
      let measurementError: string | undefined;

      if (result.timedOut || result.signal !== null) {
        measurementError = `the process was killed (${result.timedOut ? 'timeout' : String(result.signal)}) before it could be measured`;
      } else {
        try {
          const report = await readFile(reportFile, 'utf8');
          resourceUsage = parseTimeReport(report, this.flavor, result.durationMs);
          if (!resourceUsage) measurementError = 'the time report could not be parsed';
        } catch (error) {
          measurementError = `no time report: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      const measured: MeasuredCommandResult = {
        ...result,
        resourceUsage,
        ...(measurementError !== undefined ? { measurementError } : {}),
      };
      this.last = measured;
      return measured;
    } finally {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  }

  private spawn(timeArgs: string[], options: RunOptions): Promise<CommandResult> {
    const startedAt = performance.now();

    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.timeBinary, timeArgs, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group: killing the group reaches the indexer, not
        // just the `time` wrapper around it.
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const append = (current: string, chunk: Buffer): string =>
        current.length >= MAX_CAPTURED_BYTES ? current : current + chunk.toString('utf8');
      child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
      child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));

      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };

      const timer =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              killGroup('SIGKILL');
            }, options.timeoutMs)
          : undefined;
      const onAbort = (): void => killGroup('SIGTERM');
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
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
    });
  }
}

function defaultFlavor(platform: NodeJS.Platform): TimeFlavor {
  return platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd' ? 'bsd' : 'gnu';
}

/**
 * Reads a `time` report. Null when the fields it needs are not all there: a
 * partial measurement is not reported as a whole one.
 */
export function parseTimeReport(
  report: string,
  flavor: TimeFlavor,
  wallMs: number,
): ProcessResourceUsage | null {
  if (flavor === 'bsd') {
    // "        0.19 real         0.17 user         0.01 sys"
    const times = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(report);
    const rss = /(\d+)\s+maximum resident set size/.exec(report);
    if (!times || !rss) return null;
    return {
      wallMs,
      userCpuMs: seconds(times[2]),
      systemCpuMs: seconds(times[3]),
      peakRssBytes: Number(rss[1]),
      method: 'bsd-time',
    };
  }

  const user = /User time \(seconds\):\s*([\d.]+)/.exec(report);
  const system = /System time \(seconds\):\s*([\d.]+)/.exec(report);
  const rss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(report);
  if (!user || !system || !rss) return null;
  return {
    wallMs,
    userCpuMs: seconds(user[1]),
    systemCpuMs: seconds(system[1]),
    peakRssBytes: Number(rss[1]) * 1024,
    method: 'gnu-time',
  };
}

function seconds(value: string | undefined): number {
  return Math.round(Number(value) * 1000 * 100) / 100;
}
