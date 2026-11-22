import type { WorkspaceRecord } from '../src/services/workspaces.js';
import type { Settings } from '../src/config.js';
import type { Conversation, ModelChoice } from '../src/services/conversations.js';
import type { StreamEvent, ViewMessage } from '../src/protocol.js';
import type { PluginMetadata } from '../src/contracts/plugins.js';
import type { ProviderInfo } from './contracts/providers.js';
export type ThinkingLevel = import('@earendil-works/pi-coding-agent').AgentSession['thinkingLevel'];
export interface ModelInfo { provider: string; id: string; name: string; configured: boolean; thinkingLevels: ThinkingLevel[] }
export interface Bootstrap { settings: Settings; sessions: Conversation[]; models: ModelInfo[]; plugins: PluginMetadata[]; workspaces: WorkspaceRecord[]; isolation: boolean; providers: ProviderInfo[] }
export interface ConversationView extends Conversation { selectedModel: ModelChoice; thinkingLevel: ThinkingLevel; messages: ViewMessage[]; leafId: string | null; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; queue?: { steer: string[]; followUp: string[] } }
