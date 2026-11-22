import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { BuiltinPlugin } from '../plugins.js';
import type { TodoItem } from '../protocol.js';

const parameters = Type.Object({ items: Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }), text: Type.String({ minLength: 1, maxLength: 240 }),
  state: Type.String({ enum: ['pending', 'in-progress', 'completed'] })
}), { maxItems: 40 }) });

export const todos: BuiltinPlugin = {
  id: 'todos', title: 'Todo list', description: 'Keep a lightweight task list above the conversation input.',
  icon: 'files', browser: '/builtins/todos.js', inject: ['harnessTools', 'harnessTodos', 'harnessRoutes'],
  setup(ctx) {
    const bind = (sessionId: string) => defineTool({ name: 'update_todos', label: 'Update tasks',
      description: 'Replace this conversation’s task list. Use stable task IDs and mark progress explicitly.', parameters,
      async execute(_id, { items }) {
        await ctx.harnessTodos.set(sessionId, items as TodoItem[]);
        return { content: [{ type: 'text', text: 'Task list updated' }], details: { items } };
      }
    });
    ctx.effect(() => ctx.harnessTools.register(bind(''), bind, undefined, true, ['read']));
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/todos', ({ url }) => ctx.harnessTodos.get(url.searchParams.get('sessionId'))));
  }
};
