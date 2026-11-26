import type { Context } from 'mini-harness/cordis';
import type { TaskContext, TaskData, TaskOptions } from '@mini-harness/tasks/api';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { Static, TSchema } from 'typebox';
import type { TextPart, ImagePart, NativeToolMessage } from '@mini-harness/llm/api';

import type { ToolSchema } from '@mini-harness/llm/vocabulary';

export interface ToolUpdate {
  content?: (TextPart | ImagePart)[];
  details?: Record<string, unknown>;
}
export interface ToolResult extends ToolUpdate {
  content: (TextPart | ImagePart)[];
  isError?: boolean;
  outcome?: NativeToolMessage['outcome'];
  elapsedMs?: number;
}
export type ToolResultState = 'finished' | 'error' | NonNullable<NativeToolMessage['outcome']>;

export function toolResultState(result: NativeToolMessage): ToolResultState {
  if (result.outcome) return result.outcome;
  return result.isError ? 'error' : 'finished';
}

export interface ToolDefinition<Arguments = Record<string, any>> extends ToolSchema {
  /** Tags are interpreted by the tool consumer. */
  tags?: readonly string[];
  label?: string;
  /** Optional consumer-owned presentation or behavior metadata. */
  metadata?: Record<string, unknown>;
  /** Calls are serial unless this returns true for the validated arguments. */
  isConcurrencySafe?(args: Arguments): boolean;
  /** Optional compact serializable projection for retained calls. */
  projectResult?(result: ToolResult): TaskData;
  execute(args: Arguments, context: ToolContext): Promise<ToolResult>;
}

export interface ToolFactory {
  name: string;
  resolve(resourceId: string, caller?: Context): ToolDefinition;
  visible?(resourceId: string): boolean;
}

export interface ToolSelection {
  scope?: ScopeKey;
  resourceId?: string;
}

export interface ToolContext {
  callId: string;
  task: TaskContext;
  signal: AbortSignal;
  update(update: ToolUpdate): void;
  /** Present for inline calls made by another task. */
  owner?: TaskContext;
}

export interface ToolInvocation
  extends Partial<Pick<TaskOptions, 'owner' | 'signal' | 'retain' | 'metadata'>> {
  resourceId?: string;
  ownerTask?: TaskContext;
  /** Resolve a factory against a long-lived composition when starting independent work. */
  context?: Context;
  onUpdate?(update: ToolUpdate): void;
}

export interface ToolPort {
  register(tool: ToolDefinition | ToolFactory): () => Promise<void>;
  list(selection?: ToolSelection): ToolDefinition[];
}

export function isToolContent(value: unknown): value is ToolResult['content'] {
  return (
    Array.isArray(value) &&
    value.every((part) =>
      part?.type === 'text'
        ? typeof part.text === 'string'
        : part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string',
    )
  );
}

/** Infer argument types from a JSON schema without binding plugins to a model SDK. */
export function defineTool<Schema extends TSchema>(
  definition: Omit<ToolDefinition<Static<Schema>>, 'parameters'> & { parameters: Schema },
): ToolDefinition<Static<Schema>> {
  return definition;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessTools: ToolPort;
  }
}
