import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { currentSurface, editRange } from './surface-edit.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/two-turns.json', import.meta.url)));

test('editing the first or second message includes every later surface node', () => {
  const events = structuredClone(fixture);
  events.push({ seq: 19, type: 'tool/result', surfaceOp: 'append', data: {} });
  assert.deepEqual(editRange(events, 15).removed, [15, 16, 19]);
  assert.deepEqual(editRange(events, 5).removed, [5, 8, 15, 16, 19]);
});

test('repeated edits operate on the current surface, not shadowed history', () => {
  const events = structuredClone(fixture);
  events.push({ seq: 19, type: 'user/message', data: { role: 'user', id: 'edit', source: { kind: 'user' }, content: [{ type: 'text', text: 'edited' }] }, surfaceOp: { op: 'replace', startSeq: 15, endSeq: 16 }, sourceEventSeqs: [15, 16] });
  assert.deepEqual(currentSurface(events), [4, 5, 8, 19]);
  assert.deepEqual(editRange(events, 19).removed, [19]);
  assert.throws(() => editRange(events, 15), /no longer/);
});

test('rejects unsupported content and invalid replacement history', () => {
  const events = structuredClone(fixture);
  events[15].data.content = [{ type: 'image' }];
  assert.throws(() => editRange(events, 15), /text/);
  events.push({ seq: 19, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 15, endSeq: 16 }, sourceEventSeqs: [15] });
  assert.throws(() => currentSurface(events), /Incomplete/);
});
