import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPhaseDelegation, PHASE_OUTCOME_EVENT } from '../pi-extension/subagents/phase-delegation.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeManagedPhaseSnapshot } from '../pi-extension/subagents/session.ts';

function fixture() {
 const handlers = new Map<string, any[]>(); const tools = new Map<string, any>(); const listeners = new Map<string, any>();
 const entries: any[] = [{ type: 'message', id: 'user-approval', message: { role: 'user', content: 'Implement and verify this feature' } }];
 let lazy: boolean|undefined = true;
 const pi: any = { on: (n: string, f: any) => { const a = handlers.get(n) ?? []; a.push(f); handlers.set(n,a); }, events: { on: (n: string,f: any) => listeners.set(n,f), emit: (n: string,x: any) => { if(n === 'ask-user-question:lazy-query' && lazy !== undefined) x.reply({ enabled: lazy }); else listeners.get(n)?.(x); } }, registerTool: (t: any) => tools.set(t.name,t), appendEntry: (customType: string,data: any) => entries.push({ type:'custom', customType, data }), getActiveTools: () => ['subagent'], getThinkingLevel: () => 'high' };
 const ctx: any = { model: { provider:'current-provider', id:'current-model' }, sessionManager: { getBranch: () => entries, getSessionId: () => 'parent' } };
 const instance = registerPhaseDelegation(pi, () => [], {});
 const fire = (n: string, x: any) => { let result; for (const f of handlers.get(n) ?? []) result = f(x,ctx) ?? result; return result; };
 fire('session_start', {});
 const run = (x: any) => tools.get('phase_control').execute('call',x,undefined,undefined,ctx);
 const spec = (id: string) => ({ id, objective:'parser', cwd:'/repo', allowedPaths:['src/'], acceptance:['valid input'], verifyCommands:['node --test'], nonGoals:['no CLI'] });
 const approve = () => run({ action:'approve', approvalReference:'user-approval', goal: { id:'goal', scope:'implementation-and-verification', objective:'feature', phases:[spec('p1'),spec('p2')] } });
 return { pi, ctx, fire, run, approve, state: () => instance?.getState(), lazy: (x: boolean|undefined) => { lazy=x; }, entries, tools };
}

test('real tool_result event records child identity; help routes to parent and restricted resume preserves the phase', async () => {
 const f = fixture(); await f.approve(); const prepared = await f.run({ action:'prepare' });
 const c = JSON.parse(prepared.details.task);
 assert.equal(c.modelId,'current-model'); assert.equal(c.thinking,'high');
 const input = { agent:'phase-worker', name:'p1', task:prepared.details.task };
 assert.equal(f.fire('tool_call',{ toolName:'subagent',input }), undefined);
 assert.equal(f.fire('tool_call',{ toolName:'subagent',input }).block, true);
 f.fire('tool_result',{ toolName:'subagent',input,isError:false,details:{ status:'started', agent:'phase-worker', id:'run1', sessionFile:'/child.jsonl' } });
 assert.equal(f.state()?.status,'working');
 assert.equal(f.state()?.sessionFile,'/child.jsonl');
 f.pi.events.emit(PHASE_OUTCOME_EVENT,{ contract:c,runId:'run1',sessionFile:'/child.jsonl',kind:'help',exitCode:0,summary:'Which parser?' });
 assert.equal(f.state()?.status,'needs-parent');
 await assert.rejects(f.run({ action:'answer',category:'new-goal',message:'Add CLI' }), /human/);
 const answer = await f.run({ action:'answer',category:'technical-within-contract',message:'Use the existing parser' });
 assert.equal(answer.details.resume.sessionPath,'/child.jsonl');
 assert.equal(f.fire('tool_call',{ toolName:'subagent_resume',input:{ sessionPath:'/child.jsonl', autoExit:false } }).block,true);
 assert.equal(f.fire('tool_call',{ toolName:'subagent_resume',input:{ sessionPath:'/child.jsonl', message:'Use the existing parser' } }),undefined);
 f.fire('tool_result',{ toolName:'subagent_resume',input:{sessionPath:'/child.jsonl'},isError:false,details:{ status:'started', agent:'phase-worker', id:'run2', sessionFile:'/child.jsonl' } });
 f.pi.events.emit(PHASE_OUTCOME_EVENT,{ contract:c,runId:'run1',sessionFile:'/child.jsonl',kind:'result',exitCode:0,summary:'late old result' });
 assert.equal(f.state()?.status,'working', 'a previous run must not finish the resumed child');
});

