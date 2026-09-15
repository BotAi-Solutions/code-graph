import {
  apiEnvSchema,
  databaseEnvSchema,
  parseEnv,
  runtimeEnvSchema,
  type ApiEnv,
  type DatabaseEnv,
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
}

const apiEnvSchemaFull = runtimeEnvSchema.and(databaseEnvSchema).and(apiEnvSchema);

export function loadApiConfig(
  source: Record<string, string | undefined> = process.env,
): ApiConfig {
  const env = parseEnv(apiEnvSchemaFull, source);

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
  };
}
