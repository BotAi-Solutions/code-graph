import type { RetrievalEvaluationCase } from './types.js';

/**
 * The dataset.
 *
 * Every expectation here was read out of an indexed fixture before it was
 * written down — the node names, the relationship types, the file paths, the
 * line numbers and the path sequences are all things the API actually returned.
 * None of it was guessed from the source, which matters: a case that asserts
 * what the code *says* rather than what the graph *holds* measures the fixture,
 * not retrieval.
 *
 * Three fixtures, chosen for what each one can answer:
 *
 * - `express-postgres-sample` — routes, services, a repository, two tables, a
 *   queue, an event and two external services. The architectural questions.
 * - `typescript-sample` — a plain layered application. Inheritance and
 *   interface implementation, which the express fixture has none of.
 * - `repository-knowledge-sample` — the above plus Markdown, an OpenAPI
 *   contract and SQL migrations. The questions about what a repository says
 *   about itself.
 */
export const RETRIEVAL_CASES: readonly RetrievalEvaluationCase[] = [
  // --- symbol lookup -------------------------------------------------------
  {
    id: 'symbol-user-repository',
    category: 'symbol_lookup',
    question: 'Where is UserRepository defined?',
    repository: 'express-postgres-sample',
    probe: { graphSearch: 'UserRepository', node: 'UserRepository' },
    expected: { nodes: ['UserRepository'] },
  },
  {
    id: 'symbol-user-service',
    category: 'symbol_lookup',
    question: 'Where is UserService defined?',
    repository: 'express-postgres-sample',
    probe: { graphSearch: 'UserService' },
    expected: { nodes: ['UserService'] },
  },
  {
    id: 'symbol-method-by-qualified-name',
    category: 'symbol_lookup',
    question: 'Where is UserRepository.markVerified defined?',
    repository: 'express-postgres-sample',
    probe: { graphSearch: 'UserRepository.markVerified' },
    expected: { nodes: ['UserRepository.markVerified'] },
  },
  {
    id: 'symbol-interface',
    category: 'symbol_lookup',
    question: 'Where is the User model defined?',
    repository: 'express-postgres-sample',
    probe: { graphSearch: 'User' },
    expected: { nodes: ['User'] },
  },
  {
    id: 'symbol-auth-service',
    category: 'symbol_lookup',
    question: 'Where is AuthService defined?',
    repository: 'repository-knowledge-sample',
    probe: { graphSearch: 'AuthService', node: 'AuthService' },
    expected: { nodes: ['AuthService'] },
  },

  // --- code lookup ---------------------------------------------------------
  {
    id: 'code-user-repository-mentions',
    category: 'code_lookup',
    question: 'Where does the code mention UserRepository?',
    repository: 'express-postgres-sample',
    probe: { codeSearch: 'UserRepository', limit: 20 },
    expected: {
      files: ['src/app.ts', 'src/repositories/user.repository.ts', 'src/services/user.service.ts'],
    },
  },
  {
    id: 'code-class-declaration',
    category: 'code_lookup',
    question: 'Where is the UserService class declared, textually?',
    repository: 'express-postgres-sample',
    probe: { codeSearch: 'class UserService' },
    expected: {
      files: ['src/services/user.service.ts'],
      sourceMatches: [{ file: 'src/services/user.service.ts', line: 21 }],
    },
  },
  {
    id: 'code-sql-insert',
    category: 'code_lookup',
    question: 'Where is a row inserted into the users table?',
    repository: 'express-postgres-sample',
    probe: { codeSearch: 'INSERT INTO users' },
    expected: {
      files: ['src/repositories/user.repository.ts'],
      sourceMatches: [{ file: 'src/repositories/user.repository.ts', line: 13 }],
    },
  },
  {
    id: 'code-external-service-config',
    category: 'code_lookup',
    question: 'Where is SendGrid configured?',
    repository: 'express-postgres-sample',
    probe: { codeSearch: 'sendgrid', limit: 20 },
    expected: { files: ['src/config/app.config.ts', 'src/services/email.service.ts'] },
  },
  {
    id: 'code-case-sensitivity',
    category: 'code_lookup',
    question: 'Does a lower-cased query find the class? (it must not: search is literal)',
    repository: 'express-postgres-sample',
    probe: { codeSearch: 'userrepository' },
    // Nothing is expected, and nothing must be claimed: this case passes by
    // the search being case-sensitive, which the empty expectation asserts.
    expected: { files: [] },
  },

  // --- call relationships --------------------------------------------------
  {
    id: 'calls-who-calls-user-service',
    category: 'call_relationship',
    question: 'Who calls UserService?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserService' },
    expected: {
      relationships: [{ from: 'UserController', type: 'CALLS', to: 'UserService' }],
    },
  },
  {
    id: 'calls-what-user-service-calls',
    category: 'call_relationship',
    question: 'What does UserService call?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserService' },
    expected: {
      relationships: [
        { from: 'UserService', type: 'CALLS', to: 'UserRepository' },
        { from: 'UserService', type: 'CALLS', to: 'EmailService' },
        { from: 'UserService', type: 'CALLS', to: 'PaymentService' },
      ],
    },
  },
  {
    id: 'calls-who-calls-user-repository',
    category: 'call_relationship',
    question: 'Who calls UserRepository?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserRepository' },
    expected: { relationships: [{ from: 'UserService', type: 'CALLS', to: 'UserRepository' }] },
  },
  {
    id: 'calls-controller-members',
    category: 'call_relationship',
    question: 'What methods does UserController contain?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserController' },
    expected: {
      relationships: [
        { from: 'UserController', type: 'CONTAINS', to: 'UserController.create' },
        { from: 'UserController', type: 'CONTAINS', to: 'UserController.remove' },
      ],
    },
  },
  {
    id: 'calls-ts-sample-layers',
    category: 'call_relationship',
    question: 'Who calls UserRepository in the plain TypeScript sample?',
    repository: 'typescript-sample',
    probe: { node: 'UserRepository' },
    expected: { relationships: [{ from: 'UserService', type: 'CALLS', to: 'UserRepository' }] },
  },

  // --- database access -----------------------------------------------------
  {
    id: 'db-user-repository-reads',
    category: 'database_access',
    question: 'Where does UserRepository read from the database?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserRepository' },
    expected: {
      relationships: [{ from: 'UserRepository', type: 'READS_FROM', to: 'postgresql.users' }],
    },
  },
  {
    id: 'db-user-repository-writes',
    category: 'database_access',
    question: 'Where does UserRepository write to the database?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserRepository' },
    expected: {
      relationships: [{ from: 'UserRepository', type: 'WRITES_TO', to: 'postgresql.users' }],
    },
  },
  {
    id: 'db-second-table',
    category: 'database_access',
    question: 'Does UserRepository touch any table other than users?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserRepository' },
    expected: {
      relationships: [{ from: 'UserRepository', type: 'READS_FROM', to: 'postgresql.orders' }],
    },
  },
  {
    id: 'db-session-repository',
    category: 'database_access',
    question: 'Which table does SessionRepository use?',
    repository: 'repository-knowledge-sample',
    probe: { node: 'SessionRepository' },
    expected: {
      relationships: [
        { from: 'SessionRepository', type: 'READS_FROM', to: 'postgresql.sessions' },
        { from: 'SessionRepository', type: 'WRITES_TO', to: 'postgresql.sessions' },
      ],
    },
  },

  // --- implementation ------------------------------------------------------
  {
    id: 'impl-user-store',
    category: 'implementation',
    question: 'What implements the UserStore interface?',
    repository: 'typescript-sample',
    probe: { node: 'UserRepository' },
    expected: { relationships: [{ from: 'UserRepository', type: 'IMPLEMENTS', to: 'UserStore' }] },
  },
  {
    id: 'impl-base-controller',
    category: 'implementation',
    question: 'What does UserController extend?',
    repository: 'typescript-sample',
    probe: { node: 'UserController' },
    expected: { relationships: [{ from: 'UserController', type: 'EXTENDS', to: 'BaseController' }] },
  },

  // --- architecture --------------------------------------------------------
  {
    id: 'arch-route-to-controller',
    category: 'architecture',
    question: 'Which controller serves POST /users?',
    repository: 'express-postgres-sample',
    probe: { node: 'POST /users' },
    expected: {
      relationships: [{ from: 'POST /users', type: 'ROUTES_TO', to: 'UserController' }],
    },
    knownGap:
      'The ROUTES_TO edge is in the graph — a depth-1 traversal from this node returns it — but node detail reports no relationships for an api node.',
  },
  {
    id: 'arch-queue-publisher',
    category: 'architecture',
    question: 'What publishes to the welcome-emails queue?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserService' },
    expected: {
      relationships: [{ from: 'UserService', type: 'PUBLISHES', to: 'welcome-emails' }],
    },
  },
  {
    id: 'arch-event-publisher',
    category: 'architecture',
    question: 'What publishes the user.created event?',
    repository: 'express-postgres-sample',
    probe: { node: 'UserService' },
    expected: { relationships: [{ from: 'UserService', type: 'PUBLISHES', to: 'user.created' }] },
  },
  {
    id: 'arch-external-service',
    category: 'architecture',
    question: 'Which external service does EmailService use?',
    repository: 'express-postgres-sample',
    probe: { node: 'EmailService' },
    expected: { relationships: [{ from: 'EmailService', type: 'CALLS', to: 'sendgrid' }] },
  },
  {
    id: 'arch-routes-listed',
    category: 'architecture',
    question: 'What HTTP routes does this service expose?',
    repository: 'express-postgres-sample',
    probe: { graphSearch: 'users', limit: 50 },
    expected: { nodes: ['POST /users', 'GET /users', 'GET /users/:id'] },
  },

  {
    id: 'arch-queue-consumer',
    category: 'architecture',
    question: 'What publishes to, or consumes, the welcome-emails queue?',
    repository: 'express-postgres-sample',
    probe: { node: 'welcome-emails' },
    expected: {
      relationships: [{ from: 'UserService', type: 'PUBLISHES', to: 'welcome-emails' }],
    },
    knownGap:
      'Asked from the queue, nothing comes back. The PUBLISHES edge is only visible from UserService, so "what feeds this queue" is unanswerable without already knowing the answer.',
  },
  {
    id: 'arch-event-subscribers',
    category: 'architecture',
    question: 'What publishes the user.created event?',
    repository: 'express-postgres-sample',
    probe: { node: 'user.created' },
    expected: { relationships: [{ from: 'UserService', type: 'PUBLISHES', to: 'user.created' }] },
    knownGap: 'Same shape as the queue: an event node carries no relationships of its own.',
  },
  {
    id: 'arch-who-reads-the-table',
    category: 'database_access',
    question: 'What reads from the users table?',
    repository: 'express-postgres-sample',
    probe: { node: 'postgresql.users' },
    expected: {
      relationships: [{ from: 'UserRepository', type: 'READS_FROM', to: 'postgresql.users' }],
    },
    knownGap:
      'The reverse of db-user-repository-reads, which passes. Code → table is retrievable; table → code is not.',
  },
  {
    id: 'arch-service-dependencies',
    category: 'dependency',
    question: 'What does the service itself depend on?',
    repository: 'express-postgres-sample',
    probe: { node: 'users-service' },
    expected: {
      relationships: [
        { from: 'users-service', type: 'DEPENDS_ON', to: 'express' },
        { from: 'users-service', type: 'DEPENDS_ON_SERVICE', to: 'stripe' },
      ],
    },
  },
  {
    id: 'arch-table-columns',
    category: 'architecture',
    question: 'Which columns does the users table have?',
    repository: 'repository-knowledge-sample',
    probe: { node: 'postgresql.users' },
    expected: {
      relationships: [
        { from: 'postgresql.users', type: 'CONTAINS', to: 'postgresql.users.email' },
        { from: 'postgresql.users', type: 'CONTAINS', to: 'postgresql.users.role' },
      ],
    },
  },
  {
    id: 'arch-openapi-endpoints',
    category: 'architecture',
    question: 'Which operations does the OpenAPI specification declare?',
    repository: 'repository-knowledge-sample',
    probe: { graphSearch: 'users', limit: 50 },
    expected: { nodes: ['POST /users', 'GET /users/{id}'] },
  },
  {
    id: 'arch-config-properties',
    category: 'architecture',
    question: 'How is the database connection configured?',
    repository: 'repository-knowledge-sample',
    probe: { graphSearch: 'database', limit: 50 },
    expected: {
      nodes: ['config/app.config.json#database.host', 'config/app.config.json#database.port'],
    },
  },

  // --- cross-file flow -----------------------------------------------------
  {
    id: 'flow-controller-to-repository',
    category: 'cross_file_flow',
    question: 'How does UserController reach UserRepository?',
    repository: 'express-postgres-sample',
    probe: { trace: { from: 'UserController', to: 'UserRepository' } },
    expected: {
      path: {
        from: 'UserController',
        to: 'UserRepository',
        nodes: ['UserController', 'UserService', 'UserRepository'],
        relationships: ['CALLS'],
      },
      nodes: ['UserController', 'UserService', 'UserRepository'],
    },
  },
  {
    id: 'flow-controller-to-table',
    category: 'cross_file_flow',
    question: 'How does UserController reach the users table?',
    repository: 'express-postgres-sample',
    probe: { trace: { from: 'UserController', to: 'postgresql.users' } },
    expected: {
      path: {
        from: 'UserController',
        to: 'postgresql.users',
        nodes: ['UserController', 'UserService', 'UserRepository', 'postgresql.users'],
        relationships: ['CALLS', 'READS_FROM'],
      },
    },
  },
  {
    id: 'flow-request-to-store',
    category: 'cross_file_flow',
    question: 'How does a POST /users request reach the users table?',
    repository: 'express-postgres-sample',
    probe: { trace: { from: 'POST /users', to: 'postgresql.users' } },
    expected: {
      path: {
        from: 'POST /users',
        to: 'postgresql.users',
        nodes: [
          'POST /users',
          'UserController',
          'UserService',
          'UserRepository',
          'postgresql.users',
        ],
        relationships: ['ROUTES_TO', 'CALLS', 'READS_FROM'],
      },
    },
  },
  {
    id: 'flow-rkg-controller-to-table',
    category: 'cross_file_flow',
    question: 'How does UserController reach the users table in the knowledge fixture?',
    repository: 'repository-knowledge-sample',
    probe: { trace: { from: 'UserController', to: 'postgresql.users' } },
    expected: {
      path: {
        from: 'UserController',
        to: 'postgresql.users',
        nodes: ['UserController', 'UserService', 'UserRepository', 'postgresql.users'],
      },
    },
  },

  // --- trace path ----------------------------------------------------------
  {
    id: 'trace-service-to-queue',
    category: 'trace_path',
    question: 'How does UserService reach the welcome-emails queue?',
    repository: 'express-postgres-sample',
    probe: { trace: { from: 'UserService', to: 'welcome-emails' } },
    expected: {
      path: {
        from: 'UserService',
        to: 'welcome-emails',
        nodes: ['UserService', 'welcome-emails'],
        relationships: ['PUBLISHES'],
      },
    },
  },
  {
    id: 'trace-ts-sample-layers',
    category: 'trace_path',
    question: 'How does UserController reach UserRepository in the plain sample?',
    repository: 'typescript-sample',
    probe: { trace: { from: 'UserController', to: 'UserRepository' } },
    expected: {
      path: {
        from: 'UserController',
        to: 'UserRepository',
        nodes: ['UserController', 'UserService', 'UserRepository'],
        relationships: ['CALLS'],
      },
    },
  },
  {
    id: 'trace-auth-to-session-store',
    category: 'trace_path',
    question: 'How does AuthService reach the sessions table?',
    repository: 'repository-knowledge-sample',
    probe: { trace: { from: 'AuthService', to: 'postgresql.sessions' } },
    expected: {
      path: {
        from: 'AuthService',
        to: 'postgresql.sessions',
        nodes: ['AuthService', 'SessionRepository', 'postgresql.sessions'],
      },
    },
  },
  {
    id: 'trace-bounded-depth',
    category: 'trace_path',
    question: 'Is UserController within one hop of the users table? (it is not)',
    repository: 'express-postgres-sample',
    probe: { trace: { from: 'UserController', to: 'postgresql.users', maxDepth: 1 } },
    // The route is three hops, so a one-hop search must report no path rather
    // than reaching for a longer one. Stated as the negative it is, so the
    // right behaviour reads as a pass.
    expected: { noPath: true },
  },

  // --- source context ------------------------------------------------------
  {
    id: 'source-class-body',
    category: 'source_context',
    question: 'Show me the UserRepository class definition.',
    repository: 'express-postgres-sample',
    probe: { source: { file: 'src/repositories/user.repository.ts', aroundLine: 8 } },
    expected: {
      sourceMatches: [
        {
          file: 'src/repositories/user.repository.ts',
          line: 8,
          contains: 'export class UserRepository {',
        },
      ],
    },
  },
  {
    id: 'source-sql-statement',
    category: 'source_context',
    question: 'Show me the INSERT statement UserRepository.create runs.',
    repository: 'express-postgres-sample',
    probe: { source: { file: 'src/repositories/user.repository.ts', startLine: 11, endLine: 18 } },
    expected: {
      sourceMatches: [
        { file: 'src/repositories/user.repository.ts', contains: 'INSERT INTO users' },
      ],
    },
  },
  {
    id: 'source-found-then-read',
    category: 'source_context',
    question: 'Find where the welcome-email worker is defined and read it.',
    repository: 'express-postgres-sample',
    probe: {
      codeSearch: 'welcome-emails',
      source: { file: 'src/workers/welcome-email.worker.ts', aroundLine: 15 },
    },
    expected: {
      files: ['src/workers/welcome-email.worker.ts', 'src/services/user.service.ts'],
      sourceMatches: [{ file: 'src/workers/welcome-email.worker.ts', line: 15 }],
    },
  },

  // --- documentation -------------------------------------------------------
  {
    id: 'docs-what-documents-the-repository',
    category: 'documentation',
    question: 'What does the repository say about UserRepository?',
    repository: 'repository-knowledge-sample',
    probe: { node: 'UserRepository' },
    expected: {
      relationships: [
        { from: 'docs/architecture.md#persistence', type: 'DOCUMENTS', to: 'UserRepository' },
      ],
    },
  },
  {
    id: 'docs-contract-implemented-by',
    category: 'documentation',
    question: 'Which specification does UserController implement?',
    repository: 'repository-knowledge-sample',
    probe: { node: 'UserController' },
    expected: {
      relationships: [
        { from: 'POST /users', type: 'IMPLEMENTED_BY', to: 'UserController' },
      ],
    },
  },
  {
    id: 'docs-migration-defines-table',
    category: 'documentation',
    question: 'Which migration creates the users table?',
    repository: 'repository-knowledge-sample',
    probe: { node: 'postgresql.users' },
    expected: {
      relationships: [
        {
          from: 'database/migrations/0001_create_users.sql',
          type: 'DEFINES',
          to: 'postgresql.users',
        },
      ],
    },
  },

  // --- dependency ----------------------------------------------------------
  {
    id: 'dep-service-packages',
    category: 'dependency',
    question: 'Which third-party packages does this service depend on?',
    repository: 'express-postgres-sample',
    probe: { graphSearch: 'module', limit: 50 },
    expected: { nodes: ['express', 'pg', 'bullmq', 'stripe'] },
  },
  {
    id: 'dep-payment-external',
    category: 'dependency',
    question: 'Which external service does PaymentService talk to?',
    repository: 'express-postgres-sample',
    probe: { node: 'PaymentService' },
    expected: { relationships: [{ from: 'PaymentService', type: 'CALLS', to: 'stripe' }] },
  },
];
