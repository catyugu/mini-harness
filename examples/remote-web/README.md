# Remote Web

Pair a device to the existing mini-harness interface with read-only access. A device can view the conversation and file panels and follow live updates. Changes to settings, conversation history, the workspace catalog and shell approvals require local access.

The listener defaults to port 3840 on loopback. To expose it to other devices, provide an HTTPS reverse proxy that forwards the original Host header and configure its origin in the plugin settings. The host's administrative interface stays on loopback.

Install the example after publishing it to an npm registry:

    mini-harness plugin install remote-web @mini-harness-examples/remote-web

Enable Remote Web in the local plugin catalog, open its page and create a pairing link. The QR code and link expire in two minutes and each can pair one device. Revoke a device from the same page. Disabling the plugin closes the gateway and its active connections.

For local development, install the package dependencies and run:

    mini-harness plugin dev ./examples/remote-web

The example consumes the public server and browser interfaces from the single mini-harness npm package. To develop against an unpublished build, use npm pack in the host checkout and install that tarball as the example's mini-harness development dependency. The host's packaging check performs this build and exercises installation, single-use pairing, revocation and cleanup.
