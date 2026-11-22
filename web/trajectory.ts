import type { SessionFact, ViewMessage } from '../src/protocol.js';
import type { ToolView } from './extensions.js';
import { projectTurns, textContent, type sessionProjection } from './session-projection.js';

type Step = { node: HTMLDetailsElement; summary: HTMLElement; source?: unknown };
type Turn = { node: HTMLElement; heading: HTMLElement; prompt: HTMLElement; timing: HTMLElement; steps: HTMLElement; approval: Step };

function step(id?: string): Step {
  const node = document.createElement('details');
  if (id) node.id = 'trajectory-' + id;
  node.className = 'trajectory-step';
  const summary = document.createElement('summary');
  node.append(summary);
  return { node, summary };
}

function pre(content: string) {
  const node = document.createElement('pre');
  node.textContent = content;
  return node;
}

function setText(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

function updateStep(item: Step, label: string, source: unknown, body: () => HTMLElement[]) {
  setText(item.summary, label);
  if (item.source === source) return;
  const next = body();
  const current = [...item.node.children].slice(1);
  if (current.length !== next.length || current.some((node, index) => !node.isEqualNode(next[index]))) {
    for (const child of current) child.remove();
    item.node.append(...next);
  }
  item.source = source;
}

function messageBody(message: ViewMessage) {
  const facts = document.createElement('dl');
  const add = (key: string, value: string) => {
    const name = document.createElement('dt'), detail = document.createElement('dd');
    name.textContent = key;
    detail.textContent = value;
    facts.append(name, detail);
  };
  add('Identity', message.id ?? 'Unavailable in legacy history');
  add('Timestamp', new Date(message.timestamp).toISOString());
  add('Elapsed', message.elapsedMs === undefined ? 'Unavailable' : Math.round(message.elapsedMs) + ' ms');
  add('Token usage', message.usage ? JSON.stringify(message.usage) + ' (SDK report; completeness unverified)' : 'Unavailable');
  if (message.error) add('Error', message.error);
  const nodes = [facts, pre(message.arguments === undefined ? '' : JSON.stringify(message.arguments, null, 2)),
    pre(textContent(message) || '(No text output)')];
  const thinking = Array.isArray(message.content) && message.content.filter((block) => block.type === 'thinking' && block.thinking).map((block) => block.thinking).join('\n');
  if (thinking) nodes.push(pre(thinking));
  return nodes;
}

function turnNode(): Turn {
  const node = document.createElement('section');
  node.className = 'trajectory-turn';
  const heading = document.createElement('h3'), prompt = document.createElement('p'), timing = document.createElement('small');
  const steps = document.createElement('div');
  node.append(heading, prompt, timing, steps);
  return { node, heading, prompt, timing, steps, approval: step() };
}

function orderChildren(parent: HTMLElement, nodes: HTMLElement[]) {
  let cursor = parent.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}

export function createTrajectory(target: HTMLElement) {
  const turns = new Map<string, Turn>();
  const steps = new Map<string, Step>();
  return (history: ReturnType<typeof sessionProjection>) => {
    const entries = projectTurns(history.messages, history.runs);
    const approvals = new Map<string, SessionFact[]>();
    for (const fact of history.facts) {
      const run = (fact.data as { runId?: string })?.runId;
      const list = approvals.get(run) ?? [];
      list.push(fact);
      approvals.set(run, list);
    }

    const currentTurns = new Set<string>();
    const currentSteps = new Set<string>();
    function useStep(key: string, id: string, label: string, source: unknown, body: () => HTMLElement[]) {
      const item = steps.get(key) ?? step(id);
      currentSteps.add(key);
      steps.set(key, item);
      updateStep(item, label, source, body);
      return item.node;
    }

    const live = (tool: ToolView, turnId: string) => useStep('tool:' + turnId + ':' + tool.id, tool.id, tool.name + ' · Running', tool, () => [
      pre(tool.arguments === undefined ? 'Input unavailable' : JSON.stringify(tool.arguments, null, 2)),
      pre(tool.content ? textContent({ content: tool.content }) : 'Waiting for output')
    ]);
    const nodes = entries.map((turn, index) => {
      const key = turn.id;
      const ui = turns.get(key) ?? turnNode();
      turns.set(key, ui);
      currentTurns.add(key);
      setText(ui.heading, 'Turn ' + (index + 1) + ' · ' + turn.state);
      setText(ui.prompt, textContent(turn.user));
      const run = turn.run;
      ui.timing.hidden = !run;
      if (run) setText(ui.timing, 'Run ' + run.id + ' · ' + run.startedAt + (run.finishedAt ? ' → ' + run.finishedAt : ''));
      const nodes = [...turn.process, ...(turn.final ? [turn.final] : [])].map((message, index) => {
        const id = message.toolCallId ?? message.id ?? key + ':' + index;
        const label = 'Step ' + (index + 1) + ' · ' + (message.toolName ?? message.role) + (message.isError || message.error ? ' · Failed' : '');
        const stepKey = message.toolCallId ? 'tool:' + key + ':' + id : 'message:' + id;
        return useStep(stepKey, id, label, message, () => messageBody(message));
      });
      if (index === entries.length - 1) nodes.push(...[...history.tools.values()].map((tool) => live(tool, key)));
      const facts = approvals.get(run?.id);
      if (facts?.length) {
        updateStep(ui.approval, 'Approval events', facts.map(({ id }) => id).join(','), () => facts.map((fact) =>
          pre(fact.timestamp + '\n' + JSON.stringify(fact.data, null, 2))));
        nodes.push(ui.approval.node);
      }
      orderChildren(ui.steps, nodes);
      return ui.node;
    });
    if (!entries.length) nodes.push(...[...history.tools.values()].map((tool) => live(tool, '')));
    orderChildren(target, nodes);
    for (const key of turns.keys()) if (!currentTurns.has(key)) turns.delete(key);
    for (const key of steps.keys()) if (!currentSteps.has(key)) steps.delete(key);
  };
}
