// Fold the host's positional surface operations without changing the log.
const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

export function currentSurface(events) {
  const nodes = [];
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) throw new Error('The session log is not contiguous.');
    if (!surfaceTypes.has(event.type)) continue;
    if (event.surfaceOp === 'append') {
      nodes.push(event.seq);
      continue;
    }
    const op = event.surfaceOp;
    if (!op || op.op !== 'replace') throw new Error('Invalid surface operation.');
    const start = nodes.indexOf(op.startSeq);
    const end = nodes.indexOf(op.endSeq);
    if (start < 0 || end < start) throw new Error('Invalid surface replacement range.');
    const removed = nodes.slice(start, end + 1);
    if (!Array.isArray(event.sourceEventSeqs) || removed.some((seq) => !event.sourceEventSeqs.includes(seq))) {
      throw new Error('Incomplete surface replacement.');
    }
    nodes.splice(start, removed.length, event.seq);
  }
  return nodes;
}

export function editRange(events, eventSeq) {
  const nodes = currentSurface(events);
  const index = nodes.indexOf(eventSeq);
  const event = events[eventSeq];
  if (index < 0 || event?.type !== 'user/message' || event.data?.source?.kind !== 'user') {
    throw new Error('The message is no longer in the current context.');
  }
  const content = event.data.content;
  if (!Array.isArray(content) || !content.length || content.some((part) => part.type !== 'text' || typeof part.text !== 'string')) {
    throw new Error('Only text messages can be edited.');
  }
  const removed = nodes.slice(index);
  return { event, removed, startSeq: removed[0], endSeq: removed.at(-1) };
}
