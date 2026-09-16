import { Router } from 'express';
import { UserController } from '../controllers/user.controller.js';

/**
 * The HTTP surface for users.
 *
 * The router is mounted under `/users` by `app.ts`, so `router.post('/')`
 * answers `POST /users` — which is the path the graph records, not the literal
 * written here.
 */
export function createUserRouter(controller: UserController): Router {
  const router = Router();

  router.post('/', (request, response) => controller.create(request, response));
  router.get('/', (request, response) => controller.list(request, response));
  router.get('/:id', (request, response) => controller.get(request, response));
  router.patch('/:id/verify', (request, response) => controller.verify(request, response));
  router.delete('/:id', (request, response) => controller.remove(request, response));

  return router;
}
