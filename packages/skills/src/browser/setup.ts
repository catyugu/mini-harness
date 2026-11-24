import type {} from '@mini-harness/conversation/browser/navigation-api';
import type {} from '@mini-harness/ui-runtime/projection-api';
import { slotExtensions } from '@mini-harness/ui-slots/browser/api';
import { conversationExtensions } from '@mini-harness/conversation/browser/composer-api';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { iconButton } from '@mini-harness/ui-primitives/primitives';

const setup: FrontendSetup = (ctx, api) => {
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
    const controller = request = new AbortController();
    const previous = commands;
    commands = [];
    button.hidden = !workspace;
    await Promise.all(previous.map((dispose) => dispose()));
    if (!workspace || controller.signal.aborted || api.signal.aborted) return;
    try {
      const query = sessionId ? '?' + new URLSearchParams({ sessionId }) : '';
      const skills = await api.request<{ name: string; description: string }[]>(workspaceRoute(workspace, '/skills') + query, { signal: controller.signal });
      if (controller.signal.aborted || api.signal.aborted) return;
      for (const skill of skills)
        commands.push(api.contribute(conversationExtensions.command, { name: 'skill:' + skill.name, aliases: [skill.name], description: skill.description, group: 'Skill' }));
    } catch (error) {
      if (!controller.signal.aborted && !api.signal.aborted) services.report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  button.hidden = true;
  button.onclick = () => {
    const refreshed = update(true);
    const current = request;
    void refreshed.then(() => {
      if (current === request && !api.signal.aborted) ctx.miniComposer.insert('/skill:');
    });
  };
  api.contribute(slotExtensions.register, 'conversation.composer', button);
  api.onDispose(ctx.miniProjections.register('plugins', { sync: () => update(true) }));
  services.onConversationChange(() => void update(), api.signal);
  void update();
};
export default setup;
