# Harness UI and execution boundaries

The application remains a single npm package. Pi owns the agent, provider calls, context and message JSONL. Cordis owns the server and browser plugin scopes. Browser rendering uses TypeScript and native DOM.

## Theme

`web/style.css` loads the palette, semantic aliases, elevation, corner, focus, scrollbar, component, typography and motion layers. Use semantic variables such as `--ink`, `--panel`, `--border`, and `--dsw-elevation-panel` in extensions. Raised surfaces use a rebindable half-pixel stroke and soft shadows; menus share a translucent surface. Body, code and terminal sizes are independent settings (10–22 px). Reduced motion disables scanning and transitions. Keyboard focus remains visible, and touch layouts keep actions available.

## Contributions

`web/contributions.ts` is independent of DOM and Cordis. The host connects registrations to Cordis effects. Contributions require `id`, and acquire their `owner` from the loading plugin. `order` sorts lists; `priority` chooses replacements; equal priorities use registration order. A replacement retains the original identity's list position. Removing the winner reveals the next eligible implementation.

| Region | Composition | Value |
| --- | --- | --- |
| `conversation.chat.node` | chain | `(message) => HTMLElement`, optionally gated by `accepts(message)` |
| `tool.call.toolview` | keyed | `(tool) => HTMLElement`, keyed by tool name |
| `conversation.input.permission` | single | DOM control |
| `conversation.input.dock` | list | DOM node above the input, including Todos |
| `conversation.composer.dock` | list | DOM statistics/activity node; built-in identities `activity` and `usage` |
| `sidebar.panellist` | list | Sidebar entry |
| `sidebar.right.pane.tab` | keyed | RightTabType keyed by registered type |
| `settings.section` | list | `{title, node}` |
| `plugins.detail.section` | list | `(plugin) => HTMLElement | undefined` |

`scope: {workspaceId, sessionId?}` limits a contribution to that workspace or session. An unscoped contribution is global. A keyed registration requires `key`. Duplicate identities within the same plugin/region/scope are errors. `mount`, `tool`, `rightTab` and `settingsPage` are convenience registrations in this registry; they do not maintain competing rendering systems. All registrations and `watchContributions` subscriptions are released on unload. Pass the plugin or resource abort signal to external listeners and requests.

Browser setup receives `(api, services)`. Services supply snapshots, current scope, conversation navigation, `openResource({path, kind, line})`, conversation changes and run events. Business plugins do not need another plugin's DOM. Server manifests still declare required plugins and validate their dependency graph before reconfiguration.

## Workspaces and resource tabs

New workspaces receive random, persisted identities. Existing catalog IDs are retained. A directory change preserves that identity and leaves existing Pi JSONL files at their original storage address. The runtime opens them with the workspace's current directory. Directory changes require idle conversations and release bound tool resources.

Legacy sessions lacking IDs are normalized against their explicit directory. References to records removed by older releases are restored so those sessions are visible again. Duplicate/ambiguous catalog records are rejected without rewriting either index. Writes are atomic; normalization can be retried.

Deleting a nonempty workspace requires `DELETE /api/workspaces/:id` with `{deleteSessions:true}`. The runtime blocks new sessions in that workspace, cancels and deletes its conversation trees, then removes the catalog record. Project files are retained. If deletion fails, the record stays visible for retry.

Tabs are owned by `{workspaceId, sessionId}`. Their addresses, selected identity and open state survive reload in browser tab storage. Resource navigation reuses an existing tab and can reveal a source line. `create(address, signal)` owns a tab's resources; closing or unloading aborts them. `canOpen`, `keepMounted` (default true), and `closed` describe availability, inactive-resource retention and final cleanup. File tree, preview, Diff and recorded Shell output share this mechanism. The mobile panel uses the full available area.

## Pi projection and statistics

Historical messages are projected from the active Pi session branch, retaining Pi entry identities and tool call IDs. Tool arguments/results and SDK tool durations are read from that same source. The application appends custom Pi entries only for run lifecycle, approval decisions and session Todos. It does not store another copy of chat text. The latest indexed run is reconciled on restart so unfinished work is marked interrupted.

Chat groups process records by user turn and keeps the final answer outside the collapsible process group. Failed processes remain visible. Standard/detailed display and collapse timing are independent preferences. Tool errors do not force individual cards open. Collapsed tool rows omit durations; Inspect opens the corresponding Trajectory entry. Real model-provided thinking is available in Trajectory; no placeholder reasoning is generated.

The installed Pi SDK normalizes absent provider usage to zero and does not expose a completeness flag. Zero defaults are omitted. Nonzero SDK reports are labelled as unverified in Trajectory; they are not presented as complete round totals. The built-in `usage` dock stays empty until complete accounting can be established. This is deliberate: substituting estimates or summing partial attempts would misrepresent the run. Activity state and elapsed time use actual run records.

## Execution policy

| Session permission | File tools | Built-in Shell | Local plugin tools |
| --- | --- | --- | --- |
| View only | Read/search | Isolated, workspace mounted read-only | Rejected |
| Workspace modifications | Read/write within validated workspace | Isolated, workspace mounted read-write | Rejected |
| Full access | Validated workspace tools | Configured isolated or explicitly enabled host mode | Allowed |

The tool registry checks permission on every execution, including already cached tools. Children inherit permission and cannot exceed any ancestor. Changing permission requires idle descendants; full access requires an explicit confirmation acknowledged by the backend. Default permission changes only affect future sessions.

Capabilities describe tool requirements. Every third-party tool additionally requires `trusted-code`, regardless of its declared capabilities. Plugins themselves run in the Node process and are trusted code: permission selection does not sandbox plugin setup, timers or HTTP handlers. The installer states this boundary before loading anything.

Shell always asks for one-command approval. Decisions, expiry and cancellation produce session events and Pi facts; the browser reacts to these events instead of polling approvals. Restricted Shell never honors host mode. Unsupported isolation, including Windows, rejects execution unless the session has explicitly confirmed full permission and host mode is configured. Output is bounded to 1 MiB; cancellation, timeout and excess output terminate the process tree.

## Skills

Pi's native user/project discovery remains enabled. Same-name precedence is **workspace > application configuration directory > user-level**. Workspace sources include `.mini-harness/skills` and Pi-discovered project sources; application sources include `$MINI_HARNESS_HOME/skills` and its Pi agent skills. Native user sources, including `~/.agents/skills`, remain available. Losing definitions are included when resolving precedence so native discovery cannot hide a higher-priority application/workspace definition. The same loader options feed agent sessions and the Skills UI. The UI displays source and conflict information.

Unit tests preload a fresh temporary HOME and USERPROFILE before SDK imports. Browser fixtures isolate the application server’s HOME while Playwright retains its installed browser cache. This isolates fixtures without changing product discovery. Skill tests verify all three levels and fallback after deleting higher-priority definitions.

## Validation

`npm run check`, `npm run test:browser`, and `npm run pack:check` exercise the real Pi SDK with a local provider fixture. Browser coverage includes plugin replacement/unload, workspace/session isolation, persisted tabs, tasks/trajectory/resource navigation, themes, reduced viewport height and mobile controls. Linux isolation tests require working bubblewrap; CI provisions it explicitly. Windows runs the same functional tests; visual reference images use the Linux font environment.
