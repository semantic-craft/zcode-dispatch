# AGENTS

- Never print or commit keys. Only reference file paths / env var names (`~/.config/zcode-dispatch/key`, `ZCODE_DISPATCH_KEY`, `ZHIPU_CODING_API_KEY`).
- Keep ZCode's Yobiru wake adapter (private deploy, outside this public repo) separate from DSH's `dsh-wake`; never route zcode work through DSH's entry.
- Plugin changes: bump version in both `marketplace/marketplace.json` and the plugin's `plugin.json`.
- Tests: `npm test` (node --test, no network, stub runner).
- Local literal-IP guard: `bin/check` (docs, test(s)/fixtures, and exact path+address entries in `.ip-literals-allow` are exempt).
- Merge via PR, squash.

## 验收记录与错题本（硬规则）

- 动手前读 [lessons.md](lessons.md)；返工、用户纠正、验收漏项按其中格式记录；同一条教训在 3 个不同日子出现，就升为本文件的硬规则，并在 lessons.md 注明去向。
- 每个 commit 正文和 PR 评论都要写清三项：①回退测试：哪条回归测试先失败、修后通过；没有就说明为什么。②真实使用情况：在真机、真实数据或真实界面上实际跑了什么、结果如何；没跑就写「未在真实环境验证」。③没跑到的项目：跳过的检查、没覆盖的场景和原因。只写「测试通过」不算验收，旧记录不能充当这次的证据；squash 合并时把这三项带进合并提交正文。
