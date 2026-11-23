import { Context } from '../web/vendor/cordis.js';
import { data } from '../web/api.js';
import { mountBrowser } from './application.js';
import type { Bootstrap } from '../web/types.js';

void data<Bootstrap>('/bootstrap').then((snapshot) => mountBrowser(new Context(), snapshot)).catch((error: Error) => {
  const status = document.getElementById('startupStatus');
  status.hidden = false;
  status.textContent = error.message;
});
