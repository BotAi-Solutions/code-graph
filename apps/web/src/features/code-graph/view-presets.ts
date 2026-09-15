import type { CodeNodeType, CodeRelationship } from '../../types/index.js';

/**
 * Named starting points for the filters.
 *
 * A repository graph answers several different questions and they want
 * different slices of it. Presets are just filter combinations — nothing here
 * is a separate code path — but they save a new user from having to guess which
 * of ten node types and six relationships they need.
 */
export interface ViewPreset {
  id: string;
  label: string;
  title: string;
  nodeTypes: CodeNodeType[];
  relationships: CodeRelationship[];
}

/**
 * The view a project opens on.
 *
 * Not "everything": an unfiltered overview of a real repository is a hairball
 * of methods and variables, and a hairball is not an introduction. Architecture
 * answers the question someone actually arrives with — how is this system put
 * together — and every other view is one click away.
 */
export const DEFAULT_PRESET_ID = 'architecture';

export const VIEW_PRESETS: ViewPreset[] = [
  {
    id: 'everything',
    label: 'Everything',
    title: 'No filters: every node type and relationship',
    nodeTypes: [],
    relationships: [],
  },
  {
    id: 'architecture',
    label: 'Architecture',
    title: 'Types and the behaviour between them — how the system is composed',
    nodeTypes: ['class', 'interface', 'type'],
    relationships: ['CALLS', 'REFERENCES', 'IMPLEMENTS', 'EXTENDS'],
  },
  {
    id: 'calls',
    label: 'Call graph',
    title: 'Functions and methods, and what calls what',
    nodeTypes: ['class', 'interface', 'function', 'method'],
    relationships: ['CALLS'],
  },
  {
    id: 'files',
    label: 'Files',
    title: 'The source tree and its file-level dependencies',
    nodeTypes: ['repository', 'directory', 'file', 'module'],
    relationships: ['CONTAINS', 'IMPORTS'],
  },
];

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Which preset the current filters correspond to, if any. */
export function matchPreset(
  nodeTypes: readonly CodeNodeType[],
  relationships: readonly CodeRelationship[],
): string | null {
  return (
    VIEW_PRESETS.find(
      (preset) =>
        sameSet(preset.nodeTypes, nodeTypes) && sameSet(preset.relationships, relationships),
    )?.id ?? null
  );
}

export function defaultPreset(): ViewPreset {
  const preset = VIEW_PRESETS.find((candidate) => candidate.id === DEFAULT_PRESET_ID);
  if (!preset) throw new Error(`unknown default preset: ${DEFAULT_PRESET_ID}`);
  return preset;
}
