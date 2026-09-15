export { BinaryReader, ProtobufParseError, WireType } from './protobuf.js';
export { normalizeSymbolKind, SYMBOL_ROLE } from './kinds.js';
export { parseScipIndex, ScipParseError } from './scip-index.js';
export {
  leafDescriptor,
  ownerSymbolId,
  parseDescriptors,
  parseScipSymbol,
  ScipSymbolParseError,
  symbolDisplayName,
} from './symbol.js';
export { readScipIndexFile } from './read-file.js';
export { inferDocumentLanguages } from './infer-language.js';
