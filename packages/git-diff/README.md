# Git Diff

Provides read-only Git status and diff inspection at a registered workspace's repository root. It owns the Git inspection routes and workspace-panel contributions. Files owns browsing and editing; File Preview owns ordinary previews; UI Layout owns the tabs.

## Activation and use

The [web Profile](../../profiles/web.yml) enables the native `@mini-harness/git-diff` plugin as `git-diff`. Open the workspace panel and choose **Git changes**, then select a file to open its diff tab. The plugin has no configuration schema or public SDK module and can be disabled independently of file browsing and previews.

The [manifest](src/manifest.ts) requires Routes, Workspaces, Profile Scopes and File Access on the server. The browser requires `miniTabs` and `miniProjections`. A local `git` executable must be available.

## Inspection contract

| Route                                       | Behavior                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/workspaces/:id/files/changes`     | Returns availability, a list of paths with Git's two-column status, and truncation information when applicable. |
| `GET /api/workspaces/:id/files/diff?path=…` | Returns staged and working-tree diffs for a path; untracked text is read through File Access.                   |

The workspace root must be the repository root. A non-repository, missing Git installation or nested workspace produces an unavailable explanation rather than a misleading empty repository. No commit, stage, checkout or other repository mutation is exposed.

[`GitInspection`](src/server/git.ts) bounds output and execution time, disables external diff/text conversion and filesystem-monitor commands, and treats paths as literal pathspecs. It validates requested paths through File Access; deleted files need no live target, while existing targets are checked before reading. Binary or metadata-only changes are reported as such. These are direct, fixed Git inspection commands, not Shell tool invocations or Task Runtime jobs.

## Tab and request lifetime

The [browser contribution](src/browser/setup.ts) registers separate change-list and diff tab types. Each belongs to its workspace and survives conversation navigation. Unloading Git Diff removes its panel entry and tabs. Closing a tab or starting a newer refresh cancels the previous request; request cancellation reaches the Git process.

Views refresh on file invalidations, window focus and tab activation, and expose explicit refresh controls for changes from external programs. They do not continuously watch Git. Server output and displayed lines are bounded; the view marks truncated results. Operational Git failures are reported in the tab with a message suitable for retrying a refresh.

## Verification

[Git inspection tests](tests/git.test.ts) cover staged, unstaged and untracked files, repository handling and out-of-scope paths. [File-view tests](../../test/browser/files.spec.ts) cover diff tabs and refreshing after an agent write.

See [Workspaces](../workspaces/README.md), [File Access](../file-access/README.md), [UI Layout](../ui-layout/README.md), and [frontend composition](../../docs/subsystems/frontend.md).
