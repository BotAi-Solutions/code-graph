# function-values-sample

Function-valued variables, and the ways they are called or used as values.
It is the fixture for how the graph classifies `const f = () => {}` and when a
reference to it is a `CALLS` edge.

```
src/helpers.ts        one const per declaration form (arrow, async, generic,
                      function expression, parenthesised) and the values that
                      must stay variables ({}, [], 123, 'foo', an object of
                      functions, a let)
src/callers.ts        one declared function per way of using them: each call
                      form, and each value use (alias, callback, bind, return)
src/access.ts         the shape of Immich's src/utils/access.ts: arrow helpers
                      that call each other
src/asset.util.ts     helpers the upload flow uses, and a mimeTypes-style object
src/upload.service.ts the shape of AssetMediaService.uploadAsset: method calls
                      beside helper calls
```

It has no dependencies and is never installed: the pipeline indexes it in place.
Regenerate the SCIP fixture with `pnpm fixtures:build`.
