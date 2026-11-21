import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { readJson, writeJson } from './config.js';

export class SessionRegistry {
  constructor(paths) {
    this.paths = paths;
    const data = readJson(paths.registry, { sessions: [] });
    this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
  }

  list() { return this.sessions.map((session) => ({ ...session })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id) { return this.sessions.find((entry) => entry.id === id); }
  persist() { writeJson(this.paths.registry, { sessions: this.sessions }); }

  create({ parentId = null, title = 'New conversation', cwd = this.paths.cwd } = {}) {
    if (parentId && !this.get(parentId)) throw new Error('Parent conversation not found');
    const now = new Date().toISOString();
    const session = { id: randomUUID(), title: String(title).slice(0, 140), cwd, parentId, file: null, createdAt: now, updatedAt: now };
    this.sessions.push(session);
    this.persist();
    return { ...session };
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) throw new Error('Conversation not found');
    for (const key of ['title', 'file']) if (key in patch) item[key] = patch[key];
    item.updatedAt = new Date().toISOString();
    this.persist();
    return { ...item };
  }

  descendants(ids) {
    const selected = new Set(ids);
    let changed;
    do {
      changed = false;
      for (const entry of this.sessions) {
        if (entry.parentId && selected.has(entry.parentId) && !selected.has(entry.id)) {
          selected.add(entry.id);
          changed = true;
        }
      }
    } while (changed);
    return [...selected];
  }

  delete(ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !this.get(id))) throw new Error('Unknown conversation');
    const all = this.descendants(ids);
    const chosen = new Set(all);
    const files = this.sessions.filter((entry) => chosen.has(entry.id)).map((entry) => entry.file).filter(Boolean);
    const root = resolve(this.paths.sessions) + sep;
    for (const path of files) {
      const target = resolve(path);
      if (!target.startsWith(root)) throw new Error('Refusing to delete session outside managed storage');
    }
    for (const path of files) if (existsSync(path)) unlinkSync(path);
    this.sessions = this.sessions.filter((entry) => !chosen.has(entry.id));
    this.persist();
    return all;
  }
}
