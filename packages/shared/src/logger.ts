import { pino, type Logger as PinoLogger } from 'pino';

/**
 * Structured logging for the Node services.
 *
 * Exposed on the `@ckg/shared/logger` subpath rather than the package root so
 * that the browser bundle, which imports the same package for types and
 * schemas, never pulls in a Node-only dependency.
 *
 * Contract (see docs/architecture.md):
 *  - one JSON object per line
 *  - application logs on stdout, `error` and `fatal` on stderr — except in a
 *    process whose stdout carries a protocol (see `destination`)
 *  - every line carries timestamp, level, module and message; jobId and
 *    projectId are bound by the caller where they apply
 *  - source code, secrets, tokens and environment variables are never logged
 */

export type Logger = PinoLogger;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface CreateLoggerOptions {
  /** Appears on every line as `module`. */
  module: string;
  level?: LogLevel;
  /** Extra fields bound to every line, e.g. `{ service: 'worker' }`. */
  base?: Record<string, string | number>;
  /**
   * Where lines go.
   *
   * `split` is the contract above and the default: everything on stdout, errors
   * on stderr. `stderr` sends every line to stderr instead, for a process whose
   * stdout is not a log stream at all — the MCP server speaks JSON-RPC over
   * stdout, and one stray log line there is a protocol error rather than a
   * cosmetic problem.
   */
  destination?: 'split' | 'stderr';
}

/** pino's numeric level for `error`. Anything at or above goes to stderr. */
const ERROR_LEVEL = 50;
const ERROR_LABELS: ReadonlySet<string> = new Set(['error', 'fatal']);

/**
 * Matches either rendering of the level: the numeric default, or the string
 * label this module configures below. Handling both means the routing cannot
 * silently break if the formatter changes.
 */
const LEVEL_PATTERN = /"level":(?:(\d+)|"([a-z]+)")/;

function isErrorLine(line: string): boolean {
  const match = LEVEL_PATTERN.exec(line);
  if (!match) return false;

  const numeric = match[1];
  if (numeric !== undefined) return Number.parseInt(numeric, 10) >= ERROR_LEVEL;

  const label = match[2];
  return label !== undefined && ERROR_LABELS.has(label);
}

/**
 * Routes each rendered line to stdout or stderr. pino calls `write` once per
 * log record, so inspecting the serialised level is both correct and cheap.
 */
const splitDestination = {
  write(line: string): void {
    if (isErrorLine(line)) {
      process.stderr.write(line);
      return;
    }
    process.stdout.write(line);
  },
};

/** Everything on stderr, leaving stdout free for something that is not logs. */
const stderrDestination = {
  write(line: string): void {
    process.stderr.write(line);
  },
};

/**
 * Defence in depth. Nothing in the codebase logs these, but a future caller
 * passing a whole config object should not be able to leak one.
 */
const REDACTED_PATHS = [
  'password',
  'secret',
  'token',
  'authorization',
  'apiKey',
  'connectionString',
  'DATABASE_URL',
  '*.password',
  '*.secret',
  '*.token',
  '*.connectionString',
  '*.DATABASE_URL',
];

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: { module: options.module, ...options.base },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    },
    options.destination === 'stderr' ? stderrDestination : splitDestination,
  );
}

/** A logger that discards everything; used in tests. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
