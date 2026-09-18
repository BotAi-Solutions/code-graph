import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerNodeDraft,
  CodeAnalyzer,
  NodeReference,
} from '@ckg/graph';
import { draftRef, nodeRef } from '@ckg/graph';
import { classifyFile } from '@ckg/language-detection';
import { evidence } from '@ckg/shared';
import type { MarkdownDocument, MarkdownHeading } from '../parsers/markdown.js';
import { slugify } from '../parsers/markdown.js';
import { ResourceTree } from '../source/resource-file.js';
import { markdownDocumentFor } from '../source/shared.js';

/**
 * What the repository writes about itself.
 *
 * A README is the only place a repository says *why* it is shaped the way it
 * is, and until now the pipeline could not see it at all. This reads the
 * document's structure — which is unambiguous — and then makes exactly one
 * kind of claim beyond it: that a name written in prose is the thing in the
 * graph that carries that name.
 *
 * ## The rule for a documentation edge
 *
 * A mention becomes a `DOCUMENTS` edge only when **exactly one** node in the
 * whole repository answers to the name. Not the closest match, not the first,
 * not the best-scoring: one, or none. Two classes called `Client` make every
 * mention of `Client` a piece of document text and nothing more.
 *
 * On top of uniqueness, a name written as prose must also be *distinctive* —
 * two or more capitalised words run together, which `AuthService` is and
 * `User` is not. A name written in a code span has already been marked by its
 * author as an identifier and needs no such test.
 *
 * Both together are what separates this from the name-similarity guessing the
 * rest of the pipeline refuses. It is still a resolution step that could be
 * wrong, so every edge it produces is `medium`, never `high`, and the evidence
 * records the file, the line and the name that was matched.
 */

const ANALYZER = 'document-analyzer';

/** Mentions read from one document before the rest are ignored. */
const MAX_MENTIONS_PER_DOCUMENT = 400;
/** Sections promoted from one document. A book-length file is not an outline. */
const MAX_SECTIONS_PER_DOCUMENT = 200;

const DOCUMENT_SUFFIXES = ['.md', '.mdx', '.markdown'] as const;

export class DocumentAnalyzer implements CodeAnalyzer {
  readonly name = ANALYZER;
  /**
   * Classification, not source: a mention resolves against the *whole* graph,
   * including the routes, tables and services the source stage created. A
   * README saying "POST /users is handled by UserController" should reach both,
   * and only this stage can see both.
   */
  readonly stage: AnalysisStage = 'classification';

  supports(context: AnalysisContext): boolean {
    return context.sources.matching(...DOCUMENT_SUFFIXES).length > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const repository = context.symbols.repository();
    const tree = new ResourceTree(repository?.id ?? null, ANALYZER);

    const nodes: AnalyzerNodeDraft[] = [];
    const edges: AnalyzerEdgeDraft[] = [];

    const documents = context.sources.matching(...DOCUMENT_SUFFIXES);

    let sectionCount = 0;
    let mentionCount = 0;
    let resolvedMentionCount = 0;
    let ambiguousMentionCount = 0;
    let linkCount = 0;
    let unresolvedLinkCount = 0;

    // Every path the walk found, so a link can be told from a dead link
    // without touching the disk.
    const knownPaths = new Set(context.sources.all().map((file) => file.relativePath));

    for (const file of documents) {
      const parsed = markdownDocumentFor(context.sources, file.relativePath);
      if (!parsed) continue;

      const classification = classifyFile(file.relativePath);
      const documentRef = tree.file({
        classification,
        type: 'document',
        metadata: {
          ...(parsed.title !== null ? { title: parsed.title } : {}),
          headingCount: parsed.headings.length,
          codeBlockCount: parsed.codeBlocks.length,
          lineCount: parsed.lineCount,
        },
      });

      const sections = this.sections(parsed, documentRef, nodes, edges);
      sectionCount += sections.filter((section) => section !== null).length;

      linkCount += parsed.links.filter((link) => link.kind === 'path').length;
      unresolvedLinkCount += this.links(parsed, documentRef, knownPaths, edges);

      const resolution = this.mentions(context, parsed, documentRef, sections, edges);
      mentionCount += resolution.seen;
      resolvedMentionCount += resolution.resolved;
      ambiguousMentionCount += resolution.ambiguous;
    }

    return {
      nodes: [...tree.nodes(), ...nodes],
      edges: [...tree.edges(), ...edges],
      stats: {
        markdownFileCount: documents.length,
        sectionCount,
        mentionCount,
        resolvedMentionCount,
        // Reported so an operator can see the cost of the uniqueness rule,
        // which is the number this analyzer is most likely to be judged by.
        ambiguousMentionCount,
        linkCount,
        unresolvedLinkCount,
      },
    };
  }

