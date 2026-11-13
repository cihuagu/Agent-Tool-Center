import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiChatState, normalizeHookInput, validateHookEvent } from '../src/multi-chat-state.mjs';

const session = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const turn = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const next = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const time = '2026-11-11T00:00:00.000Z';
const event = (name, overrides = {}) => ({
  sessionId: session, project: 'project', event: name, turnId: turn,
  toolName: null, toolUseId: null, at: time, subagent: false, ...overrides,
});

test('normalization rejects invalid metadata and discards private input', () => {
  const raw = { session_id: session, cwd: 'C:\\private\\project', hook_event_name: 'UserPromptSubmit',
    turn_id: turn, prompt: 'secret', transcript_path: 'secret', tool_input: { secret: 1 } };
  const result = normalizeHookInput(raw, () => new Date(time));
  assert.equal(result.project, 'project');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(validateHookEvent({ ...result, command: 'secret' }), false);
  assert.equal(normalizeHookInput({ ...raw, session_id: 'bad' }), null);
  assert.equal(normalizeHookInput({ ...raw, cwd: 'C:\\bad\u0000name' }), null);
  assert.equal(normalizeHookInput({ ...raw, tool_name: 'x'.repeat(129) }), null);
});

test('old and subagent completions cannot end a newer turn', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  state.accept(event('UserPromptSubmit'));
  state.accept(event('UserPromptSubmit', { turnId: next }));
  state.accept(event('Stop'));
  state.accept(event('Stop', { turnId: next, subagent: true }));
  state.accept(event('SessionStart', { turnId: null }));
  state.accept(event('SessionEnd', { turnId: null }));
  state.accept(event('SessionEnd'));
  state.accept(event('SessionEnd', { turnId: next, subagent: true }));
  state.accept(event('UserPromptSubmit'));
  assert.equal(state.snapshot().sessions[0].turnId, next);
  assert.equal(state.snapshot().sessions[0].status, 'running');
  assert.equal(state.accept(event('SubagentStop')), false);
});

test('a turnless session end closes only its own stopped session', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  const other = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const current = (id) => state.snapshot().sessions.find((item) => item.sessionId === id);

  state.accept(event('UserPromptSubmit'));
  state.accept(event('UserPromptSubmit', { sessionId: other, project: 'other' }));
  state.accept(event('Stop'));
  state.accept(event('Stop', { sessionId: other, project: 'other' }));
  state.accept(event('SessionEnd', { turnId: null }));
  assert.equal(current(session).status, 'ended');
  assert.equal(current(session).turnId, turn);
  assert.equal(current(other).status, 'idle');
  assert.equal(current(other).turnId, turn);
  state.accept(event('SessionEnd', { sessionId: other, project: 'other', turnId: null }));
  assert.equal(current(other).status, 'ended');
});

test('turnless session ends remain distinct across a continuous session lifecycle', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  const at = (increment) => new Date(Date.parse(time) + increment).toISOString();
  const current = () => state.snapshot().sessions[0];

  state.accept(event('UserPromptSubmit', { at: at(0) }));
  state.accept(event('SessionEnd', { turnId: null, at: at(1) }));
  assert.equal(current().status, 'running');

  state.accept(event('Stop', { at: at(2) }));
  const firstEnd = event('SessionEnd', { turnId: null, at: at(3) });
  state.accept(firstEnd);
  assert.equal(current().status, 'ended');
  const endedSnapshot = state.snapshot();
  state.accept(firstEnd);
  assert.deepEqual(state.snapshot(), endedSnapshot);

  state.accept(event('UserPromptSubmit', { turnId: next, at: at(4) }));
  assert.equal(current().status, 'running');
  state.accept(event('Stop', { turnId: next, at: at(5) }));
  assert.equal(current().status, 'idle');
  state.accept(event('SessionEnd', { turnId: null, at: at(6) }));
  assert.equal(current().status, 'ended');
  assert.equal(current().turnId, next);
});

