import { defineTool } from '@mini-harness/tools/api';
import type { Context } from 'mini-harness/cordis';
import { Type } from 'typebox';

export function setup(ctx: Context) {
  const workspace = ctx.harnessSessions;
  const requestApproval = ctx.harnessApprovalRequests.request.bind(ctx.harnessApprovalRequests);
  const options = ctx.fiber.effectiveConfig as { mode: 'isolated' | 'host'; timeoutSeconds: number };
  const tool = (sessionId: string) =>
    defineTool({
      name: 'sandbox_shell',
      label: 'Shell',
      description:
        'Run a shell command in the workspace. Standard requires approval; Full access skips the approval prompt.',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
      execute: async (_id, args, signal, _update, context) => {
        await ctx.harnessProfileScopes.prepare(`session:${sessionId}`, signal);
        const cwd = workspace.workspacePath(sessionId);
        // A pending Standard approval may be released when the user selects Full access.
        // If the permission is reduced again before resuming, request approval anew.
        let automaticallyApproved = false;
        const approval = async () => {
          automaticallyApproved = await requestApproval(
            sessionId,
            {
              title: 'Shell approval',
              message: args.command,
              context: JSON.stringify([cwd, options]),
              followFullAccess: true,
            },
            signal,
          );
        };
        while (workspace.get(sessionId)?.permission !== 'fullAccess') {
          if (context?.waitForApproval) await context.waitForApproval(approval);
          else await approval();
          if (!automaticallyApproved) break;
        }
        // Permission changes also apply while a Shell command is awaiting approval.
        context?.assertAuthorized?.();
        const execution = ctx.harnessProfileScopes.require(`session:${sessionId}`, 'harnessProcess');
        try {
          const output = await execution.run({ command: args.command, cwd, ...options, signal, sessionId });
          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            details: { ...output, exitCode: output.code },
          };
        } finally {
          const workspaceId = workspace.get(sessionId)?.workspaceId;
          if (workspaceId) ctx.harnessChanges.invalidate('files', { workspaceId });
        }
      },
    });
  ctx.effect(() => ctx.harnessTools.register({ name: 'sandbox_shell', bind: tool }));
}
