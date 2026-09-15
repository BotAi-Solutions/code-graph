import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ScipIndexError,
  ScipIndexerRegistry,
  TypeScriptScipIndexer,
  TypeScriptSymbolRefiner,
  createDefaultIndexerRegistry,
  type CommandResult,
  type CommandRunner,
  type RunOptions,
} from '@ckg/scip';

/** Records invocations instead of spawning a process. */
class RecordingCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options: RunOptions }> = [];

  constructor(private readonly result: Partial<CommandResult> = {}) {}

  async run(command: string, args: string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 1,
      ...this.result,
    };
  }
}

describe('TypeScriptScipIndexer', () => {
  it('supports TypeScript and JavaScript only', () => {
    const indexer = new TypeScriptScipIndexer();

    expect(indexer.supports('typescript')).toBe(true);
    expect(indexer.supports('javascript')).toBe(true);
    expect(indexer.supports('python')).toBe(false);
    expect(indexer.supports('go')).toBe(false);
  });

  it('invokes the indexer with an explicit output path inside the workspace', async () => {
    const runner = new RecordingCommandRunner();
    const indexer = new TypeScriptScipIndexer({ commandRunner: runner, command: '/bin/scip-ts' });

    const result = await indexer.index('/repo', { outputDirectory: '/tmp/workspace/job-1' });

    const call = runner.calls[0];
    expect(call?.command).toBe('/bin/scip-ts');
    expect(call?.args).toEqual([
      'index',
      '--cwd',
      path.resolve('/repo'),
      '--output',
      path.join('/tmp/workspace/job-1', 'index.scip'),
      '--infer-tsconfig',
      '--no-progress-bar',
    ]);
    expect(result.indexPath).toBe(path.join('/tmp/workspace/job-1', 'index.scip'));
    expect(result.language).toBe('typescript');
  });

  it('fails with a usable message when the indexer exits non-zero', async () => {
    const runner = new RecordingCommandRunner({ exitCode: 2, stderr: 'tsconfig.json not found' });
    const indexer = new TypeScriptScipIndexer({ commandRunner: runner, command: '/bin/scip-ts' });

    await expect(indexer.index('/repo', { outputDirectory: '/tmp/workspace/job-2' })).rejects.toThrow(
      ScipIndexError,
    );
  });

  it('reports a timeout distinctly from a failure', async () => {
    const runner = new RecordingCommandRunner({ timedOut: true, exitCode: null });
    const indexer = new TypeScriptScipIndexer({ commandRunner: runner, command: '/bin/scip-ts' });

    await expect(
      indexer.index('/repo', { outputDirectory: '/tmp/workspace/job-3' }),
    ).rejects.toThrow(/timed out/);
  });

  it('explains how to install the binary when it cannot be executed', async () => {
    const failing: CommandRunner = {
      run: () => Promise.reject(new Error('spawn ENOENT')),
    };
    const indexer = new TypeScriptScipIndexer({ commandRunner: failing, command: 'scip-typescript' });

    await expect(
      indexer.index('/repo', { outputDirectory: '/tmp/workspace/job-4' }),
    ).rejects.toThrow(/SCIP_TYPESCRIPT_COMMAND/);
  });
});

describe('ScipIndexerRegistry', () => {
  it('resolves an indexer by language and reports nothing for unimplemented ones', () => {
    const registry = createDefaultIndexerRegistry();

    expect(registry.resolve('typescript')?.name).toBe('scip-typescript');
    expect(registry.resolve('javascript')?.name).toBe('scip-typescript');
    expect(registry.resolve('python')).toBeNull();
    expect(registry.supportedLanguages(['python', 'typescript', 'go'])).toEqual(['typescript']);
  });

  it('resolves the language-specific refiner, falling back to a no-op', () => {
    const registry = createDefaultIndexerRegistry();

    expect(registry.resolveRefiner('typescript')).toBeInstanceOf(TypeScriptSymbolRefiner);
    expect(registry.resolveRefiner('rust').name).toBe('noop');
  });

  it('accepts new indexers without any call-site change', () => {
    const registry = new ScipIndexerRegistry().register({
      name: 'scip-python',
      supports: (language) => language === 'python',
      index: () => {
        throw new Error('not called');
      },
    });

    expect(registry.resolve('python')?.name).toBe('scip-python');
    expect(registry.resolve('typescript')).toBeNull();
  });
});
