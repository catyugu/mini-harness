import type { FrontendSetup } from '../extensions.js';
import { workspaceRoute } from '../api.js';
import { iconButton } from '../primitives.js';

const setup: FrontendSetup = (api, services) => {
  const button = iconButton('Choose skill', 'skills');
  button.hidden = true;
  button.onclick = () => api.insert('/skill:');
  api.mount('composer', button);

  let workspaceId: string;
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
      const skills = await api.request<{ name: string; description: string; source?: string; conflicts?: string[] }[]>(workspaceRoute(next, '/skills'), { signal: controller.signal });
      if (controller.signal.aborted || api.signal.aborted) return;
      for (const skill of skills) commands.push(api.command({ name: 'skill:' + skill.name, description: skill.description + (skill.conflicts?.length ? ' · ' + skill.conflicts.length + ' name conflict(s)' : ''), group: 'Skill · ' + (skill.source ?? 'user') }));
      button.hidden = !skills.length;
    } catch (error) {
      if (!controller.signal.aborted && !api.signal.aborted) services.report(error);
    }
  }
  services.onConversationChange(() => void update(), api.signal);
  void update();
};
export default setup;
