# Subagents

Subagents is an optional Cordis plugin that creates child conversations and supplies their concurrency policy. Each child is a Session with its own Inbox and Runs.

## Tools and configuration

`delegate` accepts a task and optional provider/model override. It returns the child Session and Run IDs immediately. The chosen provider/model takes precedence over the configured child model, with the parent model as the fallback. The [plugin schema](src/manifest.ts) defaults to one level of recursion and up to four concurrent child Runs. The dynamic pool also applies to follow-up Runs and automatic wakeups.

`send_message` sends to a parent or direct child Session. It defaults to Steer and accepts an explicit delivery mode. Both sides can send progress or follow-up requests while their own Run continues. An idle recipient wakes automatically unless it is paused. A child's terminal Run status is sent to its parent with Queue delivery. Child conversations stay available for further work.

Use `subagent_control` to list direct children or inspect, wait for, or stop their latest Run by session ID. Status and wait include the completed answer. Supply `runId` with status to inspect an earlier Run. Stop and Interrupt affect the current Run in the selected conversation. Deleting a parent Session drains and deletes its descendants and their tasks.

The Subagents browser contribution lists direct child conversations beside the working directory with their latest Run status and duration. Opening a row navigates to the child; Stop in that conversation cancels its active Run. It reads the existing session projection, independently of the background jobs panel.

Use Plugins → Subagents to edit the run limits and select a child model from the configured catalog. Choosing **Inherit parent model** clears the override.

Subagents consumes the Runs settlement event after the terminal record is committed. It sends a stable, deduplicated completion message to the parent Inbox and uses Run records and existing assistant messages to retry delivery on startup.
