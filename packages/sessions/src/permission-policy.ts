import type { Plugin } from 'mini-harness/cordis';
import type { ToolDefinition } from '@mini-harness/tools/api';

export type ToolPolicy = (sessionId: string, tool: Pick<ToolDefinition, 'name' | 'tags'>) => boolean;

declare module 'mini-harness/cordis' {
  interface Context {
    harnessToolPolicy: ToolPolicy;
  }
}
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Conversation tool policy',
  description: 'Select tools according to the conversation mode',
};

const plugin: Plugin.Object = {
  inject: ['harnessSessions'],
  provide: ['harnessToolPolicy'],
  apply(ctx) {
    const sessions = ctx.harnessSessions;
    const authorize: ToolPolicy = (id, tool) => {
      for (
        let record = sessions.get(id);
        record;
        record = record.parentId ? sessions.get(record.parentId) : undefined
      )
        if (record.permission === 'readOnly') return tool.tags?.includes('readOnly') === true;
      return true;
    };
    ctx.provide('harnessToolPolicy', authorize);
  },
};

export default plugin;
