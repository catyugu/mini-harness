import type { ToolView } from '@mini-harness/conversation/browser/history-api';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { iconButton, textOutput } from '@mini-harness/ui-primitives/primitives';

const setup = (ctx: Context) => {
  ctx.inject(['miniMessages'], (history) => {
    function nameOf(args: unknown) {
      return args && typeof args === 'object' && 'name' in args && typeof args.name === 'string' ? args.name : '';
    }
    history.effect(() => history.miniMessages.registerTool('load_skill', () => {
      const node = document.createElement('span');
      node.className = 'skill-tool-summary ui-truncate';
      return { node, update(tool) {
        const name = nameOf(tool.arguments);
        if (node.textContent !== name) node.textContent = name;
        node.hidden = !name;
      } };
    }, 'summary'));
    history.effect(() => history.miniMessages.registerTool('load_skill', () => {
      const node = document.createElement('div');
      node.className = 'skill-tool-body';
      const title = document.createElement('strong');
      const output = textOutput('');
      node.append(title, output);
      let previous: ToolView['content'];
      return { node, update({ arguments: args, content }) {
        const name = nameOf(args);
        if (title.textContent !== name) title.textContent = name;
        title.hidden = !name;
        if (content !== previous) {
          previous = content;
          const text = typeof content === 'string' ? content :
            content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
          if (output.textContent !== text) output.textContent = text;
        }
        output.hidden = !output.textContent;
      } };
    }));
  });
  const signal = ctx.fiber.signal;
  const services = ctx.harnessBrowser;
  const button = iconButton('Choose skill', 'skills');
  let workspaceId: string | undefined;
  let sessionId: string | undefined;
  let request: AbortController | undefined;
  let commands: (() => void | Promise<void>)[] = [];

  async function update(force = false) {
    const workspace = services.workspace()?.workspaceId;
    const session = services.session();
    const conversation = session?.workspaceId === workspace ? session?.id : undefined;
    if (!force && workspaceId === workspace && sessionId === conversation) return;
    workspaceId = workspace;
    sessionId = conversation;
    request?.abort();
    const controller = (request = new AbortController());
    const previous = commands;
    commands = [];
    button.hidden = !workspace;
    await Promise.all(previous.map((dispose) => dispose()));
    if (!workspace || controller.signal.aborted || signal.aborted) return;
    try {
      const query = sessionId ? '?' + new URLSearchParams({ sessionId }) : '';
      const skills = await browserRequest<{ name: string; description: string }[]>(
        ctx,
        workspaceRoute(workspace, '/skills') + query,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || signal.aborted) return;
      for (const skill of skills)
        commands.push(
          ctx.effect(() =>
            ctx.miniComposer.command({
              name: 'skill:' + skill.name,
              aliases: [skill.name],
              description: skill.description,
              group: 'Skill',
            }),
          ),
        );
    } catch (error) {
      if (!controller.signal.aborted && !signal.aborted)
        services.report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  button.hidden = true;
  button.onclick = () => {
    const refreshed = update(true);
    const current = request;
    void refreshed.then(() => {
      if (current === request && !signal.aborted) ctx.miniComposer.insert('/skill:');
    });
  };
  ctx.effect(() => ctx.miniSlots.register('conversation.composer', button));
  ctx.effect(() => ctx.miniProjections.register('plugins', { sync: () => update(true) }));
  services.onConversationChange(() => void update(), signal);
  void update();
};
export default {
  inject: ['harnessBrowser', 'miniProjections', 'miniComposer', 'miniSlots'],
  provide: [],
  apply: setup,
};
