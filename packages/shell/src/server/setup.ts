import { defineTool } from '@mini-harness/tools/api';
import type { Context } from 'mini-harness/cordis';
import { Type } from 'typebox';

export function setup(ctx: Context) {
  const workspace = ctx.harnessSessions.access();
  const options = ctx.fiber.effectiveConfig as { mode: 'isolated' | 'host'; timeoutSeconds: number };
  const tool = (sessionId: string) =>
    defineTool({
      name: 'sandbox_shell',
      label: 'Shell',
      description:
        'Run a shell command in the workspace. Standard requires approval; Full access skips the approval prompt.',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
      approval: ({ command }) =>
        workspace.get(sessionId)?.permission === 'fullAccess'
          ? undefined
          : {
              title: 'Shell approval',
              message: command,
              context: JSON.stringify([workspace.workspacePath(sessionId), options]),
              followFullAccess: true,
            },
      execute: async (_id, args, signal, _update, context) => {
        await ctx.harnessScopes.prepare(`session:${sessionId}`, signal);
        const cwd = workspace.workspacePath(sessionId);
        context?.assertAuthorized?.();
        const execution = ctx.harnessScopes.require(`session:${sessionId}`, 'harnessProcess');
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
