import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const scenarios = [
  "terminal-groups", "source-identities", "host-scope-identities", "anonymous-rows",
  "terminal-summaries", "restore-latest-and-input", "close-path",
  "layout-normal", "layout-controlled-150-percent"
];

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
    static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string[] Terminal = {
        "succeeded", "failed", "cancelled", "not_run", "returned", "denied"
    };
    static bool English;
    static List<string> Errors;
    static string L(string en, string zh) { return English ? en : zh; }
    static void Check(bool ok, string message) { if (!ok) Errors.Add(message); }
    static T Field<T>(Form form, string name) where T : class {
        FieldInfo field = form.GetType().GetField(name, Private);
        T value = field == null ? null : field.GetValue(form) as T;
        if (value == null)
            throw new InvalidOperationException("Assertion: required " + typeof(T).Name + " " + name + " is missing");
        return value;
    }
    static Dictionary<string, object> Row(string marker, string state,
        string source, string call, string selection) {
        Dictionary<string, object> row = new Dictionary<string, object> {
            { "capabilityId", source == "codex-observer" ? "SIMULATED_HOST_TOOL" : "SIMULATED_" + marker },
            { "toolName", "SIMULATED_" + marker },
            { "taskLabel", "SIMULATED_" + marker },
            { "selectedCapabilityName", "SIMULATED_SELECTED_" + marker },
            { "actualCapabilityName", "SIMULATED_ACTUAL_" + marker },
            { "state", state }, { "source", source },
            { "callId", call }, { "selectionId", selection },
            { "reason", "none" }, { "quality", "not_assessed" },
            { "scope", "thread_tail" }, { "ordering", "unknown" }
        };
        if (source == "codex-observer") {
            row["threadId"] = "SIMULATED_THREAD";
            row["turnId"] = "SIMULATED_TURN";
        }
        return row;
    }
    static Dictionary<string, object> Agent(string marker, string state, string id) {
        return Row(marker, state, "agent_reported", null, id);
    }
    static Dictionary<string, object> Host(string marker, string state, string id) {
        return Row(marker, state, "codex-observer", id, null);
    }
    static Dictionary<string, object> Current(string marker, string state, string id) {
        Dictionary<string, object> row = Agent(marker, state, id);
        row.Remove("source");
        return row;
    }
    static Dictionary<string, object> ScopedHost(string marker, string state, string call,
        string thread, string turn, string capability) {
        Dictionary<string, object> row = Host(marker, state, call);
        row["threadId"] = thread;
        row["turnId"] = turn;
        row["capabilityId"] = capability;
        return row;
    }
    static Dictionary<string, object> Snapshot(params Dictionary<string, object>[] rows) {
        return new Dictionary<string, object> {
            { "displayMode", "advisor" },
            { "current", Current("CURRENT_ACTIVE", "waiting", "SIMULATED_CURRENT") },
            { "hostCurrent", Host("HOST_ACTIVE", "running", "SIMULATED_HOST") },
            { "observer", new Dictionary<string, object> {
                { "state", "observing" }, { "threadId", "SIMULATED_SCOPE_ONLY" },
                { "lastReadAt", "SIMULATED_LAST_READ" },
                { "lastErrorCode", "SIMULATED_NO_ERROR" }, { "cleanupFailed", false },
                { "coverage", new Dictionary<string, object> {
                    { "turnCount", 7 }, { "raw", new Dictionary<string, object> {
                        { "available", true }, { "truncated", false }, { "unscopedItems", 2 }
                    } }
                } }
            } },
            { "history", rows }
        };
    }
    static void Apply(Form form, Dictionary<string, object> snapshot) {
        string before = Json.Serialize(snapshot);
        form.GetType().GetField("latest", Private).SetValue(form, snapshot);
        form.GetType().GetMethod("ApplyLatest", Private).Invoke(form, null);
        Check(Json.Serialize(snapshot) == before, "applying must not mutate supplied snapshot");
    }
    static void Toggle(Form form, bool value) { Field<CheckBox>(form, "hideEnded").Checked = value; }
    static string History(Form form) { return Field<TextBox>(form, "history").Text; }
    static string Summary(Form form) {
        return Field<Label>(form, "task").Text + "\n" +
            Field<Label>(form, "capabilities").Text + "\n" +
            Field<Label>(form, "status").Text + "\n" + Field<Label>(form, "elapsed").Text;
    }
    static void Present(string text, string marker, bool expected) {
        Check(text.Contains("SIMULATED_" + marker) == expected,
            (expected ? "retain " : "hide ") + "SIMULATED_" + marker);
    }
    static void Click(Button button) {
        typeof(Button).GetMethod("OnClick", Private).Invoke(button, new object[] { EventArgs.Empty });
    }
    static void Groups(Form form) {
        Check(!Field<CheckBox>(form, "hideEnded").Checked, "hideEnded defaults unchecked");
        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
        foreach (string state in Terminal) {
            string id = "SIMULATED_GROUP_" + state;
            rows.Add(Agent("EARLY_" + state, "selected", id));
            rows.Add(Agent("RUN_" + state, "running", id));
            rows.Add(Agent("END_" + state, state, id));
        }
        foreach (string state in new string[] { "running", "waiting", "selected", "unknown" })
            rows.Add(Agent("KEEP_" + state, state, "SIMULATED_ACTIVE_" + state));
        Apply(form, Snapshot(rows.ToArray()));
        string full = History(form);
        foreach (Dictionary<string, object> row in rows)
            Check(full.Contains((string)row["capabilityId"]), "default retains " + row["capabilityId"]);
        Toggle(form, true);
        foreach (string state in Terminal)
            foreach (string prefix in new string[] { "EARLY_", "RUN_", "END_" })
                Present(History(form), prefix + state, false);
        foreach (string state in new string[] { "running", "waiting", "selected", "unknown" })
            Present(History(form), "KEEP_" + state, true);
    }
    static void Identities(Form form) {
        Apply(form, Snapshot(
            Host("HOST_EARLY", "running", "SIMULATED_SHARED"),
            Host("HOST_END", "returned", "SIMULATED_SHARED"),
            Agent("AGENT_SAME_RAW", "running", "SIMULATED_SHARED"),
            Agent("AGENT_EARLY", "selected", "SIMULATED_AGENT_DONE"),
            Agent("AGENT_END", "failed", "SIMULATED_AGENT_DONE"),
            Host("HOST_SAME_RAW", "waiting", "SIMULATED_AGENT_DONE"),
            Row("HOST_OTHER_CALL", "running", "codex-observer", "SIMULATED_OTHER_CALL", "SIMULATED_SHARED_SELECTION"),
            Row("HOST_SHARED_SELECTION_END", "denied", "codex-observer", "SIMULATED_DONE_CALL", "SIMULATED_SHARED_SELECTION"),
            Row("AGENT_OTHER_SELECTION", "waiting", "agent_reported", "SIMULATED_SHARED_CALL", "SIMULATED_OTHER_SELECTION"),
            Row("AGENT_SHARED_CALL_END", "cancelled", "agent_reported", "SIMULATED_SHARED_CALL", "SIMULATED_DONE_SELECTION"),
            Row("HOST_DIFFERENT_SELECTION", "selected", "codex-observer", "SIMULATED_SHARED", "SIMULATED_DISTINCT"),
            Row("AGENT_DIFFERENT_CALL", "running", "agent_reported", "SIMULATED_DISTINCT", "SIMULATED_AGENT_DONE")
        ));
        Toggle(form, true);
        foreach (string marker in new string[] {
            "HOST_EARLY", "HOST_END", "AGENT_EARLY", "AGENT_END",
            "HOST_SHARED_SELECTION_END", "AGENT_SHARED_CALL_END",
            "HOST_DIFFERENT_SELECTION", "AGENT_DIFFERENT_CALL"
        }) Present(History(form), marker, false);
        foreach (string marker in new string[] {
            "AGENT_SAME_RAW", "HOST_SAME_RAW", "HOST_OTHER_CALL", "AGENT_OTHER_SELECTION"
        }) Present(History(form), marker, true);
    }
    static void HostScopes(Form form) {
        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
        rows.Add(Host("SCOPE_EARLY", "running", "SIMULATED_SCOPE_CALL"));
        rows.Add(Host("SCOPE_END", "returned", "SIMULATED_SCOPE_CALL"));
        rows.Add(ScopedHost("OTHER_THREAD", "running", "SIMULATED_SCOPE_CALL",
            "SIMULATED_OTHER_THREAD", "SIMULATED_TURN", "SIMULATED_HOST_TOOL"));
        rows.Add(ScopedHost("OTHER_TURN", "running", "SIMULATED_SCOPE_CALL",
            "SIMULATED_THREAD", "SIMULATED_OTHER_TURN", "SIMULATED_HOST_TOOL"));
        rows.Add(ScopedHost("OTHER_CAPABILITY", "running", "SIMULATED_SCOPE_CALL",
            "SIMULATED_THREAD", "SIMULATED_TURN", "SIMULATED_OTHER_TOOL"));
        rows.Add(ScopedHost("NULL_TURN_EARLY", "running", "SIMULATED_NULL_TURN_CALL",
            "SIMULATED_THREAD", null, "SIMULATED_HOST_TOOL"));
        rows.Add(ScopedHost("NULL_TURN_END", "returned", "SIMULATED_NULL_TURN_CALL",
            "SIMULATED_THREAD", null, "SIMULATED_HOST_TOOL"));
        rows.Add(Host("NONNULL_TURN", "running", "SIMULATED_NULL_TURN_CALL"));
        foreach (string field in new string[] { "threadId", "capabilityId", "callId" })
            foreach (string shape in new string[] { "missing", "empty" }) {
                string marker = "INCOMPLETE_" + field + "_" + shape;
                Dictionary<string, object> running = Host(marker + "_RUN", "running", "SIMULATED_" + marker);
                Dictionary<string, object> ended = Host(marker + "_END", "returned", "SIMULATED_" + marker);
                if (shape == "missing") {
                    running.Remove(field);
                    ended.Remove(field);
                } else {
                    running[field] = "";
                    ended[field] = "";
                }
                rows.Add(running);
                rows.Add(ended);
            }
        Apply(form, Snapshot(rows.ToArray()));
        foreach (Dictionary<string, object> row in rows)
            Check(History(form).Contains((string)row["toolName"]),
                "default retains " + row["toolName"]);
        Toggle(form, true);
        foreach (string marker in new string[] {
            "SCOPE_EARLY", "SCOPE_END", "NULL_TURN_EARLY", "NULL_TURN_END"
        }) Present(History(form), marker, false);
        foreach (string marker in new string[] {
            "OTHER_THREAD", "OTHER_TURN", "OTHER_CAPABILITY", "NONNULL_TURN"
        }) Present(History(form), marker, true);
        foreach (string field in new string[] { "threadId", "capabilityId", "callId" })
            foreach (string shape in new string[] { "missing", "empty" }) {
                Present(History(form), "INCOMPLETE_" + field + "_" + shape + "_RUN", true);
                Present(History(form), "INCOMPLETE_" + field + "_" + shape + "_END", false);
            }
    }
    static void Anonymous(Form form) {
        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
        foreach (string source in new string[] { "codex-observer", "agent_reported" }) {
            foreach (string state in Terminal)
                rows.Add(Row("ANON_" + source + "_" + state, state, source, null, null));
            foreach (string state in new string[] { "running", "waiting", "unknown" })
                rows.Add(Row("ANON_" + source + "_" + state, state, source, null, null));
        }
        Apply(form, Snapshot(rows.ToArray()));
        Toggle(form, true);
        foreach (Dictionary<string, object> row in rows)
            Check(History(form).Contains((string)row["toolName"]) ==
                !Array.Exists(Terminal, delegate(string s) { return s == (string)row["state"]; }),
                "anonymous row handled only by explicit state: " + row["toolName"]);
    }
    static void Summaries(Form form) {
        Toggle(form, true);
        foreach (string mode in new string[] { "advisor", "desktop" })
            foreach (string state in Terminal) {
                Dictionary<string, object> snapshot = Snapshot(Agent("UNRELATED_HISTORY", "running", "SIMULATED_UNRELATED"));
                snapshot["displayMode"] = mode;
                snapshot["current"] = Current("TERMINAL_CURRENT", state, "SIMULATED_TERMINAL_CURRENT");
                snapshot["hostCurrent"] = Host("TERMINAL_HOST", state, "SIMULATED_TERMINAL_HOST");
                Apply(form, snapshot);
                string summary = Summary(form);
                Present(summary, "TERMINAL_CURRENT", false);
                Present(summary, "TERMINAL_HOST", false);
                Check(Regex.IsMatch(summary, L(@"(?is)(hid(?:e|den).*?(end|complet)|(end|complet).*?hid(?:e|den))",
                    @"(隐藏.*(结束|完成)|(结束|完成).*隐藏)")), mode + "/" + state + " honest hidden-item message");
                Check(!Regex.IsMatch(summary, L(@"(?is)no\s+(running|active)\s+(work|tasks?|calls?)",
                    @"没有.*(运行|任务)|无运行")), "hidden summary must not claim chat-wide inactivity");
                Present(History(form), "UNRELATED_HISTORY", true);
                Present(History(form), "SCOPE_ONLY", true);
                Present(History(form), "LAST_READ", true);
                Check(Field<Label>(form, "observer").Text.Contains(L("Observing", "观察中")),
                    "observation status retained");
                Check(History(form).Contains(L("Covered turns: 7", "覆盖轮数：7")),
                    "observation coverage retained");
            }
    }
    static void Restore(Form form) {
        Dictionary<string, object> first = Snapshot(
            Agent("FIRST_DONE", "succeeded", "SIMULATED_FIRST_DONE"),
            Agent("FIRST_ACTIVE", "running", "SIMULATED_FIRST_ACTIVE"));
        first["current"] = Current("FIRST_SUMMARY", "failed", "SIMULATED_FIRST_SUMMARY");
        string supplied = Json.Serialize(first);
        Apply(form, first);
        string full = History(form), summary = Summary(form);
        Toggle(form, true);
        Present(History(form), "FIRST_DONE", false);
        Toggle(form, false);
        Check(History(form) == full && Summary(form) == summary, "unchecking restores original history and summary");
        Check(Json.Serialize(first) == supplied, "toggling preserves first supplied snapshot");
        Toggle(form, true);
        Dictionary<string, object> second = Snapshot(
            Agent("LATEST_DONE", "returned", "SIMULATED_LATEST_DONE"),
            Agent("LATEST_ACTIVE", "waiting", "SIMULATED_LATEST_ACTIVE"));
        second["current"] = Current("LATEST_SUMMARY", "cancelled", "SIMULATED_LATEST_SUMMARY");
        supplied = Json.Serialize(second);
        TextBox history = Field<TextBox>(form, "history");
        history.Select(3, 5);
        Apply(form, second);
        Check(history.SelectionStart == 3 && history.SelectionLength == 5, "history update retains text selection");
        Present(History(form), "LATEST_ACTIVE", true);
        Present(History(form), "LATEST_DONE", false);
        Present(History(form), "FIRST_ACTIVE", false);
        Toggle(form, false);
        Present(History(form), "LATEST_DONE", true);
        Present(Summary(form), "LATEST_SUMMARY", true);
        Present(History(form), "FIRST_DONE", false);
        string restored = History(form), restoredSummary = Summary(form);
        Apply(form, second);
        Check(History(form) == restored && Summary(form) == restoredSummary,
            "restored latest snapshot equals unfiltered rendering");
        Check(Json.Serialize(second) == supplied, "new snapshot and toggles leave supplied input unchanged");
    }
    static void ClosePath(Form form) {
        Button close = Field<Button>(form, "closeWindow");
        IntPtr handle = form.Handle;
        bool closed = false;
        form.FormClosed += delegate { closed = true; };
        Click(close);
        Check(closed && form.IsDisposed, "closeWindow invokes actual Form.Close and disposes the form");
    }
    static void Layout(Form form, bool scaled) {
        CheckBox hide = Field<CheckBox>(form, "hideEnded");
        Button close = Field<Button>(form, "closeWindow");
        Button expand = Field<Button>(form, "expand");
        Check(hide.Text == L("Hide ended", "隐藏已结束"), "localized hideEnded label");
        Check(close.Text == L("Close window", "关闭浮窗"), "localized closeWindow label");
        if (scaled) {
            form.AutoScaleMode = AutoScaleMode.None;
            form.Scale(new SizeF(1.5F, 1.5F));
            form.Font = new Font(form.Font.FontFamily, form.Font.Size * 1.5F);
        }
        List<Control> bottom = new List<Control>();
        foreach (Control control in form.Controls)
            if (control is CheckBox || control is Button) bottom.Add(control);
        Check(bottom.Count >= 4, "top, hide, close and expand controls retained");
        for (int phase = 0; phase < 3; phase++) {
            form.PerformLayout();
            foreach (Control control in bottom) {
                Check(control.Enabled, "bottom control enabled: " + control.Text);
                Check(form.ClientRectangle.Contains(control.Bounds), "bottom control contained: " + control.Text);
                int chrome = control is CheckBox ? 24 : 12;
                Size needed = TextRenderer.MeasureText(control.Text, control.Font,
                    new Size(Math.Max(1, control.ClientSize.Width - control.Padding.Horizontal - chrome), Int32.MaxValue),
                    TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl);
                Check(needed.Height <= control.ClientSize.Height - control.Padding.Vertical,
                    "bottom caption fits: " + control.Text);
            }
            for (int i = 0; i < bottom.Count; i++)
                for (int j = i + 1; j < bottom.Count; j++)
                    Check(!bottom[i].Bounds.IntersectsWith(bottom[j].Bounds),
                        "bottom controls do not overlap: " + bottom[i].Text + "/" + bottom[j].Text);
            if (phase == 2) break;
            Rectangle area = Screen.FromControl(form).WorkingArea;
            form.Location = new Point(area.Right - form.Width, area.Bottom - form.Height);
            Click(expand);
            Check(area.Contains(form.Bounds), "expansion/collapse keeps outer frame within working area");
            if (phase == 0)
                Check(Field<TextBox>(form, "history").ClientSize.Height > 0,
                    "expanded history has usable height");
        }
        Apply(form, Snapshot(Agent("LAYOUT_ENDED", "returned", "SIMULATED_LAYOUT")));
        Toggle(form, true);
        Present(History(form), "LAYOUT_ENDED", false);
        Toggle(form, false);
        Present(History(form), "LAYOUT_ENDED", true);
    }
    static void Run(string name, Action<Form> action) {
        Errors = new List<string>();
        Form form = null;
        try {
            form = (Form)Activator.CreateInstance(typeof(AgentStatusWindow), true);
            action(form);
        } catch (Exception error) {
            Exception actual = error is TargetInvocationException && error.InnerException != null
                ? error.InnerException : error;
            Errors.Add(actual.Message);
        } finally {
            if (form != null && !form.IsDisposed) {
                Timer timer = Field<Timer>(form, "timer");
                timer.Stop(); timer.Dispose(); form.Dispose();
            }
        }
        Console.WriteLine(Json.Serialize(new { scenario = name, errors = Errors }));
    }
    [STAThread] static void Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        English = args[0] == "en";
        Run("terminal-groups", Groups);
        Run("source-identities", Identities);
        Run("host-scope-identities", HostScopes);
        Run("anonymous-rows", Anonymous);
        Run("terminal-summaries", Summaries);
        Run("restore-latest-and-input", Restore);
        Run("close-path", ClosePath);
        Run("layout-normal", delegate(Form form) { Layout(form, false); });
        Run("layout-controlled-150-percent", delegate(Form form) { Layout(form, true); });
    }
}
`;

test("single-window controls filter SIMULATED snapshots and close hidden owned forms", {
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
  const directory = await mkdtemp(path.join(resolvedCache, "owned-single-window-controls-"));
  const owned = await realpath(directory);
  const isOwned = value =>
    /^owned-single-window-controls-[^\\/]+$/.test(path.relative(resolvedCache, value));
  assert.ok(isOwned(owned));
  try {
    const source = path.join(owned, "Probe.cs");
    const executable = path.join(owned, "Probe.exe");
    await writeFile(source, probeSource, "utf8");
    const compiled = spawnSync(compiler, [
      "/nologo", "/target:exe", "/langversion:5", "/codepage:65001", "/main:Probe",
      "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
      "/reference:System.Web.Extensions.dll", `/out:${executable}`,
      path.join(project, "src", "status-window", "AgentStatusWindow.cs"), source
    ], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
    assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stdout + compiled.stderr);
    for (const language of ["en", "zh-CN"]) {
      await t.test(language, async t => {
        const run = spawnSync(executable, [language], {
          env: { ...process.env, ATC_UI_LANGUAGE: language },
          encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024
        });
        assert.equal(run.status, 0, run.error?.message ?? run.stderr);
        const results = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.deepEqual(results.map(result => result.scenario), scenarios);
        for (const result of results)
          await t.test(result.scenario, () => assert.deepEqual(result.errors, []));
      });
    }
  } finally {
    assert.equal(await realpath(cache), resolvedCache);
    const current = await realpath(directory);
    assert.equal(current, owned);
    assert.ok(isOwned(current));
    await rm(current, { recursive: true, force: true });
  }
});
