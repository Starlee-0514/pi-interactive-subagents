import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../pi-extension/subagents/phase-policy.ts';

const spec = (id = 'p1') => ({ id, objective: 'bounded task', cwd: '/repo', allowedPaths: ['src/'], acceptance: ['unit behavior'], verifyCommands: ['node --test'], nonGoals: ['no deploy'] });
const goal = () => ({ id: 'g1', scope: 'implementation-and-verification', objective: 'feature', phases: [spec(), spec('p2')] });
const ready = () => p.approveGoal(goal(), 'user-entry');
const reported = () => { const s = ready(); const c = p.preparePhase(s, { provider: 'provider', id: 'actual-model' }, 'high', 'parent', 'a1', true); s.current = c; s.status = 'working'; s.sessionFile = '/run.jsonl'; p.applyPhaseOutcome(s, { contract: c, sessionFile: '/run.jsonl', kind: 'result', exitCode: 0 }); return s; };

test('review needs evidence for the actual contract commands, not an unrelated successful command', () => {
 const s = reported();
 assert.throws(() => p.reviewPhase(s, true, [{ command: 'echo ok', exitCode: 0 }], ['works']), /verification|command/i);
 assert.equal(s.next, 0);
});
test('parent on continues approved stages; off requires a human checkpoint; no owner/design-only fail closed', () => {
 const s = reported();
 p.reviewPhase(s, true, [{ command: 'node --test', exitCode: 0 }], ['verified behavior']);
 assert.equal(s.status, 'accepted');
 assert.throws(() => p.preparePhase(s, { provider: 'p', id: 'm' }, 'medium', 'parent', 'a2', false), /checkpoint/);
 assert.equal(p.preparePhase(s, { provider: 'p', id: 'm' }, 'medium', 'parent', 'a2', true).phaseId, 'p2');
 p.checkpointPhase(s);
 assert.equal(p.preparePhase(s, { provider: 'p', id: 'm' }, 'medium', 'parent', 'a2', false).phaseId, 'p2');
 assert.throws(() => p.preparePhase(s, { provider: 'p', id: 'm' }, 'medium', 'parent', 'a2', undefined), /owner/);
 assert.throws(() => p.approveGoal({ ...goal(), scope: 'design-only' }, 'entry'), /approval/);
});
test('help is not completion; stale or duplicate outcomes cannot release a writable worker', () => {
 const s = ready(); const c = p.preparePhase(s, { provider: 'p', id: 'm' }, 'medium', 'parent', 'a1', true);
 s.current = c; s.status = 'working'; s.sessionFile = '/s';
 assert.equal(p.applyPhaseOutcome(s, { contract: { ...c, attemptId: 'old' }, sessionFile: '/s', kind: 'result', exitCode: 0 }), false);
 assert.equal(p.applyPhaseOutcome(s, { contract: c, sessionFile: '/s', kind: 'help', exitCode: 0 }), true);
 assert.equal(s.status, 'needs-parent');
 assert.equal(p.applyPhaseOutcome(s, { contract: c, sessionFile: '/s', kind: 'result', exitCode: 0 }), false);
 assert.throws(() => p.preparePhase(s, { provider: 'p', id: 'm' }, 'medium', 'parent', 'a2', true), /needs-parent/);
 assert.throws(() => p.reviewPhase(s, true, [{ command: 'node --test', exitCode: 0 }], ['x']), /reported/);
 assert.equal(p.canParentDecide('technical-within-contract'), true);
 for (const kind of ['deletion','spending','permissions','new-goal','uncertain']) assert.equal(p.canParentDecide(kind), false);
});
test('repair limit stops loops and complete goals cannot create optional stages', () => {
 const s = reported(); p.reviewPhase(s, false, [], []); assert.equal(s.repairs, 1);
 assert.equal(s.sessionFile, undefined, 'a reported ended run must not block repair dispatch');
 assert.equal(s.current, undefined);
 s.status = 'reported'; p.reviewPhase(s, false, [], []);
 s.status = 'reported'; assert.throws(() => p.reviewPhase(s, false, [], []), /limit/);
 assert.equal(s.status, 'failed');
 const done = reported(); p.reviewPhase(done, true, [{ command: 'node --test', exitCode: 0 }], ['ok']);
 done.status = 'reported'; p.reviewPhase(done, true, [{ command: 'node --test', exitCode: 0 }], ['ok']);
 assert.throws(() => p.preparePhase(done, { provider: 'p', id: 'm' }, 'medium', 'parent', 'a3', true), /complete/);
});
