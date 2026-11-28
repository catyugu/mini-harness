import type { ToolResult, ToolUpdate } from '@mini-harness/tools/api';

export interface Work {
  id: string;
  tool: string;
  name: string;
  arguments: Record<string, unknown>;
  state: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancellationRequested: boolean;
  outputCursor: number;
  error?: string;
  progress?: ToolUpdate;
  result?: { content: string[]; toolState: ToolResult['state']; details?: Record<string, unknown> };
}

export interface OutputChunk {
  start: number;
  end: number;
  channel: string;
  text: string;
}

export interface WorkOutput {
  cursor: number;
  truncated: boolean;
  chunks: OutputChunk[];
}
