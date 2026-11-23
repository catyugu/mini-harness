import type { Conversation } from '#mini-harness/contracts/conversation.js';
import type { StreamEvent } from '#mini-harness/contracts/transport.js';
import type { ViewMessage } from '#mini-harness/contracts/message.js';
import type { ProviderInfo } from './contracts/providers.js';
import type { BrowserEntry } from '#mini-harness/contracts/browser.js';
import type { ThinkingLevel } from '#mini-harness/contracts/agent.js';
export type { ThinkingLevel } from '#mini-harness/contracts/agent.js';
export interface ModelInfo { provider: string; id: string; name: string; configured: boolean; thinkingLevels: ThinkingLevel[] }
export interface Bootstrap { ui: BrowserEntry[] }
export interface ModelCatalog { models: ModelInfo[]; providers: ProviderInfo[] }
export interface ConversationView extends Conversation { thinkingLevel: ThinkingLevel; messages: ViewMessage[]; leafId: string | null; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; queue?: { steer: string[]; followUp: string[] } }
