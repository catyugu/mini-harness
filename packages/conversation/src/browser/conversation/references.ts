import { icon } from '@mini-harness/ui-primitives/icons';

/** Keep the quoted wire representation; only the displayed label omits its syntax. */
export function referenceNodes(text: string, open: (path: string) => void, editable = false): Node[] {
  const nodes: Node[] = [];
  const pattern = /(?:^|\s)@("(?:\\.|[^"\\])*")/gu;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = '@' + match[1];
    const start = match.index! + match[0].length - raw.length;
    let path: string;
    try { path = JSON.parse(match[1]); }
    catch { continue; }
    if (!path || /[\x00-\x1f]/.test(path)) continue;
    nodes.push(document.createTextNode(text.slice(offset, start)));
    const link = document.createElement('span');
    link.className = 'file-reference';
    link.dataset.reference = raw;
    link.title = path;
    link.setAttribute('role', 'link');
    link.tabIndex = 0;
    if (editable) link.contentEditable = 'false';
    link.append(icon(path.endsWith('/') ? 'folder' : 'file-text'), document.createTextNode(path));
    link.onmousedown = (event) => { if (editable) event.preventDefault(); };
    link.onclick = (event) => { event.preventDefault(); event.stopPropagation(); open(path); };
    link.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); open(path);
      }
    };
    nodes.push(link);
    offset = start + raw.length;
  }
  if (offset < text.length) nodes.push(document.createTextNode(text.slice(offset)));
  return nodes;
}
