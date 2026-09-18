/**
 * Markdown, read for structure rather than rendered.
 *
 * A focused CommonMark subset: front matter, fenced code blocks, ATX headings,
 * inline code spans and inline links. That is the whole list, and it is short
 * on purpose — the graph wants to know how a document is organised and what it
 * names, not how to draw it. Everything a renderer needs and a graph does not
 * (emphasis, tables, block quotes, HTML) passes through as prose.
 *
 * Two decisions are worth stating because they change what the graph believes:
 *
 * - **Fenced code is not prose.** A fence is tracked before anything else, so a
 *   `# comment` inside a shell block is never a heading and a class name inside
 *   an example is never a prose mention. Getting this wrong would fill a graph
 *   with sections that do not exist.
 * - **Setext headings are not supported.** `---` under a line is also a
 *   thematic break and also closes front matter, and a parser that guesses
 *   between the three will eventually guess wrong. ATX (`## Heading`) is what
 *   the subset recognises, and a document using setext simply has fewer
 *   sections rather than wrong ones.
 */

export interface MarkdownHeading {
  /** 1 for `#`, 6 for `######`. */
  level: number;
  text: string;
  /** Anchor slug, as GitHub derives one. Used to resolve `#fragment` links. */
  slug: string;
  /** 1-based line the heading is written on. */
  line: number;
  /** Last line of the section this heading owns, inclusive. */
  endLine: number;
  /** Index into `headings` of the nearest enclosing heading, or null. */
  parentIndex: number | null;
}

export interface MarkdownCodeBlock {
  /** The fence's info string, lower-cased: `ts`, `bash`, or null. */
  language: string | null;
  /** 1-based line of the opening fence. */
  line: number;
  endLine: number;
  text: string;
}

export type MarkdownLinkKind = 'path' | 'anchor' | 'external';

export interface MarkdownLink {
  text: string;
  /** The raw target, exactly as written. */
  target: string;
  kind: MarkdownLinkKind;
  /** For a `path` link: the target with any `#fragment` and `?query` removed. */
  path: string | null;
  /** The `#fragment`, without the hash, when there is one. */
  fragment: string | null;
  line: number;
  column: number;
}

export type MentionForm = 'code-span' | 'prose';

export interface MarkdownMention {
  /** The name as written, without backticks or a trailing `()`. */
  name: string;
  form: MentionForm;
  line: number;
  column: number;
  /** Index into `headings` of the section it appears in, or null. */
  headingIndex: number | null;
}

export interface MarkdownDocument {
  relativePath: string;
  /** The first level-1 heading, or null. */
  title: string | null;
  headings: MarkdownHeading[];
  codeBlocks: MarkdownCodeBlock[];
  links: MarkdownLink[];
  mentions: MarkdownMention[];
  /** Lines in the document. */
  lineCount: number;
  /** True when a `---` front-matter block opened the file. */
  hasFrontMatter: boolean;
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*(\S*)/;
const ATX_HEADING = /^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/;
const INLINE_LINK = /\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/**
 * A name distinctive enough that finding it in prose means something.
 *
 * Two or more capitalised words run together (`AuthService`, `UserRepository`),
 * or a dotted member of one (`UserService.create`). A single word — `User`,
 * `Config`, `Server` — is deliberately excluded however well it matches a
 * class: those are English, and matching them is exactly the guessing this
 * pipeline refuses to do.
 */
const DISTINCTIVE_NAME = /\b([A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)(?:\.([A-Za-z_$][\w$]*))?\b/g;

/** Inside a code span, a single word or a dotted path is enough. */
const CODE_SPAN_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

export function parseMarkdown(relativePath: string, text: string): MarkdownDocument {
  const lines = text.split('\n');

  const headings: MarkdownHeading[] = [];
  const codeBlocks: MarkdownCodeBlock[] = [];
  const links: MarkdownLink[] = [];
  const mentions: MarkdownMention[] = [];

  let index = 0;
  let hasFrontMatter = false;

  // Front matter: only when `---` is the very first line. Anywhere else it is a
  // thematic break, and treating it as front matter would swallow the document.
  if (lines[0]?.trim() === '---') {
    let end = 1;
    while (end < lines.length && lines[end]?.trim() !== '---') end += 1;
    if (end < lines.length) {
      hasFrontMatter = true;
      index = end + 1;
    }
  }

  let openFence: { marker: string; language: string | null; line: number; body: string[] } | null =
    null;

  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    const fence = FENCE.exec(line);

    if (openFence) {
      // A fence closes only with the same character, and at least as long.
      if (
        fence &&
        fence[2] !== undefined &&
        fence[2][0] === openFence.marker[0] &&
        fence[2].length >= openFence.marker.length &&
        (fence[3] ?? '') === ''
      ) {
        codeBlocks.push({
          language: openFence.language,
          line: openFence.line,
          endLine: lineNumber,
          text: openFence.body.join('\n'),
        });
        openFence = null;
        continue;
      }
      openFence.body.push(line);
      continue;
    }

    if (fence && fence[2] !== undefined) {
      const info = (fence[3] ?? '').toLowerCase();
      openFence = {
        marker: fence[2],
        language: info === '' ? null : info,
        line: lineNumber,
        body: [],
      };
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading?.[2] !== undefined && heading[3] !== undefined) {
      const level = heading[2].length;
      const headingText = stripInline(heading[3]);
      headings.push({
        level,
        text: headingText,
        slug: slugify(headingText),
        line: lineNumber,
        // Fixed up once the next heading at this level or above is found.
        endLine: lines.length,
        parentIndex: null,
      });
      continue;
    }

    collectLinks(line, lineNumber, links);
    collectMentions(line, lineNumber, mentions);
  }

  // An unterminated fence still holds real content, and a document that ends
  // mid-example is common enough that dropping it would lose sections.
  if (openFence) {
    codeBlocks.push({
      language: openFence.language,
      line: openFence.line,
      endLine: lines.length,
      text: openFence.body.join('\n'),
    });
  }

  closeSections(headings, lines.length);
  assignParents(headings);
  assignSections(mentions, headings);

  return {
    relativePath,
    title: headings.find((entry) => entry.level === 1)?.text ?? null,
    headings,
    codeBlocks,
    links,
    mentions,
    lineCount: lines.length,
    hasFrontMatter,
  };
}

/** A section runs until the next heading at the same level or shallower. */
function closeSections(headings: MarkdownHeading[], lastLine: number): void {
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!heading) continue;

