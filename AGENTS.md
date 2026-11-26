# Agent instructions

mini-harness is a minimal agent harness composed from Cordis plugins. The workspace packages are implementation boundaries, not independently published products.

## Before editing

- Read [architecture](docs/architecture.md) for the system boundaries and [package index](docs/packages.md) to find the owner of the behavior.
- Read each affected package README and the relevant cross-package reference. Check the actual public interfaces, schemas, implementations and tests before changing a contract.
- Follow [engineering conventions](docs/conventions.md), [TypeScript nullability and invariants](docs/code-style/typescript-nullability.md), and the [development workflow](docs/development.md).
- Follow [documentation rules](docs/AGENTS.md) when changing any documented behavior.

## Changes

- Branch from `main` and open a focused pull request against it.
- Compose features using native Cordis services, effects and YAML Profiles. Keep lower layers business-independent and shared state singly owned.
- Treat internal and external plugins consistently. Prefer removing redundant abstractions to adding new ones.
- Remove superseded code, interfaces, tests and documentation rather than preserving parallel legacy paths.
- Update owning documentation in the same change as API, configuration, lifecycle, ownership, or user-visible behavior.
- Run focused checks locally and use existing CI for broader verification. Do not add unrelated CI jobs or matrices.
