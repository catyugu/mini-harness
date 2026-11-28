import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { assistantFailed, type NativeAssistantMessage } from '@mini-harness/llm/api';
import { thinkingLevels } from '@mini-harness/llm/vocabulary';
import { selectModel } from '@mini-harness/models/selection';
import type { SessionStore } from '@mini-harness/sessions/records';

export const metadata: PluginInfo = {
  title: 'AI Conversation Titles',
  description: 'Generate a short title from the first user message using the conversation model.',
};

const plugin: Plugin.Object = {
  inject: ['harnessSessions', 'harnessProfileScopes'],
  apply(ctx) {
    const sessions: SessionStore = ctx.harnessSessions;
    const scopes = ctx.harnessProfileScopes;
    ctx.on('harness/observe', async (event, signal) => {
      if (event.type !== 'input-accepted' || event.source !== 'user') return;
      const { sessionId, inputEntryId, model } = event;
      if (sessions.get(sessionId)?.titleSource === 'manual') return;
      if (sessions.inspectLog(sessionId, (log) => log.firstUserInputId()) !== inputEntryId) return;
      const input = sessions.messageEntry(sessionId, inputEntryId)?.presentation;
      const text = input?.userText || input?.attachments[0]?.name;
      if (!text) return;

      const scope = scopes.context(`session:${sessionId}`);
      const { capabilities } = selectModel(scope.harnessModels, [model]);
      const thinkingLevel =
        thinkingLevels.find((level) => capabilities.thinkingLevels?.includes(level)) ?? 'off';
      let answer: NativeAssistantMessage | undefined;
      await scope.harnessLlm.stream(
        {
          model,
          systemPrompt: 'Write a short title in the language of the input. Return only the title.',
          messages: [
            { role: 'user', content: [{ type: 'text', text: text.slice(0, 2000) }], timestamp: Date.now() },
          ],
          thinkingLevel,
          maxTokens: Math.min(64, capabilities.maxTokens),
          signal,
        },
        (event) => {
          if (event.type === 'done') answer = event.message;
        },
      );
      signal.throwIfAborted();
      if (!answer || assistantFailed(answer))
        throw new Error(answer?.errorMessage || 'Could not generate a conversation title');
      const title = answer.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!title) throw new Error('The model returned an empty conversation title');
      sessions.rename(sessionId, title, 'auto');
    });
  },
};

export default plugin;
