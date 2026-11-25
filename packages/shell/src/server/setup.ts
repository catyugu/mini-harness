import { defineTool } from '@mini-harness/tools/api';
import type { Context } from 'mini-harness/cordis';
import type { ProcessCommand } from '@mini-harness/process-execution/api';
import { Type } from 'typebox';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { containsPath } from '@mini-harness/platform/paths';
import { runShellCommand } from './command.ts';

export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessChanges.register('files'));
  const workspace = ctx.harnessSessions;
  const requestApproval = ctx.harnessApprovalRequests.request.bind(ctx.harnessApprovalRequests);
  const options = ctx.fiber.effectiveConfig as { mode: 'isolated' | 'host'; timeoutSeconds: number };
  const tool = (sessionId: string, caller = ctx) =>
    defineTool({
      name: 'sandbox_shell',
      label: 'Shell',
      description:
        'Run a shell command in the workspace. Standard requires approval; Full access skips the approval prompt.',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16000 }) }),
      execute: async (_id, args, signal, _update, context) => {
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
        const execution = caller.get('harnessProcess');
        if (!execution) throw new Error('Process execution is unavailable');
        const attachments = ctx.harnessRegistry.attachmentDirectory(sessionId);
        const { mode, timeoutSeconds } = options;
        let command: ProcessCommand;
        if (mode === 'isolated') {
          const sandbox = caller.get('harnessSandbox');
          if (!sandbox) throw new Error('Isolation unavailable: no Sandbox backend is configured');
          const [root, state] = await Promise.all([realpath(cwd), realpath(ctx.harnessState.paths.home)]);
          if (relative(root, cwd) || containsPath(root, state) || containsPath(state, root))
            throw new Error('Use a canonical working directory separate from protected storage');
          command = await sandbox.prepare(
            {
              file: '/bin/sh',
              args: ['-c', args.command],
              cwd,
              env: {
                PATH: '/usr/local/bin:/usr/bin:/bin',
                HOME: '/tmp',
                ...(attachments && { MINI_HARNESS_ATTACHMENTS: '/attachments' }),
              },
            },
            {
              workingDirectory: '/workspace',
              limits: { cpuSeconds: timeoutSeconds, openFiles: 1024, fileBytes: 268435456, coreBytes: 0 },
              mounts: [
                { source: root, target: '/workspace' },
                ...(attachments ? [{ source: attachments, target: '/attachments', readOnly: true }] : []),
              ],
              signal,
            },
          );
        } else {
          const env = { ...process.env };
          if (attachments) env.MINI_HARNESS_ATTACHMENTS = attachments;
          else delete env.MINI_HARNESS_ATTACHMENTS;
          command =
            process.platform === 'win32'
              ? {
                  file: env.ComSpec || 'cmd.exe',
                  args: ['/d', '/s', '/c', '"' + args.command + '"'],
                  cwd,
                  env,
                  windowsVerbatimArguments: true,
                }
              : { file: '/bin/sh', args: ['-c', args.command], cwd, env };
        }
        try {
          const output = await runShellCommand(execution, command, timeoutSeconds, signal);
          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            details: { ...output, exitCode: output.code },
          };
        } finally {
          const workspaceId = workspace.get(sessionId)?.workspaceId;
          if (workspaceId) ctx.harnessChanges.invalidate('files', workspaceId);
        }
      },
    });
  ctx.effect(() => ctx.harnessTools.register({ name: 'sandbox_shell', resolve: tool }));
}
