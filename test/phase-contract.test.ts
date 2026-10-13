import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as phase from '../pi-extension/subagents/phase-contract.ts';

export const contract = () => ({ kind: 'phase-contract', version: 1, goalId: 'goal-a', phaseId: 'phase-1', attemptId: 'attempt-1', parentSessionId: 'parent-1', objective: 'Implement parser', cwd: '/repo', allowedPaths: ['src/', 'test/'], acceptance: ['Invalid input rejected'], verifyCommands: ['node --test'], nonGoals: ['No CLI'], authorizationReference: 'entry-user-1', provider: 'openai-codex', modelId: 'model-current', thinking: 'medium', deadlineMs: Date.now() + 60000 });

test('phase contract validates the complete bounded task and fails closed on bad paths/mode', () => {
 const c = contract();
 assert.deepEqual(phase.parsePhaseContract(JSON.stringify(c)), c);
 for (const patch of [{ kind: 'x' }, { allowedPaths: ['../outside'] }, { allowedPaths: ['/etc'] }, { allowedPaths: ['src/../../escape'] }, { allowedPaths: [] }, { parentSessionId: '' }, { acceptance: [] }, { verifyCommands: [] }, { thinking: 'invalid' }, { deadlineMs: 0 }]) {
  assert.throws(() => phase.parsePhaseContract(JSON.stringify({ ...contract(), ...patch })), /contract|phase|path|deadline|thinking/i);
 }
});

test('managed launch pins role, original model/thinking, tools and excludes all discovered extensions', () => {
 const c = contract();
 const profile = phase.managedPhaseProfile(c);
 assert.equal(profile.autoExit, true);
 assert.equal(profile.sessionMode, 'lineage-only');
 assert.equal(profile.spawning, false);
 assert.equal(profile.model, 'openai-codex/model-current');
 assert.equal(profile.thinking, 'medium');
 const args = phase.managedPhaseCliArgs(c, '/lazy.ts', '/child.ts', '/contract.json');
 for (const flag of ['--no-extensions', '--no-mcp', '--no-prompt-templates', '--tools', '--model', '--thinking']) assert.ok(args.includes(flag));
 assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls,write,edit,bash,caller_ping');
 assert.ok(!args.join(' ').includes('ask_user_question'));
 assert.throws(() => phase.validatePhaseOverrides({ fork: true }, c), /override|fork/i);
 assert.throws(() => phase.validatePhaseOverrides({ model: 'other' }, c), /override/i);
 assert.throws(() => phase.validatePhaseOverrides({ tools: 'bash,subagent' }, c), /override/i);
 assert.throws(() => phase.validatePhaseOverrides({ cwd: '/other' }, c), /override/i);
});