  /**
   * One node per heading, nested the way the headings nest.
   *
   * A section is identified by its slug within its document, which is the same
   * thing that identifies it to a browser following `README.md#login-flow`. A
   * document with two identically-named headings disambiguates the second by
   * its line, because two sections that are genuinely different must not
   * collapse into one node.
   */
  private sections(
    parsed: MarkdownDocument,
    documentRef: NodeReference,
    nodes: AnalyzerNodeDraft[],
    edges: AnalyzerEdgeDraft[],
  ): Array<NodeReference | null> {
    const refs: Array<NodeReference | null> = [];
    const usedSlugs = new Set<string>();

    parsed.headings.forEach((heading, index) => {
      if (index >= MAX_SECTIONS_PER_DOCUMENT) {
        refs.push(null);
        return;
      }

      const draft = sectionDraft(parsed.relativePath, heading, uniqueSlug(heading, usedSlugs));
      nodes.push(draft);

      const ref = draftRef(draft);
      refs.push(ref);

      const parent =
        heading.parentIndex === null ? documentRef : (refs[heading.parentIndex] ?? documentRef);

      edges.push({
        from: parent,
        to: ref,
        relationship: 'CONTAINS',
        evidence: evidence({
          source: ANALYZER,
          basis: 'parsedStructure',
          method: 'markdown',
          file: parsed.relativePath,
          line: heading.line,
          matched: heading.text,
        }),
        metadata: { level: heading.level },
      });
    });

    return refs;
  }

  /**
   * Links from a document to another file in the repository.
   *
   * Only repository-relative links that resolve to a file the walk actually
   * found. An external URL is a fact about the document and is counted, not
   * turned into a node — the graph is about this repository.
   *
   * Returns how many in-repository links pointed at nothing, which is a genuine
   * finding: a README linking to a file that was moved is a broken README.
   */
  private links(
    parsed: MarkdownDocument,
    documentRef: NodeReference,
    knownPaths: ReadonlySet<string>,
    edges: AnalyzerEdgeDraft[],
  ): number {
    let unresolved = 0;

    for (const link of parsed.links) {
      if (link.kind !== 'path' || link.path === null) continue;

      const target = resolveRelative(parsed.relativePath, link.path);
      if (target === null || !knownPaths.has(target)) {
        unresolved += 1;
        continue;
      }
      if (target === parsed.relativePath) continue;

      // The target is a file that exists. Whether it has a *node* is another
      // matter, and the assembler drops the edge if it does not rather than
      // inventing one to point at.
      edges.push({
        from: documentRef,
        to: draftRef({
          type: fileTypeFor(target),
          name: baseNameOf(target),
          symbolKey: target,
          filePath: target,
        }),
        relationship: 'LINKS_TO',
        evidence: evidence({
          source: ANALYZER,
          basis: 'resolvedLink',
          method: 'markdown',
          file: parsed.relativePath,
          line: link.line,
          column: link.column,
          matched: target,
        }),
        metadata: {
          text: link.text,
          target: link.target,
          ...(link.fragment !== null ? { fragment: link.fragment } : {}),
        },
      });
    }

    return unresolved;
  }

