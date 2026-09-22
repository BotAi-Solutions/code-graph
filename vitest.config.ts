import { defineConfig } from 'vitest/config';

/**
 * One workspace-level test runner. Each project resolves workspace packages
 * through the alias map below so tests always run against `src/`, never a
 * stale `dist/` build.
 */
const alias = {
  // More specific subpaths first: Vite matches string aliases by prefix.
  '@ckg/shared/logger': new URL('./packages/shared/src/logger.ts', import.meta.url).pathname,
  '@ckg/shared/node': new URL('./packages/shared/src/node.ts', import.meta.url).pathname,
  '@ckg/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
  '@ckg/language-detection': new URL(
    './packages/language-detection/src/index.ts',
    import.meta.url,
  ).pathname,
  '@ckg/scip': new URL('./packages/scip/src/index.ts', import.meta.url).pathname,
  '@ckg/graph': new URL('./packages/graph/src/index.ts', import.meta.url).pathname,
  '@ckg/analysis': new URL('./packages/analysis/src/index.ts', import.meta.url).pathname,
  '@ckg/benchmark': new URL('./packages/benchmark/src/index.ts', import.meta.url).pathname,
  '@ckg/retrieval-eval': new URL(
    './packages/retrieval-eval/src/index.ts',
    import.meta.url,
  ).pathname,
  '@ckg/database': new URL('./packages/database/src/index.ts', import.meta.url).pathname,
};

export default defineConfig({
  resolve: { alias },
  test: {
    globals: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'language-detection',
          root: './packages/language-detection',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'scip',
          root: './packages/scip',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'graph',
          root: './packages/graph',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'analysis',
          root: './packages/analysis',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'benchmark',
          root: './packages/benchmark',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'retrieval-eval',
          root: './packages/retrieval-eval',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'database',
          root: './packages/database',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'worker',
          root: './apps/worker',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'mcp',
          root: './apps/mcp',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        // The web project's pure view logic: what the canvas is handed, and
        // what it is drawn with. The components themselves are exercised by
        // running the app, not by a simulated DOM.
        resolve: { alias },
        test: {
          name: 'web',
          root: './apps/web',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
    ],
  },
});
