import { describe, expect, it } from 'vitest';
import { ownerSymbolId, parseScipSymbol, symbolDisplayName } from '@ckg/scip';

const PREFIX = 'scip-typescript npm typescript-sample 1.0.0 ';

describe('parseScipSymbol', () => {
  it('splits the package header from the descriptors', () => {
    const identity = parseScipSymbol(`${PREFIX}src/models/\`user.ts\`/User#`);

    expect(identity.scheme).toBe('scip-typescript');
    expect(identity.packageManager).toBe('npm');
    expect(identity.packageName).toBe('typescript-sample');
    expect(identity.packageVersion).toBe('1.0.0');
    expect(identity.isLocal).toBe(false);
  });

  it('parses the descriptor chain, including backtick-escaped names', () => {
    const identity = parseScipSymbol(`${PREFIX}src/models/\`user.ts\`/User#id.`);

    expect(identity.descriptors).toEqual([
      { name: 'src', suffix: 'namespace' },
      { name: 'models', suffix: 'namespace' },
      { name: 'user.ts', suffix: 'namespace' },
      { name: 'User', suffix: 'type' },
      { name: 'id', suffix: 'term' },
    ]);
  });

  it('parses method descriptors with a disambiguator', () => {
    const identity = parseScipSymbol(`${PREFIX}src/\`a.ts\`/C#m(+1).`);

    expect(identity.descriptors.at(-1)).toEqual({
      name: 'm',
      suffix: 'method',
      disambiguator: '+1',
    });
  });

  it('parses parameter and type-parameter descriptors', () => {
    const parameter = parseScipSymbol(`${PREFIX}src/\`a.ts\`/C#m().(id)`);
    expect(parameter.descriptors.at(-1)).toEqual({ name: 'id', suffix: 'parameter' });

    const typeParameter = parseScipSymbol(`${PREFIX}src/\`a.ts\`/C#[T]`);
    expect(typeParameter.descriptors.at(-1)).toEqual({ name: 'T', suffix: 'type-parameter' });
  });

  it('recognises local symbols, which are file-scoped', () => {
    const identity = parseScipSymbol('local 12');

    expect(identity.isLocal).toBe(true);
    expect(identity.ownerId).toBeNull();
    expect(identity.descriptors).toEqual([{ name: '12', suffix: 'local' }]);
  });

  it('derives the owning symbol from the descriptor chain', () => {
    const method = parseScipSymbol(`${PREFIX}src/\`a.ts\`/C#m().`);
    expect(ownerSymbolId(method)).toBe(`${PREFIX}src/\`a.ts\`/C#`);

    const klass = parseScipSymbol(`${PREFIX}src/\`a.ts\`/C#`);
    expect(ownerSymbolId(klass)).toBe(`${PREFIX}src/\`a.ts\`/`);
  });

  it('derives the owner correctly through backtick-escaped segments', () => {
    const symbol = `${PREFIX}src/\`user.controller.ts\`/UserController#getUser().`;
    const owner = ownerSymbolId(parseScipSymbol(symbol));

    expect(owner).toBe(`${PREFIX}src/\`user.controller.ts\`/UserController#`);
    // The owner must itself be a parseable symbol, or containment breaks.
    expect(parseScipSymbol(owner as string).descriptors.at(-1)?.suffix).toBe('type');
  });

  it('has no owner for a top-level descriptor', () => {
    expect(ownerSymbolId(parseScipSymbol(`${PREFIX}src/`))).toBeNull();
  });

  it('degrades to a best-effort identity rather than throwing on a malformed symbol', () => {
    const identity = parseScipSymbol(`${PREFIX}src/\`unterminated`);

    expect(identity.descriptors).toEqual([]);
    expect(identity.packageName).toBe('typescript-sample');
    expect(symbolDisplayName(identity)).toBe('typescript-sample');
  });

  it('names a symbol by its trailing descriptor', () => {
    expect(symbolDisplayName(parseScipSymbol(`${PREFIX}src/\`a.ts\`/C#m().`))).toBe('m');
  });
});
