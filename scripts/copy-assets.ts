import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// TypeScript owns the browser app; only static documents and styles are copied.
mkdirSync('dist/web', { recursive: true });
for (const asset of ['index.html', 'style.css', 'logo.svg']) {
  copyFileSync(join('web', asset), join('dist/web', asset));
}
