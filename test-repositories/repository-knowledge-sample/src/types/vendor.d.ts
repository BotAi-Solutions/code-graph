/**
 * Minimal ambient declarations for the packages this sample imports.
 *
 * The sample is analysed in place and never installed — that is the point of a
 * fixture — so the declarations it needs to typecheck live here rather than in
 * a `node_modules` tree.
 */

declare module 'express' {
  export interface Request {
    body: Record<string, unknown>;
    params: Record<string, string>;
  }

  export interface Response {
    status(code: number): Response;
    json(body: unknown): Response;
  }

  export type Handler = (request: Request, response: Response) => void | Promise<void>;

  export interface Router {
    get(path: string, ...handlers: Handler[]): Router;
    post(path: string, ...handlers: Handler[]): Router;
    use(path: string, ...handlers: unknown[]): Router;
  }

  export interface Application extends Router {
    listen(port: number, callback?: () => void): void;
  }

  export function Router(): Router;

  export default function express(): Application;
}

declare module 'pg' {
  export interface QueryResult<T> {
    rows: T[];
    rowCount: number;
  }

  export class Pool {
    constructor(config: { connectionString: string });
    query<T>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  }
}
