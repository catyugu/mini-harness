# Background

The optional `background` Profile plugin manages independent tool work. `start_background` returns a work ID after saving admission. `background_control` lists, inspects, reads output from, waits for or cancels work in the calling conversation.

Eligible tools declare `background: true`. Background calls Tools with the validated arguments, binds execution to the tool provider's Fiber and uses Tasks for cancellation and waiting. A Run can finish or stop while work continues. Session deletion and plugin disposal cancel and drain affected work.

Background retains bounded channel output with UTF-8 byte cursors. Terminal results retain text when no stream was produced and select compact details through `detailKeys` and the tool's optional `metadata.backgroundDetails` key list. The optional `report` function queues a progress message. A terminal notice follows the durable outcome and uses the work ID as part of its deduplication key. Startup marks unfinished work interrupted and retries undelivered notices.

The browser contribution mounts a conversation header panel and renders tool receipts. Tool providers can contribute input, summary and diagnostic renderers by tool name through the Conversation history API. The panel supports incremental output reads and cancellation.
