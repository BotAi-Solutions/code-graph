import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-analysis scratch space. Each run gets its own directory so concurrent
 * analyses cannot overwrite one another's `index.scip`, and so a failed run
 * leaves its artefacts behind for inspection.
 */
export class AnalysisWorkspace {
  constructor(private readonly rootDirectory: string) {}

  directoryFor(analysisId: string): string {
    return path.join(this.rootDirectory, analysisId);
  }

  async prepare(analysisId: string): Promise<string> {
    const directory = this.directoryFor(analysisId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /** Called after a successful run; failures keep their artefacts. */
  async cleanup(analysisId: string): Promise<void> {
    await rm(this.directoryFor(analysisId), { recursive: true, force: true });
  }
}