test('current lazy mode at dispatch wins over an earlier preparation; unknown owner fails closed', async () => {
 const f = fixture(); await f.approve(); await f.run({ action:'prepare' });
 f.state()!.status = 'reported'; await f.run({ action:'review', passed:true, verification:[{command:'node --test',exitCode:0}], acceptanceEvidence:['verified'] });
 const next = await f.run({ action:'prepare' });
 f.lazy(false);
 assert.equal(f.fire('tool_call',{toolName:'subagent', input:{agent:'phase-worker',name:'next',task:next.details.task}}).block,true);
 assert.equal(f.state()?.status,'prepared');
 f.lazy(undefined);
 assert.equal(f.fire('tool_call',{toolName:'subagent', input:{agent:'phase-worker',name:'next',task:next.details.task}}).block,true);
});

test('unrelated resumes are blocked while a writable phase is unresolved', async () => {
 const f = fixture(); await f.approve(); await f.run({ action:'prepare' });
 const blocked = f.fire('tool_call', { toolName:'subagent_resume', input:{ sessionPath:'/other.jsonl', message:'Write another feature' } });
 assert.equal(blocked?.block, true);
 assert.equal(f.state()?.status, 'prepared');
});

test('restricted resume must use the answer approved by phase_control', async () => {
 const f = fixture(); await f.approve(); const prepared = await f.run({ action:'prepare' });
 const c = JSON.parse(prepared.details.task);
 const input = { agent:'phase-worker', name:'p1', task:prepared.details.task };
 f.fire('tool_call', { toolName:'subagent', input });
 f.fire('tool_result', { toolName:'subagent', input, details:{status:'started', agent:'phase-worker', id:'run', sessionFile:'/child.jsonl'} });
 f.pi.events.emit(PHASE_OUTCOME_EVENT, {contract:c, runId:'run', sessionFile:'/child.jsonl', kind:'help', exitCode:0});
 await f.run({action:'answer', category:'technical-within-contract', message:'Use existing parser'});
 const blocked = f.fire('tool_call', {toolName:'subagent_resume', input:{sessionPath:'/child.jsonl', message:'Add an unapproved CLI'}});
 assert.equal(blocked?.block, true);
 assert.equal(f.state()?.status, 'prepared');
 assert.equal(f.fire('tool_call', {toolName:'subagent_resume', input:{sessionPath:'/child.jsonl', message:'Use existing parser'}}), undefined);
});

test('historical managed sessions cannot resume outside the currently approved phase', () => {
 const f = fixture();
 const dir = mkdtempSync(join(tmpdir(), 'phase-history-'));
 const path = join(dir, 'child.jsonl');
 writeFileSync(path, JSON.stringify({type:'session', id:'child'}) + '\n');
 const contract = {kind:'phase-contract', version:1, goalId:'old-goal', phaseId:'old-phase', attemptId:'old-attempt', parentSessionId:'parent', objective:'old task', cwd:dir, allowedPaths:['src/'], acceptance:['ok'], verifyCommands:['node --test'], nonGoals:[], authorizationReference:'user-approval', provider:'p', modelId:'m', thinking:'high', deadlineMs:Date.now()+60000};
 writeManagedPhaseSnapshot(path, {contract, body:'role', agentDir:dir, lazyModule:'/lazy.ts', piExecutable:'/usr/bin/pi'});
 assert.equal(f.fire('tool_call', {toolName:'subagent_resume', input:{sessionPath:path, message:'Unapproved follow-up'}})?.block, true);
});

test('repair limit remains durable when review throws and the session reloads', async () => {
 const f = fixture(); await f.approve(); await f.run({action:'prepare'});
 for (let i=0; i<2; i++) {
  f.state()!.status = 'reported'; await f.run({action:'review', passed:false});
 }
 f.state()!.status = 'reported';
 await assert.rejects(f.run({action:'review', passed:false}), /limit/);
 f.fire('session_start', {});
 assert.equal(f.state()?.status, 'failed');
 assert.equal(f.state()?.repairs, 3);
 await assert.rejects(f.run({action:'prepare'}), /failed/);
});

