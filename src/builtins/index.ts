import { files } from './files.js';
import { skills } from './skills.js';
import { shell } from './shell.js';
import { subagents } from './subagents.js';
import { messageCopy } from './message-copy.js';
import { editResend } from './edit-resend.js';

export { Delegation } from './delegation.js';
export const builtins = [files, skills, subagents, shell, messageCopy, editResend];
