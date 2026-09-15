import type {
  ScipDescriptorSuffix,
  ScipSymbolDescriptor,
  ScipSymbolIdentity,
} from '../types/index.js';

/**
 * Parser for the SCIP symbol grammar:
 *
 *   <symbol>     ::= <scheme> ' ' <manager> ' ' <package> ' ' <version> ' ' {<descriptor>}
 *   <descriptor> ::= <name> '/'  | <name> '#' | <name> '.' | <name> '(' <disambiguator> ').'
 *                  | '[' <name> ']' | '(' <name> ')' | <name> ':' | <name> '!'
 *   <name>       ::= <identifier> | '`' <escaped> '`'
 *
 * Symbol strings are the only identifier SCIP guarantees to be stable across
 * runs, which makes them the backbone of our deterministic node ids.
 */

const SUFFIX_BY_CHARACTER: Record<string, ScipDescriptorSuffix> = {
  '/': 'namespace',
  '#': 'type',
  '.': 'term',
  ':': 'meta',
  '!': 'macro',
};

export class ScipSymbolParseError extends Error {
  constructor(message: string, readonly symbol: string) {
    super(`${message}: ${symbol}`);
    this.name = 'ScipSymbolParseError';
  }
}

/** Splits on spaces while honouring backtick escaping. */
function splitHeader(symbol: string): { parts: string[]; descriptorStart: number } {
  const parts: string[] = [];
  let current = '';
  let index = 0;
  let inEscape = false;

  while (index < symbol.length && parts.length < 4) {
    const character = symbol[index] as string;

    if (character === '`') {
      inEscape = !inEscape;
      current += character;
      index += 1;
      continue;
    }

    if (character === ' ' && !inEscape) {
      parts.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  return { parts, descriptorStart: index };
}

/** Reads a (possibly backtick-escaped) name starting at `index`. */
function readName(symbol: string, index: number, terminators: string): { name: string; next: number } {
  if (symbol[index] === '`') {
    let cursor = index + 1;
    let name = '';
    while (cursor < symbol.length) {
      if (symbol[cursor] === '`') {
        // A doubled backtick is a literal backtick.
        if (symbol[cursor + 1] === '`') {
          name += '`';
          cursor += 2;
          continue;
        }
        return { name, next: cursor + 1 };
      }
      name += symbol[cursor];
      cursor += 1;
    }
    throw new ScipSymbolParseError('unterminated backtick-escaped name', symbol);
  }

  let cursor = index;
  let name = '';
  while (cursor < symbol.length && !terminators.includes(symbol[cursor] as string)) {
    name += symbol[cursor];
    cursor += 1;
  }
  return { name, next: cursor };
}

interface PositionedDescriptor extends ScipSymbolDescriptor {
  /** Offset of this descriptor within the full symbol string. */
  start: number;
}

function parseDescriptorsWithPositions(symbol: string, start: number): PositionedDescriptor[] {
  const descriptors: PositionedDescriptor[] = [];
  let index = start;

  while (index < symbol.length) {
    const descriptorStart = index;
    const character = symbol[index] as string;

    // `[T]` type parameter and `(p)` parameter are bracketed, name-first forms.
    if (character === '[' || character === '(') {
      const closing = character === '[' ? ']' : ')';
      const { name, next } = readName(symbol, index + 1, closing);
      if (symbol[next] !== closing) {
        throw new ScipSymbolParseError(`expected "${closing}"`, symbol);
      }
      descriptors.push({
        name,
        suffix: character === '[' ? 'type-parameter' : 'parameter',
        start: descriptorStart,
      });
      index = next + 1;
      continue;
    }

    const { name, next } = readName(symbol, index, '/#.:!()[]');
    const terminator = symbol[next];

    if (terminator === '(') {
      // Method: name '(' disambiguator ').'
      const disambiguator = readName(symbol, next + 1, ')');
      if (symbol[disambiguator.next] !== ')' || symbol[disambiguator.next + 1] !== '.') {
        throw new ScipSymbolParseError('malformed method descriptor', symbol);
      }
      const descriptor: PositionedDescriptor = { name, suffix: 'method', start: descriptorStart };
      if (disambiguator.name) descriptor.disambiguator = disambiguator.name;
      descriptors.push(descriptor);
      index = disambiguator.next + 2;
      continue;
    }

    const suffix = terminator ? SUFFIX_BY_CHARACTER[terminator] : undefined;
    if (!suffix) {
      throw new ScipSymbolParseError(
        `unexpected descriptor terminator "${terminator ?? '<end>'}"`,
        symbol,
      );
    }

    descriptors.push({ name, suffix, start: descriptorStart });
    index = next + 1;
  }

  if (index !== symbol.length) {
    throw new ScipSymbolParseError('trailing characters after descriptors', symbol);
  }

  return descriptors;
}

export function parseDescriptors(symbol: string, start: number): ScipSymbolDescriptor[] {
  return parseDescriptorsWithPositions(symbol, start).map(({ start: _start, ...rest }) => rest);
}

/**
 * Parses a SCIP symbol string. Malformed symbols are not fatal — an indexer
 * bug should degrade one node, not fail the whole analysis — so the caller gets
 * a best-effort identity with an empty descriptor list.
 */
export function parseScipSymbol(symbol: string): ScipSymbolIdentity {
  if (symbol.startsWith('local ')) {
    return {
      id: symbol,
      scheme: 'local',
      packageManager: '',
      packageName: '',
      packageVersion: '',
      descriptors: [{ name: symbol.slice('local '.length), suffix: 'local' }],
      ownerId: null,
      isLocal: true,
    };
  }

  const { parts, descriptorStart } = splitHeader(symbol);
  const [scheme = '', packageManager = '', packageName = '', packageVersion = ''] = parts;

  let positioned: PositionedDescriptor[] = [];
  try {
    positioned = parseDescriptorsWithPositions(symbol, descriptorStart);
  } catch {
    positioned = [];
  }

  // The owner is everything up to the final descriptor: for `pkg \`a.ts\`/C#m().`
  // that is `pkg \`a.ts\`/C#`, which is itself a valid SCIP symbol.
  const leaf = positioned.at(-1);
  const ownerId =
    positioned.length >= 2 && leaf !== undefined ? symbol.slice(0, leaf.start) : null;

  return {
    id: symbol,
    scheme,
    packageManager,
    packageName: unescapeName(packageName),
    packageVersion,
    descriptors: positioned.map(({ start: _start, ...rest }) => rest),
    ownerId,
    isLocal: false,
  };
}

function unescapeName(value: string): string {
  if (!value.startsWith('`')) return value;
  return value.slice(1, -1).replaceAll('``', '`');
}

/** The trailing descriptor, which is what the symbol actually names. */
export function leafDescriptor(identity: ScipSymbolIdentity): ScipSymbolDescriptor | undefined {
  return identity.descriptors.at(-1);
}

/**
 * Display name for a symbol. Falls back through the descriptor chain, then to
 * the package name, and finally to the raw symbol so nothing is ever unnamed.
 */
export function symbolDisplayName(identity: ScipSymbolIdentity): string {
  const leaf = leafDescriptor(identity);
  if (leaf?.name) return leaf.name;
  if (identity.packageName) return identity.packageName;
  return identity.id;
}

/**
 * The SCIP symbol that lexically owns this one, e.g. the class `A#` for the
 * method `A#b().`. Derived from the symbol string rather than from
 * `enclosing_symbol`, which not every indexer emits.
 */
export function ownerSymbolId(identity: ScipSymbolIdentity): string | null {
  return identity.ownerId;
}
