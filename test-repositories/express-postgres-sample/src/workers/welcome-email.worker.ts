import { Worker } from 'bullmq';
import { EmailService } from '../services/email.service.js';
import { UserRepository } from '../repositories/user.repository.js';
import { createPool } from '../config/database.js';

/**
 * Drains the welcome-email queue. Nothing calls this file: it is reached
 * through the queue, which is why the queue has to be a node for the
 * architecture to be legible.
 */
export function startWelcomeEmailWorker(): Worker {
  const repository = new UserRepository(createPool());
  const email = new EmailService();

  return new Worker('welcome-emails', async (job) => {
    const userId = String(job.data.userId ?? '');
    const user = await repository.findById(userId);
    if (user) await email.sendWelcome(user);
  });
}
