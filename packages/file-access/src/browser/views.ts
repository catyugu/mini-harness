import type {} from '@mini-harness/ui-runtime/projection-api';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import type { Context } from 'mini-harness/cordis';

export interface WorkspaceView { workspaceId: string; sessionId?: string }

export function fileRoute(scope: WorkspaceView, route: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams(query);
  if (scope.sessionId) params.set('sessionId', scope.sessionId);
  return workspaceRoute(scope.workspaceId, route) + '?' + params;
}

export function refreshOnFileChange(ctx: Context, scope: WorkspaceView, root: HTMLElement, signal: AbortSignal, load: () => void) {
  const release = ctx.miniProjections.register('files', {
    sync(_revision, reconnect, workspaceId) {
      if (reconnect || !workspaceId || workspaceId === scope.workspaceId) load();
    }
  });
  window.addEventListener('focus', load, { signal });
  root.addEventListener('tab-activate', load, { signal });
  signal.addEventListener('abort', release, { once: true });
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniFileTree: { open(path: string, scope: WorkspaceView): void };
  }
}
