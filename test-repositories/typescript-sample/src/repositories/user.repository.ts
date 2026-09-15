import { createUser, type User, type UserDraft } from '../models/user.js';
import { Logger } from '../utils/logger.js';

export interface UserStore {
  findById(id: string): User | undefined;
  findAll(): User[];
  save(draft: UserDraft): User;
  remove(id: string): boolean;
}

/** In-memory persistence. References the User model, implements UserStore. */
export class UserRepository implements UserStore {
  private readonly users = new Map<string, User>();
  private readonly logger = new Logger('UserRepository');
  private sequence = 0;

  findById(id: string): User | undefined {
    this.logger.debug(`findById ${id}`);
    return this.users.get(id);
  }

  findAll(): User[] {
    return [...this.users.values()];
  }

  save(draft: UserDraft): User {
    this.sequence += 1;
    const user = createUser(`user-${this.sequence}`, draft);
    this.users.set(user.id, user);
    this.logger.info(`saved ${user.id}`);
    return user;
  }

  remove(id: string): boolean {
    const removed = this.users.delete(id);
    if (!removed) {
      this.logger.warn(`remove missed ${id}`);
    }
    return removed;
  }
}
