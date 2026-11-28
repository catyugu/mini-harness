import { defineTool, type ToolResult } from '@mini-harness/tools/api';
import type { Context } from 'mini-harness/cordis';
import { DomainError } from '@mini-harness/platform/errors';
import type { ProcessCommand } from '@mini-harness/process-execution/api';
import { Type } from 'typebox';
import { runShellCommand } from './command.ts';

export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessChanges.register('files'));
  const workspace = ctx.harnessSessions;
  const options = ctx.fiber.effectiveConfig as { timeoutMs: number; maxOutputBytes: number };
  const tool = (sessionId: string, caller = ctx) =>
    defineTool({
      name: 'shell',
      label: 'Shell',
      description:
        'Run a shell command in the workspace. For long builds or tests, use start_background and set timeoutMs as needed.',
      parameters: Type.Object(
        {
          command: Type.String({ minLength: 1, maxLength: 16000 }),
          timeoutMs: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 86400000,
              description: 'Command timeout in milliseconds; defaults to the Shell plugin setting.',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      background: true,
      projectResult(result) {
        if (result.details?.exitCode === undefined) return JSON.parse(JSON.stringify(result));
        const { stdout: _stdout, stderr: _stderr, ...details } = result.details;
        return JSON.parse(
          JSON.stringify({
            details,
            summary: 'Exit ' + details.exitCode,
            elapsedMs: result.elapsedMs,
          }),
        );
      },
      execute: async (args, { signal, write }): Promise<ToolResult> => {
        const cwd = workspace.workspacePath(sessionId);
        if (!cwd) throw new DomainError('unavailable', 'Shell requires a workspace');
        if (caller.get('harnessToolPolicy')?.(sessionId, { name: 'shell' }) === false)
          throw new Error('Tool denied by conversation policy: shell');
        signal.throwIfAborted();
        const execution = caller.get('harnessProcess');
        if (!execution) throw new Error('Process execution is unavailable');
        const attachments = ctx.harnessSessions.attachmentDirectory(sessionId);
        const { maxOutputBytes } = options;
        const timeoutMs = args.timeoutMs ?? options.timeoutMs;
        const env = { ...process.env };
        if (attachments) env.MINI_HARNESS_ATTACHMENTS = attachments;
        else delete env.MINI_HARNESS_ATTACHMENTS;
        const command: ProcessCommand =
          process.platform === 'win32'
            ? {
                file: env.ComSpec || 'cmd.exe',
                args: ['/d', '/s', '/c', '"' + args.command + '"'],
                cwd,
                env,
                windowsVerbatimArguments: true,
              }
            : { file: '/bin/sh', args: ['-c', args.command], cwd, env };
        try {
          const startedAt = performance.now();
          const output = await runShellCommand(execution, command, timeoutMs, maxOutputBytes, signal, write);
          const cancelled = output.reason === 'cancelled';
          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            state: cancelled ? 'cancelled' : output.reason || output.code !== 0 ? 'error' : 'finished',
            detailKeys: ['exitCode'],
            details: {
              ...output,
              timeoutMs,
              exitCode: output.code,
              diagnostics: (output.stderr + '\n' + output.stdout)
                .split('\n')
                .filter((line) => /error|fatal|failed|warning|undefined reference/i.test(line))
                .join('\n')
                .slice(0, 1000),
            },
            elapsedMs: performance.now() - startedAt,
          };
        } finally {
          const workspaceId = workspace.get(sessionId)?.workspaceId;
          if (workspaceId) ctx.harnessChanges.invalidate('files', workspaceId);
        }
      },
    });
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'shell',
      resolve: tool,
      visible: (id) => Boolean(workspace.get(id)?.workspaceId),
    }),
  );
}
