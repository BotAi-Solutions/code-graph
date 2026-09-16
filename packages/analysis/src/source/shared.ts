import type { SourceFileSet } from '@ckg/graph';
import { ModuleSet } from './module-set.js';

/**
 * One parsed view of the repository per analysis run, shared by every analyzer.
 *
 * Keyed on the source set itself, so analyzers need no wiring to cooperate and
 * a second run over a different repository cannot see the first one's trees.
 */
const MODULE_SETS = new WeakMap<SourceFileSet, ModuleSet>();

export function moduleSetFor(sources: SourceFileSet): ModuleSet {
  const existing = MODULE_SETS.get(sources);
  if (existing) return existing;

  const created = new ModuleSet(sources);
  MODULE_SETS.set(sources, created);
  return created;
}
