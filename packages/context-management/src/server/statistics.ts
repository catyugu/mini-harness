import type { NativeUsage } from '@mini-harness/llm/api';
import type { ModelAttempt, SessionEntry, SessionLogPort } from '@mini-harness/sessions/log-api';
import type { ContextState, TokenTotals } from '../shared/state.ts';

type Request = { id: string; parentId: string | null; transformed?: true };
type Observation = { id: string; parentId: string | null } & (
  | ({ type: 'model-request' } & Request)
  | ({ type: 'model-attempt' } & ModelAttempt)
  | { type: 'user' }
  | { type: 'assistant'; usage?: NativeUsage; attemptsRecorded?: true }
  | { type: 'tool'; elapsedMs: number }
);

function addUsage(total: TokenTotals | undefined, usage: TokenTotals | undefined): TokenTotals | undefined {
  if (!usage) return total;
  return {
    input: (total?.input ?? 0) + usage.input,
    cacheRead: (total?.cacheRead ?? 0) + usage.cacheRead,
    cacheWrite:
      total?.cacheWrite !== undefined || usage.cacheWrite !== undefined
        ? (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0)
        : undefined,
    output: (total?.output ?? 0) + usage.output,
  };
}

function knownUsage(usage: NativeUsage | undefined): TokenTotals | undefined {
  if (!usage || !(usage.totalTokens || usage.input || usage.cacheRead || usage.cacheWrite || usage.output))
    return;
  const { input, cacheRead, cacheWrite, output } = usage;
  return { input, cacheRead, cacheWrite: cacheWrite || (usage.cacheWriteSupported ? 0 : undefined), output };
}

function observe(entry: SessionEntry): Observation | undefined {
  const { id, parentId } = entry;
  if (entry.type === 'model-attempt') return entry;
  if (entry.type === 'model-request' && !entry.request.purpose)
    return { id, parentId, type: entry.type, transformed: entry.request.messagesPatch ? true : undefined };
  if (entry.type !== 'message') return;
  const { message } = entry;
  switch (message.role) {
    case 'user':
      return { id, parentId, type: 'user' };
    case 'assistant':
      return {
        id,
        parentId,
        type: 'assistant',
        usage: message.usage,
        attemptsRecorded: entry.attemptsRecorded,
      };
    case 'toolResult': {
      const elapsedMs = message.elapsedMs ?? entry.elapsedMs;
      if (elapsedMs !== undefined) return { id, parentId, type: 'tool', elapsedMs };
    }
  }
}

class BranchStatistics {
  private readonly totals: Omit<ContextState, 'settings' | 'custom'> = {
    turns: 0,
    steps: 0,
    assistantUsage: Object.create(null),
  };
  private latestRequest?: Request;
  private latency = 0;
  private latencySamples = 0;
  private generationMs = 0;
  private generationTokens = 0;
  private lastStep?: string;

  private assistantId?: string;
  private assistantRun?: string;
  private assistantUsage?: TokenTotals;
  private pendingRun?: string;
  private pendingUsage?: TokenTotals;

