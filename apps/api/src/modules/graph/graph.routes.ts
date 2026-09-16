import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  codeGraphSchema,
  codeNodeSchema,
  graphNodeParamsSchema,
  graphQuerySchema,
  graphSearchQuerySchema,
  graphSummarySchema,
  neighbourQuerySchema,
  nodeDetailSchema,
  projectIdParamSchema,
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
            'Matches `name`, `qualifiedName` and `filePath`, which between them cover a symbol (`UserService`), a member (`UserService.getUser`), a file (`user.service.ts`), a directory (`src/services`) and a route (`POST /users`). A term naming a node type also returns nodes of that type. Results are paged; `meta.total` is the full count.',
          params: projectIdParamSchema,
          querystring: graphSearchQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const { q, nodeTypes, limit, offset } = request.query;

        const result = await service.search(request.params.projectId, q, {
          nodeTypes,
          limit,
          offset,
        });

        return reply.send(
          success(result.nodes, {
            total: result.total,
            limit: result.limit,
            offset: result.offset,
            query: q,
            ...(nodeTypes ? { nodeTypes } : {}),
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
  };
}
