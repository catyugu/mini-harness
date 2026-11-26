# Using mini-harness

## Install and start

Requires Node.js 22.19 or later, with npm available for plugin installation.

```sh
npm install -g mini-harness
mini-harness --detached
```

Open the URL printed by the detached command. Foreground startup (`mini-harness`) opens the browser automatically; `--no-open` keeps it closed. The server listens on `127.0.0.1`, and the browser keeps the access token in tab storage. For a source checkout, follow the [development guide](../development.md).

Configuration and conversation data live in `~/.mini-harness`, or the directory selected by `MINI_HARNESS_HOME`. One process owns that directory at a time. The default application uses the Web [Profile](../profiles.md).

| Command                               | Effect                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mini-harness --cwd /path/to/project` | Start with a selected workspace directory                                                   |
| `mini-harness --port 3838`            | Use a different Web port                                                                    |
| `mini-harness --detached`             | Start independently of the current terminal                                                 |
| `mini-harness status`                 | Show whether the instance is running and any discovered conversation-log errors             |
| `mini-harness stop`                   | Stop the instance                                                                           |
| `mini-harness reset-token`            | Stop the instance and revoke its browser credential; restart and open the newly printed URL |

An open tab reconnects after restart on the same port and configuration directory. Closing the terminal does not stop a detached instance.

## Configure a model and workspace

Open **Settings → Model** to add a provider or custom endpoint. Credential status reports local configuration; the provider validates access when a request is made. Choose a configured model under the message input. Sending a main conversation message remembers the actual model across navigation and restarts; child agents keep their own selected or inherited model.

Use **Workspaces** in the sidebar to register local directories. You can browse or start conversations in one workspace while conversations elsewhere keep running. Removing a workspace permanently deletes its conversation trees and histories while preserving the project directory and files.

The workspace panel has separate **Workspace files** and **Git changes** entries. Browse folders, preview resources, inspect changes and open paths written by the current turn. Each workspace keeps its own open tabs across conversation switches.

## Send messages and attachments

A new conversation stays a draft until its first send. Paste images, drop files, choose the attachment button or type `/file` to add uploads. A message accepts up to 8 files, 6 MiB each and 12 MiB total. Image-capable models receive supported images; eligible UTF-8 text files up to 1 MiB are included in model context. [Input](../../packages/input/README.md) defines the file eligibility rules. Other uploads are available to enabled Shell commands through `MINI_HARNESS_ATTACHMENTS`. Uploads belong to the conversation and are deleted with it.

Use `@` to reference a workspace file without copying it, and `/` to discover skills and commands. Click an attachment or workspace reference to preview it. Reference text remains in the message; a workspace reference opens the current file rather than a stored snapshot.

Send normally while the conversation is idle. While its Run is active, choose **Steer**, **Interrupt**, or **Queue** beside the send button. Steer uses the next model or tool boundary. Interrupt cancels the current response and continues with the new message after cleanup. Queue waits for the current response to finish. **Settings → General → Add instructions** selects the global default for conversations without an explicit selection. **Stop response** pauses automatic delivery until you send another message. Pending messages remain visible and can be cancelled individually.

Separate **Tasks** and **Subagents** counts beside the working directory open independent popovers. Subagents links directly to each child conversation and shows its latest Run status; Tasks groups background tools into running and finished jobs. Each entry is hidden when its own list is empty. Expand a job to inspect its actual input and retained output, or cancel running work. Clear hides finished jobs from the current panel without deleting history. Agent and task notifications appear as compact, collapsed conversation records rather than user messages.

Refreshing, disconnecting or switching conversations leaves runs active. Reopen a conversation to reconnect, or choose **Stop** to cancel that run and its inline work. Independently owned child conversations continue. Restart marks unfinished work interrupted and never retries unknown tool outcomes automatically. Pending follow-ups remain for a later explicit run; steering targeted at the interrupted run is recorded as failed.

## Manage conversation history and child agents

Search or rename conversations, copy messages, retry errors, and edit/resend a persisted user message. A revision starts a new active branch; exports retain every branch. The status row below the composer shows run statistics, token usage and current context. Use the composer context settings to override Settings → General, including before the first message. Open the context usage statistic to inspect the input budget. Send `/compact` to compact the conversation. Expand a completed checkpoint row to inspect its summary. Surrounding whitespace does not affect standalone composer commands. Compaction keeps a checkpoint and recent context while preserving visible history and message identities.

With Subagents enabled, the model can delegate work to child conversations. **Plugins → Subagents** controls maximum depth, concurrency and the optional default model. Defaults are one child level and four concurrent executions. An explicit provider/model selected by the delegating model takes precedence; see [Subagents](../../packages/subagents/README.md) for selection and limit details. Delegation returns identifiers immediately, including when the child is queued. Lowering concurrency lets current work finish before admitting more children.

Expand the conversation tree to view descendants. Use checkboxes for bulk export or permanent deletion; selecting a parent includes its descendants. Stop active conversations before exporting. Exports contain metadata, the complete native JSONL histories and original attachments. Deletion drains affected work and removes the selected trees and their owned files. There is no archive state.

## Enable tools and set permissions

Use **Settings → Built-in plugins → Optional plugins** to toggle Files, Skills, Subagents, Shell, Session helper and other optional bundled capabilities. Configure Subagents, Agent and Shell from the Plugins page, which also manages local plugins. Built-in infrastructure is listed for reference in Settings. Session helper supplies message copy and edit/resend actions. Tool availability updates at the next model turn. Unloading a tool revokes its outstanding invocations while unrelated work can continue.

Choose permissions from the left side of the composer:

| Permission  | Behavior                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Read-only   | Select tools that declare read-only access; descendants inherit the restriction                                   |
| Standard    | Run enabled tools with normal plugin policies.                                                                    |
| Full access | Release pending plugin confirmations that opt into Full access, while retaining inherited read-only restrictions. |

Permission changes apply to work that has not started and persist per conversation. They do not enable disabled plugins. Shell starts disabled. Enabling it authorizes native command execution with your user permissions, without per-command confirmation. Its plugin settings control the default timeout and per-stream output limit. Review the [security model](../../SECURITY.md) and [Shell configuration](../../packages/shell/README.md) before enabling command execution.

## Load skills and instructions

Place a skill in a directory containing `SKILL.md`, then use `/skill:name` to attach it to a message. Models can also call `load_skill` while Skills is enabled. Roots are listed below from lowest to highest priority; a valid higher-priority skill replaces the same name:

1. `~/.agents/skills/`
2. `~/.mini-harness/skills/` or `$MINI_HARNESS_HOME/skills/`
3. `<workspace>/.agents/skills/`
4. `<workspace>/.mini-harness/skills/`

Skill directories and instruction files may be links to locations outside the workspace. Review their targets and instructions before loading them. Native prompts also read regular, unlinked `AGENTS.md` files in the configuration directory and workspace root. Reads and discovery are bounded; see [Skills](../../packages/skills/README.md) for the file format and limits.

## Customize configuration

Settings and Plugins edit the selected Profile's user layer. For custom startup, plugin installation, YAML overrides and separate compositions, use the [Profile reference](../profiles.md). The [configuration map](../configuration.md) identifies the owner of model credentials, plugin settings, workspace roots and conversation data. Developers can start with the [plugin cookbook](../cookbook/creating-a-plugin.md).
