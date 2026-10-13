import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mux from '../pi-extension/subagents/cmux.ts';

test('Zellij background creation targets an explicit tab and never changes focus', () => {
 assert.equal(typeof mux.buildZellijBackgroundPaneArgs, 'function');
 const tiled = mux.buildZellijBackgroundPaneArgs('worker', 4, '/repo');
 assert.deepEqual(tiled, ['new-pane', '--tab-id', '4', '--no-focus', '--name', 'worker', '--cwd', '/repo']);
 const stacked = mux.buildZellijBackgroundPaneArgs('worker', 4, '/repo', 'terminal_9', ['node', 'launch script.js']);
 assert.deepEqual(stacked, ['new-pane', '--tab-id', '4', '--no-focus', '--name', 'worker', '--cwd', '/repo', '--stacked', '--', 'node', 'launch script.js']);
 assert.ok(!stacked.includes('--floating'));
 assert.ok(!stacked.includes('--near-current-pane'), 'Zellij 0.45.1 rejects near-current-pane combined with tab-id');
 assert.throws(() => mux.buildZellijBackgroundPaneArgs('worker', 4, '/repo', 'plugin_9'), /terminal/i);
 assert.throws(() => mux.buildZellijBackgroundPaneArgs('x', NaN, '/repo'), /tab/i);
});

function fakeZellij() {
 const tabs = new Map<number, { name: string; active: boolean; others: number[] }>();
 let panes: any[] = [{ id: 0, is_plugin: false, tab_id: 1 }];
 let nextTab = 7, nextTerm = 9;
 const calls: string[][] = [];
 const run = (args: string[]) => {
  calls.push(args);
  if (args[0] === 'new-tab') { const id = nextTab++; tabs.set(id, { name: args[args.indexOf('--name') + 1], active: false, others: [] }); panes.push({ id: nextTerm++, is_plugin: false, tab_id: id }); return String(id); }
  if (args[0] === 'new-pane') { const tab = Number(args[args.indexOf('--tab-id') + 1]); const id = nextTerm++; panes.push({ id, is_plugin: false, tab_id: tab }); return `terminal_${id}`; }
  if (args[0] === 'list-panes') return JSON.stringify([{ id: 9, is_plugin: true, tab_id: 7 }, ...panes]);
  if (args[0] === 'list-tabs') return JSON.stringify([...tabs].map(([tab_id, t]) => ({ tab_id, name: t.name, active: t.active, other_focused_clients: t.others })));
  if (args[0] === 'close-pane') { const id = Number(/terminal_(\d+)/.exec(args[args.indexOf('--pane-id') + 1])![1]); panes = panes.filter(p => p.id !== id); return ''; }
  if (args[0] === 'close-tab') { const id = Number(args[args.indexOf('--tab-id') + 1]); tabs.delete(id); panes = panes.filter(p => p.tab_id !== id); return ''; }
  return '';
 };
 return { run, calls, tabs, addHumanTerminal: (tab: number) => panes.push({ id: nextTerm++, is_plugin: false, tab_id: tab }), paneIds: (tab: number) => panes.filter(p => p.tab_id === tab).map(p => p.id) };
}

test('workers share one background tab until it is full, then overflow to a new tab', () => {
 const z = fakeZellij();
 const a = mux.createZellijWorkerTab('a', '/repo', ['bash', 'a.sh'], z.run, 2);
 const b = mux.createZellijWorkerTab('b', '/repo', ['bash', 'b.sh'], z.run, 2);
 const c = mux.createZellijWorkerTab('c', '/repo', ['bash', 'c.sh'], z.run, 2);
 const newTabs = z.calls.filter(x => x[0] === 'new-tab');
 assert.equal(newTabs.length, 2, 'two tabs for three workers at capacity 2');
 assert.match(newTabs[0][newTabs[0].indexOf('--name') + 1], /^subagents-\d+$/);
 const panesIn = (tab: number) => z.calls.filter(x => x[0] === 'new-pane' && x[x.indexOf('--tab-id') + 1] === String(tab));
 assert.equal(panesIn(7).length, 2);
 assert.equal(panesIn(8).length, 1);
 assert.ok(z.calls.every(x => x[0] !== 'new-pane' || (x.includes('--no-focus') && !x.includes('--stacked'))));
 assert.ok(!z.calls.some(x => ['go-to-tab', 'move-focus', 'write-chars'].includes(x[0])));
 assert.deepEqual([a, b, c].map(x => x.startsWith('pane:')), [true, true, true]);
});

test('finished workers close only their own pane; viewed or human-used panes are preserved', () => {
 const z = fakeZellij();
 const a = mux.createZellijWorkerTab('a', '/repo', ['bash', 'a.sh'], z.run, 2);
 const b = mux.createZellijWorkerTab('b', '/repo', ['bash', 'b.sh'], z.run, 2);
 z.tabs.get(7)!.active = true;
 assert.equal(mux.closeZellijWorkerTab(a, z.run), false, 'preserve a tab being viewed');
 z.tabs.get(7)!.active = false; z.tabs.get(7)!.others = [2];
 assert.equal(mux.closeZellijWorkerTab(a, z.run), false, 'preserve another client focus');
 z.tabs.get(7)!.others = [];
 assert.equal(mux.closeZellijWorkerTab(a, z.run), true);
 assert.ok(z.calls.some(x => x[0] === 'close-pane' && x[x.indexOf('--pane-id') + 1] === a.replace('pane:', 'terminal_')));
 assert.ok(!z.calls.some(x => x[0] === 'close-tab'), 'tab stays while another worker is alive');
 assert.ok(z.paneIds(7).includes(Number(b.slice(5))), 'other worker pane untouched');
 z.addHumanTerminal(7);
 assert.equal(mux.closeZellijWorkerTab(b, z.run), true);
 assert.ok(!z.calls.some(x => x[0] === 'close-tab'), 'a human-added terminal keeps the tab');
});

test('the tab closes after its last worker pane when only its own anchor remains', () => {
 const z = fakeZellij();
 const a = mux.createZellijWorkerTab('a', '/repo', ['bash', 'a.sh'], z.run, 2);
 assert.equal(mux.closeZellijWorkerTab(a, z.run), true);
 assert.deepEqual(z.calls.at(-1), ['close-tab', '--tab-id', '7']);
 const b = mux.createZellijWorkerTab('b', '/repo', ['bash', 'b.sh'], z.run, 2);
 assert.equal(z.calls.filter(x => x[0] === 'new-tab').length, 2, 'a closed tab is not reused');
 assert.ok(b.startsWith('pane:'));
});

test('terminal IDs are explicit and parent tab lookup fails closed on ambiguous IDs', () => {
 assert.equal(typeof mux.resolveZellijParentTab, 'function');
 assert.equal(mux.resolveZellijParentTab([{ id: 1, is_plugin: true, tab_id: 8 }, { id: 1, is_plugin: false, tab_id: 4 }], 1), 4);
 assert.throws(() => mux.resolveZellijParentTab([], 1), /parent/i);
 assert.throws(() => mux.resolveZellijParentTab([{ id: 1, tab_id: 4 }, { id: 1, tab_id: 5 }], 1), /parent/i);
 assert.equal(mux.zellijTerminalSurface('pane:9'), 'terminal_9');
 assert.equal(mux.zellijTerminalSurface('terminal_9'), 'terminal_9');
 assert.throws(() => mux.zellijTerminalSurface('plugin_9'), /terminal/i);
});
