/**
 * Frameworks and platform libraries we can name from a dependency.
 *
 * Exact package names only. The list exists so the graph can say "this is a
 * NestJS service backed by Prisma" — a fact worth having on the repository node
 * — and so the API and database analyzers can require framework evidence before
 * interpreting a decorator.
 */

export const FRAMEWORK_KINDS = [
  'nestjs',
  'express',
  'fastify',
  'koa',
  'hapi',
  'next',
  'remix',
  'react',
  'vue',
  'angular',
  'svelte',
  'prisma',
  'typeorm',
  'sequelize',
  'mikro-orm',
  'mongoose',
  'drizzle',
  'knex',
  'bullmq',
  'graphql',
  'trpc',
  'socket.io',
] as const;

export type FrameworkKind = (typeof FRAMEWORK_KINDS)[number];

export const FRAMEWORKS_BY_PACKAGE: ReadonlyMap<string, FrameworkKind> = new Map([
  ['@nestjs/core', 'nestjs'],
  ['@nestjs/common', 'nestjs'],
  ['@nestjs/platform-express', 'nestjs'],
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['koa', 'koa'],
  ['@hapi/hapi', 'hapi'],

  ['next', 'next'],
  ['@remix-run/node', 'remix'],
  ['react', 'react'],
  ['vue', 'vue'],
  ['@angular/core', 'angular'],
  ['svelte', 'svelte'],

  ['@prisma/client', 'prisma'],
  ['prisma', 'prisma'],
  ['typeorm', 'typeorm'],
  ['sequelize', 'sequelize'],
  ['sequelize-typescript', 'sequelize'],
  ['@mikro-orm/core', 'mikro-orm'],
  ['mongoose', 'mongoose'],
  ['drizzle-orm', 'drizzle'],
  ['knex', 'knex'],

  ['bullmq', 'bullmq'],
  ['bull', 'bullmq'],

  ['graphql', 'graphql'],
  ['@apollo/server', 'graphql'],
  ['@trpc/server', 'trpc'],
  ['socket.io', 'socket.io'],
]);
