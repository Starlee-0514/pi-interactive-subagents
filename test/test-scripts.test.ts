import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('default test command includes upstream and added offline suites without opting into Zellij', () => {
 assert.equal(scripts.test, 'node --test test/test.ts test/*.test.ts test/integration/phase-worker-lifecycle.test.ts');
 assert.ok(!scripts.test.includes('PI_PHASE_ZELLIJ_TEST=1'));
});
