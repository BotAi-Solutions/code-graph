import { events, USER_CREATED } from './emitter.js';
import type { User } from '../models/user.js';

/**
 * Handles the domain event the service publishes.
 */
export function registerUserCreatedListener(): void {
  events.on(USER_CREATED, (user: User) => {
    process.stdout.write(`user created: ${user.id}\n`);
  });
}
