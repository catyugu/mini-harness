import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Skill, SkillPort } from '@mini-harness/contracts/skills';

const maximumSize = 128 * 1024;
const maximumEntries = 8192;
const maximumDirectories = 1024;
const maximumSkills = 256;
const unavailable = (error: unknown) => ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
};

async function configuredRoot(path: string) {
  try {
    const [root, parent] = await Promise.all([lstat(path), lstat(dirname(path))]);
    if (!root.isDirectory() || root.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) return;
    const [actual, parentPath] = await Promise.all([realpath(path), realpath(dirname(path))]);
    if (relative(join(parentPath, basename(path)), actual)) return;
    const [checked, checkedParent] = await Promise.all([lstat(path), lstat(dirname(path))]);
    if (checked.isSymbolicLink() || checked.dev !== root.dev || checked.ino !== root.ino ||
        checkedParent.isSymbolicLink() || checkedParent.dev !== parent.dev || checkedParent.ino !== parent.ino) return;
    return actual;
  } catch (error) { if (!unavailable(error)) throw error; }
}

async function readSkill(root: string, file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumSize) return;
    const actual = await realpath(file);
    if (!inside(root, actual) || relative(file, actual)) return;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maximumSize) return;
      // Read at most one byte beyond the limit, even if the file grows after stat.
      const buffer = Buffer.alloc(maximumSize + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > maximumSize) return;
      const parsed = parseSkill(buffer.subarray(0, bytes).toString('utf8'), basename(dirname(actual)));
      return parsed && { ...parsed, file: actual };
    } finally { await handle.close(); }
  } catch (error) { if (!unavailable(error)) throw error; }
}
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Read only known skill roots, in a stable order; workspace names override home names. */
export class SkillLoader implements SkillPort {
  constructor(private readonly home: string) {}
  private paths(cwd: string) { return [this.home, join(cwd, '.mini-harness', 'skills')]; }
  async discover(cwd: string): Promise<Skill[]> {
    const skills = new Map<string, Skill>();
    for (const path of this.paths(cwd)) {
      const root = await configuredRoot(path);
      if (!root) continue;
      const files: string[] = [];
      let visited = 0, remaining = maximumEntries;
      const visit = async (directory: string, depth: number) => {
        if (depth > 6 || visited >= maximumDirectories || remaining <= 0 || files.length >= maximumSkills) return;
        visited++;
        try {
          const stat = await lstat(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) return;
          const actual = await realpath(directory);
          if (!inside(root, actual) || relative(directory, actual)) return;
          const entries = [];
          for await (const entry of await opendir(directory)) {
            entries.push(entry);
            if (--remaining <= 0) break;
          }
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
            const file = join(directory, entry.name);
            if (entry.isFile() && entry.name === 'SKILL.md') files.push(file);
            else if (entry.isDirectory()) await visit(file, depth + 1);
            if (files.length >= maximumSkills) break;
          }
        } catch (error) { if (!unavailable(error)) throw error; }
      };
      await visit(root, 0);
      for (const file of files) {
        const skill = await readSkill(root, file);
        if (skill) skills.set(skill.name, skill);
      }
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async prompt(cwd: string) {
    const skills = await this.discover(cwd);
    if (!skills.length) return '';
    return 'Available skills describe task-specific instructions. When a skill matches the task, call load_skill with its name and follow its instructions.\n' +
      '<available_skills>\n' + skills.map((skill) => `  <skill name="${xml(skill.name)}">${xml(skill.description)}</skill>`).join('\n') + '\n</available_skills>';
  }
  async expand(cwd: string, text: string) {
    const match = text.match(/^\/skill:([a-z0-9-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return text;
    const skill = (await this.discover(cwd)).find(({ name }) => name === match[1]);
    if (!skill) throw new Error('Unknown skill: ' + match[1]);
    return `<skill name="${xml(skill.name)}" source="${xml(skill.file)}">\n${skill.content}\n</skill>` +
      (match[2] ? '\n\n' + match[2] : '');
  }
}

/** Deliberately narrow frontmatter: no executable tags, aliases or object coercion. */
export function parseSkill(source: string, fallback: string): Omit<Skill, 'file'> | undefined {
  const match = source.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return;
  const fields: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = lines[i].match(/^(name|description):\s*(.*?)\s*$/);
    if (!field) continue;
    let value = field[2];
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      value = parts.join(value.startsWith('>') ? ' ' : '\n').trim();
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { return; }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    else value = value.replace(/\s+#.*$/, '').trim();
    fields[field[1]] = value;
  }
  const name = fields.name || fallback;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || !fields.description || fields.description.length > 2048) return;
  return { name, description: fields.description, content: match[2].trim() };
}
