import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import { Approvals } from '../approvals.js';
import { runShell } from '../sandbox.js';
import type { BuiltinPlugin } from '../plugins.js';

export const shell: BuiltinPlugin = {
  id: 'shell', title: 'Shell', description: 'Run commands using the configured execution policy.',
  preferences: { key: 'sandbox', schema: { ...Type.Object({
    mode: Type.String({ title: 'Shell policy', enum: ['isolated', 'host'] }),
    timeoutSeconds: Type.Integer({ title: 'Timeout (seconds)', minimum: 1, maximum: 300 })
  }) } },
  icon: 'terminal', browser: '/builtins/shell.js', inject: ['harnessState', 'harnessWorkspace', 'harnessShellPolicy', 'harnessTools', 'harnessRoutes', 'harnessExecutionPolicy', 'harnessSessionEvents'],
  setup(ctx: Context) {
    const approvals = new Approvals((approval) => ctx.harnessSessionEvents.publish(approval.sessionId, { type: 'approval', approval }));
    ctx.effect(() => () => approvals.close());
    const { home } = ctx.harnessState.paths;
    const tool = (sessionId: string) => defineTool({
      name: 'sandbox_shell', label: 'Shell',
      description: 'Run a shell command in the workspace after the user approves it in the Web interface.',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
      execute: async (_id, args, signal) => {
        ctx.harnessWorkspace.approval(sessionId, true);
        try { await approvals.request(sessionId, args.command, signal); }
        finally { ctx.harnessWorkspace.approval(sessionId, false); }
        const cwd = ctx.harnessWorkspace.resolve(sessionId);
        const permission = ctx.harnessExecutionPolicy.get(sessionId);
        const output = await runShell(args.command, cwd, { ...ctx.harnessShellPolicy.get(),
          mode: permission === 'full' ? ctx.harnessShellPolicy.get().mode : 'isolated',
          writable: permission !== 'read-only', signal, stateDir: home });
        return { content: [{ type: 'text', text: JSON.stringify(output) }], details: output };
      }
    });
    ctx.effect(() => ctx.harnessTools.register(tool(''), tool, undefined, true, ['shell']));
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/approvals', () => approvals.list()));
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/approvals', async ({ body }) => {
      const input = await body() as { id?: string; allow?: boolean } | null;
      if (typeof input?.id !== 'string' || typeof input.allow !== 'boolean') throw new Error('Choose allow or deny');
      approvals.decide(input.id, input.allow);
      return { ok: true };
    }));
  }
};
