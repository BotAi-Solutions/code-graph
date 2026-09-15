import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SupportedLanguage } from '@ckg/shared';
import {
  NodeCommandRunner,
  resolveExecutable,
  type CommandRunner,
} from '../adapters/index.js';
import type { ScipIndexOptions, ScipIndexResult, ScipIndexer } from '../types/index.js';

export class ScipIndexError extends Error {
  constructor(
    message: string,
    readonly details: { command: string; exitCode: number | null; diagnostics: string[] },
  ) {
    super(message);
    this.name = 'ScipIndexError';
  }
}

export interface TypeScriptScipIndexerOptions {
  /** Command to execute. Defaults to `scip-typescript`. */
  command?: string;
  /** Injected for tests; defaults to spawning a real process. */
  commandRunner?: CommandRunner;
  defaultTimeoutMs?: number;
  /** Extra roots searched for a locally installed binary. */
  executableSearchRoots?: string[];
}

const DEFAULT_TIMEOUT_MS = 600_000;
const INDEX_FILE_NAME = 'index.scip';

/**
 * Drives the official Sourcegraph TypeScript/JavaScript indexer.
 *
 * Deliberately a thin adapter: it decides *how to invoke* scip-typescript and
 * nothing else. Parsing, graph building and persistence all happen elsewhere,
 * so replacing this with scip-python or scip-go is a matter of registering a
 * different implementation of `ScipIndexer`.
 */
export class TypeScriptScipIndexer implements ScipIndexer {
  readonly name = 'scip-typescript';

  private readonly command: string;
  private readonly commandRunner: CommandRunner;
  private readonly defaultTimeoutMs: number;
  private readonly executableSearchRoots: string[];

  constructor(options: TypeScriptScipIndexerOptions = {}) {
    this.command = options.command ?? 'scip-typescript';
    this.commandRunner = options.commandRunner ?? new NodeCommandRunner();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.executableSearchRoots = options.executableSearchRoots ?? [process.cwd()];
  }

  supports(language: SupportedLanguage): boolean {
    return language === 'typescript' || language === 'javascript';
  }

  async index(repositoryPath: string, options: ScipIndexOptions = {}): Promise<ScipIndexResult> {
    const absoluteRepository = path.resolve(repositoryPath);
    const outputDirectory = options.outputDirectory
      ? path.resolve(options.outputDirectory)
      : absoluteRepository;

    await mkdir(outputDirectory, { recursive: true });
    const indexPath = path.join(outputDirectory, INDEX_FILE_NAME);

    const executable = await resolveExecutable(this.command, {
      searchRoots: [...this.executableSearchRoots, absoluteRepository],
    });

    const args = [
      'index',
      '--cwd',
      absoluteRepository,
      '--output',
      indexPath,
      // A tsconfig is not guaranteed (plain JS repositories, for one); letting
      // the indexer infer one keeps those analysable.
      '--infer-tsconfig',
      '--no-progress-bar',
    ];

    let result;
    try {
      result = await this.commandRunner.run(executable, args, {
        cwd: absoluteRepository,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ScipIndexError(
        `could not execute "${this.command}". Install it with \`pnpm add -D @sourcegraph/scip-typescript\` or set SCIP_TYPESCRIPT_COMMAND. (${reason})`,
        { command: this.command, exitCode: null, diagnostics: [reason] },
      );
    }

    const diagnostics = collectDiagnostics(result.stdout, result.stderr);

    if (result.timedOut) {
      throw new ScipIndexError(`${this.name} timed out after ${result.durationMs}ms`, {
        command: this.command,
        exitCode: result.exitCode,
        diagnostics,
      });
    }

    if (result.exitCode !== 0) {
      throw new ScipIndexError(`${this.name} exited with code ${String(result.exitCode)}`, {
        command: this.command,
        exitCode: result.exitCode,
        diagnostics,
      });
    }

    return {
      indexPath,
      language: 'typescript',
      indexerName: this.name,
      toolVersion: null,
      durationMs: result.durationMs,
      diagnostics,
    };
  }
}

/**
 * Keeps the last few lines of indexer output for the analysis record. Indexer
 * logs describe files and progress, never file contents.
 */
function collectDiagnostics(stdout: string, stderr: string): string[] {
  return [...stderr.split('\n'), ...stdout.split('\n')]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-20);
}
