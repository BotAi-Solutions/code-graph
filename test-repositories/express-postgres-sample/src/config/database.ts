import { Pool } from 'pg';
import { loadConfig } from './app.config.js';

/** The connection pool every repository shares. */
export function createPool(): Pool {
  const config = loadConfig();
  return new Pool({ connectionString: config.databaseUrl, max: 10 });
}