test('cold-join tool metadata is visible without inventing a current task', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  const other = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const current = (id = session) => state.snapshot().sessions.find((item) => item.sessionId === id);
  const assertCard = (toolName, toolUseId) => {
    const card = current();
    assert.equal(card.status, 'unknown');
    assert.equal(card.turnId, null);
    assert.equal(card.toolName, toolName);
    assert.equal(card.toolUseId, toolUseId);
    assert.equal('startedAt' in card, false);
    assert.equal('taskName' in card, false);
  };

  state.accept(event('SessionStart', { sessionId: other, turnId: null }));
  state.accept(event('PreToolUse', { toolName: 'first/tool', toolUseId: 'call-1' }));
  assertCard('first/tool', 'call-1');
  assert.equal(current(other).toolName, null);
  assert.equal(current(other).toolUseId, null);
  state.accept(event('PostToolUse', { toolName: 'first/tool', toolUseId: null }));
  assertCard('first/tool', null);
  state.accept(event('PermissionRequest', { toolName: 'permission/tool', toolUseId: 'call-2' }));
  assertCard('permission/tool', 'call-2');
  assert.equal(current(other).status, 'connected');
  assert.equal(current(other).turnId, null);
  assert.equal(current(other).toolName, null);
  assert.equal(current(other).toolUseId, null);

  state.accept(event('UserPromptSubmit', { turnId: next }));
  state.accept(event('PreToolUse', { turnId: next, toolName: 'normal/tool', toolUseId: 'call-3' }));
  assert.equal(current().status, 'tool_running');
  assert.equal(current().turnId, next);
  assert.equal(current().toolName, 'normal/tool');
  assert.equal(current().toolUseId, 'call-3');
  state.accept(event('PostToolUse', { turnId: next, toolName: 'normal/tool', toolUseId: 'call-3' }));
  assert.equal(current().status, 'running');
});

for (const status of ['idle', 'interrupted', 'ended']) {
  for (const name of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
    test(`${status}: unanchored root ${name} shows metadata with unknown/null association`, () => {
      const state = createMultiChatState({ clock: () => new Date(time) });
      let tick = 0;
      const send = (name, overrides = {}) => state.accept(event(name, {
        ...overrides, at: new Date(Date.parse(time) + tick++).toISOString(),
      }));
      const card = () => {
        const { status, turnId, toolName, toolUseId } = state.snapshot().sessions[0];
        return { status, turnId, toolName, toolUseId };
      };

      send('UserPromptSubmit');
      send(status === 'interrupted' ? 'Interrupt' : 'Stop');
      if (status === 'ended') send('SessionEnd', { turnId: null });
      const closedCard = { status, turnId: turn, toolName: null, toolUseId: null };
      assert.deepEqual(card(), closedCard);
      send(name, {
        turnId: next, subagent: true, toolName: 'subagent/tool', toolUseId: 'sub-call',
      });
      assert.deepEqual(card(), closedCard);

      send(name, { turnId: next, toolName: 'new/tool', toolUseId: 'new-call' });
      const unassociated = {
        status: 'unknown', turnId: null, toolName: 'new/tool', toolUseId: 'new-call',
      };
      assert.deepEqual(card(), unassociated);
      assert.equal(state.snapshot().sessions[0].history.filter(
        (item) => item.event === 'UserPromptSubmit',
      ).length, 1);

      for (const late of ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit']) {
        // A distinct call ID keeps the closed prompt assertion out of the dedup path.
        send(late, { toolName: 'late/tool', toolUseId: `late-${late}` });
        assert.deepEqual(card(), unassociated);
        assert.equal(state.snapshot().sessions[0].history.at(-1).event, late);
      }

      send('UserPromptSubmit', { turnId: next });
      assert.deepEqual(card(), { status: 'running', turnId: next, toolName: null, toolUseId: null });
      send('PreToolUse', { turnId: next, toolName: 'current/tool', toolUseId: 'current-call' });
      assert.deepEqual(card(), {
        status: 'tool_running', turnId: next, toolName: 'current/tool', toolUseId: 'current-call',
      });
      send('PermissionRequest', { turnId: next, toolName: 'current/tool', toolUseId: 'current-call' });
      assert.equal(card().status, 'waiting');
      send('PostToolUse', { turnId: next, toolName: 'current/tool', toolUseId: 'current-call' });
      assert.deepEqual(card(), {
        status: 'running', turnId: next, toolName: 'current/tool', toolUseId: 'current-call',
      });
    });
  }
}

for (const status of ['running', 'tool_running', 'waiting']) {
  test(`${status}: foreign and closed tools cannot overwrite an anchored root card`, () => {
    const state = createMultiChatState({ clock: () => new Date(time) });
    const foreign = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    let tick = 0;
    const send = (name, overrides = {}) => state.accept(event(name, {
      ...overrides, at: new Date(Date.parse(time) + tick++).toISOString(),
    }));
    const card = () => {
      const { status, turnId, toolName, toolUseId } = state.snapshot().sessions[0];
      return { status, turnId, toolName, toolUseId };
    };
    send('UserPromptSubmit');
    send('UserPromptSubmit', { turnId: next });
    if (status !== 'running') {
      send(status === 'waiting' ? 'PermissionRequest' : 'PreToolUse', {
        turnId: next, toolName: 'root/tool', toolUseId: 'root-call',
      });
    }
    const expected = {
      status, turnId: next,
      toolName: status === 'running' ? null : 'root/tool',
      toolUseId: status === 'running' ? null : 'root-call',
    };
    assert.deepEqual(card(), expected);
    for (const name of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
      for (const turnId of [turn, foreign]) {
        send(name, { turnId, toolName: 'foreign/tool', toolUseId: `${turnId}-${name}` });
        assert.deepEqual(card(), expected);
      }
      send(name, {
        turnId: next, subagent: true, toolName: 'subagent/tool', toolUseId: `sub-${name}`,
      });
      assert.deepEqual(card(), expected);
    }
  });
}

