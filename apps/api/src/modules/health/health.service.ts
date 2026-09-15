export interface HealthProbe {
  ping(): Promise<boolean>;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  checks: { database: 'ok' | 'unavailable' };
}

/**
 * Liveness plus a database round trip. Degraded rather than failing hard: a
 * momentarily unreachable database should be visible without the process being
 * restarted by an orchestrator.
 */
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(private readonly database: HealthProbe) {}

  async check(): Promise<HealthReport> {
    let databaseOk = false;
    try {
      databaseOk = await this.database.ping();
    } catch {
      databaseOk = false;
    }

    return {
      status: databaseOk ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks: { database: databaseOk ? 'ok' : 'unavailable' },
    };
  }
}
