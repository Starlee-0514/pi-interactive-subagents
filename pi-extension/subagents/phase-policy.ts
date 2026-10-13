import { validatePhaseSpec, type PhaseSpec, type PhaseContract } from './phase-contract.ts';

export interface PhaseGoal { id: string; scope: 'implementation-and-verification'; objective: string; phases: PhaseSpec[]; }
export interface PhaseState {
 goal: PhaseGoal; authorizationReference: string; next: number; repairs: number;
 status: 'ready'|'prepared'|'working'|'needs-parent'|'reported'|'accepted'|'failed'|'cancelled'|'paused';
 current?: PhaseContract; sessionFile?: string; runId?: string; outcome?: string; resumeMessage?: string;
 checkpoint?: number; usedAttempts: string[];
}
export function approveGoal(goal: PhaseGoal, authorizationReference: string): PhaseState {
 if (!goal || goal.scope !== 'implementation-and-verification' || !goal.id?.trim() || !goal.objective?.trim() || !authorizationReference?.trim() || !Array.isArray(goal.phases) || !goal.phases.length) throw new Error('Explicit implementation-and-verification goal approval required');
 const ids = new Set<string>();
 for (const p of goal.phases) { validatePhaseSpec(p); if (!p.id?.trim() || ids.has(p.id)) throw new Error('Unique phase IDs required'); ids.add(p.id); }
 return { goal, authorizationReference, next: 0, repairs: 0, status: 'ready', usedAttempts: [] };
}
export function preparePhase(state: PhaseState, model: { provider: string; id: string }, thinking: string, parentSessionId: string, attemptId: string, lazy: boolean|undefined, now = Date.now()): PhaseContract {
 if (lazy === undefined) throw new Error('Lazy owner unavailable; do not auto-continue');
 if (state.status !== 'ready' && state.status !== 'accepted') throw new Error(`Phase cannot dispatch from ${state.status}`);
 if (state.next >= state.goal.phases.length) throw new Error('Goal complete; no new work');
 if (!lazy && state.next > 0 && state.checkpoint !== state.next) throw new Error('Manual phase checkpoint required while parent lazy off');
 if (!model?.provider || !model?.id || !parentSessionId || !attemptId || state.usedAttempts.includes(attemptId)) throw new Error('Invalid/duplicate dispatch identity');
 const p = state.goal.phases[state.next];
 return { kind: 'phase-contract', version: 1, goalId: state.goal.id, phaseId: p.id, attemptId, parentSessionId, objective: p.objective,
  cwd: p.cwd, allowedPaths: [...p.allowedPaths], acceptance: [...p.acceptance], verifyCommands: [...p.verifyCommands], nonGoals: [...p.nonGoals],
  authorizationReference: state.authorizationReference, provider: model.provider, modelId: model.id, thinking, deadlineMs: now + 20 * 60_000 };
}
export function phaseMatches(state: PhaseState, c: PhaseContract): boolean {
 return state.current?.attemptId === c.attemptId && state.current?.phaseId === c.phaseId && state.goal.id === c.goalId;
}
export function applyPhaseOutcome(state: PhaseState, event: { contract: PhaseContract; runId?: string; sessionFile: string; kind: 'help'|'result'; exitCode: number; summary?: string }): boolean {
 if (!phaseMatches(state, event.contract) || state.sessionFile !== event.sessionFile || state.runId !== event.runId || state.status !== 'working') return false;
 state.status = event.kind === 'help' ? 'needs-parent' : event.exitCode === 0 ? 'reported' : 'failed';
 state.outcome = event.summary ?? event.kind;
 return true;
}
export function reviewPhase(state: PhaseState, passed: boolean, verification: { command: string; exitCode: number }[], acceptanceEvidence: string[]): void {
 if (!['reported','failed'].includes(state.status)) throw new Error('Only a reported phase can be reviewed');
 if (!passed) {
  if (++state.repairs > 2) { state.status = 'failed'; throw new Error('Repair limit reached; ask the user'); }
  state.status = 'ready'; state.current = undefined; state.sessionFile = undefined; state.runId = undefined; return;
 }
 if (state.status !== 'reported' || !verification?.length || verification.some(v => !v.command?.trim() || v.exitCode !== 0) || !acceptanceEvidence?.length || acceptanceEvidence.length < state.goal.phases[state.next].acceptance.length || acceptanceEvidence.some(e => !e?.trim())) throw new Error('Independent successful verification and acceptance evidence required');
 if (!state.goal.phases[state.next].verifyCommands.every(command => verification.some(v => v.command === command && v.exitCode === 0))) throw new Error('Verification evidence must cover the contract commands');
 // Evidence is the parent's report, not a mechanical correctness proof.
 state.next++; state.repairs = 0; state.status = 'accepted'; state.current = undefined; state.sessionFile = undefined; state.runId = undefined;
}
export function checkpointPhase(state: PhaseState): void {
 if (!['ready','accepted'].includes(state.status)) throw new Error('Cannot checkpoint an active/unreviewed phase');
 state.checkpoint = state.next;
}
export function canParentDecide(category: string): boolean {
 return category === 'technical-within-contract';
}

/** Actions that are valid right now, derived from the same rules the handlers enforce. Lets a model stop guessing the order. */
export function allowedNextActions(state: PhaseState | undefined, lazy: boolean | undefined): { actions: string[]; note?: string } {
 if (!state || state.status === 'cancelled') return { actions: ['approve'] };
 const done = state.next >= state.goal.phases.length;
 switch (state.status) {
  case 'ready': case 'accepted':
   if (done) return { actions: ['approve'], note: 'Goal complete: every phase is accepted. Nothing to release; report the result to the user and stop. approve is only for a new goal.' };
   if (lazy === false && state.next > 0 && state.checkpoint !== state.next) return { actions: ['checkpoint', 'cancel'], note: 'Parent lazy is off: a human checkpoint is required before the next phase (use status.humanReferenceCandidate).' };
   return { actions: ['prepare', 'cancel'] };
  case 'prepared':
   return state.sessionFile
    ? { actions: ['subagent_resume', 'cancel'], note: 'Resume with the exact message and sessionPath returned by answer.' }
    : { actions: ['subagent(agent=phase-worker)', 'release', 'cancel'], note: 'Dispatch passes the approved contract automatically; the task text you send is replaced.' };
  case 'working': return { actions: ['cancel'], note: 'The child is running; wait for its result or help request.' };
  case 'needs-parent': return { actions: ['answer', 'cancel'] };
  case 'reported': case 'failed': return { actions: ['review', 'cancel'] };
  case 'paused': return { actions: ['reconcile', 'cancel'], note: 'reconcile needs stopped:true after you verify the child is stopped.' };
 }
 return { actions: [] };
}
