import type { SessionRecord, ModelChoice } from './conversation.js';

/** Configuration belongs to the Subagents plugin, not global Settings. */
export interface SubagentPolicy { maxDepth: number; maxParallel: number; model: ModelChoice | null }

/** The host-facing seam for child-agent scheduling. The kernel never imports its implementation. */
export interface DelegationPort {
  visible(id: string): boolean;
  readonly parallelLimit: number;
  readonly activeChildren: number;
  schedule(record: SessionRecord, task: () => Promise<string>, signal: AbortSignal): Promise<string>;
  delegate(id: string, request: { task: string; provider?: string; model?: string }, signal?: AbortSignal): Promise<{ id: string; text: string }>;
  run(parentId: string, task: string, choice: ModelChoice, signal?: AbortSignal): Promise<{ id: string; text: string }>;
}
