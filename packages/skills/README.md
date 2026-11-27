# Skills

Skills discovers local `SKILL.md` instructions and makes them available to the model and composer. It owns discovery, explicit invocation, the `load_skill` tool and the browser picker. A skill is instruction content; it is not a Cordis plugin or a separate executable service.

## Usage

Place a skill directory under one of the discovery roots, with a file such as:

```markdown
---
name: review-changes
description: Review a proposed change against the project conventions.
---

Read the affected interfaces and report concrete correctness or maintenance issues.
```

With the `skills` plugin enabled, invoke it using `/skill:review-changes` in a user message, choose it in the composer, or let the model call `load_skill` by name. Automatic prompt discovery lists names and descriptions; full instructions are loaded on demand. Both explicit invocation and `load_skill` include the resolved absolute skill file and its containing directory so the model can resolve relative resource paths. In workspace conversations, the ordinary [file tools](../files/README.md) can read resources at those absolute paths. Explicit user invocation removes the invocation token from model-facing user text and adds the selected instructions while retaining the original presentation text in session history.

## Discovery contract

[loader.ts](src/server/loader.ts) scans these roots from lowest to highest precedence; a higher-priority skill name replaces a lower-priority one:

1. `~/.agents/skills`
2. `<application-home>/skills`, normally `~/.mini-harness/skills`
3. `<workspace>/.agents/skills`
4. `<workspace>/.mini-harness/skills`

The workspace roots are omitted for an unbound conversation. Changing `MINI_HARNESS_HOME` changes the application root, not the user's `.agents` root. Discovery runs on demand, so edited instructions are picked up on a subsequent list or load.

The parser accepts a deliberately small frontmatter format with a description and an optional name; the containing directory supplies the fallback name. Names use lowercase letters, digits and single hyphen separators. A skill file is bounded to 128 KiB. The loader also bounds traversal depth, entries, directories and discovered skills; the implementation defines those budgets.

Root and directory links are followed with physical-directory cycle detection and physical-file deduplication. Hard-linked, oversized, changed or invalid skill files are ignored. Missing or inaccessible roots are skipped; unexpected discovery failures are logged through the plugin. A requested name absent from the current discovery result reports an unknown-skill error.

## Integration and lifetime

The server [manifest](src/manifest.ts) requires application paths, Workspaces, Sessions, Tools, Prompt and Profile scopes. [setup.ts](src/server/setup.ts) contributes a prompt section, a user-only `agent/prepare-input` listener and the read-only `load_skill` tool. The listener does not interpret plugin- or agent-originated input as a user invocation.

When HTTP routing is available, `/api/workspaces/:id/skills` lists the workspace's skills. A supplied session must belong to that workspace; the route prepares its scope first. The browser entry registers composer commands and a skill button, refreshes for the current workspace/conversation, and aborts obsolete requests. Cordis disposes these registrations with the plugin.

The shipped `skills` Profile entry has no Config schema or public SDK constructor. New skill instructions need a file, not application code. Plugins that need a different discovery mechanism can compose their own prompt, input and tool contributions using the owning public APIs.

## Testing

[Loader tests](tests/loader.test.ts) cover all four roots, override precedence, links, parser validation and bounded reads. [Agent HTTP tests](../../test/system/agent-http.test.ts) cover committed skill input. See [Agent](../agent/README.md) for input and prompt extension contracts and [getting started](../../docs/user/getting-started.md) for user workflows.
