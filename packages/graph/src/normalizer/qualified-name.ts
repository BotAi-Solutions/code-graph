import type { ScipSymbolIdentity } from '@ckg/scip';

/**
 * The dotted name that identifies a symbol within its file: `UserService` for a
 * class, `UserService.getUser` for one of its methods.
 *
 * Derived from the SCIP descriptor chain rather than from source text, so it is
 * as stable as the symbol string itself.
 *
 * Indexers prefix every symbol with the file it was declared in, and they spell
 * that prefix as one namespace descriptor per path segment:
 *
 *   scip-typescript npm users-service 1.2.0 src/repositories/`user.repository.ts`/UserRepository#create().
 *   descriptors: src · repositories · user.repository.ts · UserRepository · create
 *
 * Those leading segments are dropped, because `filePath` already carries them
 * and `src.repositories.user.repository.ts.UserRepository.create` is not a name
 * anybody would type. What remains is the name analyzers resolve against:
 * given a file and a dotted name there is exactly one node, with no name
 * matching across the repository.
 */
export function qualifiedNameOf(identity: ScipSymbolIdentity, relativePath: string): string {
  const descriptors = identity.descriptors;

  const names = descriptors
    .slice(filePrefixLength(descriptors, relativePath))
    .map((descriptor) => descriptor.name)
    .filter((name) => name.length > 0);

  return names.join('.');
}

/**
 * How many leading descriptors spell out the document's own path.
 *
 * Accumulates namespace descriptors while they remain a prefix of the path and
 * returns the length of the longest run that reconstructs it. Returns 0 when
 * nothing matches, which is the right answer for an indexer that spells the
 * prefix some other way — the qualified name is then merely longer, never wrong.
 */
function filePrefixLength(
  descriptors: ScipSymbolIdentity['descriptors'],
  relativePath: string,
): number {
  let matched = 0;
  let accumulated = '';

  for (const [index, descriptor] of descriptors.entries()) {
    if (descriptor.suffix !== 'namespace') break;

    accumulated = accumulated === '' ? descriptor.name : `${accumulated}/${descriptor.name}`;

    if (relativePath === accumulated || relativePath.endsWith(`/${accumulated}`)) {
      matched = index + 1;
      continue;
    }

    // Still climbing towards the file: `src`, then `src/repositories`, ...
    if (relativePath === accumulated || relativePath.startsWith(`${accumulated}/`)) continue;
    if (relativePath.includes(`/${accumulated}/`)) continue;

    break;
  }

  return matched;
}

/**
 * Whether a symbol describes *another* package's surface rather than this
 * repository's code.
 *
 * A declaration file may declare modules it does not own:
 *
 *   declare module 'pg' { export class Pool { ... } }
 *
 * The indexer reports `Pool` as a class defined in this repository, because
 * syntactically it is. Semantically it is a description of `pg`, and putting it
 * in the graph makes the repository look like it declares a database driver.
 * The dependency on `pg` is already a node — the import analyzer creates one —
 * so nothing is lost by leaving these out and a false claim is avoided.
 *
 * The test is exact rather than heuristic: an ambient module declaration's
 * namespace descriptor is the quoted module specifier, and a real identifier
 * cannot start with a quote.
 */
export function declaresForeignModule(identity: ScipSymbolIdentity): boolean {
  for (const descriptor of identity.descriptors) {
    if (descriptor.suffix !== 'namespace') break;

    const name = descriptor.name;
    if (name.startsWith("'") || name.startsWith('"')) return true;
  }
  return false;
}
