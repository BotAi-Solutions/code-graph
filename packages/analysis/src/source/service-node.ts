import type { AnalyzerNodeDraft } from '@ckg/graph';
import type { PackageManifest } from './manifest.js';

/**
 * The service node, in one place.
 *
 * Several analyzers have something to say about the service as a whole — what
 * it depends on, what configures it, which third parties it talks to — and they
 * all run in the same stage, which means none of them can see the nodes the
 * others created through the symbol index. They do not need to: identity is a
 * content hash, so two analyzers building this same draft produce the same id
 * and therefore the same node, and each can declare it independently.
 *
 * That is why this is a shared function rather than a lookup. An edge that
 * relies on another analyzer having run first is an edge that quietly
 * disappears when the analyzer set changes.
 */
export function serviceDraftFor(manifest: PackageManifest | null): AnalyzerNodeDraft | null {
  if (!manifest?.name) return null;

  const metadata: Record<string, unknown> = { packageName: manifest.name };
  if (manifest.version) metadata.version = manifest.version;
  if (manifest.description) metadata.description = manifest.description;

  return {
    type: 'service',
    name: manifest.name,
    // The package name, not the path: the same service analysed from a
    // different checkout is the same service.
    symbolKey: `service:${manifest.name}`,
    qualifiedName: manifest.name,
    filePath: manifest.relativePath,
    metadata,
  };
}
