import type { ComposerCommand } from '../composer-api.js';

export class CommandRegistry {
  private commands = new Map<string, ComposerCommand>();

  register(command: ComposerCommand) {
    const { name } = command;
    if (!/^[a-z0-9][\w:-]*$/i.test(name) || this.commands.has(name))
      throw new Error('Invalid or duplicate slash command: ' + name);
    this.commands.set(name, command);
    return () => {
      this.commands.delete(name);
    };
  }

  match(query: string) {
    const prefix = query.toLowerCase();
    return [...this.commands.values()].filter(({ name, aliases = [] }) =>
      [name, ...aliases].some((key) => key.toLowerCase().startsWith(prefix)),
    );
  }
}
