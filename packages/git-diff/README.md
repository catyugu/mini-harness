# Git changes

An independently configurable plugin for reading Git status and diffs at the registered workspace root.

- `src/server/` reads bounded Git output and checks file paths through the selected File Access provider.
- `src/browser/` contributes the Git changes entry and separate change list and diff tabs.
- `tests/` exercises repository, diff, and path handling.

Git views use the shared file invalidation projection and offer manual refresh for changes made by other programs.
