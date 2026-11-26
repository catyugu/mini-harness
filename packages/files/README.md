# Files

Files supplies workspace file tools, a browser directory tree and `@` path completion. It owns file inspection and edit behavior. [File Preview](../file-preview/README.md) and [Git Diff](../git-diff/README.md) own their separate views.

## Usage and activation

The shipped Profile enables the `files` entry. Users can disable it in Plugins. When a conversation has a workspace, its model can use the registered tools:

| Tool    | Observable behavior                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | Read UTF-8 text with 1-based line offsets, or a supported image. Directories produce a message directing the caller to `ls`.                                               |
| `write` | Create or replace a UTF-8 file and create missing parent directories.                                                                                                      |
| `edit`  | Apply an ordered list of exact replacements. Each `oldText` must occur exactly once in the current intermediate text; all replacements are checked before the final write. |
| `ls`    | List directory entries.                                                                                                                                                    |
| `find`  | Find workspace-relative paths by glob.                                                                                                                                     |
| `grep`  | Search UTF-8 files with a literal or RE2 pattern.                                                                                                                          |

The [tool definitions](src/server/tools.ts) own the argument schemas and limits. For example, `read` accepts `{ "path": "README.md", "offset": 1, "limit": 80 }`, and `edit` accepts `{ "path": "notes.txt", "edits": [{ "oldText": "draft", "newText": "reviewed" }] }`. Read and search tools carry the `readOnly` tag; `write` and `edit` do not.

The browser entry registers a workspace-owned directory tab and composer path completion. Open tabs and their lifetime are handled by [UI Layout](../ui-layout/README.md). Files does not own the selected conversation or a second workspace catalog.

## Policy and extension points

Server activation requires File Access, application paths, Workspaces, Sessions, Tools, projection changes and Profile scopes. Each tool factory resolves the conversation's workspace and looks up `harnessFileAccess` through the caller's scoped Context. Missing workspaces hide the tools; a missing selected provider produces an unavailable error.

The feature opens a workspace view that excludes the application's private state directory. Links are governed by [File Access](../file-access/README.md). Search respects `.gitignore`, skips link traversal and uses bounded traversal and output; direct reads and edits are explicit path operations. UTF-8 text validation, supported image detection, truncation and search budgets live in [tools.ts](src/server/tools.ts) and [search.ts](src/server/search.ts).

Optional HTTP registrations expose `/api/workspaces/:id/files/tree` and `/api/workspaces/:id/files/search`. They use the same prepared workspace/session scope and File Access provider as other workspace views. Successful writes invalidate the `files` projection and return a workspace-relative `changedPath` for consumers.

There is no public `mini-harness/files` SDK constructor or Files Config schema. Extensions register their own tools through [Tools](../tools/README.md), provide a File Access implementation, or contribute a view through [UI Layout](../ui-layout/README.md). They should not import this package's private tool factory.

## Lifetime and testing

The plugin's Cordis lifetime owns its tool registrations, HTTP routes, projection domain, tabs and completion handlers. Tool invocations use their Task cancellation signal; file mutations rely on File Access's atomic publication. Unloading the feature removes its contributions without changing workspace files.

[Policy tests](tests/policy.test.ts) cover shared read/search/write access rules. [Write API tests](../../test/system/file-write.test.ts) cover durable edit information. [Files browser tests](../../test/browser/files.spec.ts) cover directory navigation and preview interactions. See [frontend coordination](../../docs/subsystems/frontend.md) for the neighboring view owners.
