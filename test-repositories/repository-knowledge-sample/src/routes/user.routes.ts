import { Router } from 'express';
import type { UserController } from '../controllers/user.controller.js';

/**
 * The HTTP surface, declared with full paths so the route the graph records is
 * the route written here.
 */
export function createUserRouter(controller: UserController): Router {
  const router = Router();

  router.post('/users', (request, response) => controller.create(request, response));
  router.get('/users/:id', (request, response) => controller.get(request, response));

  return router;
}
