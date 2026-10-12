import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MeasuringCommandRunner,
  TypeScriptScipIndexer,
  parseTimeReport,
  type CommandRunner,
  type MeasuredCommandResult,
} from '@ckg/scip';

/**
 * Measuring a child process through the operating system's `time` utility.
 *
 * The parser is checked on captured reports from both flavours. The runner is
 * checked on real processes where `/usr/bin/time` speaks the BSD format (macOS);
 * elsewhere those cases are skipped rather than faked.
 */

const BSD_REPORT = [
  '        0.19 real         0.17 user         0.01 sys',
  '           211206144  maximum resident set size',
  '                   0  average shared memory size',
  '           172361648  peak memory footprint',
].join('\n');

const GNU_REPORT = [
  '\tCommand being timed: "node -e ..."',
  '\tUser time (seconds): 1.25',
  '\tSystem time (seconds): 0.08',
  '\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:01.40',
  '\tMaximum resident set size (kbytes): 204800',
].join('\n');

describe('parseTimeReport', () => {
  it('reads the BSD format, peak RSS in bytes', () => {
    expect(parseTimeReport(BSD_REPORT, 'bsd', 190)).toEqual({
      wallMs: 190,
      userCpuMs: 170,
      systemCpuMs: 10,
      peakRssBytes: 211206144,
      method: 'bsd-time',
    });
  });

  it('reads the GNU format, peak RSS in kilobytes', () => {
    expect(parseTimeReport(GNU_REPORT, 'gnu', 1400)).toEqual({
      wallMs: 1400,
      userCpuMs: 1250,
      systemCpuMs: 80,
      peakRssBytes: 204800 * 1024,
      method: 'gnu-time',
    });
  });

  it('refuses a partial report rather than reporting part of a measurement', () => {
    expect(parseTimeReport('        0.19 real         0.17 user         0.01 sys', 'bsd', 1)).toBeNull();
    expect(parseTimeReport('', 'gnu', 1)).toBeNull();
  });
});

const canMeasure = process.platform === 'darwin' && existsSync('/usr/bin/time');

describe.runIf(canMeasure)('MeasuringCommandRunner on real processes', () => {
  const node = process.execPath;

  it('measures CPU and peak memory, and leaves the child output intact', async () => {
    const runner = new MeasuringCommandRunner();
    const result = await runner.run(
      node,
      ['-e', "const b = Buffer.alloc(120 * 1024 * 1024, 1); console.error('child says ' + b.length)"],
      { cwd: tmpdir(), timeoutMs: 30_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('child says');
    expect(result.stderr).not.toContain('maximum resident set size');
    expect(result.resourceUsage?.method).toBe('bsd-time');
    expect(result.resourceUsage?.peakRssBytes).toBeGreaterThan(120 * 1024 * 1024);
    expect(result.resourceUsage?.userCpuMs).toBeGreaterThanOrEqual(0);
    expect(runner.last).toBe(result);
  });

  it('passes a failing exit code through, still measured', async () => {
    const result = await new MeasuringCommandRunner().run(node, ['-e', 'process.exit(3)'], { cwd: tmpdir() });

    expect(result.exitCode).toBe(3);
    expect(result.resourceUsage).not.toBeNull();
  });

  it('kills the measured process on timeout, not only the time wrapper, and says it was not measured', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ckg-timeout-'));
    const pidFile = path.join(directory, 'pid');
    try {
      const result = await new MeasuringCommandRunner().run(
        '/bin/sh',
        ['-c', `echo $$ > ${pidFile}; exec sleep 30`],
        { cwd: directory, timeoutMs: 400 },
      );

      expect(result.timedOut).toBe(true);
      expect(result.resourceUsage).toBeNull();
      expect(result.measurementError).toContain('timeout');

      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('TypeScriptScipIndexer with a measuring runner', () => {
  it('hands the measurement on in its result, and omits it with an ordinary runner', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ckg-indexer-'));
    const usage = { wallMs: 5, userCpuMs: 3, systemCpuMs: 1, peakRssBytes: 1024, method: 'bsd-time' as const };
    const result = (resourceUsage: MeasuredCommandResult['resourceUsage']): MeasuredCommandResult => ({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 5,
      resourceUsage,
    });
    const runner = (value: MeasuredCommandResult | Omit<MeasuredCommandResult, 'resourceUsage'>): CommandRunner => ({
      run: async () => value,
    });

    try {
      const measured = await new TypeScriptScipIndexer({
        command: '/bin/echo',
        commandRunner: runner(result(usage)),
      }).index(directory, { outputDirectory: directory });
      expect(measured.resources).toEqual(usage);

      const { resourceUsage: _omitted, ...plain } = result(null);
      const unmeasured = await new TypeScriptScipIndexer({
        command: '/bin/echo',
        commandRunner: runner(plain),
      }).index(directory, { outputDirectory: directory });
      expect('resources' in unmeasured).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
