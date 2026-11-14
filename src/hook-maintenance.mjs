const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd',
];
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code = 'ownership_conflict') {
  throw Object.assign(new Error('Hook 配置或所有权记录不符合要求'), { code });
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const equal = (a, b) => canonical(a) === canonical(b);
const contextOf = (group) => Object.fromEntries(
  Object.entries(group).filter(([key]) => key !== 'hooks'),
);

function validateConfig(config) {
  if (!object(config)) fail('invalid_config');
  if (!own(config, 'hooks')) return;
  if (!object(config.hooks)) fail('invalid_config');
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups)) fail('invalid_config');
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) fail('invalid_config');
      for (const handler of group.hooks) {
        if (!object(handler) || typeof handler.type !== 'string' || !handler.type) {
          fail('invalid_config');
        }
        if (handler.type === 'command'
          && (typeof handler.command !== 'string'
            || (own(handler, 'commandWindows') && typeof handler.commandWindows !== 'string'))) {
          fail('invalid_config');
        }
      }
    }
  }
}

function normalizedDecimal(token) {
  const [, sign, integer, fraction = '', exponent = '0'] =
    /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  const digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  const coefficient = digits.replace(/0+$/, '');
  const power = BigInt(exponent) - BigInt(fraction.length)
    + BigInt(digits.length - coefficient.length);
  return `${sign}${coefficient}e${power}`;
}

export function parseHookConfig(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024) {
    fail('invalid_config');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('invalid_config');
  }
  let position = 0;
  const space = () => {
    while (' \t\r\n'.includes(text[position]) && position < text.length) position++;
  };
  function string() {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, position));
        } catch {
          fail('invalid_config');
        }
      }
      if (character === '\\') position++;
    }
    fail('invalid_config');
  }
  function value(depth) {
    if (depth > 64) fail('invalid_config');
    space();
    const character = text[position];
    if (character === '"') return string();
    if (character === '{' || character === '[') {
      const isObject = character === '{';
      const result = isObject ? {} : [];
      const keys = new Set();
      const closing = isObject ? '}' : ']';
      position++;
      space();
      if (text[position] === closing) {
        position++;
        return result;
      }
      while (position < text.length) {
        space();
        let key;
        if (isObject) {
          if (text[position] !== '"') fail('invalid_config');
          key = string();
          if (keys.has(key)) fail('invalid_config');
          keys.add(key);
          space();
          if (text[position++] !== ':') fail('invalid_config');
        }
        const child = value(depth + 1);
        if (isObject) {
          Object.defineProperty(result, key, {
            value: child, enumerable: true, writable: true, configurable: true,
          });
        } else {
          result.push(child);
        }
        space();
        if (text[position] === closing) {
          position++;
          return result;
        }
        if (text[position++] !== ',') fail('invalid_config');
      }
      fail('invalid_config');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(position),
    )?.[0];
    if (!token) fail('invalid_config');
    position += token.length;
    const result = JSON.parse(token);
    if (typeof result === 'number'
      && (!Number.isFinite(result) || Object.is(result, -0)
        || normalizedDecimal(token) !== normalizedDecimal(JSON.stringify(result)))) {
      fail('invalid_config');
    }
    return result;
  }
  const config = value(0);
  space();
  if (position !== text.length) fail('invalid_config');
  validateConfig(config);
  return config;
}

function definitionItems(definitions) {
  validateConfig({ hooks: definitions });
  if (!equal(Object.keys(definitions).sort(), [...events].sort())) fail('invalid_definitions');
  return events.map((event) => {
    const groups = definitions[event];
    if (groups.length !== 1 || groups[0].hooks.length !== 1
      || groups[0].hooks[0].type !== 'command') fail('invalid_definitions');
    return {
      event,
      context: contextOf(groups[0]),
      handler: groups[0].hooks[0],
      createdGroup: true,
    };
  });
}

