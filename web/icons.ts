const paths = {
  menu: 'M4 6h16M4 12h16M4 18h16', close: 'm6 6 12 12M6 18 18 6', plus: 'M12 5v14M5 12h14',
  send: 'm6 12 6-6 6 6M12 6v14', stop: 'M6 6h12v12H6z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  plugin: 'M5 8H8V5a2 2 0 1 1 4 0v3h5v4h2a2 2 0 0 1 0 4h-2v4h-5v-2a2 2 0 0 0-4 0v2H5z',
  model: 'M6 6h12v12H6zM9 9h6v6H9zM9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3',
  theme: 'M12 3a9 9 0 1 0 9 9A7 7 0 0 1 12 3z',
  delegate: 'M12 3v6M5 14v-2h14v2M5 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm14 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM10 2h4v5h-4z',
  terminal: 'M3 5h18v14H3zM7 9l3 3-3 3m6 0h4',
  search: 'M16 10a6 6 0 1 0-12 0 6 6 0 0 0 12 0m-2 5 5 5',
  files: 'M3 7h7l2-3h9v16H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v5h4',
  'file-code': 'M6 3h8l4 4v14H6zM14 3v5h4m-7 4-2 2 2 2m2-4 2 2-2 2',
  'file-image': 'M6 3h8l4 4v14H6zM14 3v5h4M8 17l3-4 4 4m-5-7h.01',
  'file-text': 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6',
  folder: 'M3 6h7l2 2h9v12H3z',
  'folder-open': 'M4 19V5h6l2 2h8v4M4 19l3-8h15l-3 8z', attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9',
  edit: 'm4 16 12-12 4 4L8 20H4z', trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  refresh: 'M20 7v5h-5M19 12a7 7 0 1 0-2 5',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4', chevron: 'm9 5 7 7-7 7', skills: 'm12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z'
};
export function icon(name: keyof typeof paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]); svg.append(path);
  return svg;
}
export function hydrateIcons() {
  for (const node of document.querySelectorAll<HTMLElement>('[data-icon]')) node.replaceChildren(icon(node.dataset.icon as keyof typeof paths));
}

export function fileLabel(node: HTMLElement, name: string, kind: 'file' | 'folder' | 'folder-open') {
  const label = document.createElement('span');
  label.textContent = name;
  node.append(icon(kind), label);
}
