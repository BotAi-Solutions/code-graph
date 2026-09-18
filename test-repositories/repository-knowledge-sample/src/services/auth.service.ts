import type { SessionRepository } from '../repositories/session.repository.js';

/**
 * Issues and checks sessions. Named in the README, which is what makes it the
 * fixture's test of a documentation relationship.
 */
export class AuthService {
  constructor(private readonly sessions: SessionRepository) {}

  async issue(userId: string, presented: string): Promise<string> {
    const hash = this.hash(presented);
    await this.sessions.create(userId, hash);
    return hash;
  }

  async verify(token: string): Promise<string | null> {
    const session = await this.sessions.findByToken(this.hash(token));
    return session?.user_id ?? null;
  }

  private hash(value: string): string {
    return Buffer.from(value).toString('base64');
  }
}
