# mini-harness

**mini-harness** is a minimal, local-first Web harness around the [Pi coding-agent SDK](https://github.com/earendil-works/pi). It keeps a DSH-inspired conversation layout and uses [Cordis](https://github.com/cordiverse/cordis) to manage optional plugin lifecycles. The project builds as **one npm package** rather than a workspace of separately published mini-harness packages.

This is the 0.1.0 foundation. Its Pi SDK, HTTP, session, detached-process and browser flows have automated smoke tests; functionality remains deliberately narrow. No DeepSeek-specific accounts, balances, session uploads, official authentication flow, or “More” page are included.

## Start

Requires Node.js 22.19+.

```sh
git clone https://github.com/catyugu/mini-harness.git
cd mini-harness
npm install
npm run build
node dist/bin/mini-harness.js
# Or detach from the terminal:
node dist/bin/mini-harness.js --detached
```

The npm package is prepared for publication but has **not yet been published** as part of this PR. After publication, the global command will be `mini-harness`.

Open the URL shown in the terminal. The URL includes a one-time bearer access token in the fragment; the browser retains it for that tab's session. The service binds only to `127.0.0.1`, and all API requests require the token. For remote use, prefer SSH port forwarding; public binding is intentionally unavailable.

All application code, the browser client, and tests are written in **TypeScript**. The `npm run build` pipeline compiles them into `dist/` and copies static assets.

## Verification

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:browser
npm run pack:check
```

The automated integration tests run the actual Pi SDK against a local mock model provider (no external API key required). Browser tests launch mini-harness in its own process and exercise Chromium at desktop and mobile viewport sizes. CI runs the Node tests on Windows and Ubuntu, Node.js 22 and 24; Chromium runs on Ubuntu. A live commercial-provider test requires user-supplied credentials.

## Product choices

- **Single package:** `mini-harness` includes CLI, HTTP host, browser client, and built-in plugins. Pi, Cordis, and other runtime libraries remain standard npm dependencies.
- **Storage:** user configuration in `~/.mini-harness/`; override with `MINI_HARNESS_HOME`. A project can provide `.mini-harness/skills`. Existing DSH data is never migrated or modified.
- **Models:** Pi model runtime provides generic provider/model support. Choose a model in the header, specify a model ID in settings, and use `~/.mini-harness/models.json` for advanced providers. The UI's API-key editor stores the key locally; no vendor-specific flow.
- **Sessions:** messages persist in Pi JSONL, while mini-harness keeps a small index for conversation names and parent/child relationships. Multiple conversations can be selected, exported, or permanently deleted. Deleting a parent also deletes its child conversations; no archive or trash is kept.
- **Plugins:** Cordis owns lifecycle effects and disposers. Built-in Skills, Subagents, and Shell each have an independent switch. A plugin's presentation lives in its existing settings section; no global “More” area.
- **Skills:** Pi loads Agent Skills via its ResourceLoader, including configured `~/.mini-harness/skills` and project `.mini-harness/skills`.
- **Subagents:** exactly one child level, with a configurable global concurrency limit (1–16). Each child is stored as its own Pi session and appears under its parent conversation. A model's `delegate` call may override the configured child provider/model.
- **Shell isolation:** optional shell execution is disabled by default. Linux isolation uses bubblewrap with a new namespace, no network, and only the workspace mounted read-write. On unsupported hosts, isolated mode fails closed. Host mode is an explicit, unrestricted trust decision.
- **Responsive UI:** sidebar drawer on narrow screens, adaptive composer and settings panel, consistent desktop/mobile conversation management, and light/dark modes.

## Commands

```text
mini-harness [--port 3837]
mini-harness --detached [--port 3837]
mini-harness --help
```

The detached process creates `~/.mini-harness/server.json` containing its PID, URL and access token. It writes output to `~/.mini-harness/server.log`. Stop it using your OS process manager; detached mode has no live connection to the terminal that started it. Treat the token as a credential.

## Source layout

```text
bin/mini-harness.ts  CLI / detached bootstrap
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

## CI

CI runs TypeScript checks, Pi integration tests and npm package verification on native Linux and Windows runners (Node 22 and 24). Chromium E2E uses the version-pinned official Playwright container image; browser binaries and system libraries are already installed in that image. Jobs cache `node_modules` keyed by the dependency manifest, operating system and Node version, and install dependencies only when that key changes. The browser image and `@playwright/test` versions must be updated together.

GitHub-hosted runners are ephemeral, so each container job still pulls its image when the runner starts; the container avoids recurring browser/system-package setup. Windows remains native to test process and filesystem behavior.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
