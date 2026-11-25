// A normalized reference is a standalone @ followed by a JSON string.
export function references(text: string) {
  const result: { start: number; end: number; path: string }[] = [];
  for (const match of text.matchAll(/(?<!\S)@("(?:\\[^\r\n]|[^"\\\r\n])*")/g)) {
    try {
      const path: string = JSON.parse(match[1]);
      if (path && !path.includes('\0')) result.push({ start: match.index, end: match.index + match[0].length, path });
    } catch {
      // Keep unfinished or malformed input as literal text.
    }
  }
  return result;
}

export function referenceButton(path: string, open: (path: string) => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-reference';
  button.textContent = path;
  button.title = path;
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => open(path));
  return button;
}

export function renderReferences(root: HTMLElement, text: string, open: (path: string) => void) {
  let offset = 0;
  for (const { start, end, path } of references(text)) {
    root.append(text.slice(offset, start), referenceButton(path, open));
    offset = end;
  }
  root.append(text.slice(offset));
}
