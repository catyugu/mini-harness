import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import { Approvals } from './approvals.js';
import { runShell } from './sandbox.js';


export function setup(ctx: Context) {
    const approvals = new Approvals(ctx.harnessSessionChanged);
    ctx.provide('harnessApprovals', approvals);
    ctx.effect(() => () => approvals.close());
    const { home } = ctx.harnessState.paths;
    const tool = (sessionId: string) => defineTool({
      name: 'sandbox_shell', label: 'Shell',
      description: 'Run a shell command in the workspace after the user approves it in the Web interface.',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
      execute: async (_id, args, signal) => {
        await approvals.request(sessionId, args.command, signal);
        const cwd = ctx.harnessWorkspace.resolve(sessionId);
        const output = await runShell(args.command, cwd, { ...(ctx.harnessSettings().pluginConfig.shell as { mode: 'isolated' | 'host'; timeoutSeconds: number }), signal, stateDir: home });
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
      }
    });
    ctx.effect(() => ctx.harnessTools.register('sandbox_shell', tool));
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/approvals', () => approvals.list()));
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/approvals', async ({ body }) => {
      const input = await body() as { id?: string; allow?: boolean } | null;
      if (typeof input?.id !== 'string' || typeof input.allow !== 'boolean') throw new Error('Choose allow or deny');
      approvals.decide(input.id, input.allow);
      return { ok: true };
    }));
}
