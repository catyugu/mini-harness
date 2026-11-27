# File Access

File Access supplies filesystem operations to plugins. It offers both native Node access and a confined directory view for paths supplied to a feature. Workspace policy, content limits and user-facing tools belong to the consuming package.

## Public API and usage

Import `mini-harness/file-access` for `FileAccessPort`, `RootedFileAccess`, `FileReader`, `explicitFileReader`, `FileTypeError` and the `harnessFileAccess` service declaration. Declare `harnessFileAccess` as an injected dependency:

```ts
import type { Context } from 'mini-harness/cordis';
import 'mini-harness/file-access';

export async function readProjectFile(ctx: Context, canonicalRoot: string, path: string) {
  const files = ctx.harnessFileAccess.open(canonicalRoot);
  return files.readFile(path);
}
```

`open(root, { exclude })` returns a view. The optional predicate receives resolved absolute paths; the consumer decides which files to exclude. Relative paths are resolved inside the root, and absolute paths are accepted only when they remain inside it. Root validation happens when the view performs an operation.

The [API](src/api.ts) supports file reads, binary or text writes, streaming chunks, recursive directory creation, metadata, sorted directory entries and path checks. `writeFile(path, content, create, signal)` can create a missing file when `create` is true; use false when an existing file is required. Create parent directories explicitly with `mkdir`.

## Filesystem behavior

A workspace view checks lexical paths and their resolved targets against the root and exclusions. Explicit operations accept symbolic links and junctions to targets inside the view, and regular hard-linked files. Directory enumeration skips links to avoid recursion cycles. Special files are not supported. This is a convenience boundary for trusted local development, not protection against concurrent filesystem manipulation. `FileTypeError.kind` distinguishes a directory, a non-directory path component and an unsupported file type. Policy failures use the shared operational error contract; ordinary filesystem failures propagate.

Writes prepare and sync a temporary file, recheck the destination, then publish it atomically. A failed, aborted or superseded write removes its temporary file and preserves the existing destination. Existing-file replacement checks for an intervening filesystem change; creation does not overwrite a concurrently created file.

`chunks` reads until EOF and closes its handle when iteration ends or aborts. The view itself imposes no workspace-preview byte limit. Callers must choose appropriate read limits and pass cancellation signals for long operations. `validatePath` checks the resolved location, permitting missing targets; use `access`, `stat` or a read when the target's existence or type matters.

`harnessFileAccess.native` exposes Node promise-based filesystem operations and `createReadStream` with the host process's permissions, including normal link behavior. `explicitFileReader(native, cwd)` uses those native operations for streamed reads and directory listings. It resolves relative paths from `cwd` and accepts absolute paths. The confined view is a consumer-selected interface; it is not a sandbox for trusted plugin code. See [SECURITY.md](../../SECURITY.md).

## Activation and extension

The base Profile activates `core:file-access` as `@mini-harness/file-access`. The shipped provider has no Config schema and owns no workspace registry. Other providers can implement `FileAccessPort` and replace `harnessFileAccess` through native [scoped composition](../../docs/scoped-providers.md). Consumers should resolve the service in the request's prepared scope.

[Files](../files/README.md), [File Preview](../file-preview/README.md) and [Git Diff](../git-diff/README.md) apply their own content policy and presentation. The shared [workspace resolver](../workspaces/src/server/file-request.ts) selects the scoped provider and excludes private harness state.

## Testing

[Rooted file tests](tests/root.test.ts) exercise failed atomic writes, binary data and streaming beyond preview limits. [File-policy tests](../files/tests/policy.test.ts) exercise the native read path and workspace confinement through the tools. [Workspace API tests](../../test/system/workspace-api.test.ts) exercise root identity and scope selection. Implementation details live in [root.ts](src/root.ts).
