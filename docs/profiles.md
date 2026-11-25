# Profiles

The CLI starts the shipped Web Profile by default. `mini-harness --profile web` selects it explicitly. The package carries [base.yml](../profiles/base.yml) and [web.yml](../profiles/web.yml). The base is a shared configuration fragment.

The launcher loads the base, then Web, then `~/.mini-harness/profiles/web/cordis.yml` (under `MINI_HARNESS_HOME` if set). The user file is optional. Each layer can patch an entry by ID. Configuration properties merge at the top level, and the last definition of each property wins. The order of entries is for readability. Cordis waits for injected services and tears down consumers before releasing their providers.

```yaml
plugins:
  - id: core:web-server
    config:
      port: 3838
  - id: git-diff
    disabled: true
  - id: task-notes
    name: installed:task-notes
    client: true
    config:
      label: Progress
```

`name` identifies a module export. A packaged module uses a package-relative path such as `packages/files/src/manifest.js#manifest`. An installed plugin uses `installed:<id>`. Installing a plugin adds its files and metadata. A Profile entry controls activation. `client` controls whether a configured module contributes its browser entry to the Web bootstrap.

Use `providers` for service-to-entry selections, `browserProviders` for browser service selections, and `scopes` for workspace and conversation overrides. See [scoped providers](scoped-providers.md). Required entries are declared by the shipped Profile. Custom YAML tags and aliases are rejected. Changes made outside the app take effect on restart.

The Web Plugins page updates the same YAML. Candidate changes are validated before publishing committed settings, and a failed activation restores the prior entries. Domain settings such as tool grants remain in `settings.json`. The first successful startup migrates old plugin, provider, scope and port settings to the Profile. Model definitions, credentials, conversations, attachments and plugin data keep their existing locations.

The layering and lifetime follow the [DSH Profile launcher](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/profile-boot.ts) and its [base patch](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml).
