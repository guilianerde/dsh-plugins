import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const executable = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const moduleUrl = 'file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';

test('the host can restore an edited session', { skip: !existsSync(executable) }, () => {
  const script = `
    import { readFileSync } from 'node:fs';
    import { Session } from ${JSON.stringify(moduleUrl)};
    const events = JSON.parse(readFileSync(${JSON.stringify(new URL('./fixtures/two-turns.json', import.meta.url).pathname)}, 'utf8'));
    events.push({ seq: 19, type: 'turn/start', time: 1, data: { turn: 3 } });
    events.push({ seq: 20, type: 'step/start', time: 1, data: { turn: 3, step: 1 } });
    events.push({ seq: 21, type: 'system/message', time: 1,
      data: { turn: 3, step: 1, message: { id: 'edit-marker', role: 'system', source: { kind: 'system-prompt', sessionEdit: 'dsh-session-edit' }, content: [] } },
      surfaceOp: { op: 'replace', startSeq: 15, endSeq: 16 }, sourceEventSeqs: [15, 16] });
    Session.create('restore-test', events);
  `;
  const result = spawnSync(executable, ['--input-type=module', '-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
