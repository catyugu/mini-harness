import {
  Decoration,
  defaultKeymap,
  EditorState,
  EditorView,
  history,
  historyKeymap,
  keymap,
  placeholder,
  ViewPlugin,
  WidgetType,
} from './editor-vendor.ts';
import { referenceButton, references } from './file-references.ts';

export function promptEditor(parent: HTMLElement, open: (path: string) => void, signal: AbortSignal) {
  class FileReference extends WidgetType {
    constructor(readonly path: string) {
      super();
    }
    eq(other: FileReference) {
      return this.path === other.path;
    }
    toDOM() {
      return referenceButton(this.path, open);
    }
  }

  function decorations(state: EditorState) {
    return Decoration.set(
      references(state.doc.toString()).map(({ start, end, path }) =>
        Decoration.replace({ widget: new FileReference(path) }).range(start, end),
      ),
    );
  }

  const widgets = ViewPlugin.define(
    (view) => ({
      ranges: decorations(view.state),
      update(update) {
        if (update.docChanged) this.ranges = decorations(update.state);
      },
    }),
    {
      decorations: (value) => value.ranges,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.ranges ?? Decoration.none),
    },
  );

  let syncing = false;
  const extensions = [
    history(),
    keymap.of([...historyKeymap, ...defaultKeymap]),
    EditorView.lineWrapping,
    widgets,
    placeholder('Ask anything…'),
    EditorView.cspNonce.of(
      document.querySelector('meta[name="editor-style"]')?.getAttribute('content') ?? '',
    ),
    EditorView.contentAttributes.of({
      id: 'prompt',
      'aria-label': 'Message',
      'aria-controls': 'suggestions',
      'aria-autocomplete': 'list',
      'aria-multiline': 'true',
      spellcheck: 'true',
    }),
    EditorView.updateListener.of((update) => {
      if (!syncing && (update.docChanged || update.selectionSet)) {
        update.view.contentDOM.dispatchEvent(new Event('draft-change'));
      }
    }),
  ];
  const state = (doc: string, cursor: number) =>
    EditorState.create({
      doc,
      extensions,
      selection: { anchor: Math.min(cursor, doc.length) },
    });
  const editor = new EditorView({ parent, state: state('', 0) });
  signal.addEventListener('abort', () => editor.destroy(), { once: true });

  return {
    element: editor.contentDOM,
    get value() {
      return editor.state.doc.toString();
    },
    get start() {
      return editor.state.selection.main.from;
    },
    get end() {
      return editor.state.selection.main.to;
    },
    get composing() {
      return editor.composing;
    },
    focus() {
      editor.focus();
    },
    sync(value: string, cursor: number) {
      editor.setState(state(value, cursor));
    },
    select(cursor: number) {
      syncing = true;
      try {
        editor.dispatch({ selection: { anchor: Math.min(cursor, editor.state.doc.length) } });
      } finally {
        syncing = false;
      }
    },
    replace(from: number, to: number, insert: string) {
      editor.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent: 'input.complete',
      });
    },
  };
}

export type PromptEditor = ReturnType<typeof promptEditor>;
