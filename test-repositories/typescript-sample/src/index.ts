import { UserController } from './controllers/user.controller.js';
import { UserService } from './services/user.service.js';
import { UserRepository } from './repositories/user.repository.js';
import { Logger } from './utils/logger.js';

const logger = new Logger('main');

export function bootstrap(): UserController {
  const repository = new UserRepository();
  const service = new UserService(repository);
  const controller = new UserController(service);

  controller.createUser({ email: 'ada@example.com', displayName: 'Ada', role: 'admin' });
  controller.createUser({ email: 'grace@example.com', displayName: 'Grace' });

  logger.info(`bootstrapped with ${controller.listUsers().body instanceof Array ? 2 : 0} users`);
  return controller;
}
