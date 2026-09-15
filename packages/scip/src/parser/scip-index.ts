import { BinaryReader, WireType, type WireTypeValue } from './protobuf.js';
import { normalizeSymbolKind, SYMBOL_ROLE } from './kinds.js';
import { parseScipSymbol, symbolDisplayName } from './symbol.js';
import type {
  ScipDocument,
  ScipIndex,
  ScipMetadata,
  ScipOccurrence,
  ScipRange,
  ScipRelationship,
  ScipSymbol,
  ScipToolInfo,
} from '../types/index.js';

/**
 * Decodes `index.scip` straight into our internal representation.
 *
 * Field numbers below come from scip.proto (Sourcegraph, Apache-2.0). Unknown
 * fields are skipped rather than rejected, so an index produced by a newer
 * indexer still parses.
 */

export class ScipParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScipParseError';
  }
}

/** SCIP ranges are `[startLine, startChar, endLine, endChar]`, or 3 entries
 *  when the range is single-line: `[line, startChar, endChar]`. */
function toRange(values: readonly number[]): ScipRange | null {
  if (values.length === 3) {
    const [line, startCharacter, endCharacter] = values as [number, number, number];
    return { startLine: line, startCharacter, endLine: line, endCharacter };
  }
  if (values.length >= 4) {
    const [startLine, startCharacter, endLine, endCharacter] = values as [
      number,
      number,
      number,
      number,
    ];
    return { startLine, startCharacter, endLine, endCharacter };
  }
  return null;
}

function decodeToolInfo(reader: BinaryReader): ScipToolInfo {
  let name = '';
  let version = '';

  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        name = reader.readString();
        break;
      case 2:
        version = reader.readString();
        break;
      default:
        reader.skipField(wireType);
    }
  }

  return { name, version };
}

function decodeMetadata(reader: BinaryReader): ScipMetadata {
  let protocolVersion = 0;
  let projectRoot = '';
  let toolInfo: ScipToolInfo = { name: '', version: '' };

  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        protocolVersion = reader.readInt32();
        break;
      case 2:
        toolInfo = decodeToolInfo(reader.readMessage());
        break;
      case 3:
        projectRoot = reader.readString();
        break;
      default:
        reader.skipField(wireType);
    }
  }

  return { protocolVersion, projectRoot, toolInfo };
}

function decodeRelationship(reader: BinaryReader): ScipRelationship {
  const relationship: ScipRelationship = {
    symbolId: '',
    isReference: false,
    isImplementation: false,
    isTypeDefinition: false,
    isDefinition: false,
  };

  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        relationship.symbolId = reader.readString();
        break;
      case 2:
        relationship.isReference = reader.readBool();
        break;
      case 3:
        relationship.isImplementation = reader.readBool();
        break;
      case 4:
        relationship.isTypeDefinition = reader.readBool();
        break;
      case 5:
        relationship.isDefinition = reader.readBool();
        break;
      default:
        reader.skipField(wireType);
    }
  }

  return relationship;
}

/** `SignatureDocumentation` is a Document; we only want its text. */
function decodeSignatureText(reader: BinaryReader): string | undefined {
  let text: string | undefined;
  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 5) {
      text = reader.readString();
      continue;
    }
    reader.skipField(wireType);
  }
  return text;
}