    let end = lastLine;
    for (let j = i + 1; j < headings.length; j += 1) {
      const next = headings[j];
      if (next && next.level <= heading.level) {
        end = next.line - 1;
        break;
      }
    }
    heading.endLine = Math.max(heading.line, end);
  }
}

function assignParents(headings: MarkdownHeading[]): void {
  const stack: number[] = [];

  headings.forEach((heading, index) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const candidate = top === undefined ? undefined : headings[top];
      if (candidate && candidate.level < heading.level) break;
      stack.pop();
    }
    heading.parentIndex = stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
    stack.push(index);
  });
}

function assignSections(mentions: MarkdownMention[], headings: MarkdownHeading[]): void {
  for (const mention of mentions) {
    let best: number | null = null;
    // The innermost section whose range covers the line: headings are in
    // document order, so the last one that starts at or before it wins.
    headings.forEach((heading, index) => {
      if (heading.line <= mention.line && mention.line <= heading.endLine) best = index;
    });
    mention.headingIndex = best;
  }
}

function collectLinks(line: string, lineNumber: number, into: MarkdownLink[]): void {
  for (const match of line.matchAll(INLINE_LINK)) {
    const target = match[2];
    if (target === undefined || target.length === 0) continue;

    into.push({
      text: stripInline(match[1] ?? ''),
      target,
      ...classifyTarget(target),
      line: lineNumber,
      column: match.index ?? 0,
    });
  }
}

function classifyTarget(target: string): Pick<MarkdownLink, 'kind' | 'path' | 'fragment'> {
  if (target.startsWith('#')) {
    return { kind: 'anchor', path: null, fragment: target.slice(1) };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
    return { kind: 'external', path: null, fragment: null };
  }

  const hash = target.indexOf('#');
  const fragment = hash === -1 ? null : target.slice(hash + 1);
  const withoutFragment = hash === -1 ? target : target.slice(0, hash);
  const query = withoutFragment.indexOf('?');
  const path = query === -1 ? withoutFragment : withoutFragment.slice(0, query);

  if (path.length === 0) return { kind: 'anchor', path: null, fragment };
  return { kind: 'path', path, fragment };
}

/**
 * Names this line mentions.
 *
 * Code spans first, because a span is an explicit claim that the text is an
 * identifier; then prose, over the line with its spans blanked out so the same
 * name is never reported twice for one occurrence.
 */
function collectMentions(line: string, lineNumber: number, into: MarkdownMention[]): void {
  let prose = line;

  for (const match of line.matchAll(CODE_SPAN)) {
    const body = (match[2] ?? '').trim();
    const column = match.index ?? 0;

    if (CODE_SPAN_NAME.test(body)) {
      into.push({
        name: body.endsWith('()') ? body.slice(0, -2) : body,
        form: 'code-span',
        line: lineNumber,
        column,
        headingIndex: null,
      });
    }

    prose = `${prose.slice(0, column)}${' '.repeat(match[0].length)}${prose.slice(column + match[0].length)}`;
  }

  // Links carry their own targets; their display text is prose and is left in.
  for (const match of prose.matchAll(DISTINCTIVE_NAME)) {
    const head = match[1];
    if (head === undefined) continue;

    const member = match[2];
    into.push({
      name: member === undefined ? head : `${head}.${member}`,
      form: 'prose',
      line: lineNumber,
      column: match.index ?? 0,
      headingIndex: null,
    });
  }
}

/** Removes the inline markup a heading or link label may carry. */
function stripInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .trim();
}

/**
 * GitHub's anchor slug: lower-cased, punctuation dropped, spaces to hyphens.
 * Exact enough to resolve the `#fragment` links a repository writes about
 * itself, which is the only thing it is used for.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
