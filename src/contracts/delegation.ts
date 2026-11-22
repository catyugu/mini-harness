import type { Settings } from '../config.js';
import type { Conversation, ModelChoice } from './conversation.js';

/** The host-facing seam for child-agent scheduling. The kernel never imports its implementation. */
export interface DelegationPort {
  validate(policy: Settings['subagents']): void;
  configure(): void;
  checkProvider(id: string, removing?: boolean): void;
  visible(id: string): boolean;
  readonly parallelLimit: number;
  readonly activeChildren: number;
  schedule(record: Conversation, task: () => Promise<string>, signal: AbortSignal): Promise<string>;
  delegate(id: string, request: { task: string; provider?: string; model?: string }, signal?: AbortSignal): Promise<{ id: string; text: string }>;
  run(parentId: string, task: string, choice: ModelChoice, signal?: AbortSignal): Promise<{ id: string; text: string }>;
}
