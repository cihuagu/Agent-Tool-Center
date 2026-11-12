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
  state.accept(event('UserPromptSubmit'));
  assert.equal(state.snapshot().sessions[0].turnId, next);
  assert.equal(state.snapshot().sessions[0].status, 'running');
  assert.equal(state.accept(event('SubagentStop')), false);
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
