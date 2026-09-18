import type { UserRepository } from '../repositories/user.repository.js';
import type { CreateUserInput, User } from '../models/user.js';

/**
 * Registration rules. The only layer allowed to decide what a valid user is.
 */
export class UserService {
  constructor(private readonly users: UserRepository) {}

  async create(input: CreateUserInput): Promise<User> {
    if (!input.email.includes('@')) throw new Error('an email address is required');
    return this.users.create(input);
  }

  async get(id: string): Promise<User | null> {
    return this.users.findById(id);
  }
}
