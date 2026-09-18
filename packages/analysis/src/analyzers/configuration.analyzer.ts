import type {
  AnalysisContext,
  AnalysisResult,
  AnalysisStage,
  AnalyzerEdgeDraft,
  AnalyzerEnrichment,
  AnalyzerNodeDraft,
  CodeAnalyzer,
  NodeReference,
} from '@ckg/graph';
import { createNodeId, draftRef, nodeRef } from '@ckg/graph';
import { classifyFile, type FileClassification } from '@ckg/language-detection';
import { evidence } from '@ckg/shared';
import { configKindOf } from '../source/config-node.js';
import { ResourceTree } from '../source/resource-file.js';
import { structuredDocumentFor } from '../source/shared.js';
import { databaseDraft } from '../source/table-node.js';
import {
  asScalarText,
  asString,
  flatten,
  itemsOf,
  keysOf,
  member,
  stringItems,
  type StructuredDocument,
  type StructuredNode,
  type StructuredPath,
} from '../parsers/structured.js';
import { isOpenApiDocument } from '../parsers/openapi.js';

/**
 * What the repository is configured to be.
 *
 * The file analyzer already knows *which* files configure a service. This reads
 * what is inside them — and the hard part is not parsing, it is restraint. A
 * Kubernetes manifest has four hundred addressable paths and a graph node for
 * each of them is not repository intelligence, it is a YAML file redrawn as a
 * hairball.
 *
 * So promotion is by **profile**, one per recognised kind of file, and a file
 * with no profile promotes a strictly bounded slice of its top level:
 *
 *   package.json      scripts, workspaces, engine constraints
 *   tsconfig.json     the compiler options that change what the code *is*
 *   .env.example      variable names — never values, ever
 *   compose           services, as container nodes, with their images and links
 *   Dockerfile        base images and exposed ports, as metadata
 *   CI workflow       job names
 *   anything else     scalar paths at most two levels deep, capped
 *
 * ## Values
 *
 * A promoted property records its value only when the value is safe to record:
 * never from a live `.env` (which is never read at all), and never under a key
 * that names a credential. A graph that leaks a password is worse than a graph
 * that is missing a property.
 */

const ANALYZER = 'configuration-analyzer';

/** Properties promoted from one file, whichever profile applied. */
const MAX_PROPERTIES_PER_FILE = 60;
/** Paths promoted from a file with no profile. */
const MAX_GENERIC_PROPERTIES = 25;
/** How deep a generic promotion goes: `database.host`, not `a.b.c.d`. */
const GENERIC_DEPTH = 2;

/** Keys whose value is a credential however it is spelled. */
const SECRET_KEY = /(password|passwd|secret|token|credential|api[-_]?key|private[-_]?key|access[-_]?key|auth)/i;

/** Compiler options that change what the code means, rather than where it goes. */
const TSCONFIG_OPTIONS = [
  'target',
  'module',
  'moduleResolution',
  'strict',
  'jsx',
  'composite',
  'lib',
  'types',
  'outDir',
  'rootDir',
  'baseUrl',
] as const;

