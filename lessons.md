# 项目教训

实现、评审或验收前阅读相关条目；用户纠正、返工或漏验暴露可复用教训后补记。

## 记录模板

复制下列模板新增条目，已有同类条目则更新原条。未知的提交、原因或验收结果明确写“待核实”。
同一事件的多次修复、测试重跑不增加复发次数；只统计有独立证据的再次发生。
记录保留可复用的原因与证据定位；凭据、私人资料及完整日志留在各自获准的位置。

```markdown
### <教训标题>

**<一句话说明下次应遵守的规则。>**

- 起因与后果：<触发条件、原因、用户可感知的影响；关联 issue 或引入提交，未知则写待核实。>
- 修复与证据：<修复提交或 PR、回归检查与实际验收证据；区分已验证和未验证的部分。>
- 正确做法（Done right）：<下次的具体做法；链接到防复发代码、检查或所属规范。>
- 复发记录：Seen <N>x (<YYYY-MM-DD, ...>)；<每次独立发生的证据；修复提交数与重试次数不计入。>
```

### 桌面版可见会话（Automation 调度）不继承外部调用进程的环境变量

**入站任务经 ZCode.app 内部调度器启动可见会话时，不能仅靠环境变量向插件 Hook 传递 `job_id` 与回报配置，必须通过任务文本/标题内嵌标签与持久化 `session_id <-> job_id` 映射传递。**

- 起因与后果：引入提交 `0d4c447`（PR #2）将入站任务改为向 `tasks-index.sqlite` `automations` 写入单次任务交由 ZCode.app Host 创建可见会话；因会话进程由桌面端 Host 派生，不继承 `bin/zcode-dispatch-run` 的 `ZCODE_DISPATCH_JOB_ID` 和 `ZCODE_DISPATCH_NOTIFY`，导致 `hooks/stop-report.mjs` 在可见会话结束触发 Stop hook 时直接退出，无法写出报告与经 Yobiru 自动回报。
- 修复与证据：在 `lib/appsession.mjs` 与 `marketplace/plugins/zcode-dispatch/lib/job-map.mjs` 中把 `[job: <id>]` 嵌进任务 prompt 与会话标题，并在持久映射文件 `session-jobs.json` 中记录 `session_id <-> job_id`；`UserPromptSubmit` 与 `Stop` hook 通过映射表、prompt 标签及只读数据库兜底反查 `job_id` 并经 Yobiru 自动回报，由 `test/appsession.test.mjs` 与真机桌面会话端到端实测验证。
- 正确做法（Done right）：跨进程交给宿主应用调度的任务，凡需在插件 Hook 中关联外部请求上下文，统一写入任务标签与持久化状态映射（见 `marketplace/plugins/zcode-dispatch/lib/job-map.mjs` 和 `marketplace/plugins/zcode-dispatch/hooks/stop-report.mjs`），并在 `npm test` 中覆盖无环境变量场景下的 Hook 回报。
- 复发记录：Seen 1x (2026-10-15)；提交 `0d4c447` 后冒烟测试 `827d964c33e218c7` 完成但 `reports/` 为空。
