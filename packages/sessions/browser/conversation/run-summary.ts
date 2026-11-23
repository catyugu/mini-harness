import type { RunInfo } from '@mini-harness/contracts/transport';
import { isRunning } from '@mini-harness/web/transport/session-client';
import { required } from '@mini-harness/ui-primitives/primitives';

export function createRunSummary(root: HTMLElement, onDispose: (cleanup: () => void) => void) {
  const status = required(root.querySelector('span'));
  const elapsed = required(root.querySelector('time'));
  const changedFiles = required(root.querySelector<HTMLDetailsElement>('#changedFiles'));
  const states = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed',
    cancelled: 'Cancelled', interrupted: 'Interrupted. You can continue this conversation. Unconfirmed tools will not rerun.' };
  let current: RunInfo | undefined;

  function renderElapsed() {
    if (!current) return;
    const end = current.finishedAt ? Date.parse(current.finishedAt) : Date.now();
    const seconds = Math.max(0, Math.floor((end - Date.parse(current.startedAt)) / 1000));
    elapsed.textContent = seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' min ' + seconds % 60 + ' s';
  }

  const timer = setInterval(() => { if (isRunning(current)) renderElapsed(); }, 1000);
  onDispose(() => clearInterval(timer));

  return (run?: RunInfo) => {
    current = run;
    root.hidden = !run;
    if (!run) return;
    root.dataset.state = run.state;
    status.textContent = states[run.state];
    const paths = run.changedFiles ?? [];
    changedFiles.hidden = paths.length === 0;
    if (!paths.length) changedFiles.open = false;
    else {
      required(changedFiles.querySelector('summary')).textContent = paths.length + (paths.length === 1 ? ' file changed' : ' files changed');
      required(changedFiles.querySelector('ul')).replaceChildren(...paths.map((path) => {
        const item = document.createElement('li');
        item.textContent = path;
        return item;
      }));
    }
    renderElapsed();
  };
}
