import express, { type Application } from 'express';
import { healthRouter } from './api/health.routes.js';
import { createUserRouter } from './api/user.routes.js';
import { loadConfig } from './config/app.config.js';
import { createPool } from './config/database.js';
import { UserController } from './controllers/user.controller.js';
import { registerUserCreatedListener } from './events/user-created.listener.js';
import { UserRepository } from './repositories/user.repository.js';
import { EmailService } from './services/email.service.js';
import { PaymentService } from './services/payment.service.js';
import { UserService } from './services/user.service.js';
import { startWelcomeEmailWorker } from './workers/welcome-email.worker.js';

/**
 * Composition root: one place where every dependency is constructed and the
 * routers are mounted.
 */
export function createApp(): Application {
  const app = express();

  const repository = new UserRepository(createPool());
  const service = new UserService(repository, new EmailService(), new PaymentService());
  const controller = new UserController(service);

  app.use('/users', createUserRouter(controller));
  app.use('/health', healthRouter);

  registerUserCreatedListener();
  startWelcomeEmailWorker();

  return app;
}

export function main(): void {
  const config = loadConfig();
  createApp().listen(config.port, () => {
    process.stdout.write(`users-service listening on ${String(config.port)}\n`);
  });
}
