# Plugin examples

These examples are TypeScript source. Run the repository build, then copy the corresponding compiled example from `dist/docs/examples/` to your plugins directory. The Task notes package can also be built independently.

| Example                           | Enablement                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greeting service + Greeting route | Enable both as application plugins. The greeting route consumes the service at `GET /api/greeting/hello/mini-harness`.                                                      |
| Process preview                   | Disable `core:process` and enable `process-preview`. Shell still asks for approval and displays the proposed command without starting a process.                            |
| Scoped greeting                   | Enable Greeting service and select `scoped-tool` in a `session:<id>` override. It exposes the tool and its presentation transform to that conversation and its descendants. |
| [Task notes](task-notes)          | Standalone strict TypeScript example for the public SDKs. Run `npm install` and `npm run build`, then declare the example’s directory in your Profile.                      |
| Example panel                     | Enable it as an application plugin. It contributes a sidebar page, modal, settings category and assistant message action.                                                   |

See [Plugin development](../plugins.md) for the settings format and lifecycle contract.
