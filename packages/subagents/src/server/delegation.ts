import type { RunPort } from '@mini-harness/runs/api';
import type { SessionStore } from '@mini-harness/sessions/records';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

export interface SubagentPolicy {
  maxDepth: number;
  maxParallel: number;
  model: ModelChoice | null;
}

export function selectChildModel(
  request: { provider?: string; model?: string },
  defaults: ModelChoice | null,
  parent: ModelChoice | undefined,
  models: () => readonly ModelChoice[],
): ModelChoice {
  const provider = request.provider?.trim();
  const model = request.model?.trim();
  if (provider) {
    if (model) return { provider, id: model };
    const choice = models().find((candidate) => candidate.provider === provider);
    if (!choice) throw new Error('No model configured for provider: ' + provider);
    return { provider, id: choice.id };
  }
  const inherited = defaults ?? parent;
  if (!inherited) throw new Error('Configure a model before delegating');
  return { provider: inherited.provider, id: model || inherited.id };
}

/** Prefer the action over an injected workspace preamble in delegated task titles. */
export function childTitle(task: string) {
  const action = task
    .trim()
    .replace(/^in the workspace at [^,\n]+,\s*/i, '')
    .trim();
  const firstLine = action.split(/\r?\n/).find((line) => line.trim()) ?? action;
  return (firstLine || 'Subagent task').slice(0, 72);
}

export function requireChildDepth(parentDepth: number, maxDepth = 1): void {
  if (parentDepth >= maxDepth) throw new Error('Recursive subagents reached the configured depth limit');
}

export class Delegation {
  constructor(
    private readonly sessions: SessionStore,
    private readonly runs: RunPort,
    private readonly settings: () => SubagentPolicy,
    private readonly models: () => readonly ModelChoice[],
  ) {}

  visible(id: string) {
    return this.sessions.depth(id) < this.settings().maxDepth;
  }

  delegate(
    parentId: string,
    request: { task: string; provider?: string; model?: string },
    signal?: AbortSignal,
    creator?: string,
  ) {
    signal?.throwIfAborted();
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error('Parent conversation not found');
    requireChildDepth(this.sessions.depth(parentId), this.settings().maxDepth);
    const model = selectChildModel(request, this.settings().model, this.sessions.history(parentId).model, this.models);
    const record = this.sessions.create({
      parentId,
      workspaceId: parent.workspaceId,
      title: childTitle(request.task),
    });
    const { taskId } = this.runs.send(record.id, {
      message: request.task,
      model,
      origin: { source: 'agent', senderSessionId: parentId, taskId: creator },
      mode: 'queue',
    });
    if (!taskId) throw new Error('Child conversation accepted the task but could not start: ' + record.id);
    return { sessionId: record.id, taskId, state: 'accepted' as const };
  }
}
