import { HTTP_METHODS, type HttpMethod } from '../detectors/http.js';
import {
  asString,
  at,
  entryOf,
  itemsOf,
  keysOf,
  member,
  stringItems,
  type StructuredDocument,
  type StructuredNode,
  type StructuredPosition,
} from './structured.js';

/**
 * OpenAPI, read out of the structured document a JSON or YAML file parsed to.
 *
 * Format-blind by construction: the same extractor handles `openapi.json` and
 * `openapi.yaml`, because by the time it runs both are the same tree. That is
 * the whole reason the structured model exists.
 *
 * Detection is by content, not by filename. `classifyFile` guesses from the
 * name so the scan can stay a walk; this is the check that actually decides,
 * and it is the strict one: a document is a specification when it declares a
 * version *and* carries a `paths` object. A YAML file with a `paths:` key and
 * no version is a configuration file that happens to use the word.
 */

export type SpecFlavour = 'openapi-3' | 'swagger-2';

export interface OpenApiParameter {
  name: string;
  /** `path`, `query`, `header`, `cookie`. Reported as written. */
  location: string | null;
  required: boolean;
}

export interface OpenApiResponse {
  /** `200`, `404`, `default`. */
  status: string;
  /** Schema names the response body refers to, resolved from `$ref`. */
  schemas: string[];
}

export interface OpenApiOperation {
  method: HttpMethod;
  /** The path template exactly as the specification writes it: `/users/{id}`. */
  path: string;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  parameters: OpenApiParameter[];
  /** Schema names the request body refers to. */
  requestSchemas: string[];
  responses: OpenApiResponse[];
  deprecated: boolean;
  line: number;
  column: number;
}

export interface OpenApiSpec {
  relativePath: string;
  flavour: SpecFlavour;
  /** The declared version string: `3.0.3`, `2.0`. */
  version: string;
  title: string | null;
  /** The API's own version from `info.version`, not the spec format's. */
  apiVersion: string | null;
  /** A single server or base path, when the document names exactly one. */
  basePath: string | null;
  operations: OpenApiOperation[];
  /** Named schemas under `components.schemas` (3.x) or `definitions` (2.0). */
  schemaNames: string[];
  line: number;
}

/** True when this structured document is an API specification. */
export function isOpenApiDocument(document: StructuredDocument): boolean {
  return flavourOf(document.root) !== null;
}

function flavourOf(root: StructuredNode | null): SpecFlavour | null {
  if (root?.kind !== 'object') return null;
  if (member(root, 'paths')?.kind !== 'object') return null;

  const openapi = asString(member(root, 'openapi'));
  if (openapi !== null && /^3\./.test(openapi)) return 'openapi-3';

  const swagger = asString(member(root, 'swagger'));
  if (swagger !== null && /^2\./.test(swagger)) return 'swagger-2';

  return null;
}

const METHOD_BY_KEY = new Map<string, HttpMethod>(
  HTTP_METHODS.filter((method) => method !== 'ALL').map((method) => [method.toLowerCase(), method]),
);

/** `trace` is an OpenAPI operation with no equivalent in the router vocabulary. */
const IGNORED_OPERATION_KEYS = new Set(['parameters', 'summary', 'description', 'servers', '$ref', 'trace']);

export function parseOpenApi(document: StructuredDocument): OpenApiSpec | null {
  const root = document.root;
  const flavour = flavourOf(root);
  if (!root || flavour === null) return null;

  const version =
    asString(member(root, flavour === 'openapi-3' ? 'openapi' : 'swagger')) ?? 'unknown';

  const paths = member(root, 'paths');
  const operations: OpenApiOperation[] = [];

  for (const pathEntry of paths?.entries ?? []) {
    // A `paths` key that is not a path template is an extension (`x-...`) or a
    // mistake; either way it is not an endpoint.
    if (!pathEntry.key.startsWith('/')) continue;

    const item = pathEntry.value;
    if (item.kind !== 'object') continue;

    // Parameters declared once for every operation on the path.
    const shared = parametersOf(member(item, 'parameters'));

    for (const operationEntry of item.entries ?? []) {
      if (IGNORED_OPERATION_KEYS.has(operationEntry.key)) continue;

      const method = METHOD_BY_KEY.get(operationEntry.key.toLowerCase());
      if (method === undefined) continue;

      const operation = operationEntry.value;
      if (operation.kind !== 'object') continue;

      operations.push({
        method,
        path: pathEntry.key,
        operationId: asString(member(operation, 'operationId')),
        summary: asString(member(operation, 'summary')),
        tags: stringItems(member(operation, 'tags')),
        parameters: [...shared, ...parametersOf(member(operation, 'parameters'))],
        requestSchemas: requestSchemasOf(operation, flavour),
        responses: responsesOf(member(operation, 'responses')),
        deprecated: member(operation, 'deprecated')?.value === true,
        line: operationEntry.keyPosition.line,
        column: operationEntry.keyPosition.column,
      });
    }
  }

  return {
    relativePath: document.relativePath,
    flavour,
    version,
    title: asString(at(root, 'info', 'title')),
    apiVersion: asString(at(root, 'info', 'version')),
    basePath: basePathOf(root, flavour),
    // Document order, which for a specification is the order the author chose.
    operations,
    schemaNames: keysOf(
      flavour === 'openapi-3' ? at(root, 'components', 'schemas') : member(root, 'definitions'),
    ),
    line: root.line,
  };
}

