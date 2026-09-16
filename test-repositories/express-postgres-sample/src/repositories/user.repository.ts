import type { Pool } from 'pg';
import { toUser, type CreateUserInput, type User, type UserRow } from '../models/user.js';

/**
 * Persistence for users. Every statement is written out in full, which is what
 * lets an analyzer say which table each method touches.
 */
export class UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateUserInput): Promise<User> {
    const result = await this.pool.query<UserRow>(
      'INSERT INTO users (email, display_name, role) VALUES ($1, $2, $3) RETURNING *',
      [input.email, input.displayName, input.role ?? 'member'],
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

  async findAll(limit: number): Promise<User[]> {
    const result = await this.pool.query<UserRow>(
      'SELECT id, email, display_name, role, created_at FROM users ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return result.rows.map(toUser);
  }

  async listWithOrderCounts(): Promise<Array<User & { orders: number }>> {
    const result = await this.pool.query<UserRow & { orders: string }>(
      `SELECT u.*, count(o.id) AS orders
         FROM users u
         LEFT JOIN orders o ON o.user_id = u.id
        GROUP BY u.id`,
    );

    return result.rows.map((row) => ({ ...toUser(row), orders: Number(row.orders) }));
  }

  async markVerified(id: string): Promise<void> {
    await this.pool.query('UPDATE users SET verified_at = now() WHERE id = $1', [id]);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
    return result.rowCount > 0;
  }
}
