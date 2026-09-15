import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  codeGraphSchema,
  codeNodeSchema,
  graphNodeParamsSchema,
  graphQuerySchema,
  graphSummarySchema,
  neighbourQuerySchema,
  nodeDetailSchema,
  projectIdParamSchema,
} from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { GraphService } from './graph.service.js';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function graphRoutes(service: GraphService): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/projects/:projectId/graph',
      {
        schema: {
          tags: ['graph'],
          summary: 'Traverse the code knowledge graph',
          description:
            'With `rootNodeId`, walks outward to `depth` hops. Without one, returns an overview: the most connected nodes and the edges between them. The full graph is never returned.',
          params: projectIdParamSchema,
          querystring: graphQuerySchema,
          response: { 200: envelopeSchema(codeGraphSchema), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const { rootNodeId, depth, nodeTypes, relationships, limit } = request.query;

        const result = await service.query({
          projectId: request.params.projectId,
          rootNodeId,
          depth,
          nodeTypes,
          relationships,
          limit,
        });

        return reply.send(
          success(
            { nodes: result.nodes, edges: result.edges },
            {
              mode: result.mode,
              rootNodeId: result.rootNodeId,
              depth: result.depth,
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
          summary: 'Node and edge totals, composition by node type, and the root node id',
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
          summary: 'Find nodes by symbol name or file path',
          params: projectIdParamSchema,
          querystring: searchQuerySchema,
          response: { 200: envelopeSchema(z.array(codeNodeSchema)), ...commonErrorResponses },
        },
      },
      async (request, reply) => {
        const nodes = await service.search(
          request.params.projectId,
          request.query.q,
          request.query.limit,
        );
        return reply.send(success(nodes, { total: nodes.length, query: request.query.q }));
      },
    );

    app.get(
      '/projects/:projectId/graph/nodes/:nodeId',
      {
        schema: {
          tags: ['graph'],
          summary: 'Node details with callers, callees and references',
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
  };
}
