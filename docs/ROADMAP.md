# Public roadmap / 公开路线

Agent Tool Center focuses on comparing similar capabilities, following a
choice, and checking actual adoption and task quality. This is a sequence of
work, not a release-date or host-coverage promise.

| State | Work | Evidence needed |
| --- | --- | --- |
| Available | Six metadata tools, session refresh, manual/recommend/auto, current-chat mode storage, optional Windows status windows, JSON Hook maintenance tools | See the usage and maintenance boundaries; connected hosts still need local verification. |
| Current | Reproducible first run and public delivery | Dependency-free local demo, clean-directory locked installation and tests, explicit skips; hosted CI must run separately. |
| Next | Broader host-visible catalog coverage | Decide capability-group versus individual-method granularity; report imported, missing, and unchecked entries within bounded resources. No silent truncation. |
| Next | More real task comparisons | At least two verified entries per case; actual artifact, selected versus adopted entry, and real user feedback recorded separately. |
| Later, as needed | Failure and compatibility coverage | Focused storage failure, concurrent-event, host-version, and display cases; no inference of universal support from one machine. |

Current limits: 256 total catalog entries, four candidates per comparison,
session-local external snapshots, Agent-reported readiness and quality. We do
not promise discovery of all internal Codex tools, a universal native-tool
interceptor, or automatic learning from past choices. ChatGPT integration and
native macOS/Linux GUI are not implemented.

目前优先把已有能力做成别人能复现的首次体验，再扩大当前宿主可见目录与真实任务
质量案例。收录、可用、选中、实际采用和用户满意分别核对；不会靠提高数量上限
宣称发现全部工具。全局 Hook 更新、卸载和回退需要具体审阅、备份与宿主验证，
隔离测试和真实文件预览不替代真实全局维护验收。

Want to help? Share a small reproducible similar-tool task or a documented host
compatibility case. See [Contributing](../CONTRIBUTING.md). Keep private chat
traces, credentials, and raw Hook input out of reports.

- [Usage](USAGE.md) · [Current-chat bridge](DESKTOP_BRIDGE.md)
- [Installation and maintenance](INSTALLATION.md) · [Security](../SECURITY.md)