  append(entry: Observation) {
    const stats = this.totals;
    switch (entry.type) {
      case 'model-request':
        this.latestRequest = entry;
        break;
      case 'model-attempt': {
        if (!entry.summary && entry.step !== undefined) {
          const key = entry.runId + ':' + entry.step;
          if (key !== this.lastStep) stats.steps++;
          this.lastStep = key;
        }
        stats.modelMs = (stats.modelMs ?? 0) + entry.elapsedMs;
        const usage = knownUsage(entry.usage);
        stats.usage = addUsage(stats.usage, usage);
        if (entry.runId) {
          if (this.pendingRun !== entry.runId) this.pendingUsage = undefined;
          this.pendingRun = entry.runId;
          this.pendingUsage = addUsage(this.pendingUsage, usage);
        }
        if (entry.firstTokenMs !== undefined) {
          this.latency += entry.firstTokenMs;
          this.latencySamples++;
          const generation = entry.elapsedMs - entry.firstTokenMs;
          if (usage?.output && generation > 0) {
            this.generationMs += generation;
            this.generationTokens += usage.output;
          }
        }
        break;
      }
      case 'tool':
        stats.toolMs = (stats.toolMs ?? 0) + entry.elapsedMs;
        break;
      case 'user':
        stats.turns++;
        this.assistantId = undefined;
        this.assistantRun = undefined;
        this.assistantUsage = undefined;
        this.pendingRun = undefined;
        this.pendingUsage = undefined;
        break;
      case 'assistant': {
        if (this.pendingRun && this.pendingRun !== this.assistantRun) {
          this.assistantId = undefined;
          this.assistantUsage = undefined;
          this.assistantRun = this.pendingRun;
        }
        this.assistantId ??= entry.id;
        const historical = entry.attemptsRecorded ? undefined : knownUsage(entry.usage);
        if (!entry.attemptsRecorded) stats.steps++;
        stats.usage = addUsage(stats.usage, historical);
        this.assistantUsage = addUsage(addUsage(this.assistantUsage, this.pendingUsage), historical);
        if (this.assistantUsage) stats.assistantUsage[this.assistantId] = this.assistantUsage;
        this.pendingUsage = undefined;
        break;
      }
    }
  }

  read() {
    const stats = {
      ...this.totals,
      assistantUsage: { ...this.totals.assistantUsage },
      ttftMs: this.latencySamples ? this.latency / this.latencySamples : undefined,
      tokensPerSecond: this.generationMs ? (this.generationTokens * 1000) / this.generationMs : undefined,
    };
    if (this.assistantId && this.pendingRun === this.assistantRun && this.pendingUsage) {
      const usage = addUsage(this.assistantUsage, this.pendingUsage);
      if (usage) stats.assistantUsage[this.assistantId] = usage;
    }
    return { stats, latestRequest: this.latestRequest };
  }
}

type StatisticsLog = Pick<SessionLogPort, 'entries'>;

export class Statistics {
  private cursor = 0;
  private readonly links = new Map<string, { seq: number; parentId: string | null }>();
  private readonly toolDurations = new Map<string, number>();
  private readonly observations: Observation[] = [];
  private aggregate = new BranchStatistics();
  private leaf: string | null = null;

  constructor(private readonly log: StatisticsLog) {}

  read(leaf: string | null) {
    const cursor = this.cursor;
    let start = this.observations.length;
    for (const entry of this.log.entries(cursor)) {
      const { id, seq, parentId } = entry;
      this.links.set(id, { seq, parentId });
      this.cursor = seq;
      const observation = observe(entry);
      if (observation) this.observations.push(observation);
      if (entry.type === 'tool-execution' && entry.result.elapsedMs !== undefined)
        this.toolDurations.set(id, entry.result.elapsedMs);
      if (entry.type === 'tool-accepted') {
        const elapsedMs = this.toolDurations.get(entry.executionId);
        if (elapsedMs !== undefined) this.observations.push({ id, parentId, type: 'tool', elapsedMs });
      }
    }
    const ancestry = new Set<string | null>();
    let ancestor = leaf;
    while (ancestor !== this.leaf && ancestor !== null) {
      const link = this.links.get(ancestor)!;
      if (link.seq <= cursor) break;
      ancestry.add(ancestor);
      ancestor = link.parentId;
    }
    if (ancestor !== this.leaf) {
      // Revisions can select any earlier prefix. Only this case replays previous observations.
      this.aggregate = new BranchStatistics();
      start = 0;
      ancestry.clear();
      for (ancestor = leaf; ancestor !== null; ancestor = this.links.get(ancestor)!.parentId)
        ancestry.add(ancestor);
    }
    ancestry.add(ancestor);
    for (let index = start; index < this.observations.length; index++) {
      const observation = this.observations[index];
      const operational = observation.type === 'model-attempt' || observation.type === 'model-request';
      if (ancestry.has(operational ? observation.parentId : observation.id))
        this.aggregate.append(observation);
    }
    this.leaf = leaf;
    return this.aggregate.read();
  }
}
