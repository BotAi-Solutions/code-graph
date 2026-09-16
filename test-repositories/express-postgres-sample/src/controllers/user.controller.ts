import type { Request, Response } from 'express';
import type { CreateUserInput } from '../models/user.js';
import { UserService } from '../services/user.service.js';

/**
 * Transport layer. Calls the service, never the repository.
 */
export class UserController {
  constructor(private readonly service: UserService) {}

  async create(request: Request, response: Response): Promise<void> {
    const input = request.body as unknown as CreateUserInput;
    const user = await this.service.create(input);
    response.status(201).json(user);
  }

  async list(request: Request, response: Response): Promise<void> {
    const limit = Number.parseInt(request.query.limit ?? '50', 10);
    response.status(200).json(await this.service.listUsers(limit));
  }

  async get(request: Request, response: Response): Promise<void> {
    const id = request.params.id ?? '';
    try {
      response.status(200).json(await this.service.getUser(id));
    } catch {
      response.status(404).json({ error: `user ${id} was not found` });
    }
  }

  async verify(request: Request, response: Response): Promise<void> {
    const id = request.params.id ?? '';
    response.status(200).json(await this.service.verify(id));
  }

  async remove(request: Request, response: Response): Promise<void> {
    const id = request.params.id ?? '';
    await this.service.deleteUser(id);
    response.status(200).json({ deleted: true });
  }
}
