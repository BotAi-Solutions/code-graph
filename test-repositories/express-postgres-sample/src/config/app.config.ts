/**
 * Runtime configuration. Read once, at startup, from the environment.
 */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  sendgridApiKey: string;
  stripeSecretKey: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number.parseInt(process.env.PORT ?? '8080', 10),
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/users',
    sendgridApiKey: process.env.SENDGRID_API_KEY ?? '',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  };
}
