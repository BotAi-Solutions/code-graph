import type { Request, Response } from 'express';
import type { UserService } from '../services/user.service.js';

/** Turns an HTTP request into a call, and a result into JSON. */
export class UserController {
  constructor(private readonly users: UserService) {}

  async create(request: Request, response: Response): Promise<void> {
    const created = await this.users.create({
      email: String(request.body.email),
      displayName: request.body.displayName as string | undefined,
    });
    response.status(201).json(created);
  }

  async get(request: Request, response: Response): Promise<void> {
    const found = await this.users.get(String(request.params.id));
    if (!found) {
      response.status(404).json({ error: 'not found' });
      return;
    }
    response.status(200).json(found);
  }
}
