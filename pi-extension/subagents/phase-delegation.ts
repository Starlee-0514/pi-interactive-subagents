import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { readManagedPhaseSnapshot } from './session.ts';
import { parsePhaseContract } from './phase-contract.ts';
import { approveGoal, preparePhase, reviewPhase, checkpointPhase, applyPhaseOutcome, phaseMatches, canParentDecide, allowedNextActions, type PhaseState } from './phase-policy.ts';

export const PHASE_STATE_ENTRY = 'starlee.phase-state';
export const PHASE_OUTCOME_EVENT = 'starlee:phase-outcome';
export function queryParentLazy(pi: any): boolean | undefined {
 let answer: boolean | undefined;
 pi.events.emit('ask-user-question:lazy-query', { reply: (state: any) => { if (typeof state?.enabled === 'boolean') answer = state.enabled; } });
 return answer;
}
export function humanReference(ctx: any, id: string): boolean {
 const entry = ctx.sessionManager.getBranch().find((e: any) => e.id === id);
 const m = entry?.message;
 if (entry?.type !== 'message' || !m) return false;
 if (m.role === 'user') return true;
 // A manual questionnaire answer is a human approval reference; its semantic scope is still the parent's responsibility.
 return m.role === 'toolResult' && m.toolName === 'ask_user_question' && !m.isError && m.details?.autoSelected !== true && Array.isArray(m.details?.answers) && m.details.answers.length > 0 && !m.details?.error;
}
/** Newest entry on this branch that humanReference() accepts; lets the model cite a real approval instead of guessing an ID. */
export function latestHumanReference(ctx: any): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) if (humanReference(ctx, branch[i].id)) return branch[i].id;
  return undefined;
}
/** A goal may be given as a JSON file path; it must be a .json file inside the session directory. */
export function loadGoalFile(ctx: any, path: string): unknown {
  const base = ctx.cwd;
  if (typeof base !== 'string' || !base) throw new Error('goal as a file path needs a known session directory; pass the goal object instead');
  if (!isAbsolute(path) || !path.endsWith('.json')) throw new Error('goal file path must be an absolute path to a .json file');
  let real: string, root: string;
  try { real = realpathSync(resolve(path)); root = realpathSync(base); } catch { throw new Error(`goal file not found: ${path}`); }
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('goal file must be inside the session directory');
  if (statSync(real).size > 256 * 1024) throw new Error('goal file is too large');
  try { return JSON.parse(readFileSync(real, 'utf8')); } catch { throw new Error('goal file is not valid JSON'); }
}
export function registerPhaseDelegation(pi: ExtensionAPI, running: () => any[], env = process.env) {
 if (env.PI_SUBAGENT_NAME || env.PI_PHASE_WORKER === '1') return;
 let state: PhaseState | undefined;
 let ctx: any;
 const save = () => { if (state) pi.appendEntry(PHASE_STATE_ENTRY, structuredClone(state)); };
 const restore = (_event: any, context: any) => {
  ctx = context; state = undefined;
  for (const e of ctx.sessionManager.getBranch()) if (e.type === 'custom' && e.customType === PHASE_STATE_ENTRY) state = structuredClone(e.data);
  // Watchers are not revived by upstream /reload. Never invent liveness or replay a dispatch.
  if (state && ['prepared','working','needs-parent'].includes(state.status)) state.status = 'paused';
 };
 pi.on('session_start', restore); pi.on('session_switch', restore); pi.on('session_tree', restore);
 pi.events.on(PHASE_OUTCOME_EVENT, (event: any) => {
  if (!state || !ctx || event.contract.parentSessionId !== ctx.sessionManager.getSessionId()) return;
  if (applyPhaseOutcome(state, event)) save();
 });
 pi.on('before_agent_start', (event: any, context: any) => {
  ctx = context;
  if (!pi.getActiveTools().includes('subagent')) return;
  const lazy = queryParentLazy(pi);
  const text = `You are the user-facing phase orchestrator. Parent LAZY_MODE=${lazy === undefined ? 'unknown' : lazy ? 'on' : 'off'}; every phase-worker stays off. Use phase_control to approve a bounded implementation-and-verification goal using an actual human authorization entry ID, prepare one phase, dispatch subagent(agent=phase-worker,task=<returned JSON contract>), then wait for harness results without polling. Do not claim completion while a child runs. Child help goes to you: decide ordinary technical choices within the contract; escalate deletion, spending, publishing, credentials/permissions, expanded scope, preferences or uncertainty through your own ask_user_question. Resume only after phase_control answer approval. Inspect diffs and independently verify contract commands before phase_control review. Parent on: continue the next necessary approved low-risk phase without repeated checkpoints. Parent off: ask a human phase checkpoint before the next stage. Goal-scope approval and uncertain/risky decisions always remain manual. Never create optional work after all phases pass. Active state: ${JSON.stringify(state ?? null)}. Human references prove provenance, not semantic approval; you remain responsible for correctly interpreting approval. Tool boundaries are not an OS sandbox.`;
  if (event.systemPromptOptions?.sections) event.systemPromptOptions.sections.phase_delegation = text;
  return { message: { customType: 'phase-delegation-context', content: text, display: false } };
 });
 pi.registerTool({
  name: 'phase_control', label: 'Phase Control',
  description: 'Manage a single approved phased goal: approve, prepare, review, checkpoint, answer, release, reconcile, cancel, status. approve takes the goal as an object or as an absolute path to a .json file inside the session directory. Every result lists allowedNextActions (and a note); follow it instead of guessing the order. Use real human message/questionnaire entry IDs for approvals; `status` returns humanReferenceCandidate, the latest such entry on this branch (cite it only if that message is the approval). It does not spawn models or prove correctness.',
  promptGuidelines: [
   'phase_control hands bounded implementation PHASES to a child agent. Do not use it for a small edit (one or two files, a few lines), a quick fix, a question or a design discussion: do those yourself.',
   'Use phase_control only when the user wants a feature built that spans several files or phases with independent checks, or explicitly asks for a subagent or phase-worker, and has approved the goal.',
   'Before first use read the phase-worker-dispatch skill. Follow allowedNextActions in every result; never invent an approvalReference.',
  ],
  parameters: Type.Object({
   action: Type.Union(['approve','prepare','review','checkpoint','answer','release','reconcile','cancel','status'].map(v => Type.Literal(v))),
   goal: Type.Optional(Type.Any()), approvalReference: Type.Optional(Type.String()),
   passed: Type.Optional(Type.Boolean()), verification: Type.Optional(Type.Array(Type.Object({ command: Type.String(), exitCode: Type.Number() }))),
   acceptanceEvidence: Type.Optional(Type.Array(Type.String())), category: Type.Optional(Type.String()),
   message: Type.Optional(Type.String()), stopped: Type.Optional(Type.Boolean()),
  }),
  async execute(_id: string, params: any, _signal: any, _update: any, context: any) {
   try { return await executePhaseControl(params, context); }
   catch (error: any) {
    if (error instanceof Error) error.message += `; allowed next actions: ${allowedNextActions(state, queryParentLazy(pi)).actions.join(', ')}`;
    throw error;
   }
  },
 });
 async function executePhaseControl(params: any, context: any) {
   ctx = context;
   const requireHuman = () => { if (!params.approvalReference || !humanReference(ctx, params.approvalReference)) { const hint = latestHumanReference(ctx); throw new Error('An actual human authorization reference on this branch is required' + (hint ? `; latest human entry is humanReferenceCandidate=${hint} (use it only if that message is the approval)` : '; no human entry exists on this branch')); } };
   const result = (extra: any = {}) => { const next = allowedNextActions(state, queryParentLazy(pi)); const all = { allowedNextActions: next.actions, ...(next.note ? { note: next.note } : {}), ...extra }; return { content: [{ type: 'text' as const, text: JSON.stringify({ state, ...all }) }], details: { state: structuredClone(state), ...all } }; };
   if (params.action === 'status') return result({ humanReferenceCandidate: latestHumanReference(ctx) });
   if (params.action === 'approve') {
    requireHuman();
    if (running().some(r => r.phaseContract) || (state && !['cancelled','accepted'].includes(state.status))) throw new Error('Existing goal/worker must finish or be reconciled first');
    if (state?.status === 'accepted' && state.next < state.goal.phases.length) throw new Error('Existing approved goal still has phases');
    state = approveGoal(typeof params.goal === 'string' ? loadGoalFile(ctx, params.goal) as any : params.goal, params.approvalReference); save(); return result();
   }
   if (!state) throw new Error('No approved phase goal');
   if (params.action === 'prepare') {
    if (running().some(r => r.phaseContract)) throw new Error('One writable phase-worker at a time');
    const c = preparePhase(state, ctx.model, pi.getThinkingLevel(), ctx.sessionManager.getSessionId(), randomUUID(), queryParentLazy(pi));
    state.current = c; state.status = 'prepared'; save(); return result({ task: JSON.stringify(c) });
   }
   if (params.action === 'review') {
    try { reviewPhase(state, params.passed === true, params.verification ?? [], params.acceptanceEvidence ?? []); }
    finally { save(); } // The repair-limit failure mutates state before throwing; persist it too.
    return result();
   }
   if (params.action === 'checkpoint') { requireHuman(); checkpointPhase(state); save(); return result(); }
   if (params.action === 'answer') {
    if (state.status !== 'needs-parent' || !params.message?.trim()) throw new Error('No pending child question or answer');
    if (!canParentDecide(params.category)) requireHuman();
    state.resumeMessage = params.message;
    state.status = 'prepared'; save(); return result({ resume: { sessionPath: state.sessionFile, message: params.message } });
   }
   if (params.action === 'release' && state.status === 'accepted' && state.next >= state.goal.phases.length) return result({ note: 'Goal complete; nothing to release.' });
   if (params.action === 'release' && state.status === 'prepared' && !state.sessionFile) { state.status = 'ready'; state.current = undefined; save(); return result(); }
   if (params.action === 'reconcile') {
    requireHuman();
    if (state.status !== 'paused' || params.stopped !== true || running().some(r => r.phaseContract)) throw new Error('Paused worker must be explicitly verified stopped before redispatch');
    state.status = 'ready'; state.current = undefined; state.sessionFile = undefined; state.runId = undefined; save(); return result();
   }
   if (params.action === 'cancel') {
    requireHuman();
    const child = running().find(r => r.phaseContract?.goalId === state!.goal.id);
    if (child) {
     if (!ctx.executeTool) throw new Error('Interrupt child before cancelling');
     const interrupted = await ctx.executeTool('subagent_interrupt', { id: child.id });
     if (interrupted.isError || interrupted.details?.error) throw new Error('Child interrupt failed; cancellation not confirmed');
    }
    state.status = 'cancelled'; save(); return result({ note: 'No rollback. Interrupted child may remain parked; do not assume process termination.' });
   }
   throw new Error(`Invalid transition from ${state.status}`);
 }
 pi.on('tool_call', (event: any, context: any) => {
  ctx = context;
  if (event.toolName === 'subagent') {
   if (event.input.agent !== 'phase-worker') {
    if (state && ['prepared','working','needs-parent','reported','paused'].includes(state.status)) return { block: true, reason: 'Do not start another agent while the writable phase is unresolved' };
    return;
   }
   try {
    if (!state || state.status !== 'prepared' || state.sessionFile) throw new Error('Prepare an approved phase before dispatch');
    // The approved contract is authoritative: models often reword it, which only caused rejected retries.
    // Replace whatever the model sent with state.current and keep a record of the difference.
    if (state.current) {
     const approved = JSON.stringify(state.current);
     if (event.input.task !== approved) { pi.appendEntry('phase-contract-normalized', { attemptId: state.current.attemptId, hadTask: typeof event.input.task === 'string' }); event.input.task = approved; }
    }
    const c = parsePhaseContract(event.input.task);
    if (!phaseMatches(state, c) || JSON.stringify(c) !== JSON.stringify(state.current) || c.parentSessionId !== ctx.sessionManager.getSessionId()) throw new Error('Contract does not match approved current phase');
    if (c.provider !== ctx.model?.provider || c.modelId !== ctx.model?.id || c.thinking !== pi.getThinkingLevel()) throw new Error('Parent model changed; release and prepare a new snapshot');
    if (state.usedAttempts.includes(c.attemptId)) throw new Error('Duplicate dispatch');
    if (queryParentLazy(pi) === false && state.next > 0 && state.checkpoint !== state.next) throw new Error('Parent switched off; manual phase checkpoint required');
    if (queryParentLazy(pi) === undefined) throw new Error('Lazy owner unavailable');
    state.usedAttempts.push(c.attemptId); state.status = 'working'; save();
   } catch (error: any) { return { block: true, reason: error.message }; }
  }
  if (event.toolName === 'subagent_resume' && state?.sessionFile !== event.input.sessionPath && existsSync(event.input.sessionPath)) {
   try {
    if (readManagedPhaseSnapshot(event.input.sessionPath)) return { block: true, reason: 'Managed session is not the currently approved phase; do not replay historical work' };
   } catch (error: any) { return { block: true, reason: error.message }; }
  }
  if (event.toolName === 'subagent_resume' && state && ['prepared','working','needs-parent','reported','paused','failed'].includes(state.status) && state.sessionFile !== event.input.sessionPath) {
   return { block: true, reason: 'Do not resume another session while the writable phase is unresolved' };
  }
  if (event.toolName === 'subagent_resume' && state?.sessionFile === event.input.sessionPath) {
   if (state.status !== 'prepared' || !state.current || event.input.autoExit === false || !state.resumeMessage || event.input.message !== state.resumeMessage) return { block: true, reason: 'Restricted resume must use the answer approved via phase_control' };
   state.resumeMessage = undefined;
   state.status = 'working'; save();
  }
 });
 pi.on('tool_result', (event: any) => {
  if (!state || state.status !== 'working' || !['subagent','subagent_resume'].includes(event.toolName)) return;
  const details = event.details;
  if (details?.agent !== 'phase-worker' && event.input?.agent !== 'phase-worker' && event.input?.sessionPath !== state.sessionFile) return;
  if (event.isError || details?.status !== 'started') { state.status = 'ready'; state.current = undefined; state.sessionFile = undefined; state.runId = undefined; }
  else { state.sessionFile = details.sessionFile; state.runId = details.id; }
  save();
 });
 return { getState: () => state };
}
