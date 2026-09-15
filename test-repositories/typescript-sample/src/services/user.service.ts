import { isAdmin, type User, type UserDraft } from '../models/user.js';
import { UserRepository } from '../repositories/user.repository.js';
import { Logger } from '../utils/logger.js';

export class UserNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`User ${userId} was not found`);
    this.name = 'UserNotFoundError';
  }
}

/** Business rules. Calls the repository, references the User model. */
export class UserService {
  private readonly logger = new Logger('UserService');

  constructor(private readonly repository: UserRepository = new UserRepository()) {}

  getUser(id: string): User {
    const user = this.repository.findById(id);
    if (!user) {
      this.logger.warn(`missing user ${id}`);
      throw new UserNotFoundError(id);
    }
    return user;
  }

  listUsers(): User[] {
    return this.repository.findAll();
  }

  registerUser(draft: UserDraft): User {
    const user = this.repository.save(draft);
    this.logger.info(`registered ${user.id}`);
    return user;
  }

  listAdministrators(): User[] {
    return this.repository.findAll().filter((user) => isAdmin(user));
  }

  deleteUser(id: string): void {
    const user = this.getUser(id);
    if (!this.repository.remove(user.id)) {
      throw new UserNotFoundError(id);
    }
  }
}
