import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeRenderer } from "../src/status-window.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const at = "2026-11-13T12:34:56.000Z";
const uuid = index => `12345678-1234-1234-1234-${String(index).padStart(12, "0")}`;
const exactError = message => error => error instanceof Error && error.message === message;
const restoreLanguage = value => {
  if (value === undefined) delete process.env.ATC_UI_LANGUAGE;
  else process.env.ATC_UI_LANGUAGE = value;
};

test("invalid explicit languages reject before mode and native setup", async () => {
  const previous = process.env.ATC_UI_LANGUAGE;
  try {
    process.env.ATC_UI_LANGUAGE = "en";
    for (const language of [null, "", "EN", "zh-cn", "en-US", " en", 1, false, {}, []]) {
      await assert.rejects(
        createNativeRenderer({ onClose() {}, mode: "invalid", language }),
        exactError("STATUS_WINDOW_INVALID_LANGUAGE"), JSON.stringify(language)
      );
    }
  } finally { restoreLanguage(previous); }
});

test("omitted language rejects unsupported environment before native setup", async () => {
  const previous = process.env.ATC_UI_LANGUAGE;
  try {
    for (const language of ["", "EN", "zh", "en-US", "zh-CN "]) {
      process.env.ATC_UI_LANGUAGE = language;
      await assert.rejects(
        createNativeRenderer({ onClose() {}, mode: "invalid" }),
        exactError("STATUS_WINDOW_INVALID_LANGUAGE"), JSON.stringify(language)
      );
    }
  } finally { restoreLanguage(previous); }
});

test("supported explicit overrides and omitted defaults reach mode validation without launching", async () => {
  const previous = process.env.ATC_UI_LANGUAGE;
  const rejectsMode = options => assert.rejects(
    createNativeRenderer({ onClose() {}, mode: "invalid", ...options }),
    exactError("STATUS_WINDOW_INVALID_MODE")
  );
  try {
    process.env.ATC_UI_LANGUAGE = "unsupported";
    for (const language of ["en", "zh-CN"]) await rejectsMode({ language });
    for (const language of ["en", "zh-CN"]) {
      process.env.ATC_UI_LANGUAGE = language;
      await rejectsMode({});
    }
    delete process.env.ATC_UI_LANGUAGE;
    await rejectsMode({});
  } finally { restoreLanguage(previous); }
});

function fixtures() {
  const multi = {
    kind: "multi_chat", version: 1, generatedAt: at, displayRequest: 0,
    capacity: { maxSessions: 16, full: false },
    sessions: ["waiting", "tool_running", "unknown", "ended"].map((status, index) => ({
      sessionId: uuid(index + 1), project: `SIMULATED Project ${index}`, status,
      turnId: uuid(10), source: "hook", lastSeen: at,
      toolName: "server.tool:read", toolUseId: "call_simulated_123",
      history: [{ event: "PostToolUse", at, toolName: "server.tool:read",
        toolUseId: "call_simulated_123" }]
    }))
  };
  const updated = structuredClone(multi);
  updated.sessions[1].lastSeen = "2026-11-13T12:35:56.000Z";
  const current = {
    taskLabel: "SIMULATED Review native language rendering and preserve user labels".padEnd(80, "X"),
    selectedCapabilityName: "SIMULATED Native language rendering verification capability".padEnd(80, "X"),
    actualCapabilityName: "SIMULATED Actual native language rendering verification capability".padEnd(80, "X"),
    switchFromName: "SIMULATED Previous native language rendering verification capability".padEnd(80, "X"),
    state: "waiting", reason: "permission_required", quality: "meets_requirement",
    matchesSelection: true, startedAt: at, endedAt: at, cancelledAt: null
  };
  const host = {
    source: "codex-observer", state: "returned", capabilityId: "codex.native.mcp",
    serverName: "simulation", toolName: "server.tool:read", callId: uuid(20),
    threadId: uuid(21), turnId: null, scope: "thread_tail", ordering: "unknown",
    at, receivedAt: at, startedAt: at, completedAt: at, durationMs: null
  };
  const advisor = {
    displayMode: "advisor", current, hostCurrent: null,
    observer: { state: "observing", threadId: uuid(21), lastReadAt: at,
      lastErrorCode: null, cleanupFailed: false,
      coverage: { turnCount: 1, raw: { available: true, truncated: false, unscopedItems: 1 } } },
    history: [host, { ...host, callId: uuid(22), durationMs: 1234 }]
  };
  return { multi, updated, advisor, desktop: { ...advisor, displayMode: "desktop", hostCurrent: host } };
}

