import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies `/api` and `/health` to the API, so the browser never
 * deals with ports or CORS.
 *
 * The target follows the API's own `PORT` from the workspace `.env`, because
 * moving the API off a busy port should not also mean editing this file. Read
 * inline rather than through `@ckg/shared/node`: a Vite config must load before
 * the workspace packages have necessarily been built.
 */
const WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ENV_FILE = path.join(WORKSPACE_ROOT, '.env');

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const API_PORT = process.env.PORT ?? '3000';
const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? `http://localhost:${API_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      // The OpenAPI UI is served by the API; without this the SPA fallback
      // would swallow the link in the header.
      '/docs': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