/** Container images whose name declares a database provider. */
const IMAGE_PROVIDERS: ReadonlyMap<string, string> = new Map([
  ['postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
  ['mysql', 'mysql'],
  ['mariadb', 'mysql'],
  ['mongo', 'mongodb'],
  ['mongodb', 'mongodb'],
]);

/** Directories whose contents are configuration whatever the file is called. */
const CONFIG_DIRECTORIES = new Set([
  'config',
  'configs',
  'deploy',
  'deployment',
  'deployments',
  '.github',
  'k8s',
  'kubernetes',
  'helm',
  'charts',
]);

const STRUCTURED_SUFFIXES = ['.json', '.jsonc', '.yaml', '.yml'] as const;

export class ConfigurationAnalyzer implements CodeAnalyzer {
  readonly name = ANALYZER;
  readonly stage: AnalysisStage = 'source';

  supports(context: AnalysisContext): boolean {
    return context.sources.all().length > 0;
  }

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    const repository = context.symbols.repository();
    const tree = new ResourceTree(repository?.id ?? null, ANALYZER);

    const nodes: AnalyzerNodeDraft[] = [];
    const enrichments: AnalyzerEnrichment[] = [];
    const edges: AnalyzerEdgeDraft[] = [];
    const diagnostics: string[] = [];
    const containers = new Map<string, AnalyzerNodeDraft>();

    let fileCount = 0;
    let propertyCount = 0;
    let parseErrorCount = 0;

    for (const file of context.sources.all()) {
      const classification = classifyFile(file.relativePath);
      if (!this.owns(classification)) continue;

      fileCount += 1;

      // A file the compiler indexed is already a node — `vite.config.ts` is
      // configuration *and* code — so its properties hang off the node that
      // exists rather than a second one on top of it.
      const indexed = context.symbols.file(file.relativePath);

      const facts: Record<string, unknown> = {
        category: classification.category,
        ...(classification.role !== null ? { role: classification.role } : {}),
        configKind: configKindOf(file.relativePath) ?? classification.role ?? 'configuration',
        // Read before the node is built, because a Dockerfile's base images and
        // exposed ports describe the container rather than being things in the
        // repository, and the node they belong on is this one.
        ...(classification.role === 'dockerfile' ? dockerfileFacts(file.text) : {}),
      };

      const owner: NodeReference = indexed
        ? nodeRef(indexed.id)
        : tree.file({ classification, type: 'config', metadata: facts });

      // The file analyzer runs earlier in this same stage and declares a
      // `config` node for most of these files first. Identity is a content
      // hash, so that is the *same* node — but the accumulator's first writer
      // wins on metadata, so what this analyzer learned about the file is
      // added rather than declared, or it would be silently discarded.
      enrichments.push({
        nodeId: indexed
          ? indexed.id
          : createNodeId(context.identity, {
              type: 'config',
              filePath: file.relativePath,
              symbolKey: file.relativePath,
            }),
        metadata: facts,
      });

      const promoted = this.read(context, classification, file.text, owner, {
        nodes,
        edges,
        containers,
      });

      propertyCount += promoted.properties;
      if (promoted.parseError !== null) {
        parseErrorCount += 1;
        diagnostics.push(`${file.relativePath}: ${promoted.parseError}`);
      }
      if (promoted.partial) {
        diagnostics.push(
          `${file.relativePath}: multi-document stream; only the first document was read`,
        );
      }
    }

    return {
      nodes: [...tree.nodes(), ...nodes, ...containers.values()],
      edges: [...tree.edges(), ...edges],
      enrichments,
      stats: {
        configFileCount: fileCount,
        propertyCount,
        containerCount: containers.size,
        configParseErrorCount: parseErrorCount,
      },
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  /**
   * Whether this analyzer has anything to say about a file.
   *
   * Two populations: the files the file analyzer already calls configuration —
   * so the two agree on what a `config` node is — plus CI workflows and
   * configuration that lives in a configuration directory or announces itself
   * in its name. Everything else, including the repository's fixtures and its
   * data files, is left alone. That boundary is what keeps a repository full of
   * JSON from becoming a graph full of JSON.
   */
  private owns(classification: FileClassification): boolean {
    if (classification.category === 'generated' || classification.category === 'vendor') {
      return false;
    }
    if (configKindOf(classification.path) !== null) return true;
    if (classification.role === 'ci-workflow') return true;
    if (classification.category !== 'configuration') return false;

    const segments = classification.path.split('/').slice(0, -1);
    if (segments.some((segment) => CONFIG_DIRECTORIES.has(segment.toLowerCase()))) return true;

    return classification.name.toLowerCase().includes('config');
  }

  private read(
    context: AnalysisContext,
    classification: FileClassification,
    text: string,
    owner: NodeReference,
    sink: {
      nodes: AnalyzerNodeDraft[];
      edges: AnalyzerEdgeDraft[];
      containers: Map<string, AnalyzerNodeDraft>;
    },
  ): { properties: number; parseError: string | null; partial: boolean } {
    const path = classification.path;

    // A Dockerfile's facts are already on its node: they were read before it
    // was created, because a base image describes the container rather than
    // being a thing in the repository, and a port is not an entity.
    if (classification.role === 'dockerfile') {
      return { properties: 0, parseError: null, partial: false };
    }
    if (classification.role === 'env-example') {
      return { properties: this.envExample(path, text, owner, sink), parseError: null, partial: false };
    }
    // A live `.env` is listed but never read; the loader hands us empty text
    // for it and there is nothing here to promote.
    if (classification.role === 'env') {
      return { properties: 0, parseError: null, partial: false };
    }

    if (!STRUCTURED_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix))) {
      return { properties: 0, parseError: null, partial: false };
    }

    const document = structuredDocumentFor(context.sources, path);
    if (!document) return { properties: 0, parseError: null, partial: false };
    if (document.error !== null) {
      return { properties: 0, parseError: document.error, partial: false };
    }
    if (!document.root) return { properties: 0, parseError: null, partial: false };

    // A specification is the OpenAPI analyzer's file, not this one's: it owns
    // the `api_spec` node and the endpoints, and promoting `paths./users.post`
    // as a configuration property would describe it twice and worse.
    if (isOpenApiDocument(document)) return { properties: 0, parseError: null, partial: false };

    const partial = 'documentCount' in document && (document as { documentCount: number }).documentCount > 1;

    const properties = this.promote(classification, document, owner, sink);
    return { properties, parseError: null, partial };
  }

  /** Dispatches to the profile for this file, or to the bounded generic one. */
  private promote(
    classification: FileClassification,
    document: StructuredDocument,
    owner: NodeReference,
    sink: {
      nodes: AnalyzerNodeDraft[];
      edges: AnalyzerEdgeDraft[];
      containers: Map<string, AnalyzerNodeDraft>;
    },
  ): number {
    const root = document.root;
    if (!root) return 0;

    const path = classification.path;
    const add = (
      key: string,
      line: number,
      column: number,
      value: string | null,
      metadata: Record<string, unknown> = {},
    ): void => {
      const draft = propertyDraft(path, key, line, column, value, metadata);
      sink.nodes.push(draft);
      sink.edges.push({
        from: owner,
        to: draftRef(draft),
        relationship: 'CONTAINS',
        evidence: evidence({
          source: ANALYZER,
          basis: 'declaredInSpec',
          method: document.format,
          file: path,
          line,
          column,
          matched: key,
        }),
      });
    };

    switch (classification.role) {
      case 'package-manifest':
        return this.manifest(root, add);
      case 'typescript-config':
        return this.tsconfig(root, add);
      case 'compose':
        return this.compose(path, root, owner, sink);
      case 'ci-workflow':
        return this.workflow(root, add);
      default:
        return this.generic(root, add);
    }
  }

  // --- profiles ------------------------------------------------------------

  /**
   * `package.json`.
   *
   * Scripts, because they are the repository's own list of what it can do, and
   * nothing else in the graph says it. Not dependencies: the import analyzer
   * already creates a node per package and a `DEPENDS_ON` edge from the
   * service to each, which is the same fact at a more useful altitude.
   */
  private manifest(root: StructuredNode, add: AddProperty): number {
    let count = 0;

    const scripts = member(root, 'scripts');
    for (const entry of scripts?.entries ?? []) {
      if (count >= MAX_PROPERTIES_PER_FILE) break;
      count += 1;
      add(`scripts.${entry.key}`, entry.keyPosition.line, entry.keyPosition.column, asString(entry.value), {
        script: entry.key,
      });
    }

    const engines = member(root, 'engines');
    for (const entry of engines?.entries ?? []) {
      if (count >= MAX_PROPERTIES_PER_FILE) break;
      count += 1;
      add(
        `engines.${entry.key}`,
        entry.keyPosition.line,
        entry.keyPosition.column,
        asScalarText(entry.value),
      );
    }

    const workspaces = member(root, 'workspaces');
    const patterns =
      workspaces?.kind === 'array' ? stringItems(workspaces) : stringItems(member(workspaces, 'packages'));

    patterns.forEach((pattern, index) => {
      if (count >= MAX_PROPERTIES_PER_FILE) return;
      count += 1;
      const item = itemsOf(workspaces)[index] ?? workspaces;
      add(`workspaces[${String(index)}]`, item?.line ?? root.line, item?.column ?? 0, pattern, {
        workspace: pattern,
      });
    });

    return count;
  }

  /** `tsconfig.json`: the options that change what the code means. */
  private tsconfig(root: StructuredNode, add: AddProperty): number {
    let count = 0;

    const extended = member(root, 'extends');
    if (extended) {
      count += 1;
      add('extends', extended.line, extended.column, asScalarText(extended));
    }

    const options = member(root, 'compilerOptions');
    for (const option of TSCONFIG_OPTIONS) {
      const entry = options?.entries?.find((candidate) => candidate.key === option);
      if (!entry) continue;

      count += 1;
      add(
        `compilerOptions.${option}`,
        entry.keyPosition.line,
        entry.keyPosition.column,
        entry.value.kind === 'array'
          ? stringItems(entry.value).join(', ')
          : asScalarText(entry.value),
      );
    }

    return count;
  }

  /**
   * A compose file: one `container` node per service.
   *
   * A container is keyed by its service name alone, with no file path, so a
   * base compose file and its override describe one container rather than two.
   * `depends_on` becomes a real edge between them, and an image that names a
   * database provider links the container to the same `database` node the
   * database analyzer creates — which is a cross-source relationship resting on
   * nothing but two declarations agreeing.
   */
  private compose(
    path: string,
    root: StructuredNode,
    owner: NodeReference,
    sink: {
      nodes: AnalyzerNodeDraft[];
      edges: AnalyzerEdgeDraft[];
      containers: Map<string, AnalyzerNodeDraft>;
    },
  ): number {
    const services = member(root, 'services');
    if (services?.kind !== 'object') return 0;

    let count = 0;

    for (const entry of services.entries ?? []) {
      if (count >= MAX_PROPERTIES_PER_FILE) break;
      count += 1;

      const service = entry.value;
      const image = asString(member(service, 'image'));
      const build = member(service, 'build');

      const draft = containerDraft(entry.key, {
        declaredIn: path,
        ...(image !== null ? { image } : {}),
        ...(build !== undefined ? { built: true } : {}),
        ...(keysOf(member(service, 'environment')).length > 0
          ? { environment: keysOf(member(service, 'environment')) }
          : {}),
        ports: stringItems(member(service, 'ports')).length,
      });

      // A container may already be present as the bare target of another
      // service's `depends_on`. The declaration is richer than the reference,
      // so it replaces it; the id is the same either way.
      const existing = sink.containers.get(draft.symbolKey);
      if (!existing || existing.metadata?.declaredIn === undefined) {
        sink.containers.set(draft.symbolKey, draft);
      }
      const containerRef = draftRef(draft);

      sink.edges.push({
        from: owner,
        to: containerRef,
        relationship: 'DEFINES',
        evidence: evidence({
          source: ANALYZER,
          basis: 'declaredInSpec',
          method: 'yaml',
          file: path,
          line: entry.keyPosition.line,
          column: entry.keyPosition.column,
          matched: entry.key,
        }),
        metadata: image !== null ? { image } : {},
      });

      const provider = image === null ? null : IMAGE_PROVIDERS.get(imageName(image));
      if (provider) {
        sink.edges.push({
          from: containerRef,
          to: draftRef(databaseDraft(provider, `${path}:${entry.key}`)),
          relationship: 'USES',
          evidence: evidence({
            source: ANALYZER,
            basis: 'declaredInSpec',
            method: 'yaml',
            file: path,
            line: entry.keyPosition.line,
            matched: image ?? provider,
          }),
          metadata: { image, provider },
        });
      }

      for (const dependency of dependsOn(service)) {
        // A service may depend on one another file defines. Declaring the node
        // here is what keeps the edge from being dropped for want of a target.
        const dependencyDraft = containerDraft(dependency, {});
        if (!sink.containers.has(dependencyDraft.symbolKey)) {
          sink.containers.set(dependencyDraft.symbolKey, dependencyDraft);
        }

        sink.edges.push({
          from: containerRef,
          to: draftRef(dependencyDraft),
          relationship: 'DEPENDS_ON',
          evidence: evidence({
            source: ANALYZER,
            basis: 'declaredInSpec',
            method: 'yaml',
            file: path,
            line: entry.keyPosition.line,
            matched: dependency,
          }),
        });
      }
    }

    return count;
  }

  /** A CI workflow: its jobs, which is what the pipeline actually does. */
  private workflow(root: StructuredNode, add: AddProperty): number {
    const jobs = member(root, 'jobs');
    if (jobs?.kind !== 'object') return 0;

    let count = 0;

    for (const entry of jobs.entries ?? []) {
      if (count >= MAX_PROPERTIES_PER_FILE) break;
      count += 1;

      add(`jobs.${entry.key}`, entry.keyPosition.line, entry.keyPosition.column, null, {
        job: entry.key,
        ...(asString(member(entry.value, 'runs-on')) !== null
          ? { runsOn: asString(member(entry.value, 'runs-on')) }
          : {}),
        stepCount: itemsOf(member(entry.value, 'steps')).length,
      });
    }

    return count;
  }

  /**
   * A configuration file with no profile.
   *
   * Scalar leaves at most two levels down — `port`, `database.host` — and no
   * more than twenty-five of them. Deliberately shallow: the useful thing about
   * an unfamiliar configuration file is its shape, and its shape is its top two
   * levels. Everything below that is detail the source view can show.
   */
  private generic(root: StructuredNode, add: AddProperty): number {
    const paths = flatten(root, {
      maxDepth: GENERIC_DEPTH,
      maxPaths: MAX_GENERIC_PROPERTIES * 4,
      scalarsOnly: true,
    }).slice(0, MAX_GENERIC_PROPERTIES);

    for (const entry of paths) {
      add(entry.path, entry.keyPosition.line, entry.keyPosition.column, asScalarText(entry.node));
    }

    return paths.length;
  }

  // --- non-structured formats ---------------------------------------------

  /**
   * `.env.example`: the names of the variables a deployment must supply.
   *
   * Names only. The whole reason an example file exists is that it holds the
   * shape without the secrets, and this keeps that promise even though the
   * values in it are placeholders — the file could be wrong about that, and
   * the graph must not be the place it matters.
   */
  private envExample(
    path: string,
    text: string,
    owner: NodeReference,
    sink: { nodes: AnalyzerNodeDraft[]; edges: AnalyzerEdgeDraft[] },
  ): number {
    let count = 0;

    text.split('\n').forEach((line, index) => {
      if (count >= MAX_PROPERTIES_PER_FILE) return;

      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) return;

      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
      const variable = match?.[1];
      if (variable === undefined) return;

      count += 1;
      const draft = propertyDraft(path, variable, index + 1, 0, null, { variable });
      sink.nodes.push(draft);
      sink.edges.push({
        from: owner,
        to: draftRef(draft),
        relationship: 'CONTAINS',
        evidence: evidence({
          source: ANALYZER,
          basis: 'declaredInSpec',
          method: 'configuration',
          file: path,
          line: index + 1,
          matched: variable,
        }),
      });
    });

    return count;
  }

}

