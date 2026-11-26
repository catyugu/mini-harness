# Context Management

The optional base Profile plugin prepares final model requests, prunes tool output, offloads historical images, compacts history, and handles model input limit errors. The Agent request executor owns retry attempts. Sessions owns the durable transcript, context replacements, exact request snapshots and provider usage.

An adapter's input counter is used when available; otherwise tokens are estimated from native content. Model context and output limits must be configured. Measurement is persisted with the prepared request, and statistics consume that record rather than reconstructing a request. Manual compaction commits its measurement with the replacement.

Tool results use a fixed head/tail excerpt and source reference; original messages and tool results remain readable through `read_context`. Shell results carry structured diagnostics. Images are replaced independently with original entry references.

Automatic, manual and overflow compaction select one contiguous prefix at a complete tool exchange boundary. A checkpoint retains the latest user request verbatim when it leaves the active context. Larger summary inputs are segmented by token budget. A replacement is committed only when the new request fits the target budget and shrinks.

Settings → General defines Profile defaults. The composer settings control edits a complete conversation configuration directly, with one reset to defaults operation. Automatic compaction can be disabled independently of pruning and manual compaction. The footer presents statistics only.

Statistics follow the selected branch and aggregate persisted model attempts, including summary calls and retries.
