# Contributing

1. `npm test` and `npm run test:e2e` must pass before a change is proposed.
2. `npm run test:live` is optional but recommended for anything that touches
   `src/lib/api.js` or `src/background.js`.
3. `npm run check` validates the manifest and every path it references.
4. Keep the extension dependency-free. The runtime has no `node_modules`.
5. New behaviour needs a test that would fail without the change — see
   `test/unit.test.js` and `test/e2e/run-e2e.js` for the pattern.
