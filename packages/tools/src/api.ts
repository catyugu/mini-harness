import type { Context } from 'mini-harness/cordis';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { Static, TSchema } from 'typebox';
import type { TextPart, ImagePart, NativeToolMessage } from '@mini-harness/llm/api';

import type { ToolSchema } from '@mini-harness/llm/vocabulary';

export interface ToolUpdate {
  content?: (TextPart | ImagePart)[];
  details?: Record<string, unknown>;
  state?: 'running' | 'approval';
}
export interface ToolResult extends Omit<ToolUpdate, 'state'> {
  content: (TextPart | ImagePart)[];
  detailKeys?: NativeToolMessage['detailKeys'];
  isError?: boolean;
  outcome?: NativeToolMessage['outcome'];
  elapsedMs?: number;
}
export type ToolResultState = 'finished' | 'error' | NonNullable<NativeToolMessage['outcome']>;

export function toolResultState(result: Pick<ToolResult, 'isError' | 'outcome'>): ToolResultState {
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
  /** Allow independent execution through start_background. */
  background?: boolean;
  /** Compact observation for independent execution. */
  projectResult?(result: ToolResult): Record<string, unknown>;
  execute(args: Arguments, context: ToolContext): Promise<ToolResult>;
}

export const toolBinding = Symbol('tool binding');

export interface ToolBinding {
  provider: Context;
  signal: AbortSignal;
  available(): boolean;
}

/** A definition selected from a particular scope and registration lifetime. */
export interface ResolvedTool extends ToolDefinition {
  readonly [toolBinding]: ToolBinding;
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
  executionId?: string;
  signal: AbortSignal;
  update(update: ToolUpdate): void;
  write(text: string, channel?: string): void;
  report?(message: string): void;
  /** For a serial tool, wait on behalf of the enclosing execution. */
  waitFor?(id: string): Promise<void>;
}

export interface ToolInvocation {
  signal?: AbortSignal;
  executionId?: string;
  onUpdate?(update: ToolUpdate): void;
  write?(text: string, channel?: string): void;
  report?(message: string): void;
  waitFor?(id: string, signal: AbortSignal): Promise<void>;
}

export interface ToolPort {
  /**
   * Register in the caller's tool service and scope. The provider Fiber owns execution.
   * The disposer removes the registration and requests cancellation of accepted calls.
   * Dispose the provider Fiber before releasing resources used by active calls.
   */
  register(tool: ToolDefinition | ToolFactory, provider?: Context): () => void;
  list(selection?: ToolSelection): ResolvedTool[];
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
