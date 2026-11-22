const paths = {
  menu: 'M4 6h16M4 12h16M4 18h16', close: 'm6 6 12 12M6 18 18 6', plus: 'M12 5v14M5 12h14',
  send: 'm6 12 6-6 6 6M12 6v14', stop: 'M6 6h12v12H6z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  files: 'M3 7h7l2-3h9v16H3z', attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9',
  edit: 'm4 16 12-12 4 4L8 20H4z', trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
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
