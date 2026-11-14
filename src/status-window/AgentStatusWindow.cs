using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class AgentStatusWindow : Form
{
    private static readonly bool English =
        Environment.GetEnvironmentVariable("ATC_UI_LANGUAGE") == "en";

    private static string T(string en, string zh)
    {
        return English ? en : zh;
    }

    private readonly Label task = new Label();
    private readonly Label capabilities = new Label();
    private readonly Label status = new Label();
    private readonly Label elapsed = new Label();
    private readonly Label observer = new Label();
    private readonly TextBox history = new TextBox();
    private readonly Button expand = new Button();
    private readonly CheckBox hideEnded = new CheckBox();
    private readonly Button closeWindow = new Button();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly object gate = new object();
    private Dictionary<string, object> latest;
    private Dictionary<string, object> displayedSnapshot;
    private Dictionary<string, object> current;
    private Dictionary<string, object> hostCurrent;
    private bool desktopMode;
    private bool scheduled;
    private bool closing;
    private bool expanded;
    private bool summaryHidden;

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new AgentStatusWindow());
    }

    private AgentStatusWindow()
    {
        Text = T("Agent task status", "Agent 任务状态");
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        TopMost = true;
        try { Font = new Font("Microsoft YaHei UI", 9F); } catch { Font = SystemFonts.MessageBoxFont; }
        ClientSize = new Size(660, 386);
        task.SetBounds(12, 12, 636, 48);
        task.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        capabilities.SetBounds(12, 62, 636, 96);
        capabilities.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        capabilities.AutoEllipsis = true;
        status.SetBounds(12, 160, 636, 100);
        status.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        elapsed.SetBounds(12, 262, 636, 28);
        elapsed.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        observer.SetBounds(12, 292, 636, 48);
        observer.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        observer.AutoEllipsis = true;
        CheckBox top = new CheckBox();
        top.Text = T("Always on top", "置顶");
        top.Checked = true;
        top.SetBounds(12, 346, 130, 30);
        top.CheckedChanged += delegate { TopMost = top.Checked; };
        hideEnded.Text = T("Hide ended", "隐藏已结束");
        hideEnded.SetBounds(148, 346, 180, 30);
        hideEnded.CheckedChanged += delegate {
            if (displayedSnapshot != null) RenderSnapshot(displayedSnapshot);
        };
        closeWindow.Text = T("Close window", "关闭浮窗");
        closeWindow.SetBounds(334, 346, 152, 30);
        closeWindow.Click += delegate { Close(); };
        expand.Text = T("Expand history", "展开记录");
        expand.SetBounds(498, 346, 150, 30);
        expand.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        expand.Click += delegate {
            expanded = !expanded;
            float scale = expand.Height / 30F;
            Rectangle area = Screen.FromControl(this).WorkingArea;
            Size frame = new Size(Width - ClientSize.Width, Height - ClientSize.Height);
            Size = new Size(
                Math.Max(1, Math.Min(area.Width,
                    (int)Math.Ceiling((expanded ? 780 : 660) * scale) + frame.Width)),
                Math.Max(1, Math.Min(area.Height,
                    (int)Math.Ceiling((expanded ? 720 : 386) * scale) + frame.Height)));
            Location = new Point(
                Math.Max(area.Left, Math.Min(Left, area.Right - Width)),
                Math.Max(area.Top, Math.Min(Top, area.Bottom - Height)));
            expand.Text = expanded ? T("Collapse", "收起") : T("Expand history", "展开记录");
            history.Visible = expanded;
        };
        history.SetBounds(12, 394, 636, 0);
        history.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        history.Multiline = true;
        history.ReadOnly = true;
        history.WordWrap = false;
        history.ScrollBars = ScrollBars.Both;
        history.Visible = false;
        Controls.AddRange(new Control[] { task, capabilities, status, elapsed, observer, top, hideEnded, closeWindow, expand, history });
        ClientSizeChanged += delegate {
            history.Height = Math.Max(0, ClientSize.Height - history.Top - task.Left);
        };
        task.Text = T("Task: Unknown", "任务：未知");
        capabilities.Text = T("Selected: Unknown\r\nActual: Unknown", "所选：未知\r\n实际：未知");
        observer.Text = T("Real host observation: Not connected", "真实宿主观察：未连接");
        elapsed.Text = T("Self-reported elapsed (including waits): Unknown", "自报经过（含等待）：未知");
        timer.Interval = 1000;
        timer.Tick += delegate { UpdateElapsed(); };
        timer.Start();
        Shown += delegate {
            Thread reader = new Thread(ReadInput);
            reader.IsBackground = true;
            reader.Start();
        };
        FormClosed += delegate {
            lock (gate) { closing = true; latest = null; }
            timer.Stop();
            timer.Dispose();
        };
    }

    private static Dictionary<string, object> Map(object value)
    {
        return value as Dictionary<string, object>;
    }

    private static object Get(Dictionary<string, object> data, string key)
    {
        object value;
        return data != null && data.TryGetValue(key, out value) ? value : null;
    }

    private static string TextOf(Dictionary<string, object> data, string key)
    {
        string value = Get(data, key) as string;
        return value == null || value.Length > 160 ? T("Unknown", "未知") : value;
    }

    private static string State(string value)
    {
        switch (value)
        {
            case "selected": return T("Selected (execution unknown)", "已选择（执行未知）");
            case "needs_check": return T("Needs verification", "待核验");
            case "running": return T("Running", "运行中");
            case "waiting": return T("Waiting", "等待");
            case "cancelled": return T("Cancellation recorded", "已记录取消");
            case "succeeded": return T("Succeeded", "成功");
            case "failed": return T("Failed", "失败");
            case "not_run": return T("Not run", "未执行");
            case "returned": return T("Returned", "已返回");
            case "recorded": return T("Recorded", "已记录");
            case "denied": return T("Denied", "已拒绝");
            case "observing": return T("Observing", "观察中");
            case "starting": return T("Connecting", "连接中");
            case "stopping": return T("Stopping", "停止中");
            case "stopped": return T("Stopped", "已停止");
            case "error": return T("Observation failed", "观察失败");
            case "unconnected": return T("Not connected", "未连接");
            default: return T("Unknown", "未知");
        }
    }

    private static string Reason(string value)
    {
        switch (value)
        {
            case "none": return T("None", "无");
            case "awaiting_tool": return T("Waiting for tool", "等待工具");
            case "awaiting_user": return T("Waiting for user", "等待用户");
            case "permission_required": return T("Waiting for approval (permission required)", "等待许可");
            case "dependency_unavailable": return T("Dependency unavailable", "依赖不可用");
            case "tool_error": return T("Tool error", "工具错误");
            case "user_cancelled": return T("User cancelled", "用户取消");
            default: return T("Unknown", "未知");
        }
    }

    private static string Quality(string value)
    {
        return value == "meets_requirement" ? T("Meets requirements", "符合要求") :
            value == "does_not_meet" ? T("Does not meet requirements", "不符合要求") :
            T("Not assessed", "未评价");
    }

    private static string SourceScope(Dictionary<string, object> item)
    {
        return TextOf(item, "scope") == "thread_tail"
            ? T("This chat's tail · Turn unknown", "本聊天末尾 · 轮次未知")
            : T("Latest 20 turns", "最近20轮");
    }

    private static string HostTool(Dictionary<string, object> item)
    {
        string server = Get(item, "serverName") as string;
        string tool = Get(item, "toolName") as string;
        if (server != null && tool != null) return server + " / " + tool;
        return tool ?? TextOf(item, "capabilityId");
    }

    private static string SourceDuration(Dictionary<string, object> item)
    {
        object value = Get(item, "durationMs");
        return value == null ? T("Unknown", "未知") :
            Convert.ToString(value, CultureInfo.InvariantCulture) + " ms";
    }

    private static bool IsTerminal(Dictionary<string, object> item)
    {
        switch (Get(item, "state") as string)
        {
            case "succeeded":
            case "failed":
            case "cancelled":
            case "not_run":
            case "returned":
            case "denied": return true;
            default: return false;
        }
    }

    private static string Identity(Dictionary<string, object> item, bool host)
    {
        if (!host)
        {
            string selection = Get(item, "selectionId") as string;
            return string.IsNullOrWhiteSpace(selection) ? null : "agent:" + selection;
        }
        string thread = Get(item, "threadId") as string;
        string capability = Get(item, "capabilityId") as string;
        string call = Get(item, "callId") as string;
        object turn;
        if (string.IsNullOrWhiteSpace(thread) || string.IsNullOrWhiteSpace(capability) ||
            string.IsNullOrWhiteSpace(call) || item == null ||
            !item.TryGetValue("turnId", out turn) || (turn != null && !(turn is string)))
            return null;
        return "host:" + new JavaScriptSerializer().Serialize(
            new object[] { thread, turn, capability, call });
    }

    private static void AddEnded(HashSet<string> ended, Dictionary<string, object> item, bool host)
    {
        if (!IsTerminal(item)) return;
        string identity = Identity(item, host);
        if (identity != null) ended.Add(identity);
    }

    private bool IsHidden(Dictionary<string, object> item, bool host, HashSet<string> ended)
    {
        if (!hideEnded.Checked) return false;
        string identity = Identity(item, host);
        return IsTerminal(item) || (identity != null && ended.Contains(identity));
    }

    private void ReadInput()
    {
        try
        {
            using (StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true)))
            {
                JavaScriptSerializer parser = new JavaScriptSerializer();
                parser.MaxJsonLength = 102400;
                parser.RecursionLimit = 24;
                StringBuilder line = new StringBuilder();
                bool oversized = false;
                int character;
                while ((character = input.Read()) != -1)
                {
                    if (character != '\n')
                    {
                        if (!oversized && line.Length < 102400) line.Append((char)character);
                        else { oversized = true; line.Length = 0; }
                        continue;
                    }
                    if (!oversized)
                    {
                        try
                        {
                            Dictionary<string, object> snapshot = Map(parser.DeserializeObject(line.ToString()));
                            if (snapshot != null) QueueSnapshot(snapshot);
                        }
                        catch { /* Malformed data is not displayed. */ }
                    }
                    oversized = false;
                    line.Length = 0;
                }
            }
        }
        catch { /* Fixed failure behavior: close the display without diagnostic contents. */ }
        try { if (!IsDisposed) BeginInvoke(new Action(Close)); } catch { }
    }

    private void QueueSnapshot(Dictionary<string, object> snapshot)
    {
        lock (gate)
        {
            if (closing) return;
            latest = snapshot;
            if (scheduled) return;
            scheduled = true;
        }
        try { BeginInvoke(new Action(ApplyLatest)); }
        catch { lock (gate) { scheduled = false; latest = null; } }
    }

    private void ApplyLatest()
    {
        Dictionary<string, object> snapshot;
        lock (gate)
        {
            if (closing) return;
            snapshot = latest;
            latest = null;
            scheduled = false;
        }
        if (snapshot == null) return;
        displayedSnapshot = snapshot;
        RenderSnapshot(snapshot);
    }

    private void RenderSnapshot(Dictionary<string, object> snapshot)
    {
        try
        {
            current = Map(Get(snapshot, "current"));
            desktopMode = TextOf(snapshot, "displayMode") == "desktop";
            hostCurrent = Map(Get(snapshot, "hostCurrent"));
            IEnumerable entries = Get(snapshot, "history") as IEnumerable;
            HashSet<string> ended = new HashSet<string>(StringComparer.Ordinal);
            if (hideEnded.Checked)
            {
                AddEnded(ended, current, false);
                AddEnded(ended, hostCurrent, true);
                if (entries != null)
                {
                    int scanned = 0;
                    foreach (object entry in entries)
                    {
                        if (++scanned > 100) break;
                        Dictionary<string, object> item = Map(entry);
                        AddEnded(ended, item, TextOf(item, "source") == "codex-observer");
                    }
                }
            }
            bool agentHidden = IsHidden(current, false, ended);
            summaryHidden = desktopMode ? IsHidden(hostCurrent, true, ended) : agentHidden;
            task.Text = T("Task: ", "任务：") + TextOf(current, "taskLabel");
            capabilities.Text = (Get(current, "switchFromName") is string
                ? T("Switched: ", "换选：") + TextOf(current, "switchFromName") + " → " +
                    TextOf(current, "selectedCapabilityName")
                : T("Selected: ", "所选：") + TextOf(current, "selectedCapabilityName")) +
                T("\r\nActual: ", "\r\n实际：") + TextOf(current, "actualCapabilityName");
            string quality = TextOf(current, "quality");
            string qualityText = Quality(quality);
            object match = Get(current, "matchesSelection");
            status.Text = T("Agent self-report · ", "Agent自报 · ") + State(TextOf(current, "state")) +
                T(" · Reason: ", " · 原因：") + Reason(TextOf(current, "reason")) +
                T("\r\nQuality: ", "\r\n质量：") + qualityText +
                T(" · Matches selection: ", " · 采用一致：") +
                (match is bool ? ((bool)match ? T("Yes", "是") : T("No", "否")) : T("Unknown", "未知"));
            if (Get(current, "cancelledAt") is string)
                status.Text += T(" · Cancellation recorded (does not trigger host interruption)",
                    " · 曾记录取消（不代表宿主中断）");
            if (desktopMode)
            {
                task.Text = T("Latest real call record", "最近真实调用记录");
                capabilities.Text = T("Tool: ", "工具：") + HostTool(hostCurrent) +
                    T("\r\nCall: ", "\r\n调用：") + TextOf(hostCurrent, "callId");
                status.Text = T("Real host observation · ", "真实宿主观察 · ") +
                    State(TextOf(hostCurrent, "state")) +
                    T("\r\nScope: ", "\r\n范围：") + SourceScope(hostCurrent) +
                    (hostCurrent == null || TextOf(hostCurrent, "ordering") == "unknown"
                        ? T(" · Ordering unknown", " · 先后未知") : "");
            }
            if (summaryHidden)
            {
                task.Text = T("Latest ended summary hidden", "最近已结束摘要已隐藏");
                capabilities.Text = "";
                status.Text = "";
            }
            Dictionary<string, object> source = Map(Get(snapshot, "observer"));
            Dictionary<string, object> coverage = Map(Get(source, "coverage"));
            Dictionary<string, object> raw = Map(Get(coverage, "raw"));
            observer.Text = T("Real host observation: ", "真实宿主观察：") +
                State(TextOf(source, "state")) +
                T(" · Last read: ", " · 最近读取：") + TextOf(source, "lastReadAt");
            StringBuilder records = new StringBuilder();
            if (desktopMode)
            {
                if (agentHidden)
                    records.AppendLine(T("Latest ended summary hidden", "最近已结束摘要已隐藏"));
                else
                {
                records.AppendLine(T("Agent self-reported task: ", "Agent自报任务：") +
                    TextOf(current, "taskLabel"));
                records.AppendLine(T("Selected: ", "所选：") + TextOf(current, "selectedCapabilityName") +
                    T(" · Actual: ", " · 实际：") + TextOf(current, "actualCapabilityName"));
                records.AppendLine(T("Self-reported result: ", "自报结果：") +
                    State(TextOf(current, "state")) +
                    T(" · Reason: ", " · 原因：") + Reason(TextOf(current, "reason")) +
                    T(" · Quality: ", " · 质量：") + qualityText +
                    T(" · Matches selection: ", " · 采用一致：") +
                    (match is bool ? ((bool)match ? T("Yes", "是") : T("No", "否")) : T("Unknown", "未知")));
                records.AppendLine(T("Self-reported start: ", "自报开始：") + TextOf(current, "startedAt") +
                    T(" · Self-reported end: ", " · 自报结束：") + TextOf(current, "endedAt"));
                }
                records.AppendLine(T("The latest real call record does not mean only one call is running.",
                    "最近真实调用记录不代表只有一项调用正在运行。"));
                records.AppendLine();
            }
            records.AppendLine(T("Real host observation · Explicit scope: ", "真实宿主观察 · 明确范围：") +
                TextOf(source, "threadId"));
            records.AppendLine(T("Last read: ", "最近读取：") + TextOf(source, "lastReadAt") +
                T(" · Latest 20 turns / additional trailing 2 MiB; may be incomplete",
                    " · 最近20轮 / 补充末尾2MiB，可能不完整"));
            records.AppendLine(T("Covered turns: ", "覆盖轮数：") +
                Convert.ToString(Get(coverage, "turnCount"), CultureInfo.InvariantCulture) +
                T(" · Additional source available: ", " · 补充可用：") +
                Convert.ToString(Get(raw, "available"), CultureInfo.InvariantCulture) +
                T(" · Truncated: ", " · 截断：") +
                Convert.ToString(Get(raw, "truncated"), CultureInfo.InvariantCulture));
            records.AppendLine(T("Observation error: ", "观察错误：") + TextOf(source, "lastErrorCode") +
                T(" · Cleanup failed: ", " · 清理失败：") +
                Convert.ToString(Get(source, "cleanupFailed"), CultureInfo.InvariantCulture));
            if (desktopMode)
                records.AppendLine(T("This chat's tail records with unknown turn: ", "本聊天末尾轮次未知记录：") +
                    Convert.ToString(Get(raw, "unscopedItems"), CultureInfo.InvariantCulture));
            records.AppendLine(T("Tool returned does not mean success; an unknown source duration is not estimated from receive times.",
                "工具已返回不代表成功；源持续时间未知时不使用接收时间推算。"));
            int count = 0;
            if (entries != null)
            {
                foreach (object entry in entries)
                {
                    if (++count > 100) break;
                    Dictionary<string, object> item = Map(entry);
                    if (item == null) continue;
                    bool host = TextOf(item, "source") == "codex-observer";
                    if (IsHidden(item, host, ended)) continue;
                    records.AppendLine();
                    records.AppendLine((host ? T("Real host observation", "真实宿主观察") :
                        T("Agent self-report", "Agent自报")) + " · " +
                        State(TextOf(item, "state")) + " · " +
                        (host && desktopMode ? HostTool(item) :
                        host && !string.IsNullOrWhiteSpace(Get(item, "toolName") as string)
                            ? TextOf(item, "toolName") : TextOf(item, "capabilityId")));
                    if (host && desktopMode)
                    {
                        records.AppendLine(T("Scope: ", "范围：") + SourceScope(item) +
                            T(" · Turn: ", " · 轮次：") + TextOf(item, "turnId"));
                        records.AppendLine(T("Source start: ", "源开始：") + TextOf(item, "startedAt") +
                            T(" · Source end: ", " · 源结束：") + TextOf(item, "completedAt"));
                    }
                    records.AppendLine(T("Reason: ", "原因：") + Reason(TextOf(item, "reason")));
                    records.AppendLine(T("Received at: ", "接收时间：") + TextOf(item, "receivedAt") +
                        T(" · Source time: ", " · 源时间：") +
                        (host ? TextOf(item, "at") : T("Unknown", "未知")) +
                        T(" · Self-reported record time: ", " · 自报记录时间：") + TextOf(item, "recordedAt"));
                    records.AppendLine(T("Selection: ", "选择：") + TextOf(item, "selectionId") +
                        T(" · Call: ", " · 调用：") + TextOf(item, "callId") +
                        T(" · Reference: ", " · 引用：") + TextOf(item, "evidenceCallId"));
                    records.AppendLine(T("Source duration: ", "源持续时间：") +
                        (Get(item, "durationMs") == null ? T("Unknown", "未知") :
                        Convert.ToString(Get(item, "durationMs"), CultureInfo.InvariantCulture) + " ms") +
                        T(" · Quality: ", " · 质量：") + Quality(TextOf(item, "quality")) +
                        T(" · Matches selection: ", " · 一致：") +
                        Convert.ToString(Get(item, "matchesSelection"), CultureInfo.InvariantCulture));
                }
            }
            string renderedHistory = records.ToString();
            if (history.Text != renderedHistory)
            {
                int selectionStart = Math.Min(history.SelectionStart, renderedHistory.Length);
                int selectionLength = Math.Min(history.SelectionLength, renderedHistory.Length - selectionStart);
                history.Text = renderedHistory;
                history.Select(selectionStart, selectionLength);
                history.ScrollToCaret();
            }
            UpdateElapsed();
        }
        catch { /* Ignore malformed snapshots without displaying their contents. */ }
    }

    private void UpdateElapsed()
    {
        if (summaryHidden)
        {
            elapsed.Text = "";
            return;
        }
        if (desktopMode)
        {
            elapsed.Text = T("Source duration: ", "源持续时间：") + SourceDuration(hostCurrent);
            return;
        }
        DateTimeOffset start;
        DateTimeOffset end;
        if (!DateTimeOffset.TryParse(TextOf(current, "startedAt"), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out start))
        {
            elapsed.Text = T("Self-reported elapsed (including waits): Unknown", "自报经过（含等待）：未知");
            return;
        }
        if (!DateTimeOffset.TryParse(TextOf(current, "endedAt"), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out end)) end = DateTimeOffset.UtcNow;
        double seconds = Math.Max(0, (end - start).TotalSeconds);
        elapsed.Text = T("Self-reported elapsed (including waits): ", "自报经过（含等待）：") +
            Math.Floor(seconds).ToString(CultureInfo.InvariantCulture) + T(" seconds", " 秒");
    }
}
