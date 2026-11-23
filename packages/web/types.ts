import type { Conversation } from '../contracts/conversation.js';
import type { StreamEvent } from '../contracts/transport.js';
import type { ViewMessage } from '../contracts/message.js';
import type { ProviderInfo } from './contracts/providers.js';
import type { BrowserEntry } from '../contracts/browser.js';
export type ThinkingLevel = import('@earendil-works/pi-coding-agent').AgentSession['thinkingLevel'];
export interface ModelInfo { provider: string; id: string; name: string; configured: boolean; thinkingLevels: ThinkingLevel[] }
export interface Bootstrap { ui: BrowserEntry[] }
export interface ModelCatalog { models: ModelInfo[]; providers: ProviderInfo[] }
export interface ConversationView extends Conversation { thinkingLevel: ThinkingLevel; messages: ViewMessage[]; leafId: string | null; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; queue?: { steer: string[]; followUp: string[] } }
