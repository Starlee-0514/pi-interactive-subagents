import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = process.env.PI_TEST_PACKAGE_ROOT ?? resolve(dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent');
const require = createRequire(join(root,'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { alias: {
 '@mariozechner/pi-coding-agent': join(root,'dist/index.js'), '@mariozechner/pi-tui': require.resolve('@earendil-works/pi-tui'),
 '@sinclair/typebox': require.resolve('typebox'), '@earendil-works/pi-coding-agent': join(root,'dist/index.js'),
 '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'), typebox: require.resolve('typebox'),
} });
const lazyModule = resolve('/home/starlee/.pi/agent/local-packages/rpiv-ask-user-question/lazy-mode.ts');
function mock() {
 const handlers = new Map<string, any[]>(); const commands = new Map<string,any>(); const tools = new Map<string,any>(); const bus = new Map<string,any>();
 const entries:any[] = [{ type:'custom',customType:'ask-user-question-lazy-state',data:{enabled:true} }];
 let active = ['read','ask_user_question','subagent'];
 const pi:any = { on:(n:string,f:any)=>{ const a=handlers.get(n)??[];a.push(f);handlers.set(n,a); },
  events:{on:(n:string,f:any)=>{bus.set(n,f);return()=>bus.delete(n);},emit:(n:string,x:any)=>bus.get(n)?.(x)},
  registerCommand:(n:string,c:any)=>commands.set(n,c),registerTool:(t:any)=>tools.set(t.name,t),registerMessageRenderer:()=>{},registerShortcut:()=>{},
  appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data}),sendMessage:()=>{},getActiveTools:()=>active,setActiveTools:(v:string[])=>{active=v;},getAllTools:()=>[],getThinkingLevel:()=> 'medium' };
 const ctx:any = { hasUI:true,mode:'tui',isIdle:()=>true,ui:{notify:()=>{},setStatus:()=>{},setWidget:()=>{}},sessionManager:{getBranch:()=>entries,getSessionId:()=> 'child'} };
 const fire=(n:string,event:any={})=>{let result;for(const f of handlers.get(n)??[])result=f(event,ctx)??result;return result;};
 return {pi,ctx,fire,commands,tools,entries,active:()=>active};
}

test('Pi 1.1 loader registers the opt-in package without launching models or child processes', async () => {
 const extension = await jiti.import('../pi-extension/subagents/index.ts',{default:true});
 const s = mock(); extension(s.pi);
 for(const name of ['subagent','subagent_resume','subagent_interrupt','phase_control']) assert.ok(s.tools.has(name));
});

test('managed child uses the real lazy owner and blocks direct human UI, spawning and out-of-contract writes', async () => {
 const { registerPhaseWorker } = await jiti.import('../pi-extension/subagents/phase-worker-context.ts');
 const dir=mkdtempSync(join(tmpdir(),'phase-bootstrap-'));mkdirSync(join(dir,'src'));
 const c = {kind:'phase-contract',version:1,goalId:'g',phaseId:'p',attemptId:'a',parentSessionId:'parent',objective:'task',cwd:dir,allowedPaths:['src/'],acceptance:['ok'],verifyCommands:['node --test'],nonGoals:[],authorizationReference:'human',provider:'p',modelId:'m',thinking:'medium',deadlineMs:Date.now()+60000};
 const path=join(dir,'contract.json');writeFileSync(path,JSON.stringify(c));
 const s=mock();const child=await registerPhaseWorker(s.pi,{PI_PHASE_WORKER:'1',PI_SUBAGENT_AGENT:'phase-worker',PI_SUBAGENT_ID:'run',PI_PHASE_PARENT_SESSION:'parent',PI_PHASE_CONTRACT:path,PI_PHASE_LAZY_MODULE:lazyModule},(p:string)=>jiti.import(p));
 s.fire('session_start');assert.equal(child.mode.isEnabled(),false);
 await s.commands.get('lazy').handler('on',s.ctx);assert.equal(child.mode.isEnabled(),false);
 assert.ok(!s.active().includes('ask_user_question'));assert.ok(!s.active().includes('subagent'));
 const prompt={systemPromptOptions:{sections:{existing:'keep'}}};s.fire('before_agent_start',prompt);
 assert.equal(prompt.systemPromptOptions.sections.existing,'keep');assert.match(prompt.systemPromptOptions.sections.phase_worker,/LAZY_MODE=off/);
 assert.equal(s.fire('tool_call',{toolName:'caller_ping',input:{message:'help'}}),undefined);
 for(const name of ['ask_user_question','subagent','subagent_done']) assert.equal(s.fire('tool_call',{toolName:name,input:{}}).block,true);
 assert.equal(s.fire('tool_call',{toolName:'write',input:{path:'src/new.ts'}}),undefined);
 assert.equal(s.fire('tool_call',{toolName:'write',input:{path:'../outside.ts'}}).block,true);
 const outside=mkdtempSync(join(tmpdir(),'phase-outside-'));symlinkSync(outside,join(dir,'src','escape'));
 assert.equal(s.fire('tool_call',{toolName:'edit',input:{path:'src/escape/file.ts'}}).block,true);
 assert.equal(s.fire('tool_call',{toolName:'bash',input:{command:'git push'}}).block,true);
 assert.equal(s.fire('tool_call',{toolName:'bash',input:{command:'node --test',timeout:30}}),undefined);
});

test('resume retains the original loadout; missing or malformed marked snapshots never become unrestricted', async () => {
 const { writeManagedPhaseSnapshot,readManagedPhaseSnapshot }=await jiti.import('../pi-extension/subagents/session.ts');
 const dir=mkdtempSync(join(tmpdir(),'phase-resume-'));const path=join(dir,'child.jsonl');
 writeFileSync(path,JSON.stringify({type:'session',version:3,id:'child'})+'\n');
 const c={kind:'phase-contract',version:1,goalId:'g',phaseId:'p',attemptId:'a',parentSessionId:'parent',objective:'task',cwd:dir,allowedPaths:['src/'],acceptance:['ok'],verifyCommands:['node --test'],nonGoals:[],authorizationReference:'human',provider:'p',modelId:'original',thinking:'high',deadlineMs:Date.now()+60000};
 writeManagedPhaseSnapshot(path,{contract:c,body:'role',agentDir:'/config',lazyModule,piExecutable:'/usr/bin/pi'});
 assert.equal(readManagedPhaseSnapshot(path).contract.modelId,'original');
 unlinkSync(path+'.loadout.json');
 assert.throws(()=>readManagedPhaseSnapshot(path),/missing loadout/);
 writeFileSync(path+'.loadout.json',JSON.stringify({contract:c}));assert.throws(()=>readManagedPhaseSnapshot(path),/Invalid/);
});
