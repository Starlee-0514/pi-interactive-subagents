import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePhaseContract, PHASE_TOOLS, isPhaseWriteAllowed, phaseShellNeedsParent } from './phase-contract.ts';

export async function registerPhaseWorker(pi: ExtensionAPI, env = process.env, loadLazy?: (path: string) => Promise<any>) {
 if (env.PI_PHASE_WORKER !== '1' || env.PI_SUBAGENT_AGENT !== 'phase-worker' || !env.PI_SUBAGENT_ID || !env.PI_PHASE_CONTRACT || !env.PI_PHASE_LAZY_MODULE) throw new Error('Invalid managed phase-worker bootstrap');
 const c = parsePhaseContract(readFileSync(env.PI_PHASE_CONTRACT, 'utf8'));
 if (env.PI_PHASE_PARENT_SESSION !== c.parentSessionId) throw new Error('Phase parent identity mismatch');
 if (!existsSync(env.PI_PHASE_LAZY_MODULE)) throw new Error('Lazy owner module unavailable');
 const lazy = await (loadLazy ?? (path => import(pathToFileURL(path).href)))(env.PI_PHASE_LAZY_MODULE);
 const mode = lazy.registerLazyMode(pi, { fixedOff: true });
 pi.on('session_start', () => { pi.setActiveTools(PHASE_TOOLS.split(',')); });
 pi.on('before_agent_start', (event: any) => {
  if (mode.isEnabled()) throw new Error('Managed phase-worker must stay lazy off');
  const text = 'You are a managed phase-worker, not the user-facing agent. LAZY_MODE=off is fixed. Complete only this approved phase, including necessary tests/fixes. Questions must use caller_ping to the parent; never call ask_user_question or offer a human next-step menu. Final output must report completed/blocked/failed, changed paths, actual verification commands/exit codes, unverified items and risks. Do not begin another phase, spawn agents, commit/push, delete files, change credentials/permissions, publish or expand scope. Preserve all repository safety rules. Contract:\n' + JSON.stringify(c);
  if (event.systemPromptOptions?.sections) event.systemPromptOptions.sections.phase_worker = text;
  return { message: { customType: 'phase-worker-context', content: text, display: false } };
 });
 pi.on('tool_call', (event: any) => {
  if (event.toolName === 'caller_ping') return;
  if (Date.now() > c.deadlineMs) return { block: true, reason: 'Phase deadline exceeded; use caller_ping to ask parent, do not keep working.' };
  if (!PHASE_TOOLS.split(',').includes(event.toolName)) return { block: true, reason: 'Tool not allowed in managed phase; ask parent via caller_ping.' };
  if (['write','edit'].includes(event.toolName) && !isPhaseWriteAllowed(c, event.input.path)) return { block: true, reason: 'Write outside approved paths; ask parent via caller_ping.' };
  if (event.toolName === 'bash' && phaseShellNeedsParent(event.input.command)) return { block: true, reason: 'Shell operation needs parent/user authorization; use caller_ping.' };
 });
 return { contract: c, mode };
}
export default async function (pi: ExtensionAPI) { await registerPhaseWorker(pi); }
