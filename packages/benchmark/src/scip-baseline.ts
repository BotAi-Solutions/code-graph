import { edgeEvidence, type CodeGraph, type CodeNode } from '@ckg/shared';
import { declaresForeignModule, nodeTypeForSymbolKind } from '@ckg/graph';
import type { ScipIndex, ScipOccurrence, ScipRange, ScipSymbol } from '@ckg/scip';
import { addressOf } from './evaluate.js';

/**
 * The graph measured against the raw SCIP index it was built from.
 *
 * The hand-written ground truth says what a reader believes; this says what
 * the indexer said, and whether normalisation kept it. It needs no
 * expectations, so it runs on every fixture, and it joins the two sides by the
 * one identity that survives normalisation unchanged: the SCIP symbol string
 * every symbol node carries as `metadata.scipSymbol`.
 *
 * It is a consistency measurement, not a correctness one. Agreement means the
 * graph faithfully represents the index, including where the index itself is
 * wrong; that is what the ground truth is for.
 *
 * Scope attribution is computed here independently of the builder (innermost
 * definition with an enclosing range that has a node, otherwise the file), so
 * a disagreement points at a bug in one of the two.
 */

/**
 * What SCIP cannot be compared with directly, and why. Printed with every
 * report so a reader does not mistake a pair-level agreement for more.
 */
export const NOT_COMPARABLE: readonly string[] = [
  'CALLS vs REFERENCES: SCIP has no call role. Uses are compared as (source, target) pairs; which of the two relationships a pair became is scored by the ground truth only.',
  'IMPORTS: SCIP has no import role, and scip-typescript does not set one. The graph derives file dependencies; they are not compared here.',
  'EXTENDS vs IMPLEMENTS: SCIP reports both with one isImplementation flag. Inheritance is compared as pairs; the split is scored by the ground truth only.',
  'Derived class-level edges (method "graph"): a summary the graph computes, not something SCIP states.',
  'Edges from source analyzers (INSTANTIATES, ACCEPTS, RETURNS, routes, tables, documents, ...): not SCIP facts.',
  'Occurrence positions of edges: the graph collapses repeated uses into one edge with an occurrence count, so individual reference sites are not compared.',
];

export interface PairComparison {
  /** Pairs SCIP supports. */
  scip: number;
  /** Pairs the graph holds. */
  graph: number;
  both: number;
  /** In SCIP, not in the graph: lost in normalisation. */
  onlyScip: string[];
  /** In the graph, not supported by any SCIP fact: invented or misattributed. */
  onlyGraph: string[];
  recall: number | null;
  precision: number | null;
}

export interface ScipBaselineResult {
  definitions: {
    /** Non-local symbols with a definition in the index, excluding file symbols. */
    total: number;
    /** Those with a node whose `metadata.scipSymbol` is the symbol. */
    modelled: number;
    /** Not modelled, by the documented reason (`kind:parameter`, ...). */
    notModelledByDesign: Record<string, number>;
    /** Not modelled, and no documented reason explains it. */
    unexplained: string[];
    /**
     * Symbols defined more than once. Overloads and declaration merging do
     * this legitimately; two distinct declarations sharing one symbol (a
     * static and an instance method) collapse into one node.
     */
    multiplyDefined: string[];
  };
  identity: {
    nodesWithSymbol: number;
    /** A symbol represented by several nodes: identity was not stable. */
    symbolsWithSeveralNodes: string[];
  };
  locations: {
    checked: number;
    /** Node start and end lines equal the definition's range in the index. */
    preserved: number;
    mismatches: string[];
  };
  references: {
    /** Non-definition occurrences of non-local symbols. */
    occurrences: number;
    /** Names in import and export specifiers (refined from syntax). */
    specifiers: number;
    /** Module specifiers: the target is a file symbol. */
    moduleSpecifiers: number;
    /** The target is not defined anywhere in the index. */
    external: number;
    /** The target is defined in the index but is not a node (e.g. a parameter). */
    toUnmodelledSymbols: number;
    /** What the graph reports as unresolved references. */
    reportedUnresolved: number | null;
    /**
     * True when the graph's count equals external + toUnmodelledSymbols. The
     * builder counts both as unresolved; the split is only visible here.
     */
    unresolvedConsistent: boolean | null;
  };
  /** Uses (CALLS and REFERENCES together) as (scope, target) pairs. */
  uses: PairComparison;
  /** EXTENDS and IMPLEMENTS together, against SCIP implementation relationships. */
  inheritance: PairComparison & { externalTargets: number };
  notComparable: readonly string[];
  /** True when nothing was lost, invented, misplaced or left unexplained. */
  consistent: boolean;
}

interface Definition {
  symbolId: string;
  documentPath: string;
  occurrence: ScipOccurrence;
}

