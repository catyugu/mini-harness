import type { Context } from 'mini-harness/cordis';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type { Static, TSchema } from 'typebox';
import type { TextPart, ImagePart, NativeToolMessage, ToolResultState } from '@mini-harness/llm/api';

import type { ToolSchema } from '@mini-harness/llm/vocabulary';

export interface ToolUpdate {
  content?: (TextPart | ImagePart)[];
  details?: Record<string, unknown>;
  state?: 'running' | 'approval';
}
export interface ToolResult {
  content: (TextPart | ImagePart)[];
  /** Compact description for consumers that display or retain the result separately. */
  summary?: string;
  detailKeys?: NativeToolMessage['detailKeys'];
  state: ToolResultState;
  details?: Record<string, unknown>;
  elapsedMs?: number;
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
  execute(args: Arguments, context: ToolContext): Promise<ToolResult>;
}

/** A registry-selected definition whose provider owns execution. */
export interface ResolvedTool extends ToolDefinition {
  readonly binding: {
    provider: Context;
    signal: AbortSignal;
    available(): boolean;
  };
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
