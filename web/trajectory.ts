import type { RunInfo, ViewMessage } from '../src/protocol.js';
import { projectTurns, textContent } from './session-projection.js';
import { button } from './primitives.js';

export function renderTrajectory(target: HTMLElement, messages: ViewMessage[], runs: RunInfo[] = [], facts: import('../src/protocol.js').SessionFact[] = [], tools: import('./extensions.js').ToolView[] = []) {
  const fragment = document.createDocumentFragment();
  for (const [index, turn] of projectTurns(messages, runs).entries()) {
    const section = document.createElement('section');
    section.className = 'trajectory-turn';
    const heading = document.createElement('h3');
    heading.textContent = 'Turn ' + (index + 1) + ' · ' + turn.state;
    const prompt = document.createElement('p');
    prompt.textContent = textContent(turn.user);
    section.append(heading, prompt);
    if (turn.run) {
      const timing = document.createElement('small');
      timing.textContent = 'Run ' + turn.run.id + ' · ' + turn.run.startedAt + (turn.run.finishedAt ? ' → ' + turn.run.finishedAt : '');
      section.append(timing);
    }
    for (const [step, message] of [...turn.process, ...(turn.final ? [turn.final] : [])].entries()) {
      const item = document.createElement('details');
      item.id = 'trajectory-' + (message.toolCallId ?? message.id);
      item.className = 'trajectory-step';
      const label = document.createElement('summary');
      label.textContent = 'Step ' + (step + 1) + ' · ' + (message.toolName ?? message.role) + (message.isError || message.error ? ' · Failed' : '');
      const facts = document.createElement('dl');
      const add = (key: string, value: string) => {
        const name = document.createElement('dt'), detail = document.createElement('dd');
        name.textContent = key; detail.textContent = value; facts.append(name, detail);
      };
      add('Identity', message.id ?? 'Unavailable in legacy history');
      add('Timestamp', new Date(message.timestamp).toISOString());
      add('Elapsed', message.elapsedMs === undefined ? 'Unavailable' : Math.round(message.elapsedMs) + ' ms');
      add('Token usage', message.usage ? JSON.stringify(message.usage) + ' (SDK report; completeness unverified)' : 'Unavailable');
      const input = document.createElement('pre');
      input.textContent = message.arguments === undefined ? '' : JSON.stringify(message.arguments, null, 2);
      const output = document.createElement('pre');
      output.textContent = textContent(message) || '(No text output)';
      item.append(label, facts, input, output);
      const thinking = Array.isArray(message.content) ? message.content.filter((block) => block.type === 'thinking' && block.thinking).map((block) => block.thinking).join('\n') : '';
      if (thinking) { const node = document.createElement('pre'); node.textContent = thinking; item.append(node); }
      if (message.error) add('Error', message.error);
      section.append(item);
    }
    const approvals = facts.filter(({ data }) => (data as { runId?: string }).runId === turn.run?.id);
    if (approvals.length) {
      const events = document.createElement('details'); events.className = 'trajectory-step';
      const label = document.createElement('summary'); label.textContent = 'Approval events';
      events.append(label);
      for (const fact of approvals) { const record = document.createElement('pre'); record.textContent = fact.timestamp + '\n' + JSON.stringify(fact.data, null, 2); events.append(record); }
      section.append(events);
    }
    fragment.append(section);
  }
  for (const tool of tools) {
    const item = document.createElement('details'); item.id = 'trajectory-' + tool.id; item.className = 'trajectory-step';
    const summary = document.createElement('summary'); summary.textContent = tool.name + ' · Running';
    const input = document.createElement('pre'); input.textContent = tool.arguments === undefined ? 'Input unavailable' : JSON.stringify(tool.arguments, null, 2);
    const output = document.createElement('pre'); output.textContent = tool.content ? textContent({ content: tool.content }) : 'Waiting for output';
    item.append(summary, input, output); fragment.append(item);
  }
  target.replaceChildren(fragment);
}
