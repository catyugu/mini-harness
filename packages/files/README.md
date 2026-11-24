# @mini-harness/files

Provides file tools and the workspace file browser.

## Responsibilities

Owns text reads, writes, edits and file inspection results, including tree, search, preview, Git status and diff. Uses the file access service for policy.

## Structure

`src/server/` contains the tools, routes and inspection logic. `src/browser/setup.ts` contributes separate Workspace files and Git changes tabs, file-path completions and inline workspace references.

## API

Registers tools with `harnessTools` and contributes the browser panel and completions at the owning extension points.

## Dependencies

Uses [File Access](../file-access/README.md) and [Workspaces](../workspaces/README.md) to constrain paths. The host grants Files read-only tool registration.

## Lifecycle

The `files` application plugin owns tool and route registrations, its projection domain and browser contributions.

## Configuration

Enable or disable `files` in Plugins. Workspace file policy comes from the selected conversation and its provider.

File tool bindings read visible session information and resolve the selected File Access provider via the public server SDK.

## Testing

`tests/` covers inspection, access policy and writes. The [Files browser suite](../../test/browser/files.spec.ts) exercises the panel.