/**
 * The one server path the whole document is relative to.
 *
 * Only when there is exactly one server and its URL has no template variables:
 * a specification with three environments has no single base path, and picking
 * the first would silently prefix every route with a staging host.
 */
function basePathOf(root: StructuredNode, flavour: SpecFlavour): string | null {
  if (flavour === 'swagger-2') return asString(member(root, 'basePath'));

  const servers = itemsOf(member(root, 'servers'));
  if (servers.length !== 1) return null;

  const url = asString(member(servers[0], 'url'));
  if (url === null || url.includes('{')) return null;

  // Only the path component matters to a route; a host is a deployment fact.
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const trimmed = withoutScheme.replace(/\/+$/, '');
  return trimmed.length === 0 || trimmed === '/' ? null : trimmed;
}

function parametersOf(node: StructuredNode | undefined): OpenApiParameter[] {
  return itemsOf(node)
    .map((item): OpenApiParameter | null => {
      const name = asString(member(item, 'name'));
      if (name === null) return null;
      return {
        name,
        location: asString(member(item, 'in')),
        required: member(item, 'required')?.value === true,
      };
    })
    .filter((parameter): parameter is OpenApiParameter => parameter !== null);
}

function requestSchemasOf(operation: StructuredNode, flavour: SpecFlavour): string[] {
  if (flavour === 'swagger-2') {
    // Swagger 2 puts the body in a parameter whose `in` is `body`.
    const body = itemsOf(member(operation, 'parameters')).find(
      (item) => asString(member(item, 'in')) === 'body',
    );
    return schemaNamesIn(member(body, 'schema'));
  }
  return schemaNamesIn(at(operation, 'requestBody', 'content'));
}

function responsesOf(node: StructuredNode | undefined): OpenApiResponse[] {
  if (node?.kind !== 'object') return [];

  return (node.entries ?? []).map((entry) => ({
    status: entry.key,
    schemas: schemaNamesIn(entry.value),
  }));
}

/** Depth beyond which a `$ref` hunt stops. Schemas nest; they do not recurse here. */
const REF_DEPTH = 6;

/**
 * Every schema a subtree refers to, by name.
 *
 * Only named references count. An inline schema is real but has no name to put
 * in the graph, and inventing one from the operation would produce a node that
 * nothing else in the repository could ever match.
 */
function schemaNamesIn(node: StructuredNode | undefined, depth = 0): string[] {
  if (node === undefined || depth > REF_DEPTH) return [];

  const found: string[] = [];

  const ref = asString(member(node, '$ref'));
  if (ref !== null) {
    const name = refName(ref);
    if (name !== null) found.push(name);
  }

  if (node.kind === 'object') {
    for (const entry of node.entries ?? []) {
      if (entry.key === '$ref') continue;
      found.push(...schemaNamesIn(entry.value, depth + 1));
    }
  } else if (node.kind === 'array') {
    for (const item of node.items ?? []) found.push(...schemaNamesIn(item, depth + 1));
  }

  return [...new Set(found)];
}

function refName(ref: string): string | null {
  // `#/components/schemas/User` and `#/definitions/User`.
  const match = /^#\/(?:components\/schemas|definitions)\/([^/]+)$/.exec(ref);
  return match?.[1] ?? null;
}

/** Where a named schema is declared, for an evidence line. */
export function schemaPosition(
  document: StructuredDocument,
  flavour: SpecFlavour,
  name: string,
): StructuredPosition | null {
  const container =
    flavour === 'openapi-3'
      ? at(document.root ?? undefined, 'components', 'schemas')
      : member(document.root ?? undefined, 'definitions');

  return entryOf(container, name)?.keyPosition ?? null;
}

/**
 * A route path reduced to what two declarations of it must agree on.
 *
 * `/users/{id}` from a specification and `/users/:id` from an Express router
 * are the same endpoint written in two dialects, and the whole point of the
 * link is that a graph can tell. Parameter *names* are deliberately erased:
 * `{userId}` and `:id` are the same position in the same path, and a
 * specification and a controller are allowed to disagree about what to call it.
 */
export function normalizeRoutePath(path: string): string {
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith(':')) return '{}';
      if (segment.startsWith('*')) return '{}';
      // `{id}` and `:id`, plus a whole segment that is one template.
      if (/^\{[^}]*\}$/.test(segment)) return '{}';
      return segment;
    });

  return `/${segments.join('/')}`;
}

/** `POST /users/{id}` — how an endpoint is named and identified. */
export function endpointLabel(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}
