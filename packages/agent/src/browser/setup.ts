import type { Context } from 'mini-harness/cordis';
import type { SessionDisplayRecord } from '@mini-harness/plugin-api/timeline';

function setup(ctx: Context) {
  ctx.effect(() =>
    ctx.miniMessages.registerRecord('core:agent', 'reasoning', (record, { subscribe }) => {
      const body = document.createElement('p');
      const row = ctx.miniPrimitives.recordRow(record.title, body);
      row.classList.add('assistant-reasoning');
      const render = (entry: SessionDisplayRecord) => {
        body.textContent = Array.isArray(entry.content)
          ? entry.content
              .flatMap((part) => (part.type === 'thinking' && !part.redacted ? [part.thinking] : []))
              .join('\n')
          : (entry.streams?.text ?? '');
      };
      render(record);
      subscribe(render);
      return row;
    }),
  );
}

export default { inject: ['miniMessages', 'miniPrimitives'], apply: setup };
