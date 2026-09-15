import type { CodeNode, CodeNodeType, CodeRelationship } from '@ckg/shared';
import type { ScipIndex } from '@ckg/scip';
import type { GraphIdentityContext } from '../model/identity.js';
import type { GraphBuildResult, GraphBuildStats } from '../model/types.js';
import {
  isCallableNodeType,
  isContainerNodeType,
  normalizeDocument,
  type NormalizedDefinition,
  type NormalizedDocument,
} from '../normalizer/index.js';
import { EdgeAccumulator } from './edge-accumulator.js';
import { NodeAccumulator } from './node-accumulator.js';

/**
 * Builds a code knowledge graph from a parsed SCIP index.
 *
 *   SCIP documents -> normalise symbols -> create nodes -> resolve symbol
 *   relationships -> create edges -> deduplicate -> CodeGraph
 *
 * The builder is deterministic by construction: every identity is a content
 * hash (see `model/identity.ts`), maps are the only accumulators, and both
 * output arrays are sorted by id. Running it twice over the same index yields
 * byte-identical output.
 *
 * It is also language agnostic. Everything it knows about a symbol arrives as
 * the neutral `ScipSymbolKind` vocabulary produced by `@ckg/scip`; no syntax,
 * file extension or framework convention is interpreted here.
 */

export interface ScipGraphBuilderOptions {
  identity: GraphIdentityContext;
  /** Display name of the repository node. */
  repositoryName: string;
  /**
   * Also emit container-level edges (class -> class) that summarise the
   * member-level edges between them. This is what makes the graph readable at
   * an architectural altitude; disable it to keep only literal relationships.
   */
  deriveContainerEdges?: boolean;
}

interface SymbolRecord {
  nodeId: string;
  nodeType: CodeNodeType;
  /** Node id of the nearest class/interface/type ancestor, or the node itself. */
  containerNodeId: string | null;
  documentPath: string;
}

export class ScipGraphBuilder {
  private readonly deriveContainerEdges: boolean;

  constructor(private readonly options: ScipGraphBuilderOptions) {
    this.deriveContainerEdges = options.deriveContainerEdges ?? true;
  }

  build(index: ScipIndex): GraphBuildResult {
    const nodes = new NodeAccumulator(this.options.identity);
    const edges = new EdgeAccumulator(this.options.identity);

    const documents = index.documents.map((document) => normalizeDocument(document));

    const repositoryNode = nodes.add({
      type: 'repository',
      name: this.options.repositoryName,
      symbolKey: 'repository',
      metadata: {
        indexer: index.metadata.toolInfo.name,
        indexerVersion: index.metadata.toolInfo.version,
        documentCount: documents.length,
      },
    });

    // --- structure: directories and files --------------------------------
    const fileNodeByPath = new Map<string, CodeNode>();

    for (const document of documents) {
      const fileNode = this.createPathNodes(nodes, edges, repositoryNode.id, document);
      fileNodeByPath.set(document.relativePath, fileNode);
    }

    // --- symbols ----------------------------------------------------------
    const symbols = new Map<string, SymbolRecord>();
    let symbolCount = 0;

    for (const document of documents) {
      const fileNode = fileNodeByPath.get(document.relativePath);
      if (!fileNode) continue;

      // Owners must exist before children so container resolution can walk up.
      const ordered = [...document.definitions].sort(
        (a, b) => a.symbol.identity.descriptors.length - b.symbol.identity.descriptors.length,
      );

      for (const definition of ordered) {
        symbolCount += 1;
        const node = this.createSymbolNode(nodes, document, definition);

        const ownerId = definition.symbol.identity.ownerId;
        const ownerRecord = ownerId ? symbols.get(ownerId) : undefined;
        const parentNodeId = ownerRecord?.nodeId ?? fileNode.id;

        edges.add(parentNodeId, 'CONTAINS', node.id);

        symbols.set(definition.symbol.id, {
          nodeId: node.id,
          nodeType: definition.nodeType,
          containerNodeId: resolveContainer(node.id, definition.nodeType, ownerRecord),
          documentPath: document.relativePath,
        });
      }

      // The file's own SCIP symbol resolves to the file node, so references at
      // top level attribute to the file rather than being dropped.
      if (document.fileSymbolId) {
        symbols.set(document.fileSymbolId, {
          nodeId: fileNode.id,
          nodeType: 'file',
          containerNodeId: null,
          documentPath: document.relativePath,
        });
      }
    }

    // --- behaviour: calls, references, imports ----------------------------
    let unresolvedReferenceCount = 0;

    for (const document of documents) {
      const fileNode = fileNodeByPath.get(document.relativePath);
      if (!fileNode) continue;

      for (const reference of document.references) {
        const target = symbols.get(reference.targetSymbolId);
        if (!target) {
          // Defined outside the analysed repository (a dependency or the
          // standard library). Those are not nodes, so there is no edge.
          unresolvedReferenceCount += 1;
          continue;
        }

        const source = reference.enclosingSymbolId
          ? symbols.get(reference.enclosingSymbolId)
          : undefined;
        const sourceNodeId = source?.nodeId ?? fileNode.id;

        if (sourceNodeId === target.nodeId) continue;

        // File-level dependency. SCIP does not mark import occurrences, so a
        // cross-file reference is the reliable signal that one file depends on
        // another.
        if (target.documentPath !== document.relativePath) {
          const targetFileNode = fileNodeByPath.get(target.documentPath);
          if (targetFileNode && targetFileNode.id !== fileNode.id) {
            edges.add(fileNode.id, 'IMPORTS', targetFileNode.id);
          }
        }

        // A reference whose target is a file is a module specifier
        // (`from './user.service.js'`). IMPORTS above already carries that;
        // a second REFERENCES edge would only duplicate it.
        if (target.nodeType === 'file') continue;

        const relationship: CodeRelationship = isCallableNodeType(target.nodeType)
          ? 'CALLS'
          : 'REFERENCES';

        edges.add(sourceNodeId, relationship, target.nodeId);

        if (this.deriveContainerEdges) {
          this.addDerivedContainerEdge(edges, source, target, relationship);
        }
      }
    }

    // --- inheritance ------------------------------------------------------
    for (const document of documents) {
      for (const definition of document.definitions) {
        const source = symbols.get(definition.symbol.id);
        if (!source) continue;

        for (const relation of definition.symbol.relationships) {
          if (!relation.isImplementation) continue;

          const target = symbols.get(relation.symbolId);
          if (!target) continue;

          edges.add(source.nodeId, inheritanceRelationship(target.nodeType), target.nodeId);
        }
      }
    }

    const nodeArray = nodes.toArray();
    const edgeArray = edges.toArray();

    const stats: GraphBuildStats = {
      documentCount: documents.length,
      symbolCount,
      nodeCount: nodeArray.length,
      edgeCount: edgeArray.length,
      unresolvedReferenceCount,
    };

    return { nodes: nodeArray, edges: edgeArray, stats };
  }