  /** Prose and code-span names, resolved against the whole graph or dropped. */
  private mentions(
    context: AnalysisContext,
    parsed: MarkdownDocument,
    documentRef: NodeReference,
    sections: ReadonlyArray<NodeReference | null>,
    edges: AnalyzerEdgeDraft[],
  ): { seen: number; resolved: number; ambiguous: number } {
    let seen = 0;
    let resolved = 0;
    let ambiguous = 0;

    // One edge per (section, target): a README naming `UserService` in four
    // sentences of one section is one documentation relationship, and the
    // accumulator counts the occurrences behind it.
    const emitted = new Set<string>();

    for (const mention of parsed.mentions.slice(0, MAX_MENTIONS_PER_DOCUMENT)) {
      seen += 1;

      const match = context.symbols.uniqueDeclaration(mention.name);
      if (!match) {
        if (context.symbols.countNamed(mention.name) > 1) ambiguous += 1;
        continue;
      }
      // A document is allowed to name the file it is written in.
      if (match.filePath === parsed.relativePath) continue;

      const from =
        mention.headingIndex === null
          ? documentRef
          : (sections[mention.headingIndex] ?? documentRef);

      const key = `${String(mention.headingIndex)}:${match.id}`;
      if (emitted.has(key)) continue;
      emitted.add(key);

      resolved += 1;
      edges.push({
        from,
        to: nodeRef(match.id),
        relationship: 'DOCUMENTS',
        evidence: evidence({
          source: ANALYZER,
          basis: 'uniqueNameMatch',
          method: 'markdown',
          file: parsed.relativePath,
          line: mention.line,
          column: mention.column,
          matched: mention.name,
        }),
        metadata: { form: mention.form, targetType: match.type },
      });
    }

    return { seen, resolved, ambiguous };
  }
}

function sectionDraft(
  relativePath: string,
  heading: MarkdownHeading,
  slug: string,
): AnalyzerNodeDraft {
  return {
    type: 'document_section',
    name: heading.text,
    symbolKey: `${relativePath}#${slug}`,
    qualifiedName: `${relativePath}#${slug}`,
    filePath: relativePath,
    startLine: heading.line,
    endLine: heading.endLine,
    metadata: { level: heading.level, slug },
  };
}

function uniqueSlug(heading: MarkdownHeading, used: Set<string>): string {
  const base = heading.slug.length > 0 ? heading.slug : slugify(heading.text) || 'section';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  // The line, not a counter: a counter changes when a heading is inserted
  // above, and every downstream id would change with it.
  const disambiguated = `${base}-l${String(heading.line)}`;
  used.add(disambiguated);
  return disambiguated;
}

/**
 * The node type that stands for a linked file.
 *
 * Must agree with whichever analyzer owns that file, or the reference resolves
 * to an id nothing created and the edge is dropped. Kept in one place here so
 * the agreement is visible rather than implied.
 */
function fileTypeFor(path: string): 'file' | 'document' | 'config' | 'api_spec' {
  const classification = classifyFile(path);
  if (classification.category === 'document') return 'document';
  if (classification.role === 'api-spec' || classification.role === 'json-schema') {
    return 'api_spec';
  }
  if (classification.category === 'configuration') return 'config';
  return 'file';
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const NUL = String.fromCharCode(0);

/**
 * Resolves a link target against the document that wrote it.
 *
 * Returns null for anything that climbs out of the repository, which a
 * repository-relative link has no business doing and which must never become a
 * path the rest of the pipeline trusts.
 */
export function resolveRelative(from: string, target: string): string | null {
  const decoded = safeDecode(target);
  if (decoded.includes(NUL)) return null;

  const base = decoded.startsWith('/') ? [] : from.split('/').slice(0, -1);
  const segments = [...base, ...decoded.replace(/^\//, '').split('/')];
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.length === 0 ? null : resolved.join('/');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
