import type { Static, TSchema } from 'typebox';
import type { TextPart, ImagePart } from './llm.js';

export interface ToolSchema { name: string; description: string; parameters: object }
export interface ToolResult { content: (TextPart | ImagePart)[]; details?: Record<string, unknown> }
export interface ToolContext {
  sessionId: string;
  cwd: string;
  waitForApproval?(request: () => Promise<void>): Promise<void>;
}
export interface ToolDefinition<Arguments = Record<string, any>> extends ToolSchema {
  label?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  /** Calls are serial unless this returns true for the validated arguments. */
  isConcurrencySafe?(args: Arguments): boolean;
  execute(callId: string, args: Arguments, signal?: AbortSignal,
    onUpdate?: (result: ToolResult) => void, context?: ToolContext): Promise<ToolResult>;
}

export function isToolContent(value: unknown): value is ToolResult['content'] {
  return Array.isArray(value) && value.every((part) => part?.type === 'text' ? typeof part.text === 'string' :
    part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string');
}

/** Infer argument types from a JSON schema without binding plugins to a model SDK. */
export function defineTool<Schema extends TSchema>(definition: Omit<ToolDefinition<Static<Schema>>, 'parameters'> & { parameters: Schema }): ToolDefinition<Static<Schema>> {
  return definition;
}
