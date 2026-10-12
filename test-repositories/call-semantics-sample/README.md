# call-semantics-sample

The benchmark's golden fixture for code relationships. It is small on purpose:
every `CALLS`, `REFERENCES`, `IMPORTS`, `EXTENDS` and `IMPLEMENTS` relationship
in it is written down by hand in
`packages/benchmark/ground-truth/call-semantics-sample/`, so precision is a real
measurement for all five.

Each file sets a trap a code graph can fall into:

```
src/contracts.ts  an interface that extends two interfaces
src/geometry.ts   an abstract class implementing an interface, a subclass
                  calling super(), and a static method with the same name as
                  an instance method
src/registry.ts   a declared function called directly, called through a
                  namespace, and passed as a value
src/index.ts      a re-export, an import that is never called, a value use and
                  a call at module level
```

`value.toFixed()` refers to the standard library, which is not part of the
repository and must not appear in the graph.

It has no dependencies and is never installed: the pipeline indexes it in place.
Regenerate the SCIP fixture with `pnpm fixtures:build`.
