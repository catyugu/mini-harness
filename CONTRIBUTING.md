# Contributing

Start with [architecture](docs/architecture.md), the [package index](packages/README.md) and [engineering conventions](docs/conventions.md).

1. Branch from `main` and keep the change focused.
2. Read and update the owning package documentation alongside its implementation. For cross-package changes, update the applicable [subsystem reference](docs/README.md#system-reference).
3. Follow the [development workflow](docs/development.md) for build, formatting, and targeted checks. Test observable contracts rather than incidental internals.
4. Open a PR against `main` explaining the behavior, ownership changes (if any), tests run, and remaining limitations. Do not claim checks that did not run.
5. Review the existing CI checks before merging.

For a third-party extension, start with the [plugin cookbook](docs/cookbook/creating-a-plugin.md). For security-sensitive reports, see [SECURITY.md](SECURITY.md).
