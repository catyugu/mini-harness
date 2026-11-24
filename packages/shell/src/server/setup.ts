import { approvalExtensions } from '@mini-harness/approvals/api';
import { sessionExtensions } from '@mini-harness/sessions/records';
import type {} from '@mini-harness/process-execution/api';
import type {} from '@mini-harness/transport/projection-api';
import { toolExtensions } from '@mini-harness/tools/extensions';
import { defineTool } from '@mini-harness/tools/api';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';

export function setup(ctx: Context, api: PluginApi) {
  const workspace = api.contribute(sessionExtensions.access);
  const requestApproval = api.contribute(approvalExtensions.request);
  const options = api.config as { mode: 'isolated' | 'host'; timeoutSeconds: number };
  const tool = (sessionId: string) => defineTool({
    name: 'sandbox_shell', label: 'Shell',
    description: 'Run a shell command in the workspace. Standard requires approval; Full access skips the approval prompt.',
    parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
    execute: async (_id, args, signal, _update, context) => {
      await api.prepareSession(sessionId, signal);
      const cwd = workspace.workspacePath(sessionId);
      // A pending Standard approval may be released when the user selects Full access.
      // If the permission is reduced again before resuming, request approval anew.
      let automaticallyApproved = false;
      const approval = async () => {
        automaticallyApproved = await requestApproval(sessionId, {
          title: 'Shell approval', message: args.command, context: JSON.stringify([cwd, options]), followFullAccess: true
        }, signal);
      };
      while (workspace.get(sessionId)?.permission !== 'fullAccess') {
        if (context?.waitForApproval) await context.waitForApproval(approval);
        else await approval();
        if (!automaticallyApproved) break;
      }
      // Permission changes also apply while a Shell command is awaiting approval.
      context?.assertAuthorized?.();
      const execution = api.scopedService(sessionId, 'harnessProcess');
      try {
        const output = await execution.run({ command: args.command, cwd, ...options, signal, sessionId });
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: { ...output, exitCode: output.code } };
      } finally {
        const workspaceId = workspace.get(sessionId)?.workspaceId;
        if (workspaceId) ctx.harnessChanges.invalidate('files', { workspaceId });
      }
    }
  });
  api.contribute(toolExtensions.register, { name: 'sandbox_shell', bind: tool });
}
