import path from 'node:path';
import { findWorkspaceRoot } from '@ckg/shared/node';
import {
  apiEnvSchema,
  databaseEnvSchema,
  filesystemEnvSchema,
  parseEnv,
  runtimeEnvSchema,
  type ApiEnv,
  type DatabaseEnv,
  type FilesystemEnv,
  type RuntimeEnv,
} from '@ckg/shared';

/**
 * The single place the API reads `process.env`. Handlers and services receive
 * a typed `ApiConfig`; nothing else touches the environment.
 */

export interface ApiConfig {
  runtime: RuntimeEnv;
  database: DatabaseEnv;
  http: ApiEnv & { corsOrigins: string[] };
  filesystem: FilesystemEnv & {
    /**
     * Base a relative repository `sourcePath` resolves against, so the API and
     * the worker agree on which directory the bundled samples live in. Both
     * derive it the same way rather than trusting the process working
     * directory, which differs between `pnpm dev` and a package script.
     */
    repositoryBaseDirectory: string;
  };
}

const apiEnvSchemaFull = runtimeEnvSchema
  .and(databaseEnvSchema)
  .and(apiEnvSchema)
  .and(filesystemEnvSchema);

export function loadApiConfig(
  source: Record<string, string | undefined> = process.env,
  options: { repositoryBaseDirectory?: string } = {},
): ApiConfig {
  const env = parseEnv(apiEnvSchemaFull, source);
  const repositoryBaseDirectory = path.resolve(
    options.repositoryBaseDirectory ?? findWorkspaceRoot(),
  );

  return {
    runtime: { NODE_ENV: env.NODE_ENV, LOG_LEVEL: env.LOG_LEVEL },
    database: { DATABASE_URL: env.DATABASE_URL, DATABASE_POOL_MAX: env.DATABASE_POOL_MAX },
    http: {
      PORT: env.PORT,
      HOST: env.HOST,
      CORS_ORIGIN: env.CORS_ORIGIN,
      corsOrigins: env.CORS_ORIGIN.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    },
    filesystem: {
      LOCAL_FILESYSTEM_ENABLED: env.LOCAL_FILESYSTEM_ENABLED,
      DIRECTORY_PICKER_TIMEOUT_MS: env.DIRECTORY_PICKER_TIMEOUT_MS,
      repositoryBaseDirectory,
    },
  };
}
