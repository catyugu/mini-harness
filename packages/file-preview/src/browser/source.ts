const tokens =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/\/.*$|#.*$)|(\b(?:const|let|var|function|return|export|import|async|await|class|interface|def|fn|if|else|for|while|true|false|null|None|void|public|private)\b)|(\b\d+(?:\.\d+)?\b)/g;
export function source(content: string, highlight: boolean) {
  const node = document.createElement('pre');
  node.className = 'file-preview';
  const lines = content.split('\n');
  for (const [index, text] of lines.slice(0, 5000).entries()) {
    const line = document.createElement('span');
    line.className = 'source-line';
    line.dataset.line = String(index + 1);
    let offset = 0;
    if (highlight && text.length <= 2048) {
      for (const match of text.matchAll(tokens)) {
        const token = document.createElement('span');
        token.className = match[1]
          ? 'syntax-string'
          : match[2]
            ? 'syntax-comment'
            : match[3]
              ? 'syntax-keyword'
              : 'syntax-number';
        token.textContent = match[0];
        line.append(text.slice(offset, match.index), token);
        offset = match.index + match[0].length;
      }
    }
    line.append(text.slice(offset));
    if (index < lines.length - 1) line.append('\n');
    node.append(line);
  }
  const truncated = '… Preview shows the first 5,000 lines.';
  if (lines.length > 5000) node.append(truncated);
  if (!highlight) return node;
  node.setAttribute('aria-hidden', 'true');
  const plain = document.createElement('pre');
  plain.className = 'file-accessible-source';
  plain.textContent = lines.length > 5000 ? lines.slice(0, 5000).join('\n') + '\n' + truncated : content;
  const wrapper = document.createElement('div');
  wrapper.append(node, plain);
  return wrapper;
}
