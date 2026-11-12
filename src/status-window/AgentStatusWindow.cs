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
    private readonly Label task = new Label();
    private readonly Label capabilities = new Label();
    private readonly Label status = new Label();
    private readonly Label elapsed = new Label();
    private readonly Label observer = new Label();
    private readonly TextBox history = new TextBox();
    private readonly Button expand = new Button();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly object gate = new object();
    private Dictionary<string, object> latest;
    private Dictionary<string, object> current;
    private Dictionary<string, object> hostCurrent;
    private bool desktopMode;
    private bool scheduled;
    private bool closing;
    private bool expanded;

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new AgentStatusWindow());
    }

    private AgentStatusWindow()
    {
        Text = "Agent 任务状态";
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        TopMost = true;
        try { Font = new Font("Microsoft YaHei UI", 9F); } catch { Font = SystemFonts.MessageBoxFont; }
        ClientSize = new Size(480, 220);
        task.SetBounds(12, 12, 450, 25);
        capabilities.SetBounds(12, 39, 450, 43);
        capabilities.AutoEllipsis = true;
        status.SetBounds(12, 84, 450, 42);
        elapsed.SetBounds(12, 128, 450, 23);
        observer.SetBounds(12, 152, 450, 34);
        observer.AutoEllipsis = true;
        CheckBox top = new CheckBox();
        top.Text = "置顶";
        top.Checked = true;
        top.SetBounds(12, 190, 80, 24);
        top.CheckedChanged += delegate { TopMost = top.Checked; };
        expand.Text = "展开记录";
        expand.SetBounds(350, 188, 110, 26);
        expand.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        expand.Click += delegate {
            expanded = !expanded;
            ClientSize = expanded ? new Size(620, 560) : new Size(480, 220);
            expand.Text = expanded ? "收起" : "展开记录";
            history.Visible = expanded;
        };
        history.SetBounds(12, 226, 596, 322);
        history.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        history.Multiline = true;
        history.ReadOnly = true;
        history.WordWrap = false;
        history.ScrollBars = ScrollBars.Both;
        history.Visible = false;
        Controls.AddRange(new Control[] { task, capabilities, status, elapsed, observer, top, expand, history });
        task.Text = "任务：未知";
        capabilities.Text = "所选：未知\r\n实际：未知";
        observer.Text = "真实宿主观察：未连接";
        elapsed.Text = "自报经过（含等待）：未知";
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
        return value == null || value.Length > 160 ? "未知" : value;
    }

    private static string State(string value)
    {
        switch (value)
        {
            case "selected": return "已选择（执行未知）";
            case "needs_check": return "待核验";
            case "running": return "运行中";
            case "waiting": return "等待";
            case "cancelled": return "已记录取消";
            case "succeeded": return "成功";
            case "failed": return "失败";
            case "not_run": return "未执行";
            case "returned": return "已返回";
            case "recorded": return "已记录";
            case "denied": return "已拒绝";
            case "observing": return "观察中";
            case "starting": return "连接中";
            case "stopping": return "停止中";
            case "stopped": return "已停止";
            case "error": return "观察失败";
            case "unconnected": return "未连接";
            default: return "未知";
        }
    }

    private static string Reason(string value)
    {
        switch (value)
        {
            case "none": return "无";
            case "awaiting_tool": return "等待工具";
            case "awaiting_user": return "等待用户";
            case "permission_required": return "等待许可";
            case "dependency_unavailable": return "依赖不可用";
            case "tool_error": return "工具错误";
            case "user_cancelled": return "用户取消";
            default: return "未知";
        }
    }

    private static string SourceScope(Dictionary<string, object> item)
    {
        return TextOf(item, "scope") == "thread_tail"
            ? "本聊天末尾 · 轮次未知" : "最近20轮";
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
        return value == null ? "未知" :
            Convert.ToString(value, CultureInfo.InvariantCulture) + " ms";
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
        try
        {
            current = Map(Get(snapshot, "current"));
            desktopMode = TextOf(snapshot, "displayMode") == "desktop";
            hostCurrent = Map(Get(snapshot, "hostCurrent"));
            task.Text = "任务：" + TextOf(current, "taskLabel");
            capabilities.Text = (Get(current, "switchFromName") is string
                ? "换选：" + TextOf(current, "switchFromName") + " → " + TextOf(current, "selectedCapabilityName")
                : "所选：" + TextOf(current, "selectedCapabilityName")) +
                "\r\n实际：" + TextOf(current, "actualCapabilityName");
            string quality = TextOf(current, "quality");
            string qualityText = quality == "meets_requirement" ? "符合要求" :
                quality == "does_not_meet" ? "不符合要求" : "未评价";
            object match = Get(current, "matchesSelection");
            status.Text = "Agent自报 · " + State(TextOf(current, "state")) +
                " · 原因：" + Reason(TextOf(current, "reason")) + "\r\n质量：" + qualityText +
                " · 采用一致：" + (match is bool ? ((bool)match ? "是" : "否") : "未知");
            if (Get(current, "cancelledAt") is string)
                status.Text += " · 曾记录取消（不代表宿主中断）";
            if (desktopMode)
            {
                task.Text = "最近真实调用记录";
                capabilities.Text = "工具：" + HostTool(hostCurrent) +
                    "\r\n调用：" + TextOf(hostCurrent, "callId");
                status.Text = "真实宿主观察 · " + State(TextOf(hostCurrent, "state")) +
                    "\r\n范围：" + SourceScope(hostCurrent) +
                    (hostCurrent == null || TextOf(hostCurrent, "ordering") == "unknown"
                        ? " · 先后未知" : "");
            }
            Dictionary<string, object> source = Map(Get(snapshot, "observer"));
            Dictionary<string, object> coverage = Map(Get(source, "coverage"));
            Dictionary<string, object> raw = Map(Get(coverage, "raw"));
            observer.Text = "真实宿主观察：" + State(TextOf(source, "state")) +
                " · 最近读取：" + TextOf(source, "lastReadAt");
            StringBuilder records = new StringBuilder();
            if (desktopMode)
            {
                records.AppendLine("Agent自报任务：" + TextOf(current, "taskLabel"));
                records.AppendLine("所选：" + TextOf(current, "selectedCapabilityName") +
                    " · 实际：" + TextOf(current, "actualCapabilityName"));
                records.AppendLine("自报结果：" + State(TextOf(current, "state")) +
                    " · 原因：" + Reason(TextOf(current, "reason")) +
                    " · 质量：" + qualityText +
                    " · 采用一致：" + (match is bool ? ((bool)match ? "是" : "否") : "未知"));
                records.AppendLine("自报开始：" + TextOf(current, "startedAt") +
                    " · 自报结束：" + TextOf(current, "endedAt"));
                records.AppendLine("最近真实调用记录不代表只有一项调用正在运行。");
                records.AppendLine();
            }
            records.AppendLine("真实宿主观察 · 明确范围：" + TextOf(source, "threadId"));
            records.AppendLine("最近读取：" + TextOf(source, "lastReadAt") + " · 最近20轮 / 补充末尾2MiB，可能不完整");
            records.AppendLine("覆盖轮数：" + Convert.ToString(Get(coverage, "turnCount"), CultureInfo.InvariantCulture) +
                " · 补充可用：" + Convert.ToString(Get(raw, "available"), CultureInfo.InvariantCulture) +
                " · 截断：" + Convert.ToString(Get(raw, "truncated"), CultureInfo.InvariantCulture));
            records.AppendLine("观察错误：" + TextOf(source, "lastErrorCode") +
                " · 清理失败：" + Convert.ToString(Get(source, "cleanupFailed"), CultureInfo.InvariantCulture));
            if (desktopMode)
                records.AppendLine("本聊天末尾轮次未知记录：" +
                    Convert.ToString(Get(raw, "unscopedItems"), CultureInfo.InvariantCulture));
            records.AppendLine("工具已返回不代表成功；源持续时间未知时不使用接收时间推算。");
            IEnumerable entries = Get(snapshot, "history") as IEnumerable;
            int count = 0;
            if (entries != null)
            {
                foreach (object entry in entries)
                {
                    if (++count > 100) break;
                    Dictionary<string, object> item = Map(entry);
                    if (item == null) continue;
                    bool host = TextOf(item, "source") == "codex-observer";
                    records.AppendLine();
                    records.AppendLine((host ? "真实宿主观察" : "Agent自报") + " · " +
                        State(TextOf(item, "state")) + " · " +
                        (host && desktopMode ? HostTool(item) :
                        host && !string.IsNullOrWhiteSpace(Get(item, "toolName") as string)
                            ? TextOf(item, "toolName") : TextOf(item, "capabilityId")));
                    if (host && desktopMode)
                    {
                        records.AppendLine("范围：" + SourceScope(item) +
                            " · 轮次：" + TextOf(item, "turnId"));
                        records.AppendLine("源开始：" + TextOf(item, "startedAt") +
                            " · 源结束：" + TextOf(item, "completedAt"));
                    }
                    records.AppendLine("原因：" + Reason(TextOf(item, "reason")));
                    records.AppendLine("接收时间：" + TextOf(item, "receivedAt") +
                        " · 源时间：" + (host ? TextOf(item, "at") : "未知") +
                        " · 自报记录时间：" + TextOf(item, "recordedAt"));
                    records.AppendLine("选择：" + TextOf(item, "selectionId") +
                        " · 调用：" + TextOf(item, "callId") + " · 引用：" + TextOf(item, "evidenceCallId"));
                    records.AppendLine("源持续时间：" + (Get(item, "durationMs") == null ? "未知" :
                        Convert.ToString(Get(item, "durationMs"), CultureInfo.InvariantCulture) + " ms") +
                        " · 质量：" + TextOf(item, "quality") +
                        " · 一致：" + Convert.ToString(Get(item, "matchesSelection"), CultureInfo.InvariantCulture));
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
        if (desktopMode)
        {
            elapsed.Text = "源持续时间：" + SourceDuration(hostCurrent);
            return;
        }
        DateTimeOffset start;
        DateTimeOffset end;
        if (!DateTimeOffset.TryParse(TextOf(current, "startedAt"), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out start))
        {
            elapsed.Text = "自报经过（含等待）：未知";
            return;
        }
        if (!DateTimeOffset.TryParse(TextOf(current, "endedAt"), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out end)) end = DateTimeOffset.UtcNow;
        double seconds = Math.Max(0, (end - start).TotalSeconds);
        elapsed.Text = "自报经过（含等待）：" + Math.Floor(seconds).ToString(CultureInfo.InvariantCulture) + " 秒";
    }
}
