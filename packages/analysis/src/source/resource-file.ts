import type { AnalyzerEdgeDraft, AnalyzerNodeDraft, NodeReference } from '@ckg/graph';
import { draftRef, nodeRef } from '@ckg/graph';
import { evidence, type EdgeEvidence, type EvidenceSource } from '@ckg/shared';
import type { FileClassification } from '@ckg/language-detection';

/**
 * A node for a file the compiler never saw, hung in the right place in the tree.
 *
 * SCIP creates `file` and `directory` nodes for the documents it indexed, which
 * is every TypeScript file and nothing else. A README, a compose file and a
 * migration are files too, and until they are in the tree the source explorer
 * cannot show them, a `DOCUMENTS` edge has nothing to start from, and the graph
 * says the repository is a `src/` directory with nothing around it.
 *
 * The drafts built here use *exactly* the identity `ScipGraphBuilder` uses — a
 * directory is keyed by its path, a file by its path — so the two producers
 * cannot create a second `src/` node between them. That is also why the
 * directory chain is safe to rebuild from several analyzers at once: they all
 * produce the same ids, and the accumulator keeps the first.
 */

/** Node types that stand for a whole file. */
export type ResourceFileType = 'file' | 'document' | 'config' | 'api_spec';

export interface ResourceFileInput {
  classification: FileClassification;
  type: ResourceFileType;
  /** Merged into the node's metadata, after the classification facts. */
  metadata?: Record<string, unknown>;
}

export class ResourceTree {
  private readonly drafts = new Map<string, AnalyzerNodeDraft>();
  private readonly containment: AnalyzerEdgeDraft[] = [];
  /** Paths whose directory chain has already been built. */
  private readonly wired = new Set<string>();

  private readonly evidence: EdgeEvidence;

  constructor(
    private readonly repositoryNodeId: string | null,
    source: EvidenceSource,
  ) {
    // `graph`, not the analyzer's own method: placing a file under a directory
    // is read from the path, not from the file's contents, and it has no line
    // to point at. Saying `markdown` here would promise a position in a README
    // that does not exist.
    this.evidence = evidence({ source, basis: 'parsedStructure', method: 'graph' });
  }

  /**
   * The node for a file, creating its directory chain the first time.
   *
   * Returns a reference rather than a draft so a caller cannot accidentally
   * build a second, differently-shaped draft for the same path.
   */
  file(input: ResourceFileInput): NodeReference {
    const path = input.classification.path;

    const existing = this.drafts.get(path);
    if (existing) return draftRef(existing);

    const metadata: Record<string, unknown> = {
      category: input.classification.category,
      ...(input.classification.role ? { role: input.classification.role } : {}),
      ...(input.classification.language ? { language: input.classification.language } : {}),
      ...input.metadata,
    };

    const draft: AnalyzerNodeDraft = {
      type: input.type,
      name: input.classification.name,
      symbolKey: path,
      qualifiedName: path,
      filePath: path,
      metadata,
    };

    this.drafts.set(path, draft);
    this.wire(path, draftRef(draft));
    return draftRef(draft);
  }

  /** Nodes to declare, in path order so two runs emit the same array. */
  nodes(): AnalyzerNodeDraft[] {
    return [...this.drafts.values()].sort((a, b) => a.symbolKey.localeCompare(b.symbolKey));
  }

  /** The CONTAINS edges that place those nodes in the tree. */
  edges(): readonly AnalyzerEdgeDraft[] {
    return this.containment;
  }

  /**
   * Builds the `repository -> directory -> … -> file` chain.
   *
   * Nothing is emitted when there is no repository node — a repository with no
   * indexable code at all has no root — and the file node still exists, just
   * unparented. An orphan node is a smaller lie than an invented root.
   */
  private wire(path: string, fileRef: NodeReference): void {
    if (this.repositoryNodeId === null) return;

    const segments = path.split('/');
    segments.pop();

    let parent: NodeReference = nodeRef(this.repositoryNodeId);
    let current = '';

    for (const segment of segments) {
      current = current === '' ? segment : `${current}/${segment}`;

      const directory: AnalyzerNodeDraft = {
        type: 'directory',
        name: segment,
        symbolKey: current,
        qualifiedName: current,
        filePath: current,
      };

      const key = `dir:${current}`;
      if (!this.drafts.has(key)) this.drafts.set(key, directory);

      if (!this.wired.has(current)) {
        this.wired.add(current);
        this.containment.push({
          from: parent,
          to: draftRef(directory),
          relationship: 'CONTAINS',
          evidence: this.evidence,
        });
      }
      parent = draftRef(directory);
    }

    this.containment.push({
      from: parent,
      to: fileRef,
      relationship: 'CONTAINS',
      evidence: this.evidence,
    });
  }
}
