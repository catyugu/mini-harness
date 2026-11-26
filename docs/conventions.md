# Engineering conventions

These are design constraints for new changes, not claims that every existing implementation is ideal.

- The application is a composition of native Cordis plugins and YAML Profiles. Required services are declared through injection, not a parallel application-wide registry.
- Every shared state has exactly one owner. Other layers use its contract, observe its projection, or contribute at its explicit extension points.
- Lower-level mechanisms do not interpret higher-level business concepts. For example, a task runtime schedules async functions, not conversations or tool calls.
- Prefer native Cordis scope, service, event, and lifetime mechanisms. Keep shipped and installed plugins on the same path wherever possible.
- Keep public contracts narrow, explicit, and reusable. Do not create abstractions, capability checks, or defensive restrictions without a real requirement. Scope routing is not an authorization boundary; preserve the actual trust and resource policies in [SECURITY.md](../SECURITY.md).
- Prefer subtraction and direct composition. Refactoring removes old interfaces, dead implementations, obsolete tests, and stale documents. Do not introduce compatibility layers solely to preserve internal callers.
- Separate UI theme, controls, layout, shared view state, and feature contributions. Preserve the common visual language and responsive behavior.
- Publish one npm package; private workspace packages express source ownership. Use public SDK exports for external plugins.
- Document and test observable contracts, including non-obvious failure and cancellation behavior. See [documentation rules](AGENTS.md) and [development](development.md).
