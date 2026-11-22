import { Context } from './vendor/cordis.js';
import { data } from './api.js';
import { mountBrowser } from './browser-plugins.js';
import type { Bootstrap } from './types.js';

void data<Bootstrap>('/bootstrap').then((snapshot) => mountBrowser(new Context(), snapshot)).catch((error: Error) => {
  const status = document.getElementById('startupStatus');
  status.hidden = false;
  status.textContent = error.message;
});
