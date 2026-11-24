import type { Context } from 'cordis';
import type { FrontendApi } from '@mini-harness/ui-runtime/frontend-api';
import type { Attachment } from '@mini-harness/input/message';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { ComposerCommand, Completer, DraftMode } from '../composer-api.js';
import type { ConversationDraft } from './composer.js';
import { CommandRegistry } from './commands.js';
import { exportSessions } from '../session-client.js';

export function createComposerModel(ctx: Context, api: FrontendApi) {
  const control = ctx.miniConversation, selection = ctx.miniSelection;
  const changes = new EventTarget();
  const commands = new CommandRegistry(), completions = new Map<string, Completer>();
  const blank = (): ConversationDraft => ({ text: '', attachments: [], version: 0, loading: 0 });
  const drafts = new Map<string, { input: ConversationDraft; edit?: ConversationDraft; permission?: ConversationPermission }>();
  const key = () => control.get().conversation?.id ?? 'workspace:' + selection.selectedWorkspace;
  function entryFor(key: string) {
    let entry = drafts.get(key);
    if (!entry) { entry = { input: blank() }; drafts.set(key, entry); }
    return entry;
  }
  const entry = () => entryFor(key());
  const draft = () => entry().edit ?? entry().input;
  const change = (focus = false) => changes.dispatchEvent(new CustomEvent('change', { detail: { focus } }));
  let model: ModelChoice | undefined, thinking: ThinkingLevel | null | undefined;
  let cursor: { draft: ConversationDraft; start: number; end: number } | undefined;
  const submissions = new Map<string, { runId: string; clear: () => void }>();
  control.subscribe(() => {
    const { conversation, view, events, run } = control.get();
    if (!conversation) return;
    const submitted = submissions.get(conversation.id);
    if (!submitted) return;
    if (view?.messages.some(({ submissionId }) => submissionId === submitted.runId) ||
        events.some((event) => event.type === 'user' && event.submissionId === submitted.runId)) {
      submissions.delete(conversation.id); submitted.clear();
    } else if (run && run.id === submitted.runId && !control.get().sending) submissions.delete(conversation.id);
  }, api.signal);
  const resetChoice = () => { model = undefined; thinking = undefined; change(); };
  const register = (command: ComposerCommand) => {
    const dispose = commands.register(command); change();
    return () => { dispose(); change(); };
  };
  api.onDispose(register({ name: 'export', group: 'Conversation', description: 'Export the current conversation', run: () => {
    const id = control.get().conversation?.id;
    if (!id) throw new Error('Open a conversation to export it.');
    return exportSessions([id], api.signal);
  } }));
  api.onDispose(register({ name: 'compact', group: 'Conversation', description: 'Summarize earlier messages to free context', run: control.compact }));
  return {
    draft, commands, completions,
    subscribe(listener: (focus: boolean) => void, signal: AbortSignal) {
      changes.addEventListener('change', (event) => listener((event as CustomEvent<{ focus: boolean }>).detail.focus), { signal });
    },
    permission: () => control.get().conversation?.permission ?? (control.get().conversation ? 'standard' : entry().permission ?? 'standard'),
    async setPermission(value: ConversationPermission) {
      if (control.get().conversation) await control.setPermission(value);
      else { entry().permission = value; change(); }
    },
    choice() { return model; },
    thinking() { return thinking; },
    choose(value: ModelChoice | undefined) { model = value; thinking = undefined; change(); },
    chooseThinking(value: ThinkingLevel | null) { thinking = value; change(); },
    setText(text: string, start = text.length, end = start) {
      const current = draft();
      if (current.text !== text) { current.text = text; current.version++; }
      cursor = { draft: current, start, end };
    },
    insert(text: string) {
      const current = draft(), position = cursor?.draft === current ? cursor : { start: current.text.length, end: current.text.length };
      const before = current.text.slice(0, position.start);
      if (text.startsWith('/') && /\S$/.test(before)) text = ' ' + text;
      current.text = before + text + current.text.slice(position.end);
      current.version++;
      cursor = { draft: current, start: before.length + text.length, end: before.length + text.length };
      change(true);
    },
    cursor() { return cursor?.draft === draft() ? cursor.start : draft().text.length; },
    cancelEdit() { delete entry().edit; change(true); },
    beginDraftMode(mode: DraftMode) {
      if (control.get().sending || control.get().pending || !control.get().conversation) return () => {};
      const owner = entry();
      const edit: ConversationDraft = { ...blank(), text: mode.text, revision: mode,
        attachments: (mode.images ?? []).map((file, originalIndex) => ({ ...file, originalIndex })) };
      owner.edit = edit; change(true);
      return () => {
        if (owner.edit !== edit) return;
        delete owner.edit;
        if (owner === entry() && !api.signal.aborted) change();
      };
    },
    command: register,
    completion(trigger: string, complete: Completer) {
      if (trigger === '/' || !/^[!#$%&*?@^~]$/.test(trigger) || completions.has(trigger)) throw new Error('Invalid or duplicate completion trigger: ' + trigger);
      completions.set(trigger, complete); change();
      return () => { completions.delete(trigger); change(); };
    },
    async send(queued = false) {
      const origin = key(), owner = entry(), current = draft();
      if (current.loading) throw new Error('Files are still loading');
      if (queued && current.revision) throw new Error('Finish editing before queuing a message');
      const { revision, version, text } = current;
      const attachments: Attachment[] = structuredClone(current.attachments.filter(({ originalIndex }) => originalIndex === undefined).map(({ name, mimeType, data }) => ({ name, mimeType, data })));
      const removedImages = revision?.images?.flatMap((_, index) => current.attachments.some(({ originalIndex }) => index === originalIndex) ? [] : [index]) ?? [];
      if (!text.trim() && !attachments.length && (revision?.images?.length ?? 0) === removedImages.length) return;
      const input = { message: text, attachments, model, thinkingLevel: thinking };
      const clear = () => {
        if (current.version !== version) return;
        if (revision) { if (owner.edit === current) delete owner.edit; }
        else if (owner.input === current) owner.input = blank();
        if (owner === entry()) change();
      };
      if (queued) { await control.queue(input); clear(); }
      else {
        const { sessionId, run } = await control.submit({ ...input, permission: owner.permission, revision: revision && { ...revision.revision, removedImages } });
        if (origin !== sessionId) { drafts.set(sessionId, owner); drafts.delete(origin); }
        submissions.set(sessionId, { runId: run.id, clear });
      }
      resetChoice();
    }
  };
}
