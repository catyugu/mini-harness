import type { InputAttachment } from '@mini-harness/input/message';
import { icon } from '@mini-harness/ui-primitives/icons';

export const imageMime = /^image\/(?:png|jpeg|gif|webp)$/;

export function decodedSize(data: string) {
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

function sizeLabel(size: number) {
  if (size < 1024) return size + ' B';
  const unit = size < 1024 * 1024 ? 'KB' : 'MB';
  const value = size / (unit === 'KB' ? 1024 : 1024 * 1024);
  return Number(value.toFixed(value < 10 ? 1 : 0)) + ' ' + unit;
}

export function fileCard(file: InputAttachment, clickable = false) {
  const card = document.createElement(clickable ? 'button' : 'div');
  card.className = 'file-card';
  if (card instanceof HTMLButtonElement) card.type = 'button';
  const symbol = document.createElement('span');
  symbol.className = 'file-card-icon';
  const pdf = file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (pdf) {
    symbol.classList.add('pdf');
    symbol.textContent = 'PDF';
  } else symbol.append(icon('file'));
  symbol.setAttribute('aria-hidden', 'true');
  const meta = document.createElement('span');
  meta.className = 'file-card-meta';
  const name = document.createElement('strong');
  name.textContent = file.name;
  name.title = file.name;
  const detail = document.createElement('small');
  const extension = file.name.match(/\.([a-z0-9]{1,10})$/i)?.[1].toUpperCase();
  detail.textContent =
    (pdf ? 'PDF' : (extension ?? 'FILE')) + (file.size === undefined ? '' : ' · ' + sizeLabel(file.size));
  meta.append(name, detail);
  card.append(symbol, meta);
  return card;
}
