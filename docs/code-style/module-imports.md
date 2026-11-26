# Module imports

Workspace packages are ownership and dependency boundaries. The installed SDK is a single npm package.

| Context                           | Import                                             |
| --------------------------------- | -------------------------------------------------- |
| Within the same workspace         | Relative path, such as `./state.ts`                |
| Between workspace packages        | Declared export, such as `@mini-harness/runs/api`  |
| External plugins and SDK examples | Installed root export, such as `mini-harness/runs` |
| Cordis                            | `mini-harness/cordis`                              |
| Node built-ins                    | `node:` prefix, such as `node:fs`                  |

Use explicit `.ts` extensions for TypeScript source references and `import type` for type-only imports. Actual JavaScript assets use their actual extension. The existing build rewrites source imports for distribution; do not introduce aliases, alternative resolvers, or new barrels just to shorten paths.

- Do not use a workspace's own package name to refer to its files. Do not traverse into another workspace's source or tests by relative path.
- Declare each production workspace dependency in the consuming package manifest. Keep exports limited to real inter-package contracts; root exports separately define the installed SDK.
- Unit tests follow the same boundaries, including when using shared fixtures from `test/support/`. Prefer the service contract over another package's concrete implementation. See [Tests](testing.md).
- Profile module identifiers select plugins; they are not TypeScript import aliases. Keep their mappings in `miniHarness.profileModules`.
- Resolve file-system paths with `node:path` and module-relative URLs with `import.meta.url`. Do not mix file paths, browser URLs, and module specifiers.

Remove obsolete exports and dependency entries together with their last consumers. Do not retain compatibility aliases for internal refactoring.