test('reload pauses uncertain workers; child processes never install parent policy', async () => {
 const f = fixture(); await f.approve(); await f.run({ action:'prepare' });
 f.fire('session_tree',{}); assert.equal(f.state()?.status,'paused');
 await assert.rejects(f.run({action:'prepare'}),/paused/);
 await assert.rejects(f.run({action:'reconcile',stopped:true}),/human/);
 await f.run({action:'reconcile',stopped:true,approvalReference:'user-approval'});
 assert.equal(f.state()?.status,'ready');
 const child:any = { registerTool: () => { throw new Error('should not install'); } };
 assert.equal(registerPhaseDelegation(child,()=>[],{PI_SUBAGENT_NAME:'child'}),undefined);
});

test('dispatch uses the approved contract even when the model paraphrases or omits the task', async () => {
 const f = fixture(); await f.approve(); const prepared = await f.run({ action:'prepare' });
 const approved = prepared.details.task;
 const paraphrased = JSON.stringify({ ...JSON.parse(approved), objective: 'parser (reworded for clarity)' });
 const input: any = { agent:'phase-worker', name:'p1', task: paraphrased };
 assert.equal(f.fire('tool_call',{ toolName:'subagent',input }), undefined, 'paraphrase no longer blocks the phase');
 assert.equal(input.task, approved, 'the approved contract replaces what the model sent');
 assert.equal(f.state()?.status,'working');
 assert.equal(f.fire('tool_call',{ toolName:'subagent',input:{ agent:'phase-worker', name:'p1', task:'anything' } }).block, true, 'duplicate dispatch still blocked');
});

test('dispatch still refuses when no phase is prepared, and fills a missing task', async () => {
 const f = fixture(); await f.approve();
 assert.match(f.fire('tool_call',{ toolName:'subagent',input:{ agent:'phase-worker', name:'p1', task:'x' } }).reason, /Prepare an approved phase/);
 await f.run({ action:'prepare' });
 const input: any = { agent:'phase-worker', name:'p1' };
 assert.equal(f.fire('tool_call',{ toolName:'subagent',input }), undefined);
 assert.equal(JSON.parse(input.task).phaseId, 'p1');
});

test('status exposes the latest genuine human entry so the model never has to guess an approval ID', async () => {
 const f = fixture();
 assert.equal((await f.run({ action:'status' })).details.humanReferenceCandidate, 'user-approval');
 f.entries.push({ type:'message', id:'assistant-1', message:{ role:'assistant', content:[] } });
 f.entries.push({ type:'message', id:'auto-q', message:{ role:'toolResult', toolName:'ask_user_question', isError:false, details:{ autoSelected:true, answers:[{}] } } });
 f.entries.push({ type:'message', id:'human-q', message:{ role:'toolResult', toolName:'ask_user_question', isError:false, details:{ answers:[{}] } } });
 f.entries.push({ type:'message', id:'tool-1', message:{ role:'toolResult', toolName:'bash', isError:false } });
 assert.equal((await f.run({ action:'status' })).details.humanReferenceCandidate, 'human-q', 'skips assistant, auto-selected and tool entries');
 await assert.rejects(() => f.run({ action:'approve', approvalReference:'?', goal:{} }), /humanReferenceCandidate|human-q/);
});

test('every result lists the actions that are valid now, following the real state machine', async () => {
 const f = fixture();
 const acts = async () => (await f.run({ action:'status' })).details.allowedNextActions;
 assert.deepEqual(await acts(), ['approve']);
 await f.approve();
 assert.deepEqual(await acts(), ['prepare', 'cancel']);
 const prepared = await f.run({ action:'prepare' });
 assert.deepEqual(prepared.details.allowedNextActions, ['subagent(agent=phase-worker)', 'release', 'cancel']);
 f.state()!.status = 'working';
 assert.deepEqual(await acts(), ['cancel']);
 f.state()!.status = 'needs-parent';
 assert.deepEqual(await acts(), ['answer', 'cancel']);
 f.state()!.status = 'reported';
 assert.deepEqual(await acts(), ['review', 'cancel']);
 f.state()!.status = 'failed';
 assert.deepEqual(await acts(), ['review', 'cancel']);
 f.state()!.status = 'paused';
 assert.deepEqual(await acts(), ['reconcile', 'cancel']);
 f.state()!.status = 'cancelled';
 assert.deepEqual(await acts(), ['approve']);
});

