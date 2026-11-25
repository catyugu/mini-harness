# Host

Loads the shipped Profile and user YAML, provides launch paths and options, and coordinates the Cordis Entry Tree. The Web server and browser credential are explicit Profile plugins. The CLI uses a configuration-directory lock and process metadata to manage detached instances.

- `src/profile.ts` reads the shipped and user layers and persists the selected Profile.
- `src/application.ts` boots and closes a Profile.
- `src/web.ts` and `src/server.ts` own the HTTP listener and static assets.
- `src/process.ts` owns the OS lock and detached process commands.

The [system tests](../../test/system/) exercise Profile composition, process shutdown, browser assets and HTTP. See [Profiles](../../docs/profiles.md) for configuration.
