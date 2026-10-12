import { execFile } from 'node:child_process';
import os from 'node:os';
import type { EnvironmentInfo } from './results.js';

/**
 * Where a benchmark ran, recorded with every result: two numbers from two
 * machines are not comparable unless the record says they were two machines.
 *
 * Every probe is allowed to fail. A tool that is missing or answers
 * unexpectedly is recorded as `null`, never guessed.
 */

export type CommandProbe = (command: string, args: string[], cwd?: string) => Promise<string | null>;

/** Runs a command and returns its trimmed stdout, or null if it failed. */
export const execProbe: CommandProbe = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 30_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });

export function captureMachine(): EnvironmentInfo['machine'] {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    memoryBytes: os.totalmem(),
    os: os.type(),
    osRelease: os.release(),
    kernel: os.version(),
    arch: os.arch(),
  };
}

export interface ToolProbeOptions {
  /** The repository the benchmark tool lives in. */
  workspaceRoot: string;
  /** Resolved scip-typescript executable. */
  scipExecutable: string | null;
  /** `SELECT version()` from the benchmark database, when there is one. */
  postgresVersion: string | null;
  /** sha256 of the uncommitted changes; see `EnvironmentInfo.toolCommit`. */
  treeFingerprint?: string | null;
  probe?: CommandProbe;
}

export async function captureEnvironment(options: ToolProbeOptions): Promise<EnvironmentInfo> {
  const probe = options.probe ?? execProbe;
  const [pnpm, git, scip, sha, status] = await Promise.all([
    probe('pnpm', ['--version']),
    probe('git', ['--version']),
    options.scipExecutable ? probe(options.scipExecutable, ['--version']) : Promise.resolve(null),
    probe('git', ['rev-parse', 'HEAD'], options.workspaceRoot),
    probe('git', ['status', '--porcelain'], options.workspaceRoot),
  ]);
  const treeFingerprint = options.treeFingerprint ?? null;

  return {
    machine: captureMachine(),
    tools: {
      node: process.version,
      pnpm,
      git,
      scipTypescript: scip,
      postgres: options.postgresVersion,
    },
    toolCommit: { sha, dirty: status === null ? null : status.length > 0, treeFingerprint },
  };
}
