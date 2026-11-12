using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class MultiChatWindow : Form
{
    private const int FrameLimit = 256 * 1024;
    private const long MaxSafeInteger = 9007199254740991L;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex Uuid = new Regex(
        @"\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z");
    private static readonly Regex Project = new Regex(
        @"\A[^\p{Cc}/\\]{1,60}\z");
    private static readonly Regex Tool = new Regex(
        @"\A[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}\z");
    private static readonly Regex ToolId = new Regex(
        @"\A[A-Za-z0-9][A-Za-z0-9_\-]{0,159}\z");
    private static readonly Regex Utc = new Regex(
        @"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z\z");
    private static readonly HashSet<string> Statuses = new HashSet<string>(new string[] {
        "connected", "running", "tool_running", "waiting", "idle",
        "interrupted", "ended", "unknown"
    }, StringComparer.Ordinal);
    private static readonly HashSet<string> LifecycleEvents = new HashSet<string>(new string[] {
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
        "PermissionRequest", "Stop", "Interrupt", "SessionEnd"
    }, StringComparer.Ordinal);

    private readonly TabControl tabs = new TabControl();
    private readonly FlowLayoutPanel tiles = new FlowLayoutPanel();
    private readonly Label empty = new Label();
    private readonly Label capacity = new Label();
    private readonly Dictionary<string, SessionView> views =
        new Dictionary<string, SessionView>(StringComparer.OrdinalIgnoreCase);
    private readonly object gate = new object();
    private Dictionary<string, object> latest;
    private bool scheduled;
    private bool closing;
    private bool activatePending;
    private long lastDisplayRequest;

    private sealed class SessionView
    {
        internal readonly TabPage Tab = new TabPage();
        internal readonly TextBox TabText = MakeTextBox();
        internal readonly Panel Tile = new Panel();
        internal readonly TextBox TileText = MakeTextBox();

        internal SessionView()
        {
            Tab.Controls.Add(TabText);
            Tile.BorderStyle = BorderStyle.FixedSingle;
            Tile.Size = new Size(420, 260);
            Tile.Margin = new Padding(6);
            Tile.Controls.Add(TileText);
        }
    }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MultiChatWindow());
    }

    private MultiChatWindow()
    {
        Text = "多聊天状态";
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.Sizable;
        ClientSize = new Size(900, 680);
        MinimumSize = new Size(600, 420);
        TopMost = true;
        try { Font = new Font("Microsoft YaHei UI", 9F); }
        catch { Font = SystemFonts.MessageBoxFont; }

        FlowLayoutPanel header = new FlowLayoutPanel();
        header.Dock = DockStyle.Top;
        header.Height = 72;
        header.WrapContents = true;
        RadioButton tabMode = new RadioButton();
        tabMode.Text = "标签视图";
        tabMode.AutoSize = true;
        RadioButton tileMode = new RadioButton();
        tileMode.Text = "并排视图";
        tileMode.AutoSize = true;
        tileMode.Checked = true;
        CheckBox top = new CheckBox();
        top.Text = "置顶";
        top.AutoSize = true;
        top.Checked = true;
        top.CheckedChanged += delegate { TopMost = top.Checked; };
        Label badge = new Label();
        badge.Text = "本机 Hook 元数据自报 / 不作为身份认证或权限依据";
        badge.AutoSize = true;
        badge.Margin = new Padding(12, 4, 4, 4);
        capacity.AutoSize = true;
        capacity.Margin = new Padding(12, 4, 4, 4);
        header.Controls.AddRange(new Control[] { tabMode, tileMode, top, badge, capacity });

        Panel content = new Panel();
        content.Dock = DockStyle.Fill;
        tabs.Dock = DockStyle.Fill;
        tiles.Dock = DockStyle.Fill;
        tiles.AutoScroll = true;
        tiles.WrapContents = true;
        tiles.Visible = false;
        bool sizingTiles = false;
        tiles.Layout += delegate {
            if (sizingTiles || tiles.Controls.Count == 0 ||
                tiles.ClientSize.Width <= 0 || tiles.ClientSize.Height <= 0) return;
            sizingTiles = true;
            Point scroll = tiles.AutoScrollPosition;
            tiles.SuspendLayout();
            try
            {
                Control first = tiles.Controls[0];
                float scaleX;
                float scaleY;
                using (Graphics graphics = tiles.CreateGraphics())
                {
                    scaleX = graphics.DpiX / 96F;
                    scaleY = graphics.DpiY / 96F;
                }
                int minWidth = (int)Math.Ceiling(260 * scaleX);
                int minHeight = (int)Math.Ceiling(130 * scaleY);
                int width = Math.Max(0, tiles.ClientSize.Width - tiles.Padding.Horizontal -
                    SystemInformation.VerticalScrollBarWidth);
                int height = Math.Max(0, tiles.ClientSize.Height - tiles.Padding.Vertical);
                int columns = width >= 2 * (minWidth + first.Margin.Horizontal) ? 2 : 1;
                int tileWidth = Math.Max(minWidth, width / columns - first.Margin.Horizontal);
                int tileHeight = Math.Max(minHeight, height / 2 - first.Margin.Vertical);
                foreach (Control tile in tiles.Controls)
                {
                    if (tile.Width != tileWidth || tile.Height != tileHeight)
                        tile.Size = new Size(tileWidth, tileHeight);
                }
            }
            finally
            {
                tiles.ResumeLayout(true);
                tiles.AutoScrollPosition = new Point(-scroll.X, -scroll.Y);
                sizingTiles = false;
            }
        };
        empty.Dock = DockStyle.Fill;
        empty.TextAlign = ContentAlignment.MiddleCenter;
        empty.Text = "等待聊天事件\r\n请确认 Codex Hooks 已加载并通过审核";
        content.Controls.Add(tabs);
        content.Controls.Add(tiles);
        content.Controls.Add(empty);
        Controls.Add(content);
        Controls.Add(header);

        tabMode.CheckedChanged += delegate {
            if (!tabMode.Checked) return;
            tabs.Visible = views.Count != 0;
            tiles.Visible = false;
        };
        tileMode.CheckedChanged += delegate {
            if (!tileMode.Checked) return;
            tabs.Visible = false;
            tiles.Visible = views.Count != 0;
        };
        Shown += delegate {
            Thread reader = new Thread(ReadInput);
            reader.IsBackground = true;
            reader.Start();
        };
        FormClosed += delegate {
            lock (gate) { closing = true; latest = null; }
        };
    }

    private static TextBox MakeTextBox()
    {
        TextBox text = new TextBox();
        text.Dock = DockStyle.Fill;
        text.Multiline = true;
        text.ReadOnly = true;
        text.ScrollBars = ScrollBars.Both;
        text.WordWrap = false;
        return text;
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

    private static bool Keys(Dictionary<string, object> data, params string[] keys)
    {
        if (data == null || data.Count != keys.Length) return false;
        foreach (string key in keys)
            if (!data.ContainsKey(key)) return false;
        return true;
    }

    private static bool Integer(object value, out long result)
    {
        result = 0;
        decimal number;
        if (value is int) number = (int)value;
        else if (value is long) number = (long)value;
        else if (value is decimal) number = (decimal)value;
        else return false;
        if (number < 0 || number > MaxSafeInteger || decimal.Truncate(number) != number)
            return false;
        result = (long)number;
        return true;
    }

    private static bool Date(object value)
    {
        string text = value as string;
        if (text == null || !Utc.IsMatch(text)) return false;
        DateTime parsed;
        return DateTime.TryParseExact(text,
            new string[] {
                "yyyy-MM-dd'T'HH:mm:ss'Z'",
                "yyyy-MM-dd'T'HH:mm:ss.f'Z'",
                "yyyy-MM-dd'T'HH:mm:ss.ff'Z'",
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'"
            },
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out parsed);
    }

    private static bool Match(object value, Regex pattern)
    {
        string text = value as string;
        return text != null && pattern.IsMatch(text);
    }

    private static bool NullableMatch(object value, Regex pattern)
    {
        return value == null || Match(value, pattern);
    }

    private static bool ValidHistory(object value)
    {
        object[] history = value as object[];
        if (history == null || history.Length > 20) return false;
        foreach (object entry in history)
        {
            Dictionary<string, object> item = Map(entry);
            if (!Keys(item, "event", "at", "toolName", "toolUseId") ||
                !(Get(item, "event") is string) ||
                !LifecycleEvents.Contains((string)Get(item, "event")) ||
                !Date(Get(item, "at")) ||
                !NullableMatch(Get(item, "toolName"), Tool) ||
                !NullableMatch(Get(item, "toolUseId"), ToolId)) return false;
        }
        return true;
    }

    private static bool ValidSession(object value)
    {
        Dictionary<string, object> session = Map(value);
        if (!Keys(session, "sessionId", "project", "status", "turnId", "source",
            "lastSeen", "toolName", "toolUseId", "history")) return false;
        string project = Get(session, "project") as string;
        string status = Get(session, "status") as string;
        return Match(Get(session, "sessionId"), Uuid) &&
            project != null && Project.IsMatch(project) && project != "." && project != ".." &&
            status != null && Statuses.Contains(status) &&
            NullableMatch(Get(session, "turnId"), Uuid) &&
            (Get(session, "source") as string) == "hook" &&
            Date(Get(session, "lastSeen")) &&
            NullableMatch(Get(session, "toolName"), Tool) &&
            NullableMatch(Get(session, "toolUseId"), ToolId) &&
            ValidHistory(Get(session, "history"));
    }

    internal static Dictionary<string, object> ParseSnapshot(string line)
    {
        try
        {
            if (line == null || line.Length > FrameLimit ||
                Utf8.GetByteCount(line) + 1 > FrameLimit) return null;
            JavaScriptSerializer parser = new JavaScriptSerializer();
            parser.MaxJsonLength = FrameLimit;
            parser.RecursionLimit = 24;
            Dictionary<string, object> snapshot = Map(parser.DeserializeObject(line));
            if (!Keys(snapshot, "kind", "version", "generatedAt", "displayRequest",
                "sessions", "capacity")) return null;
            long version;
            long displayRequest;
            if ((Get(snapshot, "kind") as string) != "multi_chat" ||
                !Integer(Get(snapshot, "version"), out version) || version != 1 ||
                !Date(Get(snapshot, "generatedAt")) ||
                !Integer(Get(snapshot, "displayRequest"), out displayRequest)) return null;
            object[] sessions = Get(snapshot, "sessions") as object[];
            if (sessions == null || sessions.Length > 16) return null;
            HashSet<string> ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object entry in sessions)
            {
                if (!ValidSession(entry) ||
                    !ids.Add((string)Get(Map(entry), "sessionId"))) return null;
            }
            Dictionary<string, object> capacity = Map(Get(snapshot, "capacity"));
            long maxSessions;
            if (!Keys(capacity, "maxSessions", "full") ||
                !Integer(Get(capacity, "maxSessions"), out maxSessions) || maxSessions != 16 ||
                !(Get(capacity, "full") is bool)) return null;
            return snapshot;
        }
        catch { return null; }
    }

    private void ReadInput()
    {
        try
        {
            using (Stream input = Console.OpenStandardInput())
            {
                byte[] buffer = new byte[8192];
                byte[] line = new byte[FrameLimit - 1];
                int length = 0;
                bool oversized = false;
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    for (int i = 0; i < count; i++)
                    {
                        byte current = buffer[i];
                        if (current == 10)
                        {
                            if (!oversized)
                            {
                                try
                                {
                                    Dictionary<string, object> snapshot =
                                        ParseSnapshot(Utf8.GetString(line, 0, length));
                                    if (snapshot != null) QueueSnapshot(snapshot);
                                }
                                catch { }
                            }
                            length = 0;
                            oversized = false;
                        }
                        else if (!oversized)
                        {
                            if (length < line.Length) line[length++] = current;
                            else { oversized = true; length = 0; }
                        }
                    }
                }
            }
        }
        catch { }
        try { if (!IsDisposed) BeginInvoke(new Action(Close)); }
        catch { }
    }

    private void QueueSnapshot(Dictionary<string, object> snapshot)
    {
        lock (gate)
        {
            if (closing) return;
            long request;
            Integer(Get(snapshot, "displayRequest"), out request);
            if (request > lastDisplayRequest) activatePending = true;
            if (request > lastDisplayRequest) lastDisplayRequest = request;
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
        bool activate;
        lock (gate)
        {
            if (closing) return;
            snapshot = latest;
            latest = null;
            activate = activatePending;
            activatePending = false;
            scheduled = false;
        }
        if (snapshot == null) return;
        object[] sessions = (object[])Get(snapshot, "sessions");
        HashSet<string> present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (object entry in sessions)
            present.Add((string)Get(Map(entry), "sessionId"));

        string selected = tabs.SelectedTab == null ? null : tabs.SelectedTab.Tag as string;
        Point tileScroll = tiles.AutoScrollPosition;
        List<string> removed = new List<string>();
        foreach (KeyValuePair<string, SessionView> pair in views)
        {
            if (!present.Contains(pair.Key))
            {
                tabs.TabPages.Remove(pair.Value.Tab);
                tiles.Controls.Remove(pair.Value.Tile);
                pair.Value.Tab.Dispose();
                pair.Value.Tile.Dispose();
                removed.Add(pair.Key);
            }
        }
        foreach (string id in removed) views.Remove(id);

        foreach (object entry in sessions)
        {
            Dictionary<string, object> session = Map(entry);
            string id = (string)Get(session, "sessionId");
            SessionView view;
            if (!views.TryGetValue(id, out view))
            {
                view = new SessionView();
                view.Tab.Tag = id;
                views.Add(id, view);
                tabs.TabPages.Add(view.Tab);
                tiles.Controls.Add(view.Tile);
            }
            string title = (string)Get(session, "project") + " · " +
                id.Substring(0, 8) + " · " + Status((string)Get(session, "status"));
            if (view.Tab.Text != title) view.Tab.Text = title;
            string details = Details(session);
            SetText(view.TabText, details);
            SetText(view.TileText, details);
        }
        SessionView selectedView;
        if (selected != null && views.TryGetValue(selected, out selectedView) &&
            tabs.SelectedTab != selectedView.Tab) tabs.SelectedTab = selectedView.Tab;
        if (tiles.AutoScrollPosition.X != tileScroll.X ||
            tiles.AutoScrollPosition.Y != tileScroll.Y)
            tiles.AutoScrollPosition = new Point(-tileScroll.X, -tileScroll.Y);

        bool hasSessions = sessions.Length != 0;
        empty.Visible = !hasSessions;
        if (hasSessions)
        {
            bool tileMode = false;
            foreach (Control control in ((FlowLayoutPanel)Controls[1]).Controls)
            {
                RadioButton radio = control as RadioButton;
                if (radio != null && radio.Text == "并排视图") tileMode = radio.Checked;
            }
            tabs.Visible = !tileMode;
            tiles.Visible = tileMode;
        }
        else { tabs.Visible = false; tiles.Visible = false; }
        Dictionary<string, object> cap = Map(Get(snapshot, "capacity"));
        capacity.Text = (bool)Get(cap, "full") ? "会话容量已满（16）" : "";
        if (activate)
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
    }

    private static void SetText(TextBox control, string text)
    {
        if (control.Text == text) return;
        int start = Math.Min(control.SelectionStart, text.Length);
        int length = Math.Min(control.SelectionLength, text.Length - start);
        control.Text = text;
        control.Select(start, length);
    }

    private static string Status(string status)
    {
        switch (status)
        {
            case "connected": return "已连接";
            case "running": return "运行中";
            case "tool_running": return "工具调用中";
            case "waiting": return "等待审批";
            case "idle": return "空闲";
            case "interrupted": return "已中断";
            case "ended": return "已结束";
            default: return "状态未知";
        }
    }

    private static string Value(Dictionary<string, object> data, string key)
    {
        return Get(data, key) as string ?? "未知";
    }

    private static string Details(Dictionary<string, object> session)
    {
        string id = (string)Get(session, "sessionId");
        StringBuilder text = new StringBuilder();
        text.AppendLine("任务名称：未知");
        text.AppendLine("项目：" + Value(session, "project"));
        text.AppendLine("会话：" + id.Substring(0, 8) + " · 完整 ID：" + id);
        text.AppendLine("状态：" + Status((string)Get(session, "status")));
        text.AppendLine("最近接收：" + Value(session, "lastSeen"));
        text.AppendLine("最近工具：" + Value(session, "toolName"));
        text.AppendLine("工具调用 ID：" + Value(session, "toolUseId"));
        text.AppendLine("轮次 ID：" + Value(session, "turnId"));
        text.AppendLine("事件记录：");
        foreach (object entry in (object[])Get(session, "history"))
        {
            Dictionary<string, object> item = Map(entry);
            string name = Value(item, "event");
            text.AppendLine(Value(item, "at") + " · " + name +
                (name == "PostToolUse" ? "（已返回，不代表成功）" : ""));
            text.AppendLine("  工具：" + Value(item, "toolName") +
                " · 调用 ID：" + Value(item, "toolUseId"));
        }
        return text.ToString();
    }
}
