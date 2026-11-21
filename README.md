# minih

**minih** is a minimal, local-first Web harness around the [Pi coding-agent SDK](https://github.com/earendil-works/pi). It keeps a DSH-inspired conversation layout and uses [Cordis](https://github.com/cordiverse/cordis) to manage optional plugin lifecycles. The published distribution is **one npm package** rather than a workspace of separately published minih packages.

This is an early foundation release (0.1.0). The Web UI and SDK integration are being validated; features marked below are deliberately narrow. No DeepSeek-specific accounts, balances, session uploads, official authentication flow, or “More” page are included.

## Start

Requires Node.js 22.19+.

```sh
npm install -g minih
minih
# or:
minih --detached
```

Open the URL shown in the terminal. The URL includes a one-time bearer access token in the fragment; the browser retains it for that tab's session. The service binds only to `127.0.0.1`, and all API requests require the token. For remote use, prefer SSH port forwarding; public binding is intentionally unavailable.

Development checkout: `npm install && npm start`. All application code, the browser client, and tests are written in **TypeScript**. The `npm run build` pipeline compiles them into `dist/` and copies static assets. Run `npm run typecheck`, `npm test`, and `npm run pack:check` to validate the distribution.

## Product choices

- **Single package:** `minih` includes CLI, HTTP host, browser client, and built-in plugins. Pi, Cordis, and other runtime libraries remain standard npm dependencies.
- **Storage:** user configuration in `~/.minih/`; override with `MINIH_HOME`. A project can provide `.minih/skills`. Existing DSH data is never migrated or modified.
- **Models:** Pi model runtime provides generic provider/model support. Choose a model in the header, specify a model ID in settings, and use `~/.minih/models.json` for advanced providers. The UI's API-key editor stores the key locally; no vendor-specific flow.
- **Sessions:** messages persist in Pi JSONL, while minih keeps a small index for conversation names and parent/child relationships. Multiple conversations can be selected, exported, or permanently deleted. Deleting a parent also deletes its child conversations; no archive or trash is kept.
- **Plugins:** Cordis owns lifecycle effects and disposers. Built-in Skills, Subagents, and Shell each have an independent switch. A plugin's presentation lives in its existing settings section; no global “More” area.
- **Skills:** Pi loads Agent Skills via its ResourceLoader, including configured `~/.minih/skills` and project `.minih/skills`.
- **Subagents:** exactly one child level, with a configurable global concurrency limit (1–16). Each child is stored as its own Pi session and appears under its parent conversation. A model's `delegate` call may override the configured child provider/model.
- **Shell isolation:** optional shell execution is disabled by default. Linux isolation uses bubblewrap with a new namespace, no network, and only the workspace mounted read-write. On unsupported hosts, isolated mode fails closed. Host mode is an explicit, unrestricted trust decision.
- **Responsive UI:** sidebar drawer on narrow screens, adaptive composer and settings panel, consistent desktop/mobile conversation management, and light/dark modes.

## Commands

```text
minih [--port 3837]
minih --detached [--port 3837]
minih --help
```

The detached process creates `~/.minih/server.json` containing its PID, URL and access token. It writes output to `~/.minih/server.log`. Stop it using your OS process manager; detached mode has no live connection to the terminal that started it. Treat the token as a credential.

## Source layout

```text
bin/minih.ts        CLI / detached bootstrap
src/config.ts       storage paths and validated settings
src/agent.ts        Pi SDK sessions and runtime
src/plugins.ts      Cordis plugin composition and optional tools
src/subagents.ts    concurrency control and model selection
src/sandbox.ts      explicit shell execution policy
src/registry.ts     conversation index and permanent deletion
src/server.ts       localhost-only HTTP / streaming API
web/app.ts          responsive TypeScript client
web/                static HTML, CSS and branding
test/               foundation regression tests
```

## Scope of 0.1.0

The first milestone targets a usable local shell, not full DSH parity. Rich Markdown/trajectory viewers, complete external-plugin compatibility, all-platform sandbox isolation, browser authentication beyond localhost, concurrent multi-instance handling, and desktop packaging remain work in progress. See [SECURITY.md](SECURITY.md) for the current trust boundary.

## Development principles

Keep Pi's execution internals intact. Build a small adapter instead of replacing its agent loop. Prefer one service and one lifecycle owner per domain; use Cordis for registration and disposal, but avoid proliferating separately published packages. Design user-facing switches so disabling a feature also removes its tools. Preserve upstream license notices where code is reused.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
