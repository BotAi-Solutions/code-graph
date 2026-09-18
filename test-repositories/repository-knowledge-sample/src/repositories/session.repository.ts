import type { Pool } from 'pg';

/** Persistence for sessions. One table, two statements. */
export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(userId: string, tokenHash: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now())',
      [userId, tokenHash],
    );
  }

  async findByToken(tokenHash: string): Promise<{ user_id: string } | null> {
    const result = await this.pool.query<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE token_hash = $1',
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }
}
