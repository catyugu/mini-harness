import { marked } from './vendor/marked.js';
import purify from './vendor/purify.js';

export function renderMarkdown(target: HTMLElement, text: string, interactive = true) {
  const fragment = purify.sanitize(marked.parse(text, { async: false, gfm: true }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
      'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'start'],
    ALLOW_DATA_ATTR: false
  });
  for (const link of fragment.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  if (interactive) {
    for (const code of fragment.querySelectorAll('pre > code')) {
      const pre = code.parentElement;
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
        } catch { copy.textContent = 'Copy unavailable'; }
      };
      header.append(label, copy);
      pre.replaceWith(box);
      box.append(header, pre);
    }
  }
  target.replaceChildren(fragment);
}
