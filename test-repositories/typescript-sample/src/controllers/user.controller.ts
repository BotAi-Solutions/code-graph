import type { User, UserDraft } from '../models/user.js';
import { UserService } from '../services/user.service.js';
import { Logger } from '../utils/logger.js';

export interface HttpResponse<T> {
  status: number;
  body: T | { error: string };
}

/** Shared transport concerns; UserController extends it. */
export abstract class BaseController {
  protected readonly logger: Logger;

  constructor(scope: string) {
    this.logger = new Logger(scope);
  }

  protected ok<T>(body: T): HttpResponse<T> {
    return { status: 200, body };
  }

  protected created<T>(body: T): HttpResponse<T> {
    return { status: 201, body };
  }

  protected failure<T>(status: number, error: string): HttpResponse<T> {
    this.logger.error(error);
    return { status, body: { error } };
  }
}

/** Transport layer. Calls the service, never the repository. */
export class UserController extends BaseController {
  constructor(private readonly service: UserService = new UserService()) {
    super('UserController');
  }

  getUser(id: string): HttpResponse<User> {
    try {
      return this.ok(this.service.getUser(id));
    } catch (error) {
      return this.failure(404, error instanceof Error ? error.message : 'unknown error');
    }
  }

  listUsers(): HttpResponse<User[]> {
    return this.ok(this.service.listUsers());
  }

  createUser(draft: UserDraft): HttpResponse<User> {
    return this.created(this.service.registerUser(draft));
  }

  listAdministrators(): HttpResponse<User[]> {
    return this.ok(this.service.listAdministrators());
  }

  deleteUser(id: string): HttpResponse<{ deleted: boolean }> {
    try {
      this.service.deleteUser(id);
      return this.ok({ deleted: true });
    } catch (error) {
      return this.failure(404, error instanceof Error ? error.message : 'unknown error');
    }
  }
}
