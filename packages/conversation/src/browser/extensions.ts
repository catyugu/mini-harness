import type { BrowserContributionSource } from '@mini-harness/ui-runtime/contribution';
import type { ComposerCommand, Completer, DraftMode } from './composer-api.js';
import type { MessageAction, RecordRenderer, ToolRenderer } from './history-api.js';

export const conversationExtensions = {
  command(source: BrowserContributionSource, command: ComposerCommand) {
    return source.effect(() => source.service('miniComposer').command(command));
  },
  completion(source: BrowserContributionSource, trigger: string, complete: Completer) {
    return source.effect(() => source.service('miniComposer').completion(trigger, complete));
  },
  draft(source: BrowserContributionSource, mode: DraftMode) {
    return source.effect(() => source.service('miniComposer').beginDraftMode(mode));
  },
  record(source: BrowserContributionSource, render: RecordRenderer, plugin = source.id) {
    return source.effect(() => source.service('miniMessages').registerRecord(plugin, render));
  },
  messageAction(source: BrowserContributionSource, action: MessageAction) {
    return source.effect(() => source.service('miniMessages').registerAction(action));
  },
  tool(source: BrowserContributionSource, name: string, render: ToolRenderer) {
    return source.effect(() => source.service('miniMessages').registerTool(name, render));
  },
  toolAction(source: BrowserContributionSource, name: string, render: ToolRenderer) {
    return source.effect(() => source.service('miniMessages').registerTool(name, render, true));
  }
};