test('after a phase passes with the parent off, checkpoint comes before prepare', async () => {
 const f = fixture(); await f.approve(); await f.run({ action:'prepare' });
 f.state()!.status = 'reported';
 const reviewed = await f.run({ action:'review', passed:true, verification:[{command:'node --test',exitCode:0}], acceptanceEvidence:['verified'] });
 assert.deepEqual(reviewed.details.allowedNextActions, ['prepare', 'cancel'], 'parent lazy on: continue directly');
 f.lazy(false);
 assert.deepEqual((await f.run({ action:'status' })).details.allowedNextActions, ['checkpoint', 'cancel']);
 await f.run({ action:'checkpoint', approvalReference:'user-approval' });
 assert.deepEqual((await f.run({ action:'status' })).details.allowedNextActions, ['prepare', 'cancel']);
});

test('a finished goal says so: nothing to release, only a new approval is possible', async () => {
 const f = fixture(); await f.approve();
 for (let i = 0; i < 2; i++) {
  await f.run({ action:'prepare' }); f.state()!.status = 'reported';
  await f.run({ action:'review', passed:true, verification:[{command:'node --test',exitCode:0}], acceptanceEvidence:['verified'] });
 }
 const status = await f.run({ action:'status' });
 assert.deepEqual(status.details.allowedNextActions, ['approve']);
 assert.match(status.details.note, /complete/i);
 const released = await f.run({ action:'release' });
 assert.equal(released.details.state.status, 'accepted', 'release on a finished goal is a harmless no-op');
 assert.match(released.details.note, /nothing to release/i);
 await assert.rejects(() => f.run({ action:'answer', message:'x' }), /allowed next actions: approve/i);
});

test('approve accepts a goal JSON file inside the session directory and rejects other paths', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'goal-')); const other = mkdtempSync(join(tmpdir(), 'goal-other-'));
 const goal = { id:'g', scope:'implementation-and-verification', objective:'feature', phases:[{ id:'p1', objective:'parser', cwd:'/repo', allowedPaths:['src/'], acceptance:['ok'], verifyCommands:['node --test'], nonGoals:[] }] };
 writeFileSync(join(dir, 'goal.json'), JSON.stringify(goal)); writeFileSync(join(other, 'goal.json'), JSON.stringify(goal)); writeFileSync(join(dir, 'bad.json'), '{not json');
 const f = fixture(); f.ctx.cwd = dir;
 const approved = await f.run({ action:'approve', approvalReference:'user-approval', goal: join(dir, 'goal.json') });
 assert.equal(approved.details.state.goal.id, 'g');
 for (const g of [join(other, 'goal.json'), join(dir, '..', 'x.json'), join(dir, 'missing.json'), join(dir, 'bad.json'), 'goal.json']) {
  const g2 = fixture(); g2.ctx.cwd = dir;
  await assert.rejects(() => g2.run({ action:'approve', approvalReference:'user-approval', goal: g }), /goal/i, g);
 }
 const noCwd = fixture();
 await assert.rejects(() => noCwd.run({ action:'approve', approvalReference:'user-approval', goal: join(dir, 'goal.json') }), /session directory/i);
});

test('a malformed phase names the phase and the field to fix', async () => {
 const f = fixture(); const bad: any = { id:'goal', scope:'implementation-and-verification', objective:'x', phases:[{ id:'p1', objective:'parser', cwd:'/repo', allowedPaths:['src/'], acceptance:['a'], verifyCommands:['v'] }] };
 await assert.rejects(() => f.run({ action:'approve', approvalReference:'user-approval', goal: bad }), /phase "p1".*nonGoals.*array of strings/i);
});
