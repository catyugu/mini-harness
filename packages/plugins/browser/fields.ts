import type { ModelCatalog } from '@mini-harness/contracts/models';

export function schemaFields(plugin: string, schema: Record<string, any>, values: any, models: ModelCatalog, path: string[] = []) {
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
      section.append(legend, schemaFields(plugin, property, current ?? {}, models, fieldPath));
      group.append(section);
      continue;
    }
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (property['x-modelChoice']) {
      const select = document.createElement('select');
      select.add(new Option('Inherit parent model', 'null'));
      let selected = 'null';
      for (const model of models.models.filter(({ configured }) => configured)) {
        const choice = JSON.stringify({ provider: model.provider, id: model.id });
        const provider = models.providers.find(({ id }) => id === model.provider)?.name ?? model.provider;
        select.add(new Option(model.name + ' · ' + provider, choice));
        if (current?.provider === model.provider && current?.id === model.id) selected = choice;
      }
      if (current && selected === 'null') {
        selected = JSON.stringify(current);
        const label = typeof current === 'object' ? current.provider + '/' + current.id : String(current);
        const unavailable = new Option(label + ' (unavailable)', selected);
        unavailable.disabled = true;
        select.add(unavailable);
      }
      select.value = selected;
      input = select;
      input.dataset.kind = 'enum';
    } else if (property.enum) {
      const select = document.createElement('select');
      if (!schema.required?.includes(key)) select.add(new Option('Default', ''));
      for (const [index, option] of property.enum.entries()) {
        const label = Array.isArray(property['x-enumLabels']) ? property['x-enumLabels'][index] : undefined;
        select.add(new Option(typeof label === 'string' ? label : String(option), JSON.stringify(option)));
      }
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
    // JSON Schema 'required' means the property exists; an empty string remains
    // valid unless minLength explicitly forbids it. HTML 'required' is stricter.
    const schemaRequired = schema.required?.includes(key) ?? false;
    if (schemaRequired) input.dataset.schemaRequired = 'true';
    if (schemaRequired && input.dataset.kind !== 'boolean' &&
        (input.dataset.kind !== 'string' || (property.minLength ?? 0) > 0)) input.required = true;
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

export function readPluginValues(current: Record<string, Record<string, unknown>>, container: HTMLElement) {
  const config = structuredClone(current);
  for (const field of container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-plugin]')) {
    if (field.matches(':disabled')) continue;
    const plugin = field.dataset.plugin;
    const encoded = field.dataset.path;
    if (!plugin || !encoded) throw new Error('Invalid plugin configuration field');
    const path: unknown = JSON.parse(encoded);
    if (!Array.isArray(path) || !path.length || path.some((part) => typeof part !== 'string'))
      throw new Error('Invalid configuration field path');
    const key = path[path.length - 1];
    const kind = field.dataset.kind;
    let target = config[plugin] ??= {};
    for (const key of path.slice(0, -1)) target = (target[key] ??= {}) as Record<string, unknown>;
    if (kind !== 'boolean' && !field.value && field.dataset.schemaRequired !== 'true') { delete target[key]; continue; }
    target[key] = kind === 'boolean' ? (field as HTMLInputElement).checked :
      kind === 'number' || kind === 'integer' ? Number(field.value) :
      kind === 'enum' || kind === 'json' ? JSON.parse(field.value) : field.value;
  }
  return config;
}

