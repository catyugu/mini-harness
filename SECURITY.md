# Security model

minih is a **local developer tool**. Its HTTP listener binds to 127.0.0.1, requires a bearer token on API calls, checks the Origin on state-changing browser requests, and does not offer a public-host mode. Anyone who can read `~/.minih/server.json` can use the local API. Keep that file private. Do not expose the local port to untrusted users or networks.

## Execution trust

Pi's built-in read, write, edit, grep, find, and ls tools operate on the host with the current user's permissions. The optional **sandbox_shell** tool is the only tool governed by the minih sandbox setting. Consequently, minih does **not** claim to provide end-to-end agent or plugin isolation.

Shell is off by default. In isolated mode, minih requires Linux and bubblewrap, fails closed if unavailable, unshares network/other namespaces, and mounts the selected workspace read-write. Host mode deliberately runs commands with the current user's privileges. Do not enable host mode for untrusted prompts or projects.

Subagents inherit the same host-level file capabilities as the parent but cannot delegate again. Parallel limits prevent unbounded child launches; they are not resource or cost quotas.

Cordis plugins and Pi extensions are trusted executable code and may access data and environment secrets. Only install plugins you have reviewed. The initial foundation does not promise to sandbox arbitrary third-party plugins.

## Data

Pi conversation history is persisted to `~/.minih/sessions` and indexed by minih. Explicit deletion removes indexed session files, including children. This is permanent from the UI's perspective: no archive or trash. Backups, filesystem snapshots, and provider-side logging remain outside minih's control.

Credentials are saved under `~/.minih/auth.json` for the selected model provider; environment variables can also supply provider credentials. minih does not contain DeepSeek-specific official authentication or upload controls. Any model request necessarily sends prompt contents to the chosen model provider.

If a sandbox, token, or filesystem control is unavailable, the safe behavior is to reject the operation rather than silently fall back to unrestricted execution.
