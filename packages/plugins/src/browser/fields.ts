import { button, field } from '@mini-harness/ui-primitives/primitives';

export function schemaForm(
  plugin: string,
  schema: Record<string, any>,
  values: Record<string, unknown>,
  description: string | undefined,
  saveConfig: (config: Record<string, unknown>) => Promise<string>,
) {
  const { node, read } = schemaFields(plugin, schema, values);
  const form = document.createElement('form');
  form.className = 'schema-config ui-stack';
  if (description) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = description;
    form.append(note);
  }
  const status = document.createElement('p');
  status.className = 'hint catalog-status';
  status.setAttribute('role', 'status');
  const save = button('Save configuration', 'primary');
  save.type = 'submit';
  form.append(node, status, save);
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = '';
    try {
      status.textContent = await saveConfig(read());
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      save.disabled = false;
    }
  };
  return form;
}

function schemaFields(plugin: string, schema: Record<string, any>, values: Record<string, unknown>) {
  const node = document.createElement('div');
  node.className = 'ui-stack';
  const readers = new Map<string, () => unknown>();
  for (const [key, property] of Object.entries<Record<string, any>>(schema.properties ?? {})) {
    const current = Object.hasOwn(values, key) ? values[key] : property.default;
    const title = property.title ?? key;
    if (property.type === 'object' && property.properties) {
      const section = document.createElement('fieldset');
      section.className = 'plugin-config';
      const legend = document.createElement('legend');
      legend.textContent = title;
      const nested = schemaFields(plugin, property, (current as Record<string, unknown>) ?? {});
      section.append(legend, nested.node);
      node.append(section);
      readers.set(key, nested.read);
      continue;
    }
    const label = title + ' · ' + plugin;
    const control = nativeField(property, current, label, schema.required?.includes(key) ?? false);
    const caption = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = title;
    caption.append(name);
    if (property.description) {
      const hint = document.createElement('small');
      hint.textContent = property.description;
      caption.append(hint);
    }
    node.append(field(caption, control.node, property.type === 'boolean' ? 'compact' : undefined));
    readers.set(key, control.read);
  }
  return {
    node,
    read: () =>
      Object.fromEntries(
        [...readers].map(([key, read]) => [key, read()]).filter(([, value]) => value !== undefined),
      ),
  };
}

function nativeField(property: Record<string, any>, value: unknown, label: string, required: boolean) {
  let node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (property.enum) {
    const select = document.createElement('select');
    if (!required) select.add(new Option('Default', ''));
    for (const [index, option] of property.enum.entries()) {
      select.add(new Option(property['x-enumLabels']?.[index] ?? String(option), JSON.stringify(option)));
    }
    if (value !== undefined) select.value = JSON.stringify(value);
    node = select;
  } else if (['string', 'number', 'integer', 'boolean'].includes(property.type)) {
    const input = document.createElement('input');
    switch (property.type) {
      case 'boolean':
        input.type = 'checkbox';
        input.checked = Boolean(value);
        break;
      case 'string':
        input.type = property.format === 'password' ? 'password' : 'text';
        if (property.minLength !== undefined) input.minLength = property.minLength;
        if (property.maxLength !== undefined) input.maxLength = property.maxLength;
        break;
      default:
        input.type = 'number';
        input.step = property.type === 'integer' ? '1' : 'any';
        if (property.minimum !== undefined) input.min = String(property.minimum);
        if (property.maximum !== undefined) input.max = String(property.maximum);
    }
    if (value !== undefined && input.type !== 'checkbox') input.value = String(value);
    node = input;
  } else {
    node = document.createElement('textarea');
    node.value = value === undefined ? '' : JSON.stringify(value, null, 2);
  }
  node.setAttribute('aria-label', label);
  // A required JSON Schema string may still be empty.
  node.required =
    required &&
    (node instanceof HTMLSelectElement ||
      (property.type !== 'boolean' && (property.type !== 'string' || property.minLength > 0)));
  return {
    node,
    read() {
      if (node.matches(':disabled')) return;
      if (node instanceof HTMLInputElement && node.type === 'checkbox') return node.checked;
      if (!required && node.value === '') return;
      if (node instanceof HTMLInputElement) return node.type === 'number' ? Number(node.value) : node.value;
      return JSON.parse(node.value);
    },
  };
}
