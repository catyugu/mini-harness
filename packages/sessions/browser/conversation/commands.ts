import type { ComposerCommand } from '../../../web/contracts/commands.js';

export class CommandRegistry {
  private commands = new Map<string, ComposerCommand>();

  register(command: ComposerCommand) {
    const { name } = command;
    if (!/^[a-z0-9][\w:-]*$/i.test(name) || this.commands.has(name))
      throw new Error('Invalid or duplicate slash command: ' + name);
    this.commands.set(name, command);
    return () => { this.commands.delete(name); };
  }

  match(query: string) {
    const prefix = query.toLowerCase();
    return [...this.commands.values()].filter(({ name }) => {
      const key = name.toLowerCase();
      return key.startsWith(prefix) || (key.startsWith('skill:') && key.slice(6).startsWith(prefix));
    });
  }

  prepare(text: string) {
    // Pi expands one skill command at the beginning of its prompt.
    for (const match of text.matchAll(/(?:^|\s)\/(skill:[\w-]+)(?=\s|$)/g)) {
      if (!this.commands.has(match[1])) continue;
      const start = match.index + match[0].indexOf('/');
      const before = text.slice(0, start).trimEnd();
      const after = text.slice(start + 1 + match[1].length).trimStart();
      return '/' + match[1] + ' ' + [before, after].filter(Boolean).join(' ');
    }
    return text;
  }
}
