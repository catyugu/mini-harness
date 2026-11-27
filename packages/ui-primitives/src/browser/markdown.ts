import { marked } from './vendor/marked.ts';
import purify from './vendor/purify.ts';

export const markdownSource = new WeakMap<HTMLElement, string>();

interface Block {
  key: string;
  node: ChildNode;
}

const rendered = new WeakMap<HTMLElement, { interactive: boolean; blocks: Block[] }>();

export function renderMarkdown(target: HTMLElement, text: string, interactive = true) {
  target.classList.add('markdown');
  const prior = rendered.get(target);
  const previous =
    prior?.interactive === interactive &&
    prior.blocks.length === target.childNodes.length &&
    prior.blocks.every(({ node }, index) => node === target.childNodes[index])
      ? prior.blocks
      : [];
  if (prior && previous === prior.blocks && markdownSource.get(target) === text) return;
  const fragment = purify.sanitize(marked.parse(text, { async: false, gfm: true }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'a',
      'blockquote',
      'br',
      'code',
      'del',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'li',
      'ol',
      'p',
      'pre',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class', 'start'],
    ALLOW_DATA_ATTR: false,
  });
  for (const element of fragment.querySelectorAll('[class]')) {
    const language = element.matches('pre > code')
      ? [...element.classList].find((name) => /^language-[\w+-]{1,40}$/.test(name))
      : undefined;
    if (language) element.setAttribute('class', language);
    else element.removeAttribute('class');
  }
  for (const link of fragment.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  const candidates = [...fragment.childNodes].map((node) => ({
    key: node instanceof Element ? node.outerHTML : node.nodeType + ':' + node.nodeValue,
    node,
  }));

  // Match unchanged prefix and suffix first, then reuse unchanged interior blocks in order.
  let start = 0;
  while (
    start < previous.length &&
    start < candidates.length &&
    previous[start].key === candidates[start].key
  ) {
    candidates[start] = previous[start];
    start++;
  }
  let oldEnd = previous.length,
    newEnd = candidates.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1].key === candidates[newEnd - 1].key) {
    candidates[--newEnd] = previous[--oldEnd];
  }
  const available = new Map<string, Block[]>();
  for (const block of previous.slice(start, oldEnd)) {
    const group = available.get(block.key);
    if (group) group.push(block);
    else available.set(block.key, [block]);
  }
  for (let index = start; index < newEnd; index++) {
    const candidate = candidates[index];
    const existing = available.get(candidate.key)?.shift();
    candidates[index] = existing ?? { key: candidate.key, node: decorate(candidate.node, interactive) };
  }
  const kept = new Set(candidates.map(({ node }) => node));
  for (const child of [...target.childNodes]) if (!kept.has(child)) child.remove();
  for (const [index, { node }] of candidates.entries())
    if (target.childNodes[index] !== node) target.insertBefore(node, target.childNodes[index] ?? null);
  rendered.set(target, { interactive, blocks: candidates });
  markdownSource.set(target, text);
}

function decorate(node: ChildNode, interactive: boolean) {
  const fragment = document.createDocumentFragment();
  fragment.append(node);
  for (const table of fragment.querySelectorAll('table')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-table';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Markdown table');
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  if (interactive) {
    for (const code of fragment.querySelectorAll('pre > code')) {
      const pre = code.parentElement;
      if (!pre) continue;
      const box = document.createElement('div');
      box.className = 'code-block';
      const header = document.createElement('div');
      header.className = 'code-header';
      const language = [...code.classList].find((name) => name.startsWith('language-'));
      const label = document.createElement('span');
      label.textContent = language?.slice(9) || 'Code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(code.textContent ?? '');
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Copy unavailable';
        }
      };
      header.append(label, copy);
      pre.replaceWith(box);
      box.append(header, pre);
    }
  }
  return fragment.firstChild!;
}
