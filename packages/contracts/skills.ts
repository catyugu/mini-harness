export interface Skill {
  name: string;
  description: string;
  file: string;
  content: string;
}
export interface SkillPort {
  discover(cwd: string): Promise<Skill[]>;
  prompt(cwd: string): Promise<string>;
  instruction(cwd: string, text: string): Promise<string | undefined>;
}
