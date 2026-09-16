import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  browseDirectoryQuerySchema,
  directoryListingSchema,
  inspectProjectQuerySchema,
  projectMetadataSchema,
  selectedDirectorySchema,
} from '@ckg/shared';
import { commonErrorResponses, envelopeSchema, success } from '../../common/utils/response.js';
import type { FilesystemService } from './filesystem.service.js';

/**
 * The local project intake routes.
 *
 * HTTP rather than IPC because this application is already an HTTP one: the
 * browser talks to a Fastify process running on the same machine, and that
 * process is the local runtime. Adding a second transport for three routes
 * would be a second architecture for no gain.
 */
export function filesystemRoutes(service: FilesystemService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/filesystem/select-directory',
      {
        schema: {
          tags: ['filesystem'],
          summary: "Open the host's native folder dialog",
          description:
            'Blocks until the user chooses a folder or dismisses the dialog. Returns null when they dismissed it, which is not an error. 501 when the host has no dialog to show — use the directory browser instead.',
          response: {
            200: envelopeSchema(selectedDirectorySchema.nullable()),
            ...commonErrorResponses,
          },
        },
      },
      async (_request, reply) => {
        const selected = await service.pickDirectory();
        return reply.send(success(selected));
      },
    );

    app.get(
      '/filesystem/directories',
      {
        schema: {
          tags: ['filesystem'],
          summary: 'List the subdirectories of a directory',
          description:
            "The in-app folder browser, for hosts with no native dialog. Directories only — this API never lists or reads files. Defaults to the home directory of the user running the API.",
          querystring: browseDirectoryQuerySchema,
          response: {
            200: envelopeSchema(directoryListingSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const listing = await service.listDirectories(request.query.path);
        return reply.send(success(listing));
      },
    );

    app.get(
      '/filesystem/project',
      {
        schema: {
          tags: ['filesystem'],
          summary: 'Scan a directory and report what is in it',
          description:
            'One filesystem walk, no file reads: file and directory counts and a per-language breakdown, so a folder can be checked before it is indexed. 422 when nothing in it is a language we support.',
          querystring: inspectProjectQuerySchema,
          response: {
            200: envelopeSchema(projectMetadataSchema),
            ...commonErrorResponses,
          },
        },
      },
      async (request, reply) => {
        const metadata = await service.inspectProject(request.query.path);
        return reply.send(success(metadata));
      },
    );
  };
}
