import { constants, type Stats } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type Skill = { name: string; description: string; content: string; file: string; root: string };
export type SkillRoots = (cwd: string) => readonly string[];

export function defaultSkillRoots(appHome: string, userHome = homedir()): SkillRoots {
  return (cwd) => [join(userHome, '.agents', 'skills'), join(appHome, 'skills'),
    join(cwd, '.agents', 'skills'), join(cwd, '.mini-harness', 'skills')];
}

const maximumSize = 128 * 1024;
const maximumEntries = 8192;
const maximumDirectories = 1024;
const maximumSkills = 256;
const unavailable = (error: unknown) => ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
const sameFile = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino;

async function readSkill(file: string) {
  try {
    const actual = await realpath(file);
    const before = await stat(actual);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumSize) return;
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened) || opened.size > maximumSize) return;
      // Read at most one byte beyond the limit, even if the file grows after stat.
      const buffer = Buffer.alloc(maximumSize + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > maximumSize || await realpath(file) !== actual) return;
      const after = await stat(actual);
      if (!after.isFile() || after.nlink !== 1 || !sameFile(opened, after) || after.size !== bytes) return;
      const parsed = parseSkill(buffer.subarray(0, bytes).toString('utf8'), basename(dirname(file)));
      return parsed && { ...parsed, file: actual };
    } finally { await handle.close(); }
  } catch (error) { if (!unavailable(error)) throw error; }
}
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Roots are ordered from lowest to highest priority. Each scan shares a single budget. */
export class SkillLoader {
  constructor(private readonly roots: SkillRoots, private readonly diagnose: (path: string, error: unknown) => void) {}

  async discover(cwd: string): Promise<Skill[]> {
    const skills = new Map<string, Skill>();
    const files = new Set<string>();
    let entriesLeft = maximumEntries;
    let directoriesLeft = maximumDirectories;
    let skillsLeft = maximumSkills;
    for (const root of [...this.roots(cwd)].reverse()) {
      const visited = new Set<string>();
      const visit = async (path: string, depth: number) => {
        if (depth > 6 || directoriesLeft <= 0 || entriesLeft <= 0 || skillsLeft <= 0) return;
        directoriesLeft--;
        try {
          const directory = await realpath(path);
          if (visited.has(directory)) return;
          const before = await stat(directory);
          if (!before.isDirectory()) return;
          visited.add(directory);
          const entries = [];
          for await (const entry of await opendir(directory)) {
            entries.push(entry);
            if (--entriesLeft === 0) break;
          }
          if (await realpath(path) !== directory || !sameFile(before, await stat(directory))) return;
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            if (skillsLeft <= 0) break;
            if (entry.name.startsWith('.')) continue;
            const child = join(directory, entry.name);
            if (entry.name === 'SKILL.md' && (entry.isFile() || entry.isSymbolicLink())) {
              skillsLeft--;
              try {
                const skill = await readSkill(child);
                if (!skill || files.has(skill.file)) continue;
                files.add(skill.file);
                if (!skills.has(skill.name)) skills.set(skill.name, { ...skill, root });
              } catch (error) { this.diagnose(child, error); }
            } else if (entry.isDirectory() || entry.isSymbolicLink()) {
              await visit(child, depth + 1);
            }
          }
        } catch (error) { if (!unavailable(error)) this.diagnose(path, error); }
      };
      await visit(root, 0);
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }

  async list(cwd: string) {
    return (await this.discover(cwd)).map(({ name, description }) => ({ name, description }));
  }

  async load(cwd: string, name: string) {
    const skill = (await this.discover(cwd)).find((item) => item.name === name);
    if (!skill) throw new Error('Unknown skill: ' + name);
    return skill;
  }

  async prompt(cwd: string) {
    const skills = await this.list(cwd);
    if (!skills.length) return '';
    return 'Available skills describe task-specific instructions. When a skill matches the task, call load_skill with its name and follow its instructions.\n' +
      '<available_skills>\n' + skills.map((skill) => `  <skill name="${xml(skill.name)}">${xml(skill.description)}</skill>`).join('\n') + '\n</available_skills>';
  }
  async instruction(cwd: string, text: string) {
    const match = text.match(/^\/skill:([a-z0-9-]+)(?:\s+[\s\S]*)?$/);
    if (!match) return;
    const skill = await this.load(cwd, match[1]);
    return `<skill name="${xml(skill.name)}" source="${xml(skill.file)}">\n${skill.content}\n</skill>`;
  }
}

/** Deliberately narrow frontmatter: no executable tags, aliases or object coercion. */
export function parseSkill(source: string, fallback: string): Pick<Skill, 'name' | 'description' | 'content'> | undefined {
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
