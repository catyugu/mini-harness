# Context Management

The optional base Profile plugin prepares final model requests, prunes tool output, offloads historical images, compacts history, and handles model input limit errors. The Agent request executor owns retry attempts. Sessions owns the durable transcript, context replacements, exact request snapshots and provider usage.

An adapter's input counter is used when available; otherwise tokens are estimated from native content and calibrated against the latest same-model provider input usage and its recorded request. Cache reads and writes count toward input once. Model context and output limits must be configured. Measurement is persisted with the prepared request, and statistics consume that record rather than reconstructing a request. Manual compaction commits its measurement with the replacement.

Tool results use a fixed head/tail excerpt and source reference; original messages and tool results remain readable through `read_context`. Shell results carry structured diagnostics. Images are replaced independently with original entry references.

Automatic, manual and overflow compaction select one contiguous prefix at a complete tool exchange boundary. The retained suffix meets the minimum retention ratio at exchange boundaries and preserves pending user inputs and their attachments unchanged. Already-consumed user messages participate in summarization normally. Larger summary inputs are segmented by token budget. A replacement is committed only when the new request shrinks and fits the model input budget; the target is a desired occupancy, not a hard limit. Manual compaction explicitly uses the last ordinary request's recorded model, prompt, tool schemas and output limit on the selected branch.

Settings → General defines Profile defaults. The composer settings control edits a complete conversation configuration, with one reset to defaults operation. Before the first message, custom settings belong to the workspace draft and are written to the new session before its first Run. Use `/compact` for manual compaction. The summary generation budget follows the summary model's output limit; the desired checkpoint size is stated in the prompt. Automatic compaction can be disabled independently of pruning and manual compaction. The footer presents statistics only.

Statistics follow the selected branch and aggregate persisted model attempts, including summary calls and retries.
