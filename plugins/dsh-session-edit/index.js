import { randomUUID } from 'node:crypto';
import { currentSurface, editRange } from './surface-edit.js';

export const name = '@local/session-edit';
export const inject = ['connection', 'sessionController', 'sessionQuery', 'webServer'];
const CHANNEL = '/session-edit';
const MARKER = 'dsh-session-edit';
const failure = (code, message) => ({ ok: false, error: { code, message } });
const success = (value) => ({ ok: true, value });

export function apply(ctx) {
  const pending = new Map();

  // The host opens a turn before this hook and opens its step immediately
  // afterwards. Retain the queued edit until the request hook can safely write
  // the replacement within that step.
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const edits = decision.messages.filter((message) => message.source?.sessionEdit?.targetSeq !== undefined);
    if (!edits.length) return decision;
    if (edits.length !== 1 || decision.messages.filter((m) => m.source?.kind === 'user').length !== 1) {
      throw new Error('An edit cannot run together with another user message.');
    }
    pending.set(`${agent.id}:${turn}:${step}`, edits[0]);
    return decision;
  });

  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const config = await next();
    const key = `${agent.id}:${turn}:${step}`;
    const message = pending.get(key);
    if (!message) return config;
    signal.throwIfAborted();
    const session = agent.session;
    const events = session.snapshotEvents();
    const range = editRange(events, message.source.sessionEdit.targetSeq);
    // A blank system surface node has no model message. This is written inside
    // the open step, where the host's lifecycle validator permits it. The normal
    // queued user message is appended by the agent immediately afterwards.
    session.append('system/message', {
      turn, step,
      message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt', sessionEdit: MARKER }, content: [] },
    }, {
      surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
      sourceEventSeqs: range.removed,
    });
    pending.delete(key);
    return config;
  });

  async function snapshot(sessionId) {
    const result = await ctx.sessionQuery.readSession(sessionId);
    return result.events;
  }

  function view(events) {
    const hiddenTurns = new Set();
    let currentTurn;
    const turns = new Map();
    for (const event of events) {
      if (event.type === 'turn/start') currentTurn = event.data.turn;
      turns.set(event.seq, currentTurn);
      if (event.type === 'turn/end') currentTurn = undefined;
      if (event.type === 'system/message' && event.data?.message?.source?.sessionEdit === MARKER && event.surfaceOp?.op === 'replace') {
        const start = turns.get(event.surfaceOp.startSeq);
        const end = event.data.turn;
        for (let turn = start; Number.isSafeInteger(turn) && turn < end; turn += 1) hiddenTurns.add(turn);
      }
    }
    return { hiddenTurns: [...hiddenTurns] };
  }

  async function dispatch(endpoint, payload) {
    try {
      if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId) throw new Error('Missing session id.');
      if (endpoint === 'listMessages') {
        const events = await snapshot(payload.sessionId);
        const messages = [];
        for (const seq of currentSurface(events)) {
          const event = events[seq];
          if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
          const content = event.data.content;
          if (!Array.isArray(content) || !content.length || content.some((part) => part.type !== 'text' || typeof part.text !== 'string')) continue;
          messages.push({ eventSeq: event.seq, messageId: event.data.id, text: content.map((part) => part.text).join(''), editable: true });
        }
        return success({ messages, ...view(events) });
      }
      if (endpoint !== 'editMessage') return failure('UNKNOWN_ENDPOINT', 'Unknown endpoint.');
      if (!Number.isSafeInteger(payload.eventSeq) || typeof payload.requestId !== 'string' || !payload.requestId || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 100000) throw new Error('Invalid edit request.');
      const resolved = await ctx.sessionController.resolveAgent(payload.sessionId);
      if (resolved.error) throw resolved.error;
      const agent = resolved.agent;
      const events = agent.session.snapshotEvents();
      const existing = events.flatMap((event) => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
        .find((message) => message?.source?.rpcId === payload.requestId);
      if (existing) {
        if (existing.source.sessionEdit?.targetSeq !== payload.eventSeq || existing.content?.[0]?.text !== payload.text) throw new Error('The request id was already used for a different message.');
        return success({ sessionId: payload.sessionId, prompted: true });
      }
      if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('Wait for the current work and queue to finish.');
      editRange(events, payload.eventSeq);
      // Refuse edits in the middle of one turn: page filtering is turn based.
      let turnStart = payload.eventSeq;
      while (turnStart > 0 && events[turnStart].type !== 'turn/start') turnStart--;
      if (events.slice(turnStart, payload.eventSeq).some((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')) throw new Error('Editing a later message within one turn is not supported.');
      const message = {
        id: randomUUID(), role: 'user',
        source: { kind: 'user', rpcId: payload.requestId, sessionEdit: { targetSeq: payload.eventSeq } },
        content: [{ type: 'text', text: payload.text }],
      };
      agent.followup(message);
      return success({ sessionId: payload.sessionId, prompted: true });
    } catch (error) {
      return failure('EDIT_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: CHANNEL,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const endpoint = new URL(req.url ?? '/', 'http://localhost').pathname.slice(CHANNEL.length + 1);
      if (!/^[A-Za-z]+$/.test(endpoint)) { res.writeHead(404); res.end(); return; }
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error('Request is too large.');
          chunks.push(chunk);
        }
        const result = await dispatch(endpoint, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure('INVALID_REQUEST', String(error))));
      }
    },
  }), 'session-edit channel');
}
