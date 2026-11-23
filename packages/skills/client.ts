import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import { workspaceRoute } from '@mini-harness/web/api';
import { iconButton } from '@mini-harness/ui-primitives/primitives';

const setup: FrontendSetup = (ctx, api) => {
  const services = ctx.harnessBrowser;
  const button = iconButton('Choose skill', 'skills');
  button.hidden = true;
  button.onclick = () => api.insert('/skill:');
  api.slots.register('conversation.composer', button);

  let workspaceId: string | undefined;
  let request: AbortController;
  let commands: (() => void)[] = [];
  async function update() {
    const next = services.workspace()?.workspaceId;
    if (workspaceId === next) return;
    workspaceId = next;
    request?.abort();
    button.hidden = true;
    const previous = commands;
    commands = [];
    await Promise.all(previous.map((dispose) => dispose()));
    if (!next || workspaceId !== next) return;
    const controller = request = new AbortController();
    try {
      const skills = await api.request<{ name: string; description: string }[]>(workspaceRoute(next, '/skills'), { signal: controller.signal });
      if (controller.signal.aborted || api.signal.aborted) return;
      for (const skill of skills) commands.push(api.command({ name: 'skill:' + skill.name, description: skill.description, group: 'Skill' }));
      button.hidden = !skills.length;
    } catch (error) {
      if (!controller.signal.aborted && !api.signal.aborted) services.report(error instanceof Error ? error : new Error(String(error)));
    }
  }
  services.onConversationChange(() => void update(), api.signal);
  void update();
};
export default setup;