  /**
   * Creates the directory chain for a document and the file node itself,
   * wiring CONTAINS edges from the repository down.
   */
  private createPathNodes(
    nodes: NodeAccumulator,
    edges: EdgeAccumulator,
    repositoryNodeId: string,
    document: NormalizedDocument,
  ): CodeNode {
    const segments = document.relativePath.split('/');
    const fileName = segments.pop() as string;

    let parentId = repositoryNodeId;
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const directoryNode = nodes.add({
        type: 'directory',
        name: segment,
        symbolKey: currentPath,
        filePath: currentPath,
      });
      edges.add(parentId, 'CONTAINS', directoryNode.id);
      parentId = directoryNode.id;
    }

    const fileNode = nodes.add({
      type: 'file',
      name: fileName,
      symbolKey: document.relativePath,
      filePath: document.relativePath,
      metadata: document.language ? { language: document.language } : {},
    });
    edges.add(parentId, 'CONTAINS', fileNode.id);

    return fileNode;
  }

  private createSymbolNode(
    nodes: NodeAccumulator,
    document: NormalizedDocument,
    definition: NormalizedDefinition,
  ): CodeNode {
    const range = definition.enclosingRange ?? definition.nameRange;

    const metadata: Record<string, unknown> = {
      scipSymbol: definition.symbol.id,
      scipKind: definition.symbol.kind,
    };
    if (document.language) metadata.language = document.language;
    if (definition.symbol.signature) metadata.signature = definition.symbol.signature;
    if (definition.symbol.documentation?.length) {
      metadata.documentation = definition.symbol.documentation;
    }

    return nodes.add({
      type: definition.nodeType,
      name: definition.symbol.name,
      symbolKey: definition.symbol.id,
      filePath: document.relativePath,
      // SCIP positions are zero-based; the graph exposes one-based line numbers
      // because that is what every editor and reviewer means by "line 42".
      startLine: range.startLine + 1,
      endLine: range.endLine + 1,
      metadata,
    });
  }

  /**
   * Lifts a member-level edge to the classes that own its endpoints, so the
   * graph also reads as "UserController CALLS UserService" and not only as a
   * mesh of individual methods.
   */
  private addDerivedContainerEdge(
    edges: EdgeAccumulator,
    source: SymbolRecord | undefined,
    target: SymbolRecord,
    relationship: CodeRelationship,
  ): void {
    const sourceContainer = source?.containerNodeId;
    const targetContainer = target.containerNodeId;

    if (!sourceContainer || !targetContainer) return;
    if (sourceContainer === targetContainer) return;
    if (sourceContainer === source?.nodeId && targetContainer === target.nodeId) {
      // Already a container-to-container edge; the direct edge covers it.
      return;
    }

    if (edges.has(sourceContainer, relationship, targetContainer)) return;

    edges.add(sourceContainer, relationship, targetContainer, { derived: true });
  }
}

/**
 * The nearest container for a symbol: itself when it is one, otherwise its
 * owner's container. Files are not containers for this purpose — a file-level
 * aggregate edge is already expressed as IMPORTS.
 */
function resolveContainer(
  nodeId: string,
  nodeType: CodeNodeType,
  owner: SymbolRecord | undefined,
): string | null {
  if (isContainerNodeType(nodeType) && nodeType !== 'file' && nodeType !== 'module') {
    return nodeId;
  }
  return owner?.containerNodeId ?? null;
}

/**
 * SCIP reports `extends` and `implements` with the same flag, so the target
 * decides: inheriting from an interface is IMPLEMENTS, from a class EXTENDS,
 * and a member satisfying a member of a supertype is IMPLEMENTS.
 */
function inheritanceRelationship(targetType: CodeNodeType): CodeRelationship {
  return targetType === 'class' ? 'EXTENDS' : 'IMPLEMENTS';
}
