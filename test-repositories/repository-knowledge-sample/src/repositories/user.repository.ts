import type { Pool } from 'pg';
import { toUser, type CreateUserInput, type User, type UserRow } from '../models/user.js';

/**
 * Every SQL statement in the service, written out in full so that an analyzer
 * can say which table each method touches.
 */
export class UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateUserInput): Promise<User> {
    const result = await this.pool.query<UserRow>(
      'INSERT INTO users (email, display_name, role) VALUES ($1, $2, $3) RETURNING *',
      [input.email, input.displayName ?? null, 'member'],
    );

    const row = result.rows[0];
    if (!row) throw new Error('insert returned no row');
    return toUser(row);
  }

  async findById(id: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? toUser(row) : null;
  }
}
