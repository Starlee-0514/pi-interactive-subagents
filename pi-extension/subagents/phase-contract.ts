import { isAbsolute, resolve, relative, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

export const PHASE_TOOLS = 'read,grep,find,ls,write,edit,bash,caller_ping';
export interface PhaseSpec {
 id: string; objective: string; cwd: string; allowedPaths: string[];
 acceptance: string[]; verifyCommands: string[]; nonGoals: string[];
}
export interface PhaseContract {
 kind: 'phase-contract'; version: 1; goalId: string; phaseId: string; attemptId: string;
 parentSessionId: string; objective: string; cwd: string; allowedPaths: string[];
 acceptance: string[]; verifyCommands: string[]; nonGoals: string[];
 authorizationReference: string; provider: string; modelId: string; thinking: string; deadlineMs: number;
}
const levels = new Set(['off','minimal','low','medium','high','xhigh','max']);
const string = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !v.includes('\0');
export function validatePhaseSpec(value: unknown): asserts value is PhaseSpec {
 const c = value as PhaseSpec;
 if (!c || !string(c.objective) || !string(c.cwd) || !isAbsolute(c.cwd)) throw new Error('Invalid phase contract objective/cwd');
 for (const key of ['allowedPaths','acceptance','verifyCommands'] as const) {
  if (!Array.isArray(c[key]) || !c[key].length || !c[key].every(string)) throw new Error(`Invalid phase contract ${key}`);
 }
 if (!Array.isArray(c.nonGoals) || !c.nonGoals.every(string)) throw new Error('Invalid phase contract nonGoals');
 for (const path of c.allowedPaths) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || path === '.' || path === './' || path.includes('*')) throw new Error('Invalid phase allowed path');
 }
}
export function parsePhaseContract(task: string): PhaseContract {
 let c: any;
 try { c = JSON.parse(task); } catch { throw new Error('Phase task must be a JSON contract'); }
 validatePhaseSpec(c);
 if (c.kind !== 'phase-contract' || c.version !== 1) throw new Error('Invalid phase contract kind/version');
 for (const key of ['goalId','phaseId','attemptId','parentSessionId','authorizationReference','provider','modelId']) if (!string(c[key])) throw new Error(`Invalid phase contract ${key}`);
 if (!levels.has(c.thinking)) throw new Error('Invalid phase thinking');
 if (!Number.isSafeInteger(c.deadlineMs) || c.deadlineMs <= Date.now()) throw new Error('Phase deadline expired/invalid');
 return c;
}
export function managedPhaseProfile(c: PhaseContract) {
 return { model: `${c.provider}/${c.modelId}`, thinking: c.thinking, tools: PHASE_TOOLS,
  autoExit: true, spawning: false, interactive: false, sessionMode: 'lineage-only' as const,
  systemPromptMode: 'append' as const };
}
export function validatePhaseOverrides(params: Record<string, unknown>, c: PhaseContract) {
 for (const key of ['fork','model','tools','skills','systemPrompt','resumeSessionId','interactive']) {
  if (params[key] !== undefined) throw new Error(`Managed phase override forbidden: ${key}`);
 }
 if (params.cwd !== undefined && resolve(String(params.cwd)) !== resolve(c.cwd)) throw new Error('Managed phase cwd override forbidden');
}
export function managedPhaseCliArgs(c: PhaseContract, lifecycle: string, bootstrap: string, contractPath: string): string[] {
 return ['--no-extensions','--no-mcp','--no-prompt-templates','--tools',PHASE_TOOLS,
  '--model',`${c.provider}/${c.modelId}`,'--thinking',c.thinking,
  '-e',lifecycle,'-e',bootstrap,'--append-system-prompt',`Managed phase-worker. Read the phase contract at ${contractPath}. Questions go to caller_ping; never to a human questionnaire. Lazy mode stays off.`];
}
export function managedPhaseEnv(c: PhaseContract, contractPath: string): Record<string,string> {
 return { PI_PHASE_WORKER: '1', PI_PHASE_CONTRACT: contractPath, PI_PHASE_PARENT_SESSION: c.parentSessionId,
  PI_SUBAGENT_AGENT: 'phase-worker', PI_SUBAGENT_AUTO_EXIT: '1', PI_SUBAGENT_DEPTH: '1',
  PI_DENY_TOOLS: 'subagent,subagent_interrupt,subagents_list,subagent_resume,ask_user_question' };
}
function canonical(path: string): string {
 let cursor = resolve(path); const suffix: string[] = [];
 while (!existsSync(cursor)) { const up = resolve(cursor, '..'); if (up === cursor) break; suffix.unshift(cursor.slice(up.length + (up.endsWith(sep) ? 0 : 1))); cursor = up; }
 return resolve(realpathSync(cursor), ...suffix);
}
export function isPhaseWriteAllowed(c: PhaseContract, path: string): boolean {
 const root = canonical(c.cwd); const target = canonical(resolve(c.cwd, path));
 const rel = relative(root, target);
 if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return false;
 return c.allowedPaths.some(p => {
  const allowed = canonical(resolve(c.cwd, p));
  // The allowed entry itself must not point outside the cwd through a symlink.
  const inside = relative(root, allowed);
  if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return false;
  return target === allowed || (p.endsWith('/') && target.startsWith(allowed + sep));
 });
}
export function phaseShellNeedsParent(command: string): boolean {
 // Defense in depth, not a shell parser or OS sandbox. Unknown authorization stays with the parent.
 return /\b(?:sudo|rm|rmdir|unlink|mkfs\w*|wipefs|shutdown|reboot|terraform\s+destroy|kubectl\s+delete)\b|\bgit\s+(?:commit|push|reset|clean|stash)\b|\b(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh\b/.test(command);
}