test('invalid, old-turn, and subagent tool events cannot overwrite a newer root card', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  state.accept(event('UserPromptSubmit'));
  state.accept(event('UserPromptSubmit', { turnId: next }));
  state.accept(event('PreToolUse', { turnId: next, toolName: 'root/tool', toolUseId: 'root-call' }));
  const card = () => {
    const { status, turnId, toolName, toolUseId } = state.snapshot().sessions[0];
    return { status, turnId, toolName, toolUseId };
  };
  const expected = { status: 'tool_running', turnId: next, toolName: 'root/tool', toolUseId: 'root-call' };
  for (const name of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
    assert.equal(state.accept(event(name, { turnId: next, toolName: 'invalid tool' })), false);
    state.accept(event(name, { toolName: 'old/tool', toolUseId: `old-${name}` }));
    state.accept(event(name, {
      turnId: next, subagent: true, toolName: 'subagent/tool', toolUseId: `sub-${name}`,
    }));
    assert.deepEqual(card(), expected);
  }
});

test('late pre-tool does not undo returned tool and snapshots are isolated', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  state.accept(event('UserPromptSubmit'));
  state.accept(event('PostToolUse', { toolUseId: 'call-1', toolName: 'tool' }));
  state.accept(event('PreToolUse', { toolUseId: 'call-1', toolName: 'tool' }));
  const frame = state.snapshot();
  assert.equal(frame.sessions[0].status, 'running');
  frame.sessions[0].history.length = 0;
  assert.equal(state.snapshot().sessions[0].history.length, 3);
});

test('late tool and permission events do not reopen a closed turn', () => {
  for (const [completion, expected] of [['Stop', 'idle'], ['Interrupt', 'interrupted']]) {
    const state = createMultiChatState({ clock: () => new Date(time) });
    state.accept(event('UserPromptSubmit'));
    state.accept(event(completion));
    for (const name of ['PostToolUse', 'PreToolUse', 'PermissionRequest']) {
      state.accept(event(name, { toolUseId: `call-${name}`, toolName: 'tool' }));
      assert.equal(state.snapshot().sessions[0].status, expected, `${completion}: ${name}`);
    }
  }
});

test('permission requests synchronize the current card without carrying an unrelated call ID', () => {
  for (const priorTool of [false, true]) {
    const state = createMultiChatState({ clock: () => new Date(time) });
    const current = () => state.snapshot().sessions[0];
    const card = () => {
      const { status, toolName, toolUseId } = current();
      return { status, toolName, toolUseId };
    };

    state.accept(event('UserPromptSubmit'));
    if (priorTool) {
      state.accept(event('PreToolUse', { toolName: 'other/tool', toolUseId: 'prior-call' }));
    }
    state.accept(event('PermissionRequest', { toolName: 'simulation/tool', toolUseId: null }));
    assert.deepEqual(card(), { status: 'waiting', toolName: 'simulation/tool', toolUseId: null });

    state.accept(event('UserPromptSubmit', { turnId: next }));
    state.accept(event('PreToolUse', { turnId: next, toolName: 'normal/tool', toolUseId: 'normal-call' }));
    state.accept(event('PermissionRequest', { toolName: 'late/tool', toolUseId: 'late-call' }));
    state.accept(event('PermissionRequest', {
      turnId: next, subagent: true, toolName: 'subagent/tool', toolUseId: 'subagent-call',
    }));
    assert.deepEqual(card(), { status: 'tool_running', toolName: 'normal/tool', toolUseId: 'normal-call' });
    state.accept(event('PostToolUse', { turnId: next, toolName: 'normal/tool', toolUseId: 'normal-call' }));
    assert.deepEqual(card(), { status: 'running', toolName: 'normal/tool', toolUseId: 'normal-call' });
  }
});

test('distinct permission requests without call IDs are retained and retries are idempotent', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  const first = event('PermissionRequest', {
    toolName: 'alpha/tool', toolUseId: null, at: '2026-11-11T00:00:00.001Z',
  });
  const second = event('PermissionRequest', {
    toolName: 'beta/tool', toolUseId: null, at: '2026-11-11T00:00:00.002Z',
  });

  state.accept(event('UserPromptSubmit'));
  state.accept(first);
  state.accept(second);
  const snapshot = state.snapshot();
  const card = snapshot.sessions[0];
  assert.equal(card.status, 'waiting');
  assert.equal(card.turnId, turn);
  assert.equal(card.toolName, 'beta/tool');
  assert.equal(card.toolUseId, null);
  assert.deepEqual(card.history.filter((item) => item.event === 'PermissionRequest'), [
    { event: 'PermissionRequest', at: first.at, toolName: 'alpha/tool', toolUseId: null },
    { event: 'PermissionRequest', at: second.at, toolName: 'beta/tool', toolUseId: null },
  ]);
  state.accept(second);
  assert.deepEqual(state.snapshot(), snapshot);
});

