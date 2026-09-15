import type { ScipSymbolDescriptor, ScipSymbolKind } from '../types/index.js';

/**
 * `SymbolInformation.Kind` (scip.proto) -> our normalised vocabulary.
 *
 * The SCIP enum is deliberately language-specific; collapsing it here is the
 * single place where "Ruby singleton method" and "C# static method" become the
 * same graph concept. Unlisted values fall through to descriptor-based
 * inference, which is what happens for indexers that leave `kind` unset.
 */
const KIND_BY_ENUM_VALUE: ReadonlyMap<number, ScipSymbolKind> = new Map([
  [1, 'type'], // Array
  [3, 'type'], // AssociatedType
  [4, 'property'], // Attribute
  [6, 'type'], // Boolean
  [7, 'class'], // Class
  [8, 'constant'], // Constant
  [9, 'constructor'], // Constructor
  [11, 'enum'], // Enum
  [12, 'enum-member'], // EnumMember
  [13, 'property'], // Event
  [15, 'field'], // Field
  [16, 'file'], // File
  [17, 'function'], // Function
  [18, 'accessor'], // Getter
  [20, 'variable'], // Instance
  [21, 'interface'], // Interface
  [25, 'macro'], // Macro
  [26, 'method'], // Method
  [28, 'type'], // Message
  [29, 'module'], // Module
  [30, 'namespace'], // Namespace
  [32, 'type'], // Number
  [33, 'variable'], // Object
  [34, 'method'], // Operator
  [35, 'package'], // Package
  [36, 'module'], // PackageObject
  [37, 'parameter'], // Parameter
  [38, 'parameter'], // ParameterLabel
  [41, 'property'], // Property
  [42, 'interface'], // Protocol
  [44, 'parameter'], // SelfParameter
  [45, 'accessor'], // Setter
  [46, 'type'], // Signature
  [47, 'type'], // String
  [48, 'struct'], // Struct
  [52, 'parameter'], // ThisParameter
  [53, 'trait'], // Trait
  [54, 'method'], // TraitMethod
  [55, 'type'], // Type
  [56, 'type'], // TypeAlias
  [57, 'interface'], // TypeClass
  [58, 'method'], // TypeClassMethod
  [60, 'type-parameter'], // TypeParameter
  [61, 'type'], // Union
  [62, 'interface'], // Contract
  [64, 'package'], // Library
  [66, 'method'], // AbstractMethod
  [67, 'method'], // MethodSpecification
  [68, 'method'], // ProtocolMethod
  [69, 'method'], // PureVirtualMethod
  [70, 'variable'], // Variable
  [71, 'type'], // Void
  [72, 'accessor'], // Accessor
  [73, 'class'], // Delegate
  [74, 'method'], // MethodAlias
  [75, 'class'], // SingletonClass
  [76, 'method'], // SingletonMethod
  [77, 'field'], // StaticDataMember
  [78, 'property'], // StaticEvent
  [79, 'field'], // StaticField
  [80, 'method'], // StaticMethod
  [81, 'property'], // StaticProperty
  [82, 'variable'], // StaticVariable
  [83, 'constant'], // Value
]);

/**
 * Descriptor-based inference, used when the indexer leaves `kind` unspecified —
 * which is the common case (scip-typescript 0.4 sets it on no symbol at all).
 *
 * The descriptor *chain* carries more information than the leaf alone: a
 * `method` descriptor owned by a `type` descriptor is a method, whereas the
 * same descriptor owned by a namespace is a free function. All of this is
 * derived from the SCIP grammar, so it holds for every language.
 */
function inferFromDescriptors(descriptors: readonly ScipSymbolDescriptor[]): ScipSymbolKind {
  const leaf = descriptors.at(-1);
  if (!leaf) return 'unknown';

  const ownerSuffix = descriptors.at(-2)?.suffix;
  const ownedByType = ownerSuffix === 'type';

  switch (leaf.suffix) {
    case 'method':
      if (leaf.name === '<constructor>' || leaf.name === 'constructor') return 'constructor';
      return ownedByType ? 'method' : 'function';
    case 'term':
      return ownedByType ? 'property' : 'variable';
    case 'type':
      // class / interface / enum / type-alias are indistinguishable at this
      // level; a language adapter refines it (see adapters/).
      return 'class';
    case 'namespace':
      return isFileLikeName(leaf.name) ? 'file' : 'namespace';
    case 'type-parameter':
      return 'type-parameter';
    case 'parameter':
      return 'parameter';
    case 'macro':
      return 'macro';
    case 'local':
      return 'variable';
    case 'meta':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Namespace descriptors double as file scopes in file-based languages. */
function isFileLikeName(name: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(name);
}

export function normalizeSymbolKind(
  enumValue: number,
  descriptors: readonly ScipSymbolDescriptor[],
): ScipSymbolKind {
  const mapped = KIND_BY_ENUM_VALUE.get(enumValue);
  if (mapped) return mapped;
  return inferFromDescriptors(descriptors);
}

/** Bit flags from `Occurrence.symbol_roles`. */
export const SYMBOL_ROLE = {
  Definition: 0x1,
  Import: 0x2,
  WriteAccess: 0x4,
  ReadAccess: 0x8,
  Generated: 0x10,
  Test: 0x20,
  ForwardDefinition: 0x40,
} as const;
