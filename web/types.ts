import type { Settings } from '../src/config.js';
import type { Conversation, ModelChoice } from '../src/registry.js';
import type { StreamEvent, ViewMessage } from '../src/protocol.js';
import type { PluginMetadata } from '../src/plugins.js';
import type { ProviderInfo } from './provider-manager.js';
export type ThinkingLevel = import('@earendil-works/pi-coding-agent').AgentSession['thinkingLevel'];
export interface ModelInfo { provider: string; id: string; name: string; configured: boolean; thinkingLevels: ThinkingLevel[] }
export interface Bootstrap { settings: Settings; sessions: Conversation[]; models: ModelInfo[]; plugins: PluginMetadata[]; workspace: string; isolation: boolean; providers: ProviderInfo[] }
export interface ConversationView extends Conversation { selectedModel: ModelChoice; thinkingLevel: ThinkingLevel; messages: ViewMessage[]; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[] }