/**
 * What a Dockerfile declares, as metadata for its node.
 *
 * Three instructions, each unambiguous: what it builds on, what it listens on,
 * and how many stages it has. Everything else in a Dockerfile is a shell
 * script, and reading shell scripts is not what this pipeline does.
 */
export function dockerfileFacts(text: string): Record<string, unknown> {
  const baseImages: string[] = [];
  const ports: number[] = [];
  let stages = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const from = /^from\s+(\S+)(?:\s+as\s+\S+)?/i.exec(line);
    if (from?.[1] !== undefined) {
      stages += 1;
      if (!baseImages.includes(from[1])) baseImages.push(from[1]);
      continue;
    }

    const expose = /^expose\s+(.+)$/i.exec(line);
    if (expose?.[1] !== undefined) {
      for (const part of expose[1].split(/\s+/)) {
        const port = Number.parseInt(part.split('/')[0] ?? '', 10);
        if (Number.isInteger(port) && !ports.includes(port)) ports.push(port);
      }
    }
  }

  return {
    ...(baseImages.length > 0 ? { baseImages } : {}),
    ...(ports.length > 0 ? { exposedPorts: ports } : {}),
    ...(stages > 1 ? { buildStages: stages } : {}),
  };
}

type AddProperty = (
  key: string,
  line: number,
  column: number,
  value: string | null,
  metadata?: Record<string, unknown>,
) => void;

