# Tests

Tests protect observable contracts and meaningful failure modes. Prefer a small suite that would catch a real regression over broad mechanical coverage.

## Ownership

- `packages/<name>/tests/`: the owning package's behavior and invariants. Relative source imports stay inside that package; consume dependencies through their declared interfaces or injected services. Never import another package's implementation or export private code for tests.
- `test/framework/`: Cordis integration and framework behavior.
- `test/plugins/`: plugin activation, contributions, scopes, lifecycle, and composition.
- `test/system/`: behavior involving multiple packages, the application, HTTP, persistence across restarts, or distribution boundaries.
- `test/browser/`: user-observable workflows, rendering, and responsive interaction.

Keep a scenario at the lowest layer that can exercise its actual contract. Move cross-package scenarios to integration suites instead of reproducing production wiring in unit tests.

## Test design

- Assert results, state transitions, errors, and externally significant side effects; avoid matching source text, class names, incidental ordering, and private call counts.
- Cover distinct behavior and edge cases. Combine related assertions into one scenario; parameterize equivalent cases. Do not test getters, pass-through functions, or mock implementations just for coverage.
- Use explicit expected values or independently derived invariants, not the implementation under test as the oracle.
- Keep fixtures local until shared use justifies extraction. Reusable test helpers live under `test/support/`; use actual services where practical and mock external I/O or controlled failure boundaries.
- Synchronize on events, observable conditions, or awaited work. Avoid arbitrary sleeps and duplicated teardown. Test cancellation and cleanup when they are part of the contract.
- Keep performance experiments out of regression tests. Do not preserve ad hoc benchmarks without a maintained measurement purpose.

Follow [module imports](module-imports.md) in test code as well as production code. See [Development](../development.md) for verification commands.
