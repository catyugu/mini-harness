import type { WorkspaceRecord } from '../contracts/workspace.js';
import type { Settings } from '../contracts/config.js';
import type { Conversation, ModelChoice } from '../contracts/conversation.js';
import type { StreamEvent } from '../contracts/transport.js';
import type { ViewMessage } from '../contracts/message.js';
import type { PluginMetadata } from '../contracts/plugins.js';
import type { ProviderInfo } from './contracts/providers.js';
export type ThinkingLevel = import('@earendil-works/pi-coding-agent').AgentSession['thinkingLevel'];
export interface ModelInfo { provider: string; id: string; name: string; configured: boolean; thinkingLevels: ThinkingLevel[] }
export interface Bootstrap { settings: Settings; sessions: Conversation[]; models: ModelInfo[]; plugins: PluginMetadata[]; workspaces: WorkspaceRecord[]; providers: ProviderInfo[] }
export interface ConversationView extends Conversation { selectedModel: ModelChoice; thinkingLevel: ThinkingLevel; messages: ViewMessage[]; leafId: string | null; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; queue?: { steer: string[]; followUp: string[] } }