function decodeSymbolInformation(reader: BinaryReader): ScipSymbol {
  let symbolId = '';
  let displayName = '';
  let kindValue = 0;
  let signature: string | undefined;
  let enclosingSymbolId: string | undefined;
  const documentation: string[] = [];
  const relationships: ScipRelationship[] = [];

  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        symbolId = reader.readString();
        break;
      case 3:
        documentation.push(reader.readString());
        break;
      case 4:
        relationships.push(decodeRelationship(reader.readMessage()));
        break;
      case 5:
        kindValue = reader.readInt32();
        break;
      case 6:
        displayName = reader.readString();
        break;
      case 7:
        signature = decodeSignatureText(reader.readMessage());
        break;
      case 8:
        enclosingSymbolId = reader.readString();
        break;
      default:
        reader.skipField(wireType);
    }
  }

  const identity = parseScipSymbol(symbolId);
  const kind = normalizeSymbolKind(kindValue, identity.descriptors);

  const symbol: ScipSymbol = {
    id: symbolId,
    name: displayName || symbolDisplayName(identity),
    kind,
    relationships,
    identity,
  };

  if (signature) symbol.signature = signature;
  if (documentation.length > 0) symbol.documentation = documentation;
  if (enclosingSymbolId) symbol.enclosingSymbolId = enclosingSymbolId;

  return symbol;
}

function decodeOccurrence(reader: BinaryReader): ScipOccurrence | null {
  const range: number[] = [];
  const enclosingRangeValues: number[] = [];
  let symbolId = '';
  let roles = 0;

  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        reader.readPackedInt32(wireType as WireTypeValue, range);
        break;
      case 2:
        symbolId = reader.readString();
        break;
      case 3:
        roles = reader.readInt32();
        break;
      case 7:
        reader.readPackedInt32(wireType as WireTypeValue, enclosingRangeValues);
        break;
      default:
        reader.skipField(wireType);
    }
  }

  const span = toRange(range);
  if (!span || symbolId === '') return null;

  const occurrence: ScipOccurrence = {
    ...span,
    symbolId,
    isDefinition: (roles & SYMBOL_ROLE.Definition) !== 0,
    isImport: (roles & SYMBOL_ROLE.Import) !== 0,
    isWriteAccess: (roles & SYMBOL_ROLE.WriteAccess) !== 0,
    isReadAccess: (roles & SYMBOL_ROLE.ReadAccess) !== 0,
  };

  const enclosing = toRange(enclosingRangeValues);
  if (enclosing) occurrence.enclosingRange = enclosing;

  return occurrence;
}

function decodeDocument(reader: BinaryReader): ScipDocument {
  let relativePath = '';
  let language = '';
  const occurrences: ScipOccurrence[] = [];
  const symbols: ScipSymbol[] = [];

  while (reader.hasMore()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        relativePath = reader.readString();
        break;
      case 2: {
        const occurrence = decodeOccurrence(reader.readMessage());
        if (occurrence) occurrences.push(occurrence);
        break;
      }
      case 3:
        symbols.push(decodeSymbolInformation(reader.readMessage()));
        break;
      case 4:
        language = reader.readString();
        break;
      default:
        // Field 5 is the document's full source text. We deliberately skip it:
        // source code must never enter the graph, the logs or the database.
        reader.skipField(wireType);
    }
  }

  return { relativePath: normalizePath(relativePath), language, symbols, occurrences };
}

/** SCIP paths are POSIX-relative; normalise separators defensively. */
function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function parseScipIndex(bytes: Uint8Array): ScipIndex {
  const reader = new BinaryReader(bytes);

  let metadata: ScipMetadata = {
    protocolVersion: 0,
    projectRoot: '',
    toolInfo: { name: '', version: '' },
  };
  const documents: ScipDocument[] = [];
  const externalSymbols: ScipSymbol[] = [];

  try {
    while (reader.hasMore()) {
      const { fieldNumber, wireType } = reader.readTag();
      switch (fieldNumber) {
        case 1:
          metadata = decodeMetadata(reader.readMessage());
          break;
        case 2:
          documents.push(decodeDocument(reader.readMessage()));
          break;
        case 3:
          externalSymbols.push(decodeSymbolInformation(reader.readMessage()));
          break;
        default:
          reader.skipField(wireType as WireTypeValue);
      }
    }
  } catch (error) {
    throw new ScipParseError(
      `failed to parse SCIP index: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // Deterministic order: the graph builder relies on stable iteration to
  // produce identical output for identical input.
  documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { metadata, documents, externalSymbols };
}

export { WireType };
