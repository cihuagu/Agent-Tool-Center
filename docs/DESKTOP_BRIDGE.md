# 根 Agent 的持久 node_repl 接入

仅当前聊天根 Agent 操作。继续当前聊天即可；这些片段属于同一接入流程，无需子代理。必须已有持久 `node_repl`、可信宿主上下文和项目依赖；缺少任一条件就停止，不安装、不修改全局配置。

以下为操作指南，尚未执行或验收。六工具经项目 MCP 客户端调用，不是宿主新增工具，也不提供全局强制执行。

## 初始化与逐单元守卫

在同一持久内核运行一次以下片段。`atcOwnedSession` 只记录本根 Agent 创建的引用，不能从已有全局引用推断所有权。内核状态不明时停止，不接管其他引用。

已有桥接时不得重新运行初始化；必须在初始化所有权变量前停止，不接管、覆盖、清空或关闭已有未知引用。

```js
if (globalThis.atcDesktop != null) {
  throw new Error("已有桥接；禁止重新初始化，保留原引用");
}
var atcOwnedSession = null;
var atcModeLabels = { manual: "手动", recommend: "推荐", auto: "自动" };
var atcUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

var atcHostId = () => {
  const raw = nodeRepl.requestMeta?.threadId;
  if (typeof raw !== "string" || raw.length !== 36 ||
      !atcUuidPattern.test(raw)) return null;
  return raw.toLowerCase();
};

var atcCloseOwned = async () => {
  const owned = atcOwnedSession;
  let cleanupFailed = false;
  try {
    if (owned) {
      const result = await owned.close();
      cleanupFailed = result?.cleanupFailed !== false;
    }
  } catch {
    cleanupFailed = true;
  } finally {
    atcOwnedSession = null;
    if (globalThis.atcDesktop === owned) globalThis.atcDesktop = undefined;
  }
  if (cleanupFailed) console.log("清理未确认：cleanupFailed");
  return { cleanupFailed };
};

// 每个操作前调用；失败会终止当前调用，不能在 catch 中立即重连。
var atcGuard = async () => {
  const hostId = atcHostId();
  const session = globalThis.atcDesktop;
  let matches = false;
  if (hostId && session && session === atcOwnedSession) {
    try {
      matches = session.getBinding().threadId === hostId;
    } catch {
      matches = false;
    }
  }
  if (!matches) {
    await atcCloseOwned();
    throw new Error("宿主或绑定无效；已停止本次调用");
  }
  return session;
};
```

守卫失败时，只关闭本根 Agent 持有的旧引用，检查清理结果并清空自身所有权引用；仅当全局引用仍指向自身持有的引用时才清空全局引用，保留未知替换引用；本次操作到此结束。不得用任务文本、子 Agent ID、硬编码 UUID 或最新会话文件替代宿主身份。

## 首次连接

先从可信当前项目上下文确定项目绝对根目录。**只有明确确认宿主上下文说明 `nodeRepl.cwd` 就是预期项目绝对根目录后**，才能执行下面的赋值；否则停止，取得可信根目录后再操作，不能根据目录名猜测。

```js
var { isAbsolute, resolve } = await import("node:path");
var { pathToFileURL } = await import("node:url");
var projectRoot = nodeRepl.cwd; // 仅在上述宿主上下文确认后使用
if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) {
  throw new Error("缺少可信项目绝对根目录");
}

// 已有引用走守卫并停止；首次连接仅允许有效宿主且没有旧引用。
if (!atcHostId() || atcOwnedSession || globalThis.atcDesktop != null) {
  await atcGuard();
  throw new Error("已有会话；本单元不重新连接");
}
var { createDesktopChatSession } = await import(
  pathToFileURL(resolve(projectRoot, "src/desktop-chat-session.mjs")).href
);
// 导入后再次检查当前宿主；不能复用先前缓存的身份。
if (!atcHostId()) {
  await atcCloseOwned();
  throw new Error("宿主身份无效；停止连接");
}
atcOwnedSession = createDesktopChatSession({
  threadId: nodeRepl.requestMeta.threadId
});
globalThis.atcDesktop = atcOwnedSession;
try {
  await atcOwnedSession.start();
  await atcGuard();
} catch {
  await atcCloseOwned();
  throw new Error("连接或绑定检查失败；清理状态见上方输出");
}
```

## 后续单元

每次方法调用均先执行 `await atcGuard()`，包括同一单元内的连续调用；不要跨单元缓存其返回引用。守卫和所有权变量仅保留在本持久内核，不写入产品辅助代码。

查询并按真实返回值回显：

```js
var atcMode = await (await atcGuard()).getMode();
if (!Object.hasOwn(atcModeLabels, atcMode.mode)) {
  throw new Error("模式返回值无效");
}
console.log(`当前聊天：${atcModeLabels[atcMode.mode]}模式`);
```

仅当用户已授权切换为推荐模式时运行下例；其他模式按用户要求使用 `manual` 或 `auto`。切换后必须重新读取：

```js
await (await atcGuard()).setMode("recommend");
var atcMode = await (await atcGuard()).getMode();
if (!Object.hasOwn(atcModeLabels, atcMode.mode)) {
  throw new Error("模式返回值无效");
}
console.log(`当前聊天：${atcModeLabels[atcMode.mode]}模式`);
```

比较参数须依据当前真实工具契约及任务准备，不能凭空编造候选或可用性。先在同一内核设置 `compareArguments`，且不包含 `mode`，再运行：

```js
if (typeof compareArguments !== "object" || compareArguments === null ||
    Array.isArray(compareArguments) || Object.hasOwn(compareArguments, "mode")) {
  throw new Error("请准备符合当前工具契约且省略 mode 的比较参数");
}
var atcResult = await (await atcGuard()).call(
  "compare_capabilities", compareArguments
);
if (atcResult.isError) throw new Error("比较返回 MCP 错误");
var atcComparison = atcResult.structuredContent;
```

比较自动读取当前聊天保存的模式。比较、选择、状态和采用报告不等于真实执行，也不改变授权。实际选择、宿主工具执行及验证分别进行；每次桥接调用仍执行守卫，先检查 `isError` 再读取 `structuredContent`。不输出原始参数、结果或错误正文。

## 正常关闭

```js
await atcGuard();
var atcCleanup = await atcCloseOwned();
if (!atcCleanup.cleanupFailed) console.log("本根 Agent 会话清理已确认");
```

关闭只涉及本引用拥有的资源，保留模式记录和独立常驻管理器。用户关闭窗口后不自动重开。主动重置内核前先关闭；意外重置后的清理效果未经验证，不声称已覆盖。
