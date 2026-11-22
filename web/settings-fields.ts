import { element } from './api.js';
export function schemaFields(plugin: string, schema: Record<string, any>, values: any, path: string[] = []) {
  const group = document.createElement('div');
  group.className = 'plugin-fields';
  for (const [key, property] of Object.entries<Record<string, any>>(schema.properties ?? {})) {
    const current = values?.[key] ?? property.default;
    const fieldPath = [...path, key];
    const label = document.createElement('label');
    const title = document.createElement('span');
    title.textContent = property.title ?? key;
    label.append(title);
    if (property.type === 'object' && property.properties) {
      const section = document.createElement('fieldset');
      section.className = 'plugin-config';
      const legend = document.createElement('legend');
      legend.textContent = title.textContent;
      section.append(legend, schemaFields(plugin, property, current ?? {}, fieldPath));
      group.append(section);
      continue;
    }
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (property.enum) {
      const select = document.createElement('select');
      if (!schema.required?.includes(key)) select.add(new Option('Default', ''));
      for (const option of property.enum) select.add(new Option(String(option), JSON.stringify(option)));
      if (current !== undefined) select.value = JSON.stringify(current);
      input = select;
      input.dataset.kind = 'enum';
    } else if (['string', 'number', 'integer', 'boolean'].includes(property.type)) {
      const field = document.createElement('input');
      field.type = property.type === 'boolean' ? 'checkbox' : property.type === 'string' ? (property.format === 'password' ? 'password' : 'text') : 'number';
      if (field.type === 'checkbox') field.checked = Boolean(current);
      else field.value = current === undefined ? '' : String(current);
      if (field.type === 'number') {
        field.step = property.type === 'integer' ? '1' : 'any';
        if (property.minimum !== undefined) field.min = String(property.minimum);
        if (property.maximum !== undefined) field.max = String(property.maximum);
      }
      if (property.minLength !== undefined) field.minLength = property.minLength;
      if (property.maxLength !== undefined) field.maxLength = property.maxLength;
      input = field;
      input.dataset.kind = property.type;
    } else {
      input = document.createElement('textarea');
      input.value = current === undefined ? '' : JSON.stringify(current, null, 2);
      input.dataset.kind = 'json';
    }
    input.dataset.plugin = plugin;
    input.dataset.path = JSON.stringify(fieldPath);
    input.setAttribute('aria-label', (property.title ?? key) + ' · ' + plugin);
    if (schema.required?.includes(key) && input.dataset.kind !== 'boolean') input.required = true;
    label.append(input);
    if (property.description) {
      const hint = document.createElement('small');
      hint.className = 'hint';
      hint.textContent = property.description;
      label.append(hint);
    }
    group.append(label);
  }
  return group;
}

export function readPluginValues(current: Record<string, Record<string, unknown>>, container: HTMLElement = element('pluginSettings')) {
  const config = structuredClone(current);
  for (const field of container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-plugin]')) {
    if (field.matches(':disabled')) continue;
    const path: string[] = JSON.parse(field.dataset.path);
    const kind = field.dataset.kind;
    let target = config[field.dataset.plugin] ??= {};
    for (const key of path.slice(0, -1)) target = (target[key] ??= {}) as Record<string, unknown>;
    if (kind !== 'boolean' && !field.value && !field.required) { delete target[path.at(-1)]; continue; }
    target[path.at(-1)] = kind === 'boolean' ? (field as HTMLInputElement).checked :
      kind === 'number' || kind === 'integer' ? Number(field.value) :
      kind === 'enum' || kind === 'json' ? JSON.parse(field.value) : field.value;
  }
  return config;
}

