import type { FrontendSetup } from '../extensions.js';
import { icon } from '../icons.js';

const setup: FrontendSetup = async (api) => {
  const skills = await api.request<{ name: string; description: string }[]>('/skills');
  for (const skill of skills) api.command({ name: 'skill:' + skill.name, description: skill.description, group: 'Skill' });
  if (!skills.length) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.setAttribute('aria-label', 'Choose skill');
  button.append(icon('skills'));
  button.onclick = () => api.insert('/skill:');
  api.mount('composer', button);
};
export default setup;
