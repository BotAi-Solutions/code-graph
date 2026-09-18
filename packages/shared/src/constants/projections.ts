import type { CodeNodeType, CodeRelationship } from '../types/graph.js';

/**
 * Graph projections: named slices of the one graph.
 *
 * A repository graph answers several different questions and each wants a
 * different slice. A projection is a filter definition plus a ranking hint —
 * *not* a separate graph, a separate table or a separate code path. Both the
 * API and the UI read these definitions, so the "Architecture" button in the
 * toolbar and `?projection=architecture` on the wire mean exactly the same
 * thing.
 */
export const GRAPH_PROJECTION_IDS = [
  'everything',
  'architecture',
  'calls',
  'files',
  'dependencies',
  'dataflow',
  'documentation',
  'apis',
  'configuration',
  'data',
  'cross-source',
] as const;

export type GraphProjectionId = (typeof GRAPH_PROJECTION_IDS)[number];

export interface GraphProjection {
  id: GraphProjectionId;
  label: string;
  /** One line explaining what question the projection answers. */
  title: string;
  /** Empty means "no node-type filter". */
  nodeTypes: CodeNodeType[];
  /** Empty means "no relationship filter". */
  relationships: CodeRelationship[];
  /**
   * Node types the overview ranks first when this projection is active. Degree
   * alone would surface whichever class happens to be busiest; for an
   * architecture view the API routes and the data stores are the point.
   */
  priorityNodeTypes: CodeNodeType[];
}

export const GRAPH_PROJECTIONS: readonly GraphProjection[] = [
  {
    id: 'everything',
    label: 'Everything',
    title: 'No filters: every node type and relationship',
    nodeTypes: [],
    relationships: [],
    priorityNodeTypes: [],
  },
  {
    id: 'architecture',
    label: 'Architecture',
    title: 'APIs, services, data stores and the behaviour between them',
    nodeTypes: [
      'api',
      'api_endpoint',
      'service',
      'external_service',
      'database',
      'table',
      'queue',
      'event',
      'container',
      'config',
      'class',
      'interface',
    ],
    relationships: [
      'ROUTES_TO',
      'IMPLEMENTED_BY',
      'CALLS',
      'USES',
      'READS_FROM',
      'WRITES_TO',
      'PUBLISHES',
      'SUBSCRIBES',
      'DEPENDS_ON_SERVICE',
      'CONFIGURED_BY',
      'AUTHENTICATED_BY',
      'VALIDATES',
      'IMPLEMENTS',
      'EXTENDS',
      'DEFINES',
    ],
    priorityNodeTypes: [
      'api',
      'api_endpoint',
      'service',
      'external_service',
      'database',
      'table',
      'queue',
      'event',
      'container',
    ],
  },
  {
    id: 'calls',
    label: 'Call graph',
    title: 'Functions and methods, and what calls what',
    nodeTypes: ['class', 'interface', 'function', 'method'],
    relationships: ['CALLS'],
    priorityNodeTypes: ['function', 'method'],
  },
  {
    id: 'files',
    label: 'Files',
    title: 'The source tree and its file-level dependencies',
    nodeTypes: ['repository', 'directory', 'file', 'module'],
    relationships: ['CONTAINS', 'IMPORTS', 'EXPORTS', 'DEPENDS_ON'],
    priorityNodeTypes: ['file'],
  },
  {
    id: 'dependencies',
    label: 'Dependencies',
    title: 'What this service depends on: libraries, and other services',
    nodeTypes: ['service', 'module', 'external_service', 'file', 'config'],
    relationships: ['DEPENDS_ON', 'DEPENDS_ON_SERVICE', 'IMPORTS', 'USES', 'CONFIGURED_BY'],
    priorityNodeTypes: ['service', 'external_service', 'module'],
  },
  {
    id: 'dataflow',
    label: 'Data flow',
    title: 'Request to store: API to service to database, queue and event',
    nodeTypes: [
      'api',
      'api_endpoint',
      'service',
      'class',
      'method',
      'database',
      'table',
      'queue',
      'event',
      'external_service',
    ],
    relationships: [
      'ROUTES_TO',
      'IMPLEMENTED_BY',
      'CALLS',
      'READS_FROM',
      'WRITES_TO',
      'PUBLISHES',
      'SUBSCRIBES',
      'USES',
    ],
    priorityNodeTypes: ['api', 'api_endpoint', 'table', 'queue', 'event'],
  },
  {
    id: 'documentation',
    label: 'Documentation',
    title: 'What the repository writes about itself, and what it writes about',
    nodeTypes: [
      'document',
      'document_section',
      'file',
      'class',
      'interface',
      'function',
      'method',
      'service',
      'api',
      'api_endpoint',
      'table',
    ],
    relationships: ['CONTAINS', 'DOCUMENTS', 'LINKS_TO'],
    priorityNodeTypes: ['document', 'document_section'],
  },
  {
    id: 'apis',
    label: 'APIs',
    title: 'Declared operations, the routes that serve them and the code behind',
    nodeTypes: [
      'api_spec',
      'api_endpoint',
      'api',
      'class',
      'method',
      'function',
      'service',
    ],
    relationships: ['DEFINES', 'IMPLEMENTED_BY', 'ROUTES_TO', 'CALLS'],
    priorityNodeTypes: ['api_spec', 'api_endpoint', 'api'],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    title: 'Configuration files, the settings they promote and what they configure',
    nodeTypes: ['config', 'config_property', 'container', 'service', 'module', 'file'],
    relationships: ['CONFIGURED_BY', 'CONTAINS', 'DEFINES', 'DEPENDS_ON'],
    priorityNodeTypes: ['config', 'container'],
  },
  {
    id: 'data',
    label: 'Data model',
    title: 'Schemas, tables and columns, and the code that reads and writes them',
    nodeTypes: ['database', 'table', 'column', 'class', 'method', 'config'],
    relationships: ['CONTAINS', 'DEFINES', 'READS_FROM', 'WRITES_TO', 'USES'],
    priorityNodeTypes: ['table', 'database'],
  },
  {
    id: 'cross-source',
    label: 'Cross-source',
    title: 'Only the relationships that join two different kinds of evidence',
    nodeTypes: [],
    relationships: [
      'DOCUMENTS',
      'LINKS_TO',
      'DEFINES',
      'IMPLEMENTED_BY',
      'CONFIGURED_BY',
      'ROUTES_TO',
      'READS_FROM',
      'WRITES_TO',
    ],
    priorityNodeTypes: [
      'api_spec',
      'api_endpoint',
      'document',
      'container',
      'table',
      'config',
    ],
  },
];

/** The projection a project opens on. Architecture answers the question
 * someone actually arrives with — how is this system put together — and an
 * unfiltered overview of a real repository is a hairball, which is not an
 * introduction. */
export const DEFAULT_GRAPH_PROJECTION_ID: GraphProjectionId = 'architecture';

const BY_ID = new Map<GraphProjectionId, GraphProjection>(
  GRAPH_PROJECTIONS.map((projection) => [projection.id, projection]),
);

export function graphProjection(id: GraphProjectionId): GraphProjection {
  const projection = BY_ID.get(id);
  if (!projection) throw new Error(`unknown graph projection: ${id}`);
  return projection;
}

export function defaultGraphProjection(): GraphProjection {
  return graphProjection(DEFAULT_GRAPH_PROJECTION_ID);
}

export function isGraphProjectionId(value: string): value is GraphProjectionId {
  return (GRAPH_PROJECTION_IDS as readonly string[]).includes(value);
}
