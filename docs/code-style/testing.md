# Tests

Tests protect observable contracts and meaningful failure modes. Prefer a small suite that would catch a real regression over broad mechanical coverage.

## Ownership

- `packages/<name>/tests/`: the owning package's behavior and invariants. Relative source imports stay inside that package; consume dependencies through their declared interfaces or injected services. Never import another package's implementation or export private code for tests.
- `test/framework/`: Cordis integration and framework behavior.
- `test/plugins/`: plugin activation, contributions, scopes, lifecycle, and composition.
- `test/system/`: behavior involving multiple packages, the application, HTTP, persistence across restarts, or distribution boundaries.
- `test/browser/`: user-observable workflows, rendering, and responsive interaction.

Keep each contract at the lowest layer that can exercise it, in the suite of its owner. Cover the assembled workflow in integration tests. Concentrate browser layout, focus and responsive checks on the shared UI mechanism, with a focused integration case for each distinct user workflow.

## Test design

- Assert results, state transitions, errors, and externally significant side effects; avoid matching source text, class names, incidental ordering, and private call counts.
- Group assertions around one observable contract. Replace or strengthen an existing regression case when it already covers the workflow. Remove obsolete tests in the same change as the implementation they cover.
- Use explicit expected values or independently derived invariants, not the implementation under test as the oracle.
- Reuse the harness and mock provider in `test/support/`. Keep setup local when it serves one scenario. Launch independent state for each test.
- Synchronize on events, observable conditions, or awaited work. Avoid arbitrary sleeps and duplicated teardown. Test cancellation and cleanup when they are part of the contract.
- Implement substantial provider and plugin fixtures in type-checked modules. Use inline source strings only for small activation wrappers or source-loading behavior. Diagnose installation, startup, request handling and teardown separately before changing a timeout.
- Keep performance experiments out of regression tests. Do not preserve ad hoc benchmarks without a maintained measurement purpose.

Follow [module imports](module-imports.md) in test code as well as production code. See [Development](../development.md) for verification commands.
