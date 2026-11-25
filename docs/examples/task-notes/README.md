# Task notes

This TypeScript plugin records task progress in the active conversation branch. Its browser entry adds a settings field and renders saved notes and tool results.

## Run the example

Copy this directory to an independent project named `task-notes`, then install its dependencies and compile both entry points.

```sh
npm install
npm run build
MINI_HARNESS_DEV_PLUGIN="$PWD" npx mini-harness
```

In PowerShell, set `$env:MINI_HARNESS_DEV_PLUGIN = (Get-Location).Path` before running the last command. Enable **Task notes** in Plugins. Start a conversation with a configured model and ask it to save a task note. Edit the label under Settings → Extensions.

## Try the server capabilities

The extension endpoints accept local authenticated requests under `/api/extensions/task-notes`.

| Method and path   | Input and effect                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /credential` | Stores a `token` using protected storage and returns whether a credential is present.                                                                                  |
| `GET /smoke`      | Shows the current label, instance setup state and credential presence.                                                                                                 |
| `POST /follow-up` | Takes `parentId` and `message`. Set `requireApproval` to `true` to show a user confirmation before creating a child. The child uses the parent’s last committed model. |

Disable the plugin to remove its tool, routes and browser contributions. Previously saved display records remain visible in the conversation.

The package verification builds and exercises this same example using the npm tarball. See the [plugin guide](../../plugins.md) for details.
