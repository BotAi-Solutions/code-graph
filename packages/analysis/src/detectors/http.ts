/**
 * Shared HTTP vocabulary for the API detectors.
 */

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'ALL',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** NestJS route decorators, by the HTTP method they declare. */
export const NEST_ROUTE_DECORATORS: ReadonlyMap<string, HttpMethod> = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Options', 'OPTIONS'],
  ['Head', 'HEAD'],
  ['All', 'ALL'],
]);

/**
 * Router methods, by the HTTP method they declare. `all` is included; `use` is
 * not, because it mounts rather than routes and is handled separately.
 */
export const ROUTER_METHODS: ReadonlyMap<string, HttpMethod> = new Map([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['options', 'OPTIONS'],
  ['head', 'HEAD'],
  ['all', 'ALL'],
]);

/** Packages whose router factories we recognise, and the framework name. */
export const ROUTER_PACKAGES: ReadonlyMap<string, string> = new Map([
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['@nestjs/common', 'nestjs'],
  ['@nestjs/core', 'nestjs'],
]);

/**
 * Joins route segments the way a router does: a single leading slash, no
 * doubled separators, no trailing slash. Parameter segments (`:id`, `*`) pass
 * through untouched.
 */
export function joinRoutePath(...segments: Array<string | null | undefined>): string {
  const parts = segments
    .filter((segment): segment is string => typeof segment === 'string')
    .flatMap((segment) => segment.split('/'))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.');

  return `/${parts.join('/')}`;
}

/** `POST /users/:id` — how an API node is named and identified. */
export function routeLabel(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}
