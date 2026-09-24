import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  POSTGRES_UP,
  SETUP_STEPS,
  databaseTarget,
  parseOptions,
  plannedServices,
} from '../dev-all.js';

/**
 * What `pnpm dev:all` starts, checked against the repository it runs in.
 *
 * The orchestrator's promise is that it adds no second way to run anything:
 * every step must be a script or service this repository already defines. So
 * each planned command is resolved against the real package.json files and
 * the real docker-compose.yml, and a rename there fails here rather than at
 * someone's first `pnpm dev:all`.
 */

const WORKSPACE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function packageJson(relative: string): { name: string; scripts: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(WORKSPACE_ROOT, relative, 'package.json'), 'utf8')) as {
    name: string;
    scripts: Record<string, string>;
  };
}

const PACKAGES: Record<string, string> = {
  '@ckg/api': 'apps/api',
  '@ckg/worker': 'apps/worker',
  '@ckg/web': 'apps/web',
};

describe('pnpm dev:all', () => {
  it('is a root script that runs the orchestrator', () => {
    expect(packageJson('.').scripts['dev:all']).toBe('tsx scripts/dev-all.ts');
  });

  it('leaves the existing dev scripts as they were', () => {
    const scripts = packageJson('.').scripts;
    expect(scripts.dev).toContain('--filter @ckg/api --filter @ckg/worker --filter @ckg/web dev');
    expect(scripts['dev:api']).toBeDefined();
    expect(scripts['dev:worker']).toBeDefined();
  });

  it('starts the API and the worker, the two services an MCP client needs', () => {
    expect(plannedServices({ web: false }).map((service) => service.name)).toEqual(['api', 'worker']);
  });

  it('adds the web UI unless told not to', () => {
    expect(plannedServices(parseOptions([])).map((service) => service.name)).toEqual(['api', 'worker', 'web']);
    expect(plannedServices(parseOptions(['--no-web'])).map((service) => service.name)).toEqual(['api', 'worker']);
  });

  it('starts every service through its own package’s existing dev script', () => {
    for (const service of plannedServices({ web: true })) {
      expect(service.command).toBe('pnpm');
      const [flag, name, script] = service.args;
      expect(flag).toBe('--filter');
      const directory = PACKAGES[name ?? ''];
      expect(directory, `unknown package ${String(name)}`).toBeDefined();
      expect(packageJson(directory ?? '').name).toBe(name);
      expect(packageJson(directory ?? '').scripts[script ?? '']).toBeDefined();
    }
  });

  it('builds, then migrates, through the root scripts that already exist', () => {
    expect(SETUP_STEPS.map((step) => step.args[0])).toEqual(['build:packages', 'db:migrate']);
    const scripts = packageJson('.').scripts;
    for (const step of SETUP_STEPS) expect(scripts[step.args[0] ?? '']).toBeDefined();
  });

  it('starts PostgreSQL from the compose file’s own service, waiting for its health check', () => {
    expect(POSTGRES_UP.command).toBe('docker');
    expect(POSTGRES_UP.args).toEqual(['compose', 'up', '-d', '--wait', 'postgres']);

    const compose = readFileSync(path.join(WORKSPACE_ROOT, 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/^ {2}postgres:$/m);
    expect(compose).toMatch(/healthcheck:/);
  });
});

describe('databaseTarget', () => {
  it('reads host and port from DATABASE_URL', () => {
    expect(databaseTarget('postgresql://ckg:ckg@localhost:5433/code_knowledge_graph')).toEqual({
      host: 'localhost',
      port: 5433,
    });
  });

  it('defaults the port the way libpq does', () => {
    expect(databaseTarget('postgresql://ckg:ckg@db.internal/ckg')).toEqual({ host: 'db.internal', port: 5432 });
  });

  it('refuses to guess when there is nothing to read', () => {
    expect(databaseTarget(undefined)).toBeNull();
    expect(databaseTarget('not a url')).toBeNull();
  });
});
