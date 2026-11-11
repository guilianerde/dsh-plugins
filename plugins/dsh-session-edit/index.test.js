import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { apply } from './index.js';
import { currentSurface } from './surface-edit.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/two-turns.json', import.meta.url)));
function setup() {
  const events = structuredClone(fixture);
  const hooks = new Map(); let route; let queued;
  const session = {
    snapshotEvents: () => structuredClone(events),
    append(type, data, options) { events.push({ seq: events.length, type, data, ...options }); },
  };
  const agent = { id: 'test', status: 'idle', session, inbox: { nextTurn: [], nextStep: [] }, followup(message) { queued = message; } };
  const ctx = {
    on(name, listener) { hooks.set(name, listener); },
    effect(factory) { factory(); },
    connection: { requestRejection: () => undefined },
    webServer: { register(value) { route = value; return () => {}; } },
    sessionQuery: { async readSession() { return { events: structuredClone(events) }; } },
    sessionController: { async resolveAgent() { return { agent }; } },
  };
  apply(ctx);
  async function post(endpoint, payload) {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))]); req.method = 'POST'; req.url = `/session-edit/${endpoint}`;
    let body; const res = { writeHead() {}, end(value) { body = value; } };
    await route.handler(req, res); return JSON.parse(body);
  }
  return { events, hooks, agent, post, get queued() { return queued; } };
}

test('queues an edit on the same session and replaces the old context during the next step', async () => {
  const t = setup();
  const result = await t.post('editMessage', { sessionId: 'test', requestId: 'request-1', eventSeq: 15, text: 'replacement' });
  assert.deepEqual(result, { ok: true, value: { sessionId: 'test', prompted: true } });
  assert.equal(t.events.length, 19);
  assert.equal(t.queued.content[0].text, 'replacement');
  await t.hooks.get('agent/pre-step')({ agent: t.agent, turn: 3, step: 1 }, async () => ({ kind: 'enter', messages: [t.queued] }));
  const signal = new AbortController().signal;
  await t.hooks.get('agent/request')({ agent: t.agent, turn: 3, step: 1, signal }, async () => ({ provider: 'p', model: 'm' }));
  assert.deepEqual(currentSurface(t.events), [4, 5, 8, 19]);
  assert.deepEqual(t.events.at(-1).sourceEventSeqs, [15, 16]);
  t.events.push({ seq: 20, type: 'user/message', data: t.queued, surfaceOp: 'append' });
  const view = await t.post('listMessages', { sessionId: 'test' });
  assert.deepEqual(view.value.hiddenTurns, [2]);
  assert.equal(view.value.messages.at(-1).text, 'replacement');
});

test('refuses running agents and messages with attachments', async () => {
  const t = setup();
  t.agent.status = 'running';
  assert.equal((await t.post('editMessage', { sessionId: 'test', requestId: 'r', eventSeq: 15, text: 'x' })).ok, false);
  t.agent.status = 'idle';
  t.events[15].data.content = [{ type: 'image' }];
  assert.equal((await t.post('editMessage', { sessionId: 'test', requestId: 'r', eventSeq: 15, text: 'x' })).ok, false);
  assert.equal(t.queued, undefined);
});

test('repeated delivery of an accepted edit does not queue it twice', async () => {
  const t = setup();
  const payload = { sessionId: 'test', requestId: 'r', eventSeq: 15, text: 'x' };
  assert.equal((await t.post('editMessage', payload)).ok, true);
  const message = t.queued;
  t.events.push({ seq: 19, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } });
  t.agent.status = 'running';
  assert.equal((await t.post('editMessage', payload)).ok, true);
  assert.equal(t.queued, message);
  assert.equal((await t.post('editMessage', { ...payload, text: 'different' })).ok, false);
});
