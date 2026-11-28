# AI Conversation Titles

Enable **AI Conversation Titles** in **Settings → Built-in plugins**. The bundled Profile ships with the entry disabled.

The plugin observes the first committed user input and sends a short title request to the model selected for that input. It uses up to 2,000 characters of original text or the first attachment name. The request runs in the plugin's Fiber and supplies no tools, attachment content, or conversation history.

Stopping a Run leaves the title request active. Disabling the plugin cancels its outstanding requests. Failed requests are logged and leave the deterministic title in place. [Sessions](../sessions/README.md) retains ownership of the title and enforces manual edits and deletion when the plugin submits a result. Enabling the plugin applies to future first inputs.
