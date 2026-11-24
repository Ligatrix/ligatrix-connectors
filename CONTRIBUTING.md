# Contributing

Thank you for helping improve ligatrix-connectors.

## Run and test

The library has no dependencies and needs only Node.js 20 or later.

```sh
npm test            # run the test suite (node --test)
npm run lint        # trailing whitespace, tabs, final newlines
node examples/run.mjs
```

## Branches

- Branch from `main`: `fix/<short-description>` or `feat/<short-description>`.
- Keep a branch to one change; open a pull request when it is ready for review.

## Commit style

- Imperative, sentence case, no trailing period: « Add retry-safe dedupe for CSV imports ».
- One logical change per commit. Explain the reason in the body when it is not obvious from the diff.

## Code style

- Plain ESM JavaScript, two-space indentation, no runtime dependencies.
- Public functions have JSDoc and a matching declaration in `src/index.d.ts`.
- Every adapter returns its result through `normalize()`; adapters never build final work items by hand.
- Errors are instances of the classes in `src/errors.js` with a stable `code`.

## Pull request checklist

- [ ] Tests cover the new behaviour, including failure paths and edge cases
- [ ] `npm run lint` and `npm test` pass on Node.js 20 and 22
- [ ] Types, README and CHANGELOG are updated where the public API changed
