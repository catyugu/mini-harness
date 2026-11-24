import { referenceNodes } from './references.js';

function read(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement && node.dataset.reference !== undefined) return node.dataset.reference;
  if (node instanceof HTMLBRElement) return '\n';
  let text = '';
  for (const child of node.childNodes) {
    if (child instanceof HTMLDivElement && text && !text.endsWith('\n')) text += '\n';
    text += read(child);
  }
  return text;
}

/** Maps editable DOM positions to the original draft string, with references as atomic tokens. */
export class PromptEditor {
  private position = { start: 0, end: 0 };
  private composing = false;

  constructor(readonly element: HTMLElement, private readonly open: (path: string) => void, signal: AbortSignal) {
    element.addEventListener('compositionstart', () => { this.composing = true; }, { signal });
    element.addEventListener('compositionend', () => { this.composing = false; this.normalize(); }, { signal });
    element.addEventListener('input', () => { if (!this.composing) this.normalize(); }, { signal });
    element.addEventListener('beforeinput', (event) => {
      if (event.isComposing || !['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return;
      event.preventDefault();
      this.insert('\n');
    }, { signal });
    element.addEventListener('paste', (event) => {
      if (event.clipboardData?.files.length) return;
      event.preventDefault();
      this.insert(event.clipboardData?.getData('text/plain') ?? '');
    }, { signal });
    for (const type of ['copy', 'cut'] as const) element.addEventListener(type, (event) => {
      const { start, end } = this.selection();
      if (start === end || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', this.value.slice(start, end));
      if (type === 'cut') this.insert('');
    }, { signal });
  }

  get value() {
    return this.element.childNodes.length === 1 && this.element.firstChild instanceof HTMLBRElement ? '' : read(this.element);
  }

  set value(text: string) {
    this.element.replaceChildren(...referenceNodes(text, this.open, true));
    this.position = { start: text.length, end: text.length };
    if (document.activeElement === this.element) this.setSelectionRange(text.length, text.length);
  }

  private selection() {
    const selection = document.getSelection();
    if (!selection?.rangeCount || !this.element.contains(selection.anchorNode) || !this.element.contains(selection.focusNode)) return this.position;
    const range = selection.getRangeAt(0);
    const offset = (node: Node, index: number) => {
      const prefix = document.createRange();
      prefix.selectNodeContents(this.element);
      prefix.setEnd(node, index);
      return Math.min(read(prefix.cloneContents()).length, this.value.length);
    };
    this.position = { start: offset(range.startContainer, range.startOffset), end: offset(range.endContainer, range.endOffset) };
    return this.position;
  }

  get selectionStart() { return this.selection().start; }
  get selectionEnd() { return this.selection().end; }

  setSelectionRange(start: number, end: number) {
    this.position = { start, end };
    const boundary = (offset: number): [Node, number] => {
      for (const [index, child] of [...this.element.childNodes].entries()) {
        const length = read(child).length;
        if (offset <= length) {
          if (child.nodeType === Node.TEXT_NODE) return [child, offset];
          return [this.element, offset === 0 ? index : index + 1];
        }
        offset -= length;
      }
      return [this.element, this.element.childNodes.length];
    };
    const range = document.createRange();
    range.setStart(...boundary(start)); range.setEnd(...boundary(end));
    const selection = document.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
  }

  setRangeText(text: string, start: number, end: number) {
    const value = this.value;
    this.value = value.slice(0, start) + text + value.slice(end);
    const cursor = start + text.length;
    this.setSelectionRange(cursor, cursor);
  }

  private insert(text: string) {
    const { start, end } = this.selection();
    this.setRangeText(text, start, end);
    this.element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private normalize() {
    const text = this.value;
    const nodes = referenceNodes(text, this.open, true);
    const reference = (node: Node) => node instanceof HTMLElement && node.dataset.reference;
    const current = [...this.element.childNodes];
    const normalized = current.every((node) => node.nodeType === Node.TEXT_NODE || reference(node)) &&
      current.filter(reference).map(reference).join('\0') === nodes.filter(reference).map(reference).join('\0');
    if (normalized) return;
    const { start, end } = this.selection();
    this.element.replaceChildren(...nodes);
    this.setSelectionRange(start, end);
  }
}
