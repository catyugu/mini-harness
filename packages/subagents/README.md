# Subagents

Subagents is an optional Cordis plugin that creates child conversations and supplies their concurrency policy. Each child is a Session with its own Inbox and Runs.

## Tools and configuration

`delegate` accepts a task and optional provider/model override. It returns the child Session and Run IDs immediately. The chosen provider/model takes precedence over the configured child model, with the parent model as the fallback. The [plugin schema](src/manifest.ts) defaults to one level of recursion and up to four concurrent child Runs. The dynamic pool also applies to follow-up Runs and automatic wakeups.

`send_message` sends to a parent or direct child Session. It defaults to Steer and accepts an explicit delivery mode. Both sides can send progress or follow-up requests while their own Run continues. An idle recipient wakes automatically unless it is paused. A child's terminal Run status is sent to its parent with Queue delivery. Child conversations stay available for further work.

Use [task control](../runs/README.md#independent-tools) to inspect, wait for or cancel a direct child Run. Stop and Interrupt affect the current Run in the selected conversation. Deleting a parent Session drains and deletes its descendants and their tasks.