const probeSource = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
internal static class Probe {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    static bool English;
    static Dictionary<string, object> Data;
    static List<string> Errors;
    static string L(string en, string zh) { return English ? en : zh; }
    static object Field(object owner, string name) { return owner.GetType().GetField(name, Private).GetValue(owner); }
    static T ControlField<T>(object owner, string name) { return (T)Field(owner, name); }
    static void Check(bool ok, string message) { if (!ok) Errors.Add(message); }
    static void Has(string text, string pattern, string message) {
        Check(Regex.IsMatch(text, pattern, RegexOptions.IgnoreCase | RegexOptions.Singleline), message);
    }
    static Form New(Type type) { return (Form)Activator.CreateInstance(type, true); }
    static void Dispose(Form form) {
        if (form == null) return;
        FieldInfo field = form.GetType().GetField("timer", Private);
        if (field != null) { Timer timer = (Timer)field.GetValue(form); timer.Stop(); timer.Dispose(); }
        form.Dispose();
    }
    static void Apply(Form form, object value) {
        object snapshot = Json.DeserializeObject(Json.Serialize(value));
        if (form is MultiChatWindow) {
            snapshot = MultiChatWindow.ParseSnapshot(Json.Serialize(value));
            Check(snapshot != null, "multi fixture passes actual parser");
        }
        form.GetType().GetField("latest", Private).SetValue(form, snapshot);
        form.GetType().GetMethod("ApplyLatest", Private).Invoke(form, null);
    }
    static string All(Control control) {
        StringBuilder text = new StringBuilder(control.Text + "\n");
        foreach (Control child in control.Controls) text.Append(All(child));
        return text.ToString();
    }
    static void Fits(Control control) {
        if (control.Text.Length == 0) return;
        int chrome = control is CheckBox || control is RadioButton ? 24 : control is Button ? 12 : 0;
        int width = Math.Max(1, control.ClientSize.Width - control.Padding.Horizontal - chrome);
        Size needed = TextRenderer.MeasureText(control.Text, control.Font, new Size(width, Int32.MaxValue),
            TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl);
        Check(needed.Height <= control.ClientSize.Height - control.Padding.Vertical,
            "text fits " + control.GetType().Name + ": " + control.Text);
    }
    static void SingleFits(Form form) {
        form.PerformLayout();
        foreach (Control control in form.Controls)
            if (control is Label || control is Button || control is CheckBox) Fits(control);
    }
    static void Multi() {
        Form form = New(typeof(MultiChatWindow));
        try {
            string initial = All(form);
            Has(form.Text, L("Multi-chat status", "多聊天状态"), "multi title");
            foreach (string caption in English
                ? new string[] { "Tab view", "Tiled view", "Always on top" }
                : new string[] { "标签视图", "并排视图", "置顶" })
                Has(initial, Regex.Escape(caption), "multi caption " + caption);
            Has(initial, L("waiting.*(chat|event)", "等待聊天事件"), "empty instructions");
            Has(initial, L("Hook.*not.*(authentication|identity|permission)", "Hook.*不作为身份认证或权限依据"), "metadata boundary");
            Apply(form, Data["multi"]);
            TabControl tabs = ControlField<TabControl>(form, "tabs");
            Check(tabs.TabPages.Count == 4, "four simulated sessions rendered");
            string[] states = English ? new string[] { "waiting", "tool", "unknown", "ended" }
                : new string[] { "等待审批", "工具调用中", "状态未知", "已结束" };
            for (int i = 0; i < 4; i++) {
                Has(tabs.TabPages[i].Text, states[i], "session human state " + i);
                string details = All(tabs.TabPages[i]);
                foreach (string raw in new string[] { "SIMULATED Project " + i, "server.tool:read",
                    "call_simulated_123", "PostToolUse", "2026-11-13T12:34:56.000Z",
                    "12345678-1234-1234-1234-" + (i + 1).ToString("D12") })
                    Check(details.Contains(raw), "preserved metadata " + raw);
                Has(details, L("unknown", "未知"), "unknown task remains honest");
                Has(details, L("returned.*not.*success", "已返回，不代表成功"), "returned boundary");
            }
            tabs.SelectedTab = tabs.TabPages[1];
            TabPage selected = tabs.SelectedTab;
            TextBox text = (TextBox)selected.Controls[0];
            text.Select(3, 5);
            Apply(form, Data["updated"]);
            Check(tabs.SelectedTab == selected, "selected tab retained");
            Check(text.SelectionStart == 3 && text.SelectionLength == 5, "text selection retained");
            Check(text.Text.Contains("12:35:56"), "second snapshot actually rendered");
        } finally { Dispose(form); }
    }
    static void Single(bool scaled) {
        Form form = New(typeof(AgentStatusWindow));
        try {
            Has(form.Text, L("Agent task status", "Agent 任务状态"), "single title");
            Has(All(form), L("Unknown", "未知"), "startup unknown");
            Has(All(form), L("Always on top", "置顶"), "single top caption");
            Button expand = ControlField<Button>(form, "expand");
            Has(expand.Text, L("Expand history", "展开记录"), "expand caption");
            if (scaled) {
                form.AutoScaleMode = AutoScaleMode.None;
                form.Scale(new SizeF(1.5F, 1.5F));
                form.Font = new Font(form.Font.FontFamily, form.Font.Size * 1.5F);
            }
            Dictionary<string, object> advisor = (Dictionary<string, object>)Data["advisor"];
            Dictionary<string, object> current = (Dictionary<string, object>)advisor["current"];
            Apply(form, advisor);
            string status = ControlField<Label>(form, "status").Text;
            Has(status, L("Agent.*report.*waiting.*permission", "Agent自报.*等待.*等待许可"), "advisor waiting reason and source");
            Has(status, L("meets|requirements? met", "符合要求"), "positive quality");
            foreach (string key in new string[] { "taskLabel", "selectedCapabilityName", "actualCapabilityName" })
                Check(All(form).Contains((string)current[key]), "unchanged long user label " + key);
            SingleFits(form);
            current["quality"] = "does_not_meet"; current["matchesSelection"] = false;
            current["state"] = "cancelled"; current["reason"] = "user_cancelled"; current["cancelledAt"] = "2026-11-13T12:34:56.000Z";
            Apply(form, advisor);
            status = ControlField<Label>(form, "status").Text;
            Has(status, L("not.*meet|doesn.t.*meet", "不符合要求"), "negative quality");
            Has(status, L("cancel.*not.*host.*interrupt", "曾记录取消（不代表宿主中断）"), "cancellation boundary");
            SingleFits(form);
            current["quality"] = "not_assessed"; Apply(form, advisor);
            Has(ControlField<Label>(form, "status").Text, L("not.*assess|unassessed|not.*evaluat", "未评价"), "unassessed quality");
            Rectangle area = Screen.FromControl(form).WorkingArea;
            form.Location = new Point(
                Math.Max(area.Left, Math.Min(area.Right - form.Width, area.Right)),
                Math.Max(area.Top, Math.Min(area.Bottom - form.Height, area.Bottom)));
            expand.GetType().GetMethod("OnClick", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(expand, new object[] { EventArgs.Empty });
            Check(form.Bounds.Left >= area.Left && form.Bounds.Top >= area.Top &&
                form.Bounds.Right <= area.Right && form.Bounds.Bottom <= area.Bottom,
                "expanded outer frame fits working area");
            TextBox expandedHistory = ControlField<TextBox>(form, "history");
            Check(expandedHistory.ClientSize.Height > 0 && expandedHistory.ClientSize.Width > 0,
                "expanded history has positive client size");
            Has(expand.Text, L("Collapse", "收起"), "collapse caption");
            string history = ControlField<TextBox>(form, "history").Text;
            Has(history, L("returned.*not.*success", "已返回不代表成功"), "history returned boundary");
            Has(history, L("source.*duration.*unknown", "源持续时间：未知"), "unknown source duration");
            Check(history.Contains("1234 ms"), "known history source duration");
            TextBox records = ControlField<TextBox>(form, "history"); records.Select(3, 5);
            Apply(form, Data["desktop"]);
            Check(records.SelectionStart == 3 && records.SelectionLength == 5, "single history selection retained");
            Has(ControlField<Label>(form, "status").Text, L("host.*returned", "真实宿主观察.*已返回"), "desktop source and returned state");
            Has(ControlField<Label>(form, "elapsed").Text, L("unknown", "未知"), "desktop unknown duration");
            foreach (string raw in new string[] { "simulation", "server.tool:read", "12345678-1234-1234-1234-000000000020" })
                Check(All(form).Contains(raw), "desktop metadata preserved " + raw);
            Dictionary<string, object> desktop = (Dictionary<string, object>)Data["desktop"];
            ((Dictionary<string, object>)desktop["hostCurrent"])["durationMs"] = 1234;
            Apply(form, desktop);
            Check(ControlField<Label>(form, "elapsed").Text.Contains("1234 ms"), "desktop known duration");
        } finally { Dispose(form); }
    }
    static void Run(string scenario, Action action) {
        Errors = new List<string>();
        try { action(); } catch (Exception error) { Errors.Add(error.ToString()); }
        Console.WriteLine(Json.Serialize(new { scenario = scenario, errors = Errors }));
    }
    [STAThread] static void Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false, true); Console.OutputEncoding = new UTF8Encoding(false);
        English = args[0] == "en";
        string original = Console.In.ReadToEnd();
        Data = (Dictionary<string, object>)Json.DeserializeObject(original);
        Run("multi", Multi);
        Data = (Dictionary<string, object>)Json.DeserializeObject(original);
        Run("single-normal", delegate { Single(false); });
        Data = (Dictionary<string, object>)Json.DeserializeObject(original);
        Run("single-controlled-150-percent", delegate { Single(true); });
    }
}
`;

test("owned C# probes render startup languages without showing forms", {
  skip: process.platform !== "win32" ? "requires Windows WinForms and the fixed system C# compiler" : false
}, async t => {
  const root = process.env.SystemRoot;
  assert.ok(root && path.isAbsolute(root));
  let compiler;
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = path.join(root, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    try { await access(candidate); compiler = candidate; break; } catch {}
  }
  assert.ok(compiler, "fixed system C# compiler must exist");
  const cache = path.join(project, ".cache");
  await mkdir(cache, { recursive: true });
  const resolvedCache = await realpath(cache);
  assert.equal(path.relative(await realpath(project), resolvedCache), ".cache");
  const directory = await mkdtemp(path.join(resolvedCache, "owned-native-language-"));
  const owned = await realpath(directory);
  const isOwned = value => /^owned-native-language-[^\\/]+$/.test(path.relative(resolvedCache, value));
  assert.ok(isOwned(owned));
  try {
    const source = path.join(owned, "Probe.cs"), executable = path.join(owned, "Probe.exe");
    await writeFile(source, probeSource, "utf8");
    const compiled = spawnSync(compiler, [
      "/nologo", "/target:exe", "/codepage:65001", "/main:Probe",
      "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
      "/reference:System.Web.Extensions.dll", `/out:${executable}`,
      path.join(project, "src", "MultiChatWindow.cs"),
      path.join(project, "src", "status-window", "AgentStatusWindow.cs"), source
    ], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
    assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stdout + compiled.stderr);
    for (const language of ["en", "zh-CN", undefined]) {
      await t.test(language ?? "omitted environment defaults to zh-CN", () => {
        const env = { ...process.env };
        if (language === undefined) delete env.ATC_UI_LANGUAGE;
        else env.ATC_UI_LANGUAGE = language;
        const run = spawnSync(executable, [language ?? "zh-CN"], {
          input: JSON.stringify(fixtures()), env, encoding: "utf8",
          windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024
        });
        assert.equal(run.status, 0, run.error?.message ?? run.stderr);
        const markers = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.deepEqual(markers.map(item => item.scenario),
          ["multi", "single-normal", "single-controlled-150-percent"]);
        assert.deepEqual(markers.filter(item => item.errors.length), [], JSON.stringify(markers, null, 2));
      });
    }
  } finally {
    const current = await realpath(directory);
    assert.equal(current, owned);
    assert.ok(isOwned(current));
    await rm(current, { recursive: true, force: true });
  }
});
