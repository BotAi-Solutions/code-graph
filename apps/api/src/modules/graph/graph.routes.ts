import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  codeGraphSchema,
  codeNodeSchema,
  definitionSchema,
  graphNodeParamsSchema,
  graphPathBodySchema,
  graphPathSchema,
  graphQuerySchema,
  graphSearchQuerySchema,
  graphSummarySchema,
  neighbourQuerySchema,
  nodeDetailSchema,
  projectIdParamSchema,
  relatedNodeSchema,
  sourceTreeQuerySchema,
  sourceTreeSchema,
} from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { GraphService } from './graph.service.js';

export function graphRoutes(service: GraphService): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects/:projectId/graph',
      {
        schema: {
          tags: ['graph'],
          summary: 'Traverse the code knowledge graph',
          description:
            'With `rootNodeId`, walks outward to `depth` hops — `direction` narrows which way. Without one, returns an overview: the most connected nodes and the edges between them. `projection` (architecture, calls, files, dependencies, dataflow) supplies the node-type and relationship filters when none are given, and ranks the overview. The full graph is never returned.',
          params: projectIdParamSchema,
          querystring: graphQuerySchema,
          response: { 200: envelopeSchema(codeGraphSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const { rootNodeId, depth, projection, nodeTypes, relationships, direction, limit } =
          request.query;

        const result = await service.query({
          projectId: request.params.projectId,
          rootNodeId,
          depth,
          projection,
          nodeTypes,
          relationships,
          direction,
          limit,
        });

        return reply.send(
          success(
            { nodes: result.nodes, edges: result.edges },
            {
              mode: result.mode,
              rootNodeId: result.rootNodeId,
              depth: result.depth,
              direction: result.direction,
              projection: result.projection,
              nodeTypes: result.appliedNodeTypes,
              relationships: result.appliedRelationships,
              limit,
              nodeCount: result.nodes.length,
              edgeCount: result.edges.length,
              truncated: result.truncated,
            },
          ),
        );
      },
    );

    app.get(
      '/projects/:projectId/graph/summary',
      {
        schema: {
          tags: ['graph'],
          summary:
            'Node and edge totals, composition by node type and relationship, and the root node id',
          params: projectIdParamSchema,
          response: { 200: envelopeSchema(graphSummarySchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        return reply.send(success(await service.summary(request.params.projectId)));
      },
    );

    app.get(
      '/projects/:projectId/graph/search',
      {
        schema: {
          tags: ['graph'],
          summary: 'Find nodes by symbol name, qualified name, file path, API path or node type',
          description:
            'Matches `name`, `qualifiedName` and `filePath`, which between them cover a symbol (`UserService`), a member (`UserService.getUser`), a file (`user.service.ts`), a directory (`src/services`), a route (`POST /users`), a document section (`README.md#login-flow`), a configuration property (`package.json#scripts.build`) and a table column (`postgresql.users.email`). A term naming a node type also returns nodes of that type. Narrow with `nodeTypes` for exact types, `categories` for code / architecture / knowledge, and `file` for a path prefix; given several, a node must satisfy all of them. Results are paged; `meta.total` is the full count.',
          params: projectIdParamSchema,
          querystring: graphSearchQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const { q, nodeTypes, categories, file, limit, offset } = request.query;

        const result = await service.search(request.params.projectId, q, {
          nodeTypes,
          categories,
          file,
          limit,
          offset,
        });

        return reply.send(
          success(result.nodes, {
            total: result.total,
            limit: result.limit,
            offset: result.offset,
            query: q,
            // What was actually searched, after the category narrowing was
            // resolved: a caller that asked for "knowledge" can see which
            // types that meant rather than having to know the vocabulary.
            ...(result.nodeTypes ? { nodeTypes: result.nodeTypes } : {}),
            ...(categories ? { categories } : {}),
            ...(file ? { file } : {}),
          }),
        );
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId',
      {
        schema: {
          tags: ['graph'],
          summary: 'Node details with callers, callees, references, dependencies, APIs and data stores',
          description:
            'One round trip for everything the inspector shows. `callers`, `callees` and `references` are plain nodes; the remaining sections carry the relationship and its evidence alongside each entry.',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(nodeDetailSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const detail = await service.getNodeDetail(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(detail));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/callers',
      {
        schema: {
          tags: ['graph'],
          summary: 'Nodes that call this node',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getCallers(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/callees',
      {
        schema: {
          tags: ['graph'],
          summary: 'Nodes this node calls',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getCallees(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/references',
      {
        schema: {
          tags: ['graph'],
          summary: 'Nodes that reference this node',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getReferences(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/definition',
      {
        schema: {
          tags: ['graph'],
          summary: 'Where this node is written down',
          description:
            'The node\u2019s own source coordinates as the indexer recorded them, plus the id of the `file` node that contains it. `null` for a node with no file \u2014 a table, an external package \u2014 and null coordinates for one the indexer gave no range; neither is ever guessed at.',
          params: graphNodeParamsSchema,
          response: {
            200: envelopeSchema(definitionSchema.nullable()),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const definition = await service.getDefinition(
          request.params.projectId,
          request.params.nodeId,
        );
        return reply.send(success(definition));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/dependencies',
      {
        schema: {
          tags: ['graph'],
          summary: 'What this node depends on',
          description:
            'Outgoing DEPENDS_ON, DEPENDS_ON_SERVICE, IMPORTS and USES edges. Each entry carries the relationship that produced it and its evidence, because \u201cdepends on\u201d covers four different facts and the caller should be told which.',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(relatedNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getDependencies(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/dependents',
      {
        schema: {
          tags: ['graph'],
          summary: 'What depends on this node',
          description: 'The same four relationships as `dependencies`, read the other way.',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(relatedNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getDependents(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/parents',
      {
        schema: {
          tags: ['graph'],
          summary: 'The containment chain above this node, nearest first',
          description:
            'Method \u2192 class \u2192 file \u2192 directory \u2192 repository, following CONTAINS upward. `limit` caps how far up the chain is walked.',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getParents(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/children',
      {
        schema: {
          tags: ['graph'],
          summary: 'Nodes this one contains',
          description:
            'The members of a class, the symbols of a file, the entries of a directory \u2014 in source order where the indexer recorded positions.',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getChildren(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId/implementations',
      {
        schema: {
          tags: ['graph'],
          summary: 'What implements or extends this node, and what it implements',
          description:
            'Both directions of IMPLEMENTS and EXTENDS in one list. `direction: incoming` is something that implements or extends this node; `outgoing` is what this node implements or extends.',
          params: graphNodeParamsSchema,
          querystring: neighbourQuerySchema,
          response: { 200: envelopeSchema(z.array(relatedNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.getImplementations(
          request.params.projectId,
          request.params.nodeId,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length }));
      },
    );

    app.get(
      '/projects/:projectId/graph/tree',
      {
        schema: {
          tags: ['graph'],
          summary: 'One level of the repository tree',
          description:
            'Derived from the `directory` and `file` nodes the indexer already produced, so the tree costs a query rather than a second filesystem walk. One level per request: omit `path` for the root. Paths are repository-relative.',
          params: projectIdParamSchema,
          querystring: sourceTreeQuerySchema,
          response: { 200: envelopeSchema(sourceTreeSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const level = await service.tree(
          request.params.projectId,
          request.query.path,
          request.query.limit,
        );
        return reply.send(
          success(level, { total: level.entries.length, truncated: level.truncated }),
        );
      },
    );

    app.post(
      '/projects/:projectId/graph/path',
      {
        schema: {
          tags: ['graph'],
          summary: 'The shortest route between two nodes',
          description:
            'Breadth-first, server side, bounded by `maxDepth` and by a node budget. Directed by default \u2014 which is what a request-to-store trace means \u2014 falling back to an undirected search when no directed route exists and reporting `undirected: true` when it did. `found: false` with `truncated: true` means the budget ran out before the search could conclude, not that no route exists. No route is ever inferred: every hop is an edge in the graph, with its evidence.',
          params: projectIdParamSchema,
          body: graphPathBodySchema,
          response: { 200: envelopeSchema(graphPathSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const path = await service.findPath({
          projectId: request.params.projectId,
          from: request.body.from,
          to: request.body.to,
          maxDepth: request.body.maxDepth,
          direction: request.body.direction,
          relationships: request.body.relationships,
          nodeTypes: request.body.nodeTypes,
          projection: request.body.projection,
        });

        return reply.send(
          success(path, {
            found: path.found,
            depth: path.depth,
            undirected: path.undirected,
            maxDepth: request.body.maxDepth,
          }),
        );
      },
    );
  };
}
