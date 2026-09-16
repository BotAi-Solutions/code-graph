/**
 * The external services we can name with confidence.
 *
 * Two tables, both exact-match: a package name, or an API host. Nothing is
 * guessed from a partial match — an unknown host becomes a service named after
 * the host itself rather than a vendor we are not sure about, and an unknown
 * package becomes nothing at all.
 *
 * `category` exists so the UI can group them; it is descriptive, not inferred.
 */

export interface ExternalServiceVendor {
  /** Display name: `Stripe`. */
  name: string;
  category: string;
}

export const VENDORS_BY_PACKAGE: ReadonlyMap<string, ExternalServiceVendor> = new Map([
  ['stripe', { name: 'Stripe', category: 'payments' }],
  ['@stripe/stripe-js', { name: 'Stripe', category: 'payments' }],
  ['braintree', { name: 'Braintree', category: 'payments' }],
  ['@paypal/checkout-server-sdk', { name: 'PayPal', category: 'payments' }],

  ['aws-sdk', { name: 'AWS', category: 'cloud' }],
  ['@aws-sdk/client-s3', { name: 'AWS S3', category: 'cloud' }],
  ['@aws-sdk/client-sqs', { name: 'AWS SQS', category: 'messaging' }],
  ['@aws-sdk/client-sns', { name: 'AWS SNS', category: 'messaging' }],
  ['@aws-sdk/client-ses', { name: 'AWS SES', category: 'email' }],
  ['@aws-sdk/client-dynamodb', { name: 'AWS DynamoDB', category: 'cloud' }],
  ['@google-cloud/storage', { name: 'Google Cloud Storage', category: 'cloud' }],
  ['@google-cloud/pubsub', { name: 'Google Cloud Pub/Sub', category: 'messaging' }],
  ['googleapis', { name: 'Google APIs', category: 'cloud' }],
  ['@azure/storage-blob', { name: 'Azure Blob Storage', category: 'cloud' }],

  ['firebase', { name: 'Firebase', category: 'platform' }],
  ['firebase-admin', { name: 'Firebase', category: 'platform' }],
  ['@supabase/supabase-js', { name: 'Supabase', category: 'platform' }],

  ['openai', { name: 'OpenAI', category: 'ai' }],
  ['@anthropic-ai/sdk', { name: 'Anthropic', category: 'ai' }],
  ['cohere-ai', { name: 'Cohere', category: 'ai' }],

  ['@sendgrid/mail', { name: 'SendGrid', category: 'email' }],
  ['nodemailer', { name: 'SMTP', category: 'email' }],
  ['postmark', { name: 'Postmark', category: 'email' }],
  ['resend', { name: 'Resend', category: 'email' }],
  ['twilio', { name: 'Twilio', category: 'messaging' }],
  ['@slack/web-api', { name: 'Slack', category: 'messaging' }],

  ['@octokit/rest', { name: 'GitHub', category: 'developer' }],
  ['@octokit/core', { name: 'GitHub', category: 'developer' }],
  ['algoliasearch', { name: 'Algolia', category: 'search' }],
  ['@elastic/elasticsearch', { name: 'Elasticsearch', category: 'search' }],
  ['@sentry/node', { name: 'Sentry', category: 'observability' }],
  ['posthog-node', { name: 'PostHog', category: 'analytics' }],
  ['@segment/analytics-node', { name: 'Segment', category: 'analytics' }],
]);

export const VENDORS_BY_HOST: ReadonlyMap<string, ExternalServiceVendor> = new Map([
  ['api.stripe.com', { name: 'Stripe', category: 'payments' }],
  ['api.sendgrid.com', { name: 'SendGrid', category: 'email' }],
  ['api.postmarkapp.com', { name: 'Postmark', category: 'email' }],
  ['api.resend.com', { name: 'Resend', category: 'email' }],
  ['api.mailgun.net', { name: 'Mailgun', category: 'email' }],
  ['api.twilio.com', { name: 'Twilio', category: 'messaging' }],
  ['slack.com', { name: 'Slack', category: 'messaging' }],
  ['hooks.slack.com', { name: 'Slack', category: 'messaging' }],
  ['api.openai.com', { name: 'OpenAI', category: 'ai' }],
  ['api.anthropic.com', { name: 'Anthropic', category: 'ai' }],
  ['api.github.com', { name: 'GitHub', category: 'developer' }],
  ['graph.instagram.com', { name: 'Instagram', category: 'social' }],
  ['graph.facebook.com', { name: 'Meta Graph', category: 'social' }],
  ['api.twitter.com', { name: 'X', category: 'social' }],
  ['www.googleapis.com', { name: 'Google APIs', category: 'cloud' }],
  ['oauth2.googleapis.com', { name: 'Google OAuth', category: 'identity' }],
  ['accounts.google.com', { name: 'Google OAuth', category: 'identity' }],
]);

/**
 * Hosts that name no real dependency: loopback, and the reserved example
 * domains that documentation and tests use.
 */
const PLACEHOLDER_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'example.com',
  'www.example.com',
  'example.org',
  'example.net',
  'test.com',
]);

export function isPlaceholderHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (PLACEHOLDER_HOSTS.has(lower)) return true;
  return lower.endsWith('.local') || lower.endsWith('.localhost') || lower.endsWith('.invalid');
}

export function vendorForPackage(packageName: string): ExternalServiceVendor | null {
  return VENDORS_BY_PACKAGE.get(packageName) ?? null;
}

export function vendorForHost(host: string): ExternalServiceVendor | null {
  return VENDORS_BY_HOST.get(host.toLowerCase()) ?? null;
}

/** The host of an absolute http(s) URL, or null for anything else. */
export function hostOfUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;

  try {
    const url = new URL(value);
    return url.hostname.length > 0 ? url.hostname : null;
  } catch {
    return null;
  }
}
