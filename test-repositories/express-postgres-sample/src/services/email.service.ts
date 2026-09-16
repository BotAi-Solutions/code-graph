import { loadConfig } from '../config/app.config.js';
import type { User } from '../models/user.js';

/**
 * Transactional email, sent through a third-party HTTP API. The endpoint is
 * written out as an absolute URL, which is what identifies the service the
 * application depends on.
 */
export class EmailService {
  private readonly endpoint = 'https://api.sendgrid.com/v3/mail/send';

  async sendWelcome(user: User): Promise<void> {
    const config = loadConfig();

    await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.sendgridApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: user.email }] }],
        subject: 'Welcome',
        content: [{ type: 'text/plain', value: `Hello ${user.displayName}` }],
      }),
    });
  }
}