/**
 * A promoted configuration property.
 *
 * Identified by file and dotted key, so the same key in two files is two
 * properties — which it is — and the same key read twice is one.
 */
function propertyDraft(
  path: string,
  key: string,
  line: number,
  column: number,
  value: string | null,
  extra: Record<string, unknown> = {},
): AnalyzerNodeDraft {
  const metadata: Record<string, unknown> = { key, ...extra };

  // Recorded only when it is safe to record. A key that names a credential
  // keeps its name in the graph and loses its value, which is the whole of
  // what the graph needed from it anyway.
  if (value !== null && !SECRET_KEY.test(key)) metadata.value = truncate(value);
  else if (value !== null) metadata.redacted = true;

  return {
    type: 'config_property',
    name: key,
    symbolKey: `${path}#${key}`,
    qualifiedName: `${path}#${key}`,
    filePath: path,
    startLine: line,
    startCharacter: column,
    metadata,
  };
}

/** Values longer than this are a payload, not a setting. */
const MAX_VALUE_LENGTH = 200;

function truncate(value: string): string {
  return value.length <= MAX_VALUE_LENGTH ? value : `${value.slice(0, MAX_VALUE_LENGTH)}…`;
}

function containerDraft(name: string, extra: Record<string, unknown>): AnalyzerNodeDraft {
  return {
    type: 'container',
    name,
    // The service name alone: a base compose file and its override describe one
    // container, and the same container across two files is still one.
    symbolKey: `container:${name}`,
    qualifiedName: name,
    metadata: { service: name, ...extra },
  };
}

/** `postgres:16-alpine` -> `postgres`; `docker.io/library/mysql:8` -> `mysql`. */
function imageName(image: string): string {
  const withoutTag = image.split('@')[0]?.split(':')[0] ?? image;
  return (withoutTag.split('/').pop() ?? withoutTag).toLowerCase();
}

/** `depends_on` is a list in the short form and a map in the long one. */
function dependsOn(service: StructuredNode): string[] {
  const node = member(service, 'depends_on');
  if (node?.kind === 'array') return stringItems(node);
  if (node?.kind === 'object') return keysOf(node);
  return [];
}

/** Exported for the tests that pin the promotion bounds. */
export const CONFIGURATION_LIMITS = {
  maxPropertiesPerFile: MAX_PROPERTIES_PER_FILE,
  maxGenericProperties: MAX_GENERIC_PROPERTIES,
  genericDepth: GENERIC_DEPTH,
} as const;

export type { StructuredPath };