export function compareWithScip(
  index: ScipIndex,
  graph: CodeGraph,
  options: { reportedUnresolved?: number } = {},
): ScipBaselineResult {
  const nodesBySymbol = new Map<string, CodeNode[]>();
  const fileNodeByPath = new Map<string, CodeNode>();
  const nodeById = new Map<string, CodeNode>();

  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
    if (node.type === 'file' && node.filePath !== undefined) fileNodeByPath.set(node.filePath, node);
    const symbol = node.metadata?.scipSymbol;
    if (typeof symbol !== 'string') continue;
    const existing = nodesBySymbol.get(symbol);
    if (existing) existing.push(node);
    else nodesBySymbol.set(symbol, [node]);
  }

  const label = (id: string): string => {
    const node = nodeById.get(id);
    return node ? `${node.type}|${addressOf(node)}` : id;
  };

  // --- definitions ------------------------------------------------------
  const symbolInfo = new Map<string, ScipSymbol>();
  const fileSymbols = new Set<string>();
  const definitions = new Map<string, Definition[]>();

  for (const document of index.documents) {
    for (const symbol of document.symbols) {
      symbolInfo.set(symbol.id, symbol);
      if (symbol.kind === 'file') fileSymbols.add(symbol.id);
    }
    for (const occurrence of document.occurrences) {
      if (!occurrence.isDefinition || isLocal(occurrence.symbolId)) continue;
      const entry = { symbolId: occurrence.symbolId, documentPath: document.relativePath, occurrence };
      const existing = definitions.get(occurrence.symbolId);
      if (existing) existing.push(entry);
      else definitions.set(occurrence.symbolId, [entry]);
    }
  }

  const notModelledByDesign: Record<string, number> = {};
  const unexplained: string[] = [];
  const multiplyDefined: string[] = [];
  let total = 0;
  let modelled = 0;

  for (const [symbolId, entries] of definitions) {
    if (fileSymbols.has(symbolId)) continue;
    total += 1;
    if (entries.length > 1) multiplyDefined.push(`${symbolId} (${String(entries.length)} definitions)`);

    if (nodesBySymbol.has(symbolId)) {
      modelled += 1;
      continue;
    }

    const info = symbolInfo.get(symbolId);
    const kind = info?.kind ?? 'unknown';
    if (nodeTypeForSymbolKind(kind) === null) {
      const reason = `kind:${kind}`;
      notModelledByDesign[reason] = (notModelledByDesign[reason] ?? 0) + 1;
    } else if (info && declaresForeignModule(info.identity)) {
      notModelledByDesign['ambient module declaration'] =
        (notModelledByDesign['ambient module declaration'] ?? 0) + 1;
    } else {
      unexplained.push(symbolId);
    }
  }

  // --- identity and locations --------------------------------------------
  const symbolsWithSeveralNodes: string[] = [];
  let nodesWithSymbol = 0;
  let checked = 0;
  let preserved = 0;
  const locationMismatches: string[] = [];

  for (const [symbolId, nodes] of nodesBySymbol) {
    nodesWithSymbol += nodes.length;
    if (nodes.length > 1) symbolsWithSeveralNodes.push(`${symbolId} (${String(nodes.length)} nodes)`);

    const first = definitions.get(symbolId)?.[0];
    if (!first) continue;
    const range: ScipRange = first.occurrence.enclosingRange ?? first.occurrence;

    for (const node of nodes) {
      if (node.filePath !== first.documentPath) continue;
      checked += 1;
      if (node.startLine === range.startLine + 1 && node.endLine === range.endLine + 1) {
        preserved += 1;
      } else {
        locationMismatches.push(
          `${node.type}|${addressOf(node)}: node lines ${String(node.startLine)}-${String(node.endLine)}, index lines ${String(range.startLine + 1)}-${String(range.endLine + 1)}`,
        );
      }
    }
  }

  // --- references and uses ------------------------------------------------
  let occurrences = 0;
  let specifiers = 0;
  let moduleSpecifiers = 0;
  let external = 0;
  let toUnmodelledSymbols = 0;
  const scipUses = new Set<string>();

  for (const document of index.documents) {
    const fileNode = fileNodeByPath.get(document.relativePath);

    // Scopes a use can be attributed to: definitions in this document that
    // carry an enclosing range and have a node, innermost first.
    const scopes = document.occurrences
      .filter(
        (occurrence) =>
          occurrence.isDefinition &&
          occurrence.enclosingRange !== undefined &&
          nodesBySymbol.has(occurrence.symbolId),
      )
      .map((occurrence) => ({
        symbolId: occurrence.symbolId,
        range: occurrence.enclosingRange as ScipRange,
      }))
      .sort((a, b) => size(a.range) - size(b.range));

    for (const occurrence of document.occurrences) {
      if (occurrence.isDefinition || isLocal(occurrence.symbolId)) continue;
      occurrences += 1;

      const targetDefined = definitions.has(occurrence.symbolId) || fileSymbols.has(occurrence.symbolId);
      if (!targetDefined) {
        external += 1;
        continue;
      }
      if (fileSymbols.has(occurrence.symbolId)) {
        moduleSpecifiers += 1;
        continue;
      }
      const targets = nodesBySymbol.get(occurrence.symbolId);
      if (!targets) {
        toUnmodelledSymbols += 1;
        continue;
      }
      if (occurrence.isSpecifier === true || occurrence.isImport) {
        specifiers += 1;
        continue;
      }

      const scope = scopes.find((candidate) => contains(candidate.range, occurrence));
      const sourceId = scope ? nodesBySymbol.get(scope.symbolId)?.[0]?.id : fileNode?.id;
      if (sourceId === undefined) continue;

      for (const target of targets) {
        if (target.id === sourceId) continue;
        scipUses.add(`${sourceId}>${target.id}`);
      }
    }
  }

  const graphUses = new Set<string>();
  const graphInheritance = new Set<string>();
  for (const edge of graph.edges) {
    const evidence = edgeEvidence(edge);
    if (evidence?.source !== 'scip') continue;
    const pair = `${edge.sourceNodeId}>${edge.targetNodeId}`;
    if (edge.relationship === 'CALLS' || edge.relationship === 'REFERENCES') graphUses.add(pair);
    if (edge.relationship === 'EXTENDS' || edge.relationship === 'IMPLEMENTS') graphInheritance.add(pair);
  }

  // --- inheritance ----------------------------------------------------------
  const scipInheritance = new Set<string>();
  let externalTargets = 0;
  for (const document of index.documents) {
    for (const symbol of document.symbols) {
      const sources = nodesBySymbol.get(symbol.id);
      if (!sources) continue;
      for (const relation of symbol.relationships) {
        if (!relation.isImplementation) continue;
        const targets = nodesBySymbol.get(relation.symbolId);
        if (!targets) {
          externalTargets += 1;
          continue;
        }
        for (const source of sources) {
          for (const target of targets) {
            if (source.id !== target.id) scipInheritance.add(`${source.id}>${target.id}`);
          }
        }
      }
    }
  }

  const describe = (pair: string): string => {
    const [source, target] = pair.split('>') as [string, string];
    return `${label(source)} -> ${label(target)}`;
  };

  const uses = comparePairs(scipUses, graphUses, describe);
  const inheritance = { ...comparePairs(scipInheritance, graphInheritance, describe), externalTargets };

  const reportedUnresolved = options.reportedUnresolved ?? null;
  const unresolvedConsistent =
    reportedUnresolved === null ? null : reportedUnresolved === external + toUnmodelledSymbols;

  return {
    definitions: {
      total,
      modelled,
      notModelledByDesign,
      unexplained: unexplained.sort(),
      multiplyDefined: multiplyDefined.sort(),
    },
    identity: { nodesWithSymbol, symbolsWithSeveralNodes: symbolsWithSeveralNodes.sort() },
    locations: { checked, preserved, mismatches: locationMismatches.sort() },
    references: {
      occurrences,
      specifiers,
      moduleSpecifiers,
      external,
      toUnmodelledSymbols,
      reportedUnresolved,
      unresolvedConsistent,
    },
    uses,
    inheritance,
    notComparable: NOT_COMPARABLE,
    consistent:
      unexplained.length === 0 &&
      symbolsWithSeveralNodes.length === 0 &&
      locationMismatches.length === 0 &&
      uses.onlyScip.length === 0 &&
      uses.onlyGraph.length === 0 &&
      inheritance.onlyScip.length === 0 &&
      inheritance.onlyGraph.length === 0 &&
      unresolvedConsistent !== false,
  };
}

function comparePairs(
  scip: ReadonlySet<string>,
  graph: ReadonlySet<string>,
  describe: (pair: string) => string,
): PairComparison {
  const onlyScip = [...scip].filter((pair) => !graph.has(pair)).map(describe).sort();
  const onlyGraph = [...graph].filter((pair) => !scip.has(pair)).map(describe).sort();
  const both = scip.size - onlyScip.length;

  return {
    scip: scip.size,
    graph: graph.size,
    both,
    onlyScip,
    onlyGraph,
    recall: scip.size === 0 ? null : both / scip.size,
    precision: graph.size === 0 ? null : both / graph.size,
  };
}

function isLocal(symbolId: string): boolean {
  return symbolId.startsWith('local ');
}

function size(range: ScipRange): number {
  return (range.endLine - range.startLine) * 100_000 + (range.endCharacter - range.startCharacter);
}

function contains(range: ScipRange, position: { startLine: number; startCharacter: number }): boolean {
  const { startLine: line, startCharacter: character } = position;
  if (line < range.startLine || line > range.endLine) return false;
  if (line === range.startLine && character < range.startCharacter) return false;
  if (line === range.endLine && character >= range.endCharacter) return false;
  return true;
}
