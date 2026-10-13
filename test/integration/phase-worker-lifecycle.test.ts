// Explicit opt-in: uniquely owned session, bounded PTY client and fake pi binary.
// No credentials, provider calls, or user-session panes. One attached test client
// gives actual active-tab evidence, not universal multi-client guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from '../../pi-extension/subagents/index.ts';

const enabled = process.env.PI_PHASE_ZELLIJ_TEST === '1';
const wait = async (predicate: () => boolean, ms = 15000) => {
 const end = Date.now() + ms;
 while (Date.now() < end) {
  if (predicate()) return;
  await new Promise(r => setTimeout(r, 100));
 }
 throw new Error('Bounded test wait timed out');
};

test('Zellij launches and resumes a fake managed child in dedicated background tabs', {skip:!enabled, timeout:60000}, async () => {
 const dir = mkdtempSync(join(tmpdir(), 'phase-zellij-'));
 const name = `pi-phase-test-${process.pid}-${Date.now()}`;
 const saved = {...process.env};
 const clean = {...saved};
 delete clean.ZELLIJ; delete clean.ZELLIJ_SESSION_NAME; delete clean.ZELLIJ_PANE_ID;
 const config = join(dir, 'zellij.kdl');
 writeFileSync(config, 'show_startup_tips false\nshow_release_notes false\n');
 const cli = (args:string[]) => execFileSync('zellij', ['--session', name, 'action', ...args], {encoding:'utf8', timeout:10000});
 const panes = () => JSON.parse(cli(['list-panes', '--json', '--geometry', '--state', '--tab']));
 const tabs = () => JSON.parse(cli(['list-tabs', '--json', '--state']));
 const trackedTabs = new Set<number>();
 const focus = () => ({
  focusedTerminals: panes().filter((p:any) => p.is_focused && !p.is_plugin && trackedTabs.has(p.tab_id)).map((p:any) => p.id).sort((a:number,b:number) => a-b),
  tabs: tabs().filter((t:any) => trackedTabs.has(t.tab_id)).map((t:any) => ({id:t.tab_id, active:t.active})).sort((a:any,b:any) => a.id-b.id),
  activeTabs: tabs().filter((t:any) => t.active).map((t:any) => t.tab_id).sort((a:number,b:number) => a-b),
 });
 const sessionIsLive = () => {
  const output = execFileSync('zellij', ['list-sessions', '--no-formatting'], {encoding:'utf8', timeout:10000});
  return output.split('\n').some(line => line.trim().split(/\s+/)[0] === name && !line.includes('EXITED'));
 };
 let started = false;
 let client: ReturnType<typeof spawn> | undefined;
 const handlers = new Map<string,any[]>();
 const messages:any[] = [];
 try {
  console.log(`Owned runtime fixture: ${dir}; session: ${name}`);
  writeFileSync(join(dir, 'ownership.json'), JSON.stringify({session:name, fixture:dir}));
  execFileSync('zellij', ['--config', config, 'attach', '--create-background', name, '--', 'bash', '-c', 'sleep 90'], {env:clean, timeout:10000});
  started = true;
  await wait(() => panes().some((p:any) => !p.is_plugin));
  const terminals = panes().filter((p:any) => !p.is_plugin);
  assert.equal(terminals.length, 1, 'independent fixture must have one unambiguous parent terminal');
  const parent = terminals[0];
  // Attach only the owned fixture using a PTY, never the user's live session.
  client = spawn('python3', ['-u', '-c', `
import os, pty, subprocess, select, time, signal, struct, fcntl, termios, sys
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
env = dict(os.environ, TERM='xterm-256color')
child = subprocess.Popen(['zellij', '--config', sys.argv[2], 'attach', sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
stop = False
def request_stop(*args):
 global stop
 stop = True
signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGINT, request_stop)
deadline = time.monotonic() + 75
try:
 while not stop and child.poll() is None and time.monotonic() < deadline:
  ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
  if sys.stdin in ready:
   sys.stdin.readline()
   break
  if master in ready:
   try: os.read(master, 65536)
   except OSError: break
finally:
 if child.poll() is None:
  child.terminate()
  try: child.wait(timeout=3)
  except subprocess.TimeoutExpired:
   child.kill()
   child.wait(timeout=3)
 os.close(master)
`, name, config], {env:clean, stdio:['pipe','ignore','pipe']});
  client.on('error', () => {}); // wait below fails closed if the PTY client cannot attach.
  await wait(() => tabs().some((t:any) => t.active && t.tab_id === parent.tab_id));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'pi'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const session = args[args.indexOf('--session') + 1];
const run = process.env.PI_SUBAGENT_ID;
fs.writeFileSync(session + '.ready.' + run, JSON.stringify({args, phase:process.env.PI_PHASE_WORKER, parent:process.env.PI_PHASE_PARENT_SESSION, cwd:process.cwd()}));
const deadline = Date.now() + 20000;
const timer = setInterval(() => {
 if (Date.now() > deadline) { clearInterval(timer); console.error('FAKE_CHILD_RELEASE_TIMEOUT'); process.exit(2); }
 if (!fs.existsSync(session + '.release.' + run)) return;
 clearInterval(timer);
 fs.appendFileSync(session, JSON.stringify({type:'message', id:'fake-' + run, message:{role:'assistant',content:[{type:'text',text:'Fake phase report; no provider invoked'}]}}) + '\\n');
 fs.writeFileSync(session + '.exit', JSON.stringify({type:'done'}));
 console.log('FAKE_PHASE_DONE');
}, 50);
`, {mode:0o755});
  const agentDir = join(dir, 'agent');
  const lazyDir = join(agentDir, 'local-packages', 'rpiv-ask-user-question');
  mkdirSync(lazyDir, {recursive:true});
  symlinkSync('/home/starlee/.pi/agent/local-packages/rpiv-ask-user-question/lazy-mode.ts', join(lazyDir, 'lazy-mode.ts'));
  process.env.PATH = bin + ':' + saved.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.ZELLIJ = '0'; process.env.ZELLIJ_SESSION_NAME = name;
  process.env.ZELLIJ_PANE_ID = String(parent.id); process.env.PI_SUBAGENT_MUX = 'zellij';
  const parentFile = join(dir, 'parent.jsonl');
  writeFileSync(parentFile, JSON.stringify({type:'session', version:3, id:'parent', cwd:dir}) + '\n');
  const tools = new Map<string,any>(); const bus = new Map<string,any>();
  const pi:any = {
   on:(n:string,f:any) => { const a=handlers.get(n)??[]; a.push(f); handlers.set(n,a); },
   events:{on:(n:string,f:any) => {bus.set(n,f); return () => bus.delete(n);}, emit:(n:string,x:any) => bus.get(n)?.(x)},
   registerTool:(t:any) => tools.set(t.name,t), registerCommand:() => {}, registerMessageRenderer:() => {},
   sendMessage:(m:any) => messages.push(m), appendEntry:() => {}, getActiveTools:() => ['subagent'], getThinkingLevel:() => 'high',
  };
  const ctx:any = {hasUI:false, cwd:dir, model:{provider:'fake-provider',id:'fake-model'}, sessionManager:{getSessionFile:() => parentFile, getSessionId:() => 'parent', getSessionDir:() => dir, getBranch:() => []}};
  extension(pi);
  for (const f of handlers.get('session_start')??[]) f({},ctx);
  // Setup deliberately puts our test client in another tab; launches must not move it.
  const alternateTab = cli(['new-tab', '--name', 'alternate']).trim();
  cli(['new-pane', '--tab-id', alternateTab, '--no-focus', '--name', 'alternate-anchor', '--', 'bash', '-c', 'sleep 90']);
  await wait(() => panes().filter((p:any) => !p.is_plugin).length >= 2);
  for (const t of tabs()) trackedTabs.add(t.tab_id);
  const beforeLaunch = focus();
  assert.deepEqual(beforeLaunch.activeTabs, [Number(alternateTab)], 'client is viewing an unrelated fixture tab');
  assert.ok(beforeLaunch.tabs.every((t:any) => Number.isInteger(t.id) && typeof t.active === 'boolean'), JSON.stringify(tabs()));
  const c = {kind:'phase-contract', version:1, goalId:'g', phaseId:'p', attemptId:'a', parentSessionId:'parent', objective:'fake task', cwd:dir, allowedPaths:['src/'], acceptance:['ok'], verifyCommands:['node --test'], nonGoals:[], authorizationReference:'human', provider:'fake-provider', modelId:'fake-model', thinking:'high', deadlineMs:Date.now()+60000};
  const result = await tools.get('subagent').execute('test', {agent:'phase-worker', name:'offline-child', task:JSON.stringify(c)}, undefined, undefined, ctx);
  const session = result.details.sessionFile;
  await wait(() => existsSync(session + '.ready.' + result.details.id));
  const children = panes().filter((p:any) => !p.is_plugin && p.title === 'offline-child');
  assert.equal(children.length, 1); assert.notEqual(children[0].tab_id, parent.tab_id);
  const launchTabId = children[0].tab_id;
  assert.match(children[0].tab_name, /^subagents-\d+$/);
  assert.equal(tabs().find((t:any) => t.tab_id === launchTabId).active, false);
  assert.deepEqual(focus(), beforeLaunch);
  const checkArgv = (id:string) => {
   const argv = JSON.parse(readFileSync(session + '.ready.' + id, 'utf8'));
   assert.equal(argv.phase, '1'); assert.equal(argv.parent, 'parent'); assert.equal(argv.cwd, dir);
   assert.equal(argv.args[argv.args.indexOf('--model')+1], 'fake-provider/fake-model');
   assert.equal(argv.args[argv.args.indexOf('--thinking')+1], 'high');
   assert.ok(argv.args.includes('--no-extensions')); assert.ok(argv.args.includes('--no-mcp'));
   assert.equal(argv.args[argv.args.indexOf('--tools')+1], 'read,grep,find,ls,write,edit,bash,caller_ping');
  };
  checkArgv(result.details.id);
  writeFileSync(session + '.release.' + result.details.id, 'release');
  await wait(() => messages.some(m => m.customType === 'subagent_result'));
  assert.equal(messages.find(m => m.customType === 'subagent_result').details.exitCode, 0);
  await wait(() => !tabs().some((t:any) => t.tab_id === launchTabId));
  assert.deepEqual(focus(), beforeLaunch);
  // Resume must use a background tab even when parent split/stack space is insufficient.
  process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS = '1000';
  const beforeResume = focus();
  ctx.model = {provider:'different',id:'different'}; pi.getThinkingLevel = () => 'low'; messages.length = 0;
  const resumed = await tools.get('subagent_resume').execute('resume', {sessionPath:session, name:'offline-resume', message:'Follow up'}, undefined, undefined, ctx);
  assert.equal(resumed.details.agent, 'phase-worker');
  await wait(() => existsSync(session + '.ready.' + resumed.details.id));
  const resumedPanes = panes().filter((p:any) => !p.is_plugin && p.title === 'offline-resume');
  assert.equal(resumedPanes.length, 1, JSON.stringify(panes()));
  assert.notEqual(resumedPanes[0].tab_id, parent.tab_id);
  const resumeTabId = resumedPanes[0].tab_id;
  assert.match(resumedPanes[0].tab_name, /^subagents-\d+$/);
  assert.equal(tabs().find((t:any) => t.tab_id === resumeTabId).active, false);
  assert.deepEqual(focus(), beforeResume);
  checkArgv(resumed.details.id);
  writeFileSync(session + '.release.' + resumed.details.id, 'release');
  await wait(() => messages.some(m => m.customType === 'subagent_result'));
  assert.equal(messages.find(m => m.customType === 'subagent_result').details.exitCode, 0);
  await wait(() => !tabs().some((t:any) => t.tab_id === resumeTabId));
  assert.deepEqual(focus(), beforeResume);
  assert.ok(existsSync(session + '.loadout.json'));
  const afterResume = focus();
  // Simulate a human intentionally inspecting the worker, only in our owned session.
  // Completion must not close that tab or force this client back to another tab.
  messages.length = 0;
  const viewed = await tools.get('subagent_resume').execute('viewed', {sessionPath:session, name:'viewed-worker', message:'Inspection fixture'}, undefined, undefined, ctx);
  await wait(() => existsSync(session + '.ready.' + viewed.details.id));
  const inspected = panes().filter((p:any) => !p.is_plugin && p.title === 'viewed-worker');
  assert.equal(inspected.length, 1);
  cli(['go-to-tab-name', inspected[0].tab_name]);
  await wait(() => tabs().some((t:any) => t.tab_id === inspected[0].tab_id && t.active));
  const viewedFocus = () => ({...focus(), workerFocusedTerminals:panes().filter((p:any) => !p.is_plugin && p.tab_id === inspected[0].tab_id && p.is_focused).map((p:any) => p.id)});
  const beforeViewedCompletion = viewedFocus();
  assert.equal(beforeViewedCompletion.workerFocusedTerminals.length, 1);
  checkArgv(viewed.details.id);
  writeFileSync(session + '.release.' + viewed.details.id, 'release');
  await wait(() => messages.some(m => m.customType === 'subagent_result'));
  assert.equal(messages.find(m => m.customType === 'subagent_result').details.exitCode, 0);
  assert.deepEqual(viewedFocus(), beforeViewedCompletion);
  assert.ok(tabs().some((t:any) => t.tab_id === inspected[0].tab_id && t.active));
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify({beforeLaunch, beforeResume, afterResume, beforeViewedCompletion, afterViewedCompletion:viewedFocus(), mode:'one owned PTY client; background launch/resume/completion and viewed-tab retention verified'}));
  console.log('Fake launch/resume preserve attached test-client focus; viewed worker tab is retained on completion. No provider calls.');
 } catch (error) {
  if (started && sessionIsLive()) console.log(JSON.stringify({session:name, panes:panes(), tabs:tabs(), messages}));
  throw error;
 } finally {
  try {
   if (client && client.exitCode === null) {
    const exited = new Promise<void>((resolve,reject) => {
     const timer = setTimeout(() => { client?.kill('SIGTERM'); reject(new Error('Owned PTY client did not stop within timeout')); }, 10000);
     client!.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    client.stdin?.end('stop\n');
    await exited;
   }
   for (const f of handlers.get('session_shutdown')??[]) f({},{});
   if (started && sessionIsLive()) {
    // Every resource in this unique, unattached fixture session was created here.
    const ownedTabs = tabs().map((t:any) => t.id ?? t.tab_id);
    for (const p of panes().filter((p:any) => !p.is_plugin)) {
     if (!sessionIsLive()) break;
     cli(['close-pane', '--pane-id', `terminal_${p.id}`]);
    }
    for (const id of ownedTabs) {
     if (!sessionIsLive()) break;
     assert.ok(Number.isInteger(id), 'refuse ambiguous tab cleanup');
     cli(['close-tab', '--tab-id', String(id)]);
    }
   }
   if (started) {
    await wait(() => !sessionIsLive(), 5000);
    writeFileSync(join(dir, 'cleanup.json'), JSON.stringify({session:name, live:false}));
    console.log(`Cleanup verified: owned session ${name} is no longer live.`);
   }
  } finally {
   for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
   Object.assign(process.env, saved);
  }
 }
});
