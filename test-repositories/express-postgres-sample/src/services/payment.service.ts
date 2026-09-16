import Stripe from 'stripe';
import { loadConfig } from '../config/app.config.js';
import type { User } from '../models/user.js';

/**
 * Billing. The vendor SDK is imported by name, which is unambiguous evidence
 * of the dependency without any URL to inspect.
 */
export class PaymentService {
  private readonly stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(loadConfig().stripeSecretKey);
  }

  async createCustomer(user: User): Promise<string> {
    const customer = await this.stripe.customers.create({
      email: user.email,
      name: user.displayName,
    });
    return customer.id;
  }
}
