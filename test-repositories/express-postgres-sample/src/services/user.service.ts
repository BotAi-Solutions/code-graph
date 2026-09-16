import { Queue } from 'bullmq';
import { events, USER_CREATED } from '../events/emitter.js';
import { isAdmin, type CreateUserInput, type User } from '../models/user.js';
import { UserRepository } from '../repositories/user.repository.js';
import { EmailService } from './email.service.js';
import { PaymentService } from './payment.service.js';

export class UserNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`User ${userId} was not found`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Business rules for users: persist, bill, notify, announce.
 *
 * Every outward hop is here rather than in the controller, which is what makes
 * the service the interesting node in an architecture view.
 */
export class UserService {
  private readonly welcomeQueue = new Queue('welcome-emails');

  constructor(
    private readonly repository: UserRepository,
    private readonly email: EmailService,
    private readonly payments: PaymentService,
  ) {}

  async create(input: CreateUserInput): Promise<User> {
    const user = await this.repository.create(input);

    await this.payments.createCustomer(user);
    await this.email.sendWelcome(user);
    await this.welcomeQueue.add('send-welcome', { userId: user.id });

    events.emit(USER_CREATED, user);
    return user;
  }

  async getUser(id: string): Promise<User> {
    const user = await this.repository.findById(id);
    if (!user) throw new UserNotFoundError(id);
    return user;
  }

  async listUsers(limit = 50): Promise<User[]> {
    return this.repository.findAll(limit);
  }

  async listAdministrators(): Promise<User[]> {
    const users = await this.repository.findAll(200);
    return users.filter((user) => isAdmin(user));
  }

  async verify(id: string): Promise<User> {
    const user = await this.getUser(id);
    await this.repository.markVerified(user.id);
    return user;
  }

  async deleteUser(id: string): Promise<void> {
    const user = await this.getUser(id);
    if (!(await this.repository.remove(user.id))) {
      throw new UserNotFoundError(id);
    }
  }
}
