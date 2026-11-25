export interface ModelChoice {
  provider: string;
  id: string;
}
export interface ToolSchema {
  name: string;
  description: string;
  parameters: object;
}
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return thinkingLevels.some((level) => level === value);
}

export const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;
