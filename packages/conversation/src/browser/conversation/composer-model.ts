import type { Context } from 'cordis';
import type { FrontendApi } from '@mini-harness/ui-runtime/frontend-api';
import type { Attachment } from '@mini-harness/input/message';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import { isRunning } from '@mini-harness/sessions/run-state';
import type { Completer, ComposerDraft, ComposerModel, DraftMode } from '../composer-api.js';
import { CommandRegistry } from './commands.js';
import { exportSessions } from '../session-client.js';

interface Draft {
  text: string;
  attachments: (Attachment & { originalIndex?: number })[];
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel | null;
  revision?: DraftMode;
  cursor?: { start: number; end: number };
  version: number;
  loading: number;
  failedRun?: string;
}

export function createComposerModel(ctx: Context, api: FrontendApi): ComposerModel {
  const control = ctx.miniConversation, selection = ctx.miniSelection;
  const changes = new EventTarget();
  const commands = new CommandRegistry(), completions = new Map<string, Completer>();
  const blank = (): Draft => ({ text: '', attachments: [], version: 0, loading: 0 });
  const drafts = new Map<string, { input: Draft; edit?: Draft; permission?: ConversationPermission }>();
  const key = () => control.get().session?.id ?? 'workspace:' + selection.selectedWorkspace;
  function entryFor(key: string) {
    let entry = drafts.get(key);
    if (!entry) { entry = { input: blank() }; drafts.set(key, entry); }
    return entry;
  }
  const entry = () => entryFor(key());
  const draft = () => entry().edit ?? entry().input;
  let snapshot: { owner: Draft; version: number; value: ComposerDraft } | undefined;
  const change = (focus = false) => changes.dispatchEvent(new CustomEvent('change', { detail: focus }));
  function edited(current: Draft, focus = false, inputChanged = true) {
    current.version++;
    if (inputChanged) delete current.failedRun;
    if (current === draft()) change(focus);
  }
  let selected = key();
  selection.subscribe(() => {
    const next = key();
    if (next !== selected) { selected = next; change(); }
  }, api.signal);
  const register: ComposerModel['command'] = (command) => {
    const dispose = commands.register(command); change();
    return () => { dispose(); change(); };
  };
  api.onDispose(register({ name: 'export', group: 'Conversation', description: 'Export the current conversation', run: () => {
    const id = control.get().session?.id;
    if (!id) throw new Error('Open a conversation to export it.');
    return exportSessions([id], api.signal);
  } }));
  api.onDispose(register({ name: 'compact', group: 'Conversation', description: 'Summarize earlier messages to free context', run: control.compact }));

  async function send(queued = false) {
    const origin = key(), owner = entry(), current = draft();
    if (current.loading) throw new Error('Files are still loading');
    if (queued && current.revision) throw new Error('Finish editing before queuing a message');
    const { revision, version, text } = current;
    const attachments = current.attachments.filter(({ originalIndex }) => originalIndex === undefined)
      .map(({ name, mimeType, data }) => ({ name, mimeType, data }));
    const originalImages = current.attachments.flatMap(({ originalIndex }) => originalIndex === undefined ? [] : [originalIndex]);
    const removedImages = revision?.images?.flatMap((_, index) => originalImages.includes(index) ? [] : [index]) ?? [];
    if (!text.trim() && !attachments.length && (revision?.images?.length ?? 0) === removedImages.length) return;
    const input = { message: text, attachments, model: current.model, thinkingLevel: current.thinkingLevel };
    if (queued) await control.queue(input);
    else {
      const run = await control.submit({ ...input, permission: owner.permission, revision: revision && { ...revision.revision, removedImages } }, (id) => {
        drafts.set(id, owner); drafts.delete(origin);
      });
      if (!run.accepted) {
        const sameInput = current.text === text && current.attachments.length === originalImages.length + attachments.length &&
          current.attachments.every(({ name, mimeType, data, originalIndex }) => originalIndex === undefined
            ? attachments.some((file) => file.name === name && file.mimeType === mimeType && file.data === data)
            : originalImages.includes(originalIndex));
        if (sameInput) current.failedRun = run.id;
        return;
      }
    }
    if (current.version !== version) return;
    if (revision) { if (owner.edit === current) delete owner.edit; }
    else if (owner.input === current) owner.input = blank();
    if (entry() === owner) change();
  }

  return {
    draft(): ComposerDraft {
      const current = draft();
      if (snapshot?.owner === current && snapshot.version === current.version) return snapshot.value;
      const value = Object.freeze({
        text: current.text, editTitle: current.revision?.title, loading: current.loading > 0,
        model: current.model && Object.freeze({ ...current.model }), thinkingLevel: current.thinkingLevel,
        attachments: Object.freeze(current.attachments.map(({ name, mimeType, data }) => Object.freeze({ name, mimeType, data })))
      });
      snapshot = { owner: current, version: current.version, value };
      return value;
    },
    subscribe(listener, signal) {
      changes.addEventListener('change', (event) => { if (event instanceof CustomEvent) listener(event.detail === true); }, { signal });
    },
    permission: () => control.get().session?.permission ?? entry().permission ?? 'standard',
    async setPermission(value) {
      if (control.get().session) await control.setPermission(value);
      else { entry().permission = value; change(); }
    },
    choose(model) {
      const current = draft();
      if (current.model?.provider === model?.provider && current.model?.id === model?.id) return;
      current.model = model && { ...model }; current.thinkingLevel = undefined; edited(current, false, false);
    },
    chooseThinking(level) {
      const current = draft();
      if (current.thinkingLevel !== level) { current.thinkingLevel = level; edited(current, false, false); }
    },
    setText(text, start = text.length, end = start) {
      const current = draft();
      current.cursor = { start, end };
      if (current.text !== text) { current.text = text; edited(current); }
    },
    insert(text) {
      const current = draft(), position = current.cursor ?? { start: current.text.length, end: current.text.length };
      const before = current.text.slice(0, position.start);
      if (text.startsWith('/') && /\S$/.test(before)) text = ' ' + text;
      current.text = before + text + current.text.slice(position.end);
      const cursor = before.length + text.length;
      current.cursor = { start: cursor, end: cursor };
      edited(current, true);
    },
    cursor() { const current = draft(); return current.cursor?.start ?? current.text.length; },
    async addFiles(incoming) {
      if (!incoming.length) return;
      const current = draft();
      if (current.attachments.length + current.loading + incoming.length > 8) throw new Error('Attach at most eight files');
      current.loading += incoming.length;
      edited(current);
      try {
        const added = await Promise.all(incoming.map(async (file) => {
          if (file.size > (file.type.startsWith('image/') ? 6 : 1) * 1024 * 1024)
            throw new Error('Images: up to 6 MiB; UTF-8 text: up to 1 MiB');
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('Could not read ' + file.name));
            reader.readAsDataURL(file);
          });
          api.signal.throwIfAborted();
          return { name: file.name, mimeType: file.type || 'text/plain', data };
        }));
        if ([...current.attachments, ...added].reduce((total, file) => total + file.data.length * .75, 0) > 12 * 1024 * 1024)
          throw new Error('Attachments exceed 12 MiB per message');
        current.attachments.push(...added);
      } finally {
        current.loading -= incoming.length;
        if (!api.signal.aborted) edited(current);
      }
    },
    removeAttachment(index) {
      const current = draft();
      if (Number.isInteger(index) && index >= 0 && index < current.attachments.length) { current.attachments.splice(index, 1); edited(current); }
    },
    cancelEdit() { delete entry().edit; change(true); },
    beginDraftMode(mode) {
      if (isRunning(control.get().run) || control.get().interaction.operation || !control.get().session) return () => {};
      const owner = entry();
      const edit: Draft = { ...blank(), text: mode.text, revision: structuredClone(mode),
        attachments: (mode.images ?? []).map((file, originalIndex) => ({ ...file, originalIndex })) };
      owner.edit = edit; change(true);
      return () => {
        if (owner.edit !== edit) return;
        delete owner.edit;
        if (owner === entry() && !api.signal.aborted) change();
      };
    },
    matchCommands: (query) => commands.match(query),
    completer: (trigger) => completions.get(trigger),
    command: register,
    completion(trigger, complete) {
      if (trigger === '/' || !/^[!#$%&*?@^~]$/.test(trigger) || completions.has(trigger)) throw new Error('Invalid or duplicate completion trigger: ' + trigger);
      completions.set(trigger, complete); change();
      return () => { completions.delete(trigger); change(); };
    },
    send,
    async retry() {
      const { session, run, interaction } = control.get();
      if (!session || run?.state !== 'failed' || interaction.operation) return;
      const current = draft();
      if (run.inputEntryId === null && current.failedRun === run.id) return send();
      const input = await api.request<{ message: string; attachments: Attachment[]; missing: string[]; model?: ModelChoice; thinkingLevel?: ThinkingLevel } | null>(
        '/sessions/' + session.id + '/runs/' + run.id + '/input');
      if (control.get().run?.id !== run.id || control.get().interaction.operation) return;
      if (!input) throw new Error('This run did not accept a message. Check the draft and send it again.');
      const { missing, ...submission } = input;
      if (missing.length) {
        if (current === draft() && !current.text && !current.attachments.length && !current.revision) {
          current.text = submission.message; current.attachments = submission.attachments;
          current.model ??= submission.model;
          if (current.thinkingLevel === undefined) current.thinkingLevel = submission.thinkingLevel; edited(current, true);
        }
        throw new Error('Reattach ' + missing.join(', ') + ' before sending this message again.');
      }
      await control.submit({ ...submission, model: current.model ?? submission.model, thinkingLevel: current.thinkingLevel === undefined ? submission.thinkingLevel : current.thinkingLevel });
    }
  };
}