function validateReceipt(receipt) {
  if (!object(receipt)
    || !equal(Object.keys(receipt).sort(), ['absentEvents', 'hooksAbsent', 'items'])
    || typeof receipt.hooksAbsent !== 'boolean'
    || !Array.isArray(receipt.absentEvents)
    || receipt.absentEvents.some((event) => !events.includes(event))
    || new Set(receipt.absentEvents).size !== receipt.absentEvents.length
    || !Array.isArray(receipt.items) || receipt.items.length !== events.length) fail();
  const seen = new Set();
  for (const item of receipt.items) {
    if (!object(item)
      || !equal(Object.keys(item).sort(), ['context', 'createdGroup', 'event', 'handler'])
      || !events.includes(item.event) || seen.has(item.event)
      || !object(item.context) || own(item.context, 'hooks')
      || typeof item.createdGroup !== 'boolean'
      || !object(item.handler) || item.handler.type !== 'command') fail();
    validateConfig({ hooks: { [item.event]: [{ ...item.context, hooks: [item.handler] }] } });
    seen.add(item.event);
  }
  if (receipt.hooksAbsent && receipt.absentEvents.length !== events.length) fail();
}

function matches(config, item) {
  const found = [];
  for (const group of config.hooks?.[item.event] ?? []) {
    for (let index = 0; index < group.hooks.length; index++) {
      if (equal(group.hooks[index], item.handler)) {
        if (!equal(contextOf(group), item.context)) fail();
        found.push({ group, index });
      }
    }
  }
  if (found.length !== 1) fail();
  return found[0];
}

function recognizable(handler) {
  return ['command', 'commandWindows'].some((key) =>
    typeof handler[key] === 'string'
    && /multi-chat-hook\.mjs(?:["'\s]|$)/i.test(handler[key]));
}

function rejectUnowned(config, items, locations = []) {
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    for (const group of groups) {
      for (let index = 0; index < group.hooks.length; index++) {
        if (locations.some((location) => location.group === group && location.index === index)) continue;
        const handler = group.hooks[index];
        if (recognizable(handler)
          || items.some((item) => item.event === event && equal(item.handler, handler))) {
          fail();
        }
      }
    }
  }
}

export function reconcileHookConfig({ operation, config, definitions, receipt } = {}) {
  if (!['install', 'update', 'uninstall', 'adopt'].includes(operation)) {
    fail('invalid_operation');
  }
  validateConfig(config);
  const current = definitionItems(definitions);
  const result = structuredClone(config);
  const desired = structuredClone(current);

  if (operation === 'adopt') {
    if (receipt !== undefined) fail();
    const locations = desired.map((item) => matches(result, item));
    rejectUnowned(result, desired, locations);
    return {
      config: result,
      receipt: {
        items: desired.map((item) => ({ ...item, createdGroup: false })),
        hooksAbsent: false,
        absentEvents: [],
      },
    };
  }

  if (receipt === undefined) {
    if (operation !== 'install') fail();
    rejectUnowned(result, desired);
    const provenance = {
      items: desired,
      hooksAbsent: !own(result, 'hooks'),
      absentEvents: events.filter((event) => !own(result.hooks ?? {}, event)),
    };
    if (!own(result, 'hooks')) result.hooks = {};
    for (const item of desired) {
      if (!own(result.hooks, item.event)) result.hooks[item.event] = [];
      result.hooks[item.event].push({ ...item.context, hooks: [item.handler] });
    }
    return { config: result, receipt: provenance };
  }

  validateReceipt(receipt);
  const saved = structuredClone(receipt);
  const locations = saved.items.map((item) => matches(result, item));
  rejectUnowned(result, [...saved.items, ...desired], locations);
  if (operation === 'install') {
    if (saved.items.some((item) => {
      const replacement = desired.find((candidate) => candidate.event === item.event);
      return !equal(item.context, replacement.context) || !equal(item.handler, replacement.handler);
    })) fail('update_required');
    return { config: result, receipt: saved };
  }
  for (let index = 0; index < saved.items.length; index++) {
    const item = saved.items[index];
    const location = locations[index];
    if (operation === 'update') {
      const replacement = desired.find((candidate) => candidate.event === item.event);
      // Changing context would also change the meaning of added foreign handlers.
      if (!equal(item.context, replacement.context)) fail();
      location.group.hooks[location.index] = replacement.handler;
      item.handler = replacement.handler;
    } else {
      location.group.hooks.splice(location.index, 1);
      if (item.createdGroup && location.group.hooks.length === 0) {
        const groups = result.hooks[item.event];
        groups.splice(groups.indexOf(location.group), 1);
      }
      if (saved.absentEvents.includes(item.event) && result.hooks[item.event].length === 0) {
        delete result.hooks[item.event];
      }
    }
  }
  if (operation === 'uninstall' && saved.hooksAbsent && Object.keys(result.hooks).length === 0) {
    delete result.hooks;
  }
  return { config: result, receipt: saved };
}
