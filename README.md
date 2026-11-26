# mini-harness

A minimal local Web harness with a native Agent, shipped as one npm package. Applications compose through a [vendored Cordis runtime](vendor/cordis/README.md) shared by server and browser.

## Start

Requires Node.js 22.19 or later.

```sh
npm install -g mini-harness
mini-harness --detached
```

Configure a model in Settings → Model, register a workspace and start a conversation. The detached command prints the local URL. See the [user guide](docs/user/getting-started.md) for installation, process controls, tools, skills, permissions and conversation management.

## Documentation

- [Documentation index](docs/README.md)
- [Configuration and Profiles](docs/configuration.md)
- [Architecture](docs/architecture.md) and [package index](docs/packages.md)
- [Plugin development](docs/cookbook/creating-a-plugin.md) and [examples](docs/examples/README.md)
- [Development](docs/development.md) and [contributing](CONTRIBUTING.md)
- [Security and trust model](SECURITY.md)

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
