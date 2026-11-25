# Third-party software

mini-harness is licensed under MIT (Copyright 2026 Catyugu).

The architecture is informed by DeepSeek Harness, which is distributed under the MIT License:

Copyright (c) 2026 DeepSeek

The folder, settings, disclosure triangle, new-chat and ellipsis icon contours in `packages/ui-primitives/icons.ts` are adapted from the DeepSeek Harness icon artwork (MIT), without its product branding.

The Pi model transport package (`@earendil-works/pi-ai`) is distributed under the MIT License. Copyright notices and licenses from Pi and its transitive dependencies remain in their respective npm packages. The shared Cordis runtime is based on the DeepSeek Harness fork of Cordis (MIT), including a small set of Cosmokit helpers (MIT). Its source origins and changes are recorded in [vendor/cordis](vendor/cordis/README.md), with the original notices at [Cordis LICENSE](vendor/cordis/LICENSE) and [Cosmokit LICENSE](vendor/cordis/COSMOKIT.LICENSE).

No bundled DeepSeek commercial integrations or branding assets are used in mini-harness. When importing upstream source code into this repository, preserve its required copyright notices and license text. Installing mini-harness with npm also installs standard third-party runtime dependencies subject to their own licenses.

The npm tarball includes the Cordis notices under `dist/vendor/cordis/` and the licenses for Marked (MIT) and DOMPurify (Apache-2.0 OR MPL-2.0) under `dist/packages/ui-primitives/src/browser/vendor/`.

The prompt editor bundles CodeMirror and its browser dependencies. Their notices are included in `dist/packages/conversation/src/browser/vendor/`. Profile parsing uses the `yaml` npm package (ISC).