test('no-ID permission requests cannot overwrite a newer or closed root card', () => {
  for (const [completion, status] of [['Stop', 'idle'], ['Interrupt', 'interrupted']]) {
    const state = createMultiChatState({ clock: () => new Date(time) });
    const at = (increment) => new Date(Date.parse(time) + increment).toISOString();
    const card = () => {
      const { turnId, status, toolName, toolUseId } = state.snapshot().sessions[0];
      return { turnId, status, toolName, toolUseId };
    };
    state.accept(event('UserPromptSubmit', { at: at(0) }));
    state.accept(event('UserPromptSubmit', { turnId: next, at: at(1) }));
    state.accept(event('PreToolUse', {
      turnId: next, toolName: 'root/tool', toolUseId: 'root-call', at: at(2),
    }));
    const expected = { turnId: next, status: 'tool_running', toolName: 'root/tool', toolUseId: 'root-call' };
    state.accept(event('PermissionRequest', { toolName: 'old/tool', toolUseId: null, at: at(3) }));
    assert.deepEqual(card(), expected);
    state.accept(event('PermissionRequest', {
      turnId: next, subagent: true, toolName: 'subagent/tool', toolUseId: null, at: at(4),
    }));
    assert.deepEqual(card(), expected);
    state.accept(event(completion, { turnId: next, at: at(5) }));
    state.accept(event('PermissionRequest', {
      turnId: next, toolName: 'late/tool', toolUseId: null, at: at(6),
    }));
    assert.deepEqual(card(), { ...expected, status });
  }
});

test('concurrent tools remain active until each known call returns', () => {
  const state = createMultiChatState({ clock: () => new Date(time) });
  const call = (name, id, toolName) =>
    state.accept(event(name, { toolUseId: id, toolName }));
  const current = () => state.snapshot().sessions[0];

  state.accept(event('UserPromptSubmit'));
  call('PreToolUse', 'a', 'alpha');
  call('PreToolUse', 'a', 'alpha');
  call('PreToolUse', 'b', 'beta');
  call('PostToolUse', 'a', 'alpha');
  assert.equal(current().status, 'tool_running');
  assert.equal(current().toolUseId, 'b');
  assert.equal(current().toolName, 'beta');
  call('PostToolUse', 'a', 'alpha');
  call('PostToolUse', 'unknown', 'other');
  call('PreToolUse', 'a', 'alpha');
  assert.equal(current().status, 'tool_running');
  assert.equal(current().toolUseId, 'b');
  call('PostToolUse', 'b', 'beta');
  assert.equal(current().status, 'running');
  call('PostToolUse', 'b', 'beta');
  assert.equal(current().status, 'running');

  state.accept(event('UserPromptSubmit', { turnId: next }));
  state.accept(event('PreToolUse', { turnId: next, toolUseId: 'a', toolName: 'alpha' }));
  assert.equal(current().status, 'tool_running');
  assert.equal(current().toolUseId, 'a');
  state.accept(event('PostToolUse', { turnId: next, toolUseId: 'a', toolName: 'alpha' }));
  assert.equal(current().status, 'running');
});

test('history and capacity are bounded, active sessions are retained, and staleness is projected', () => {
  let now = new Date(time);
  const state = createMultiChatState({ clock: () => now });
  for (let i = 0; i < 16; i++) {
    const id = `${i.toString(16).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    state.accept(event('UserPromptSubmit', { sessionId: id }));
  }
  state.accept(event('UserPromptSubmit', { sessionId: session }));
  assert.equal(state.snapshot().capacity.full, true);
  assert.equal(state.snapshot().sessions.length, 16);
  const id = '00000000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  for (let i = 0; i < 25; i++) {
    state.accept(event('PostToolUse', { sessionId: id, toolUseId: `call-${i}` }));
  }
  assert.equal(state.snapshot().sessions.find((item) => item.sessionId === id).history.length, 20);
  now = new Date(Date.parse(time) + 300001);
  assert.equal(state.snapshot().sessions[0].status, 'unknown');
  state.accept(event('UserPromptSubmit', { sessionId: session, at: now.toISOString() }));
  assert.equal(state.snapshot().sessions.length, 16);
  assert.equal(state.snapshot().capacity.full, true);
});
