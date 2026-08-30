## 1. OpenSpec 与契约

- [x] 1.1 定义候选发现、显式 Native Session 关联、状态保留、竞争、回滚、恢复及非目标
- [x] 1.2 增加 DSH-only 浏览器安全 strict contracts并覆盖边界测试
- [x] 1.3 运行 `openspec validate add-deepseek-harness-session-import --strict`

## 2. DeepSeek 候选目录

- [x] 2.1 通过锁定协议 `sessions.list` 投影真实候选并处理 title/cwd/running/blank/subagent
- [x] 2.2 强化 `open(resume)` 的存在、cwd、类型和 busy 最终复查
- [x] 2.3 覆盖协议错误、空列表、Windows/POSIX 路径、无效 metadata、空历史和状态保留

## 3. Host 关联事务

- [x] 3.1 使用 Mapping Store 排除已映射 Session并增加两个固定 DSH Host 方法
- [x] 3.2 实现 provisional → resume → readSnapshot → commit → register 与逐阶段回滚
- [x] 3.3 修复 Mapping Store 跨 Thread Native Session 并发唯一性窗口
- [x] 3.4 覆盖成功、完整/空历史、稳定 Turn ID、冷恢复、后续补齐、重复/并发/映射竞争及全部故障注入

## 4. Renderer 流程

- [x] 4.1 从固定 draft policy只读捕获当前 cwd并增加 fixed client方法
- [x] 4.2 增加仅 DeepSeek 新任务可见的本地化可访问 Dialog
- [x] 4.3 复用 Host-qualified sidebar导航并阻止陈旧请求打开错误 Thread
- [x] 4.4 覆盖 loading/empty/error/retry/list/selection/disabled、键盘、焦点、成功导航和 stale generation
- [x] 4.5 从官方 draft prewarm 缓存恢复唯一 cwd，空、非法或多 cwd 时失败关闭

## 5. 文档与验证

- [x] 5.1 更新中英韩 README 与 Harness 实现参考，记录关联语义和 rc.2 限制
- [x] 5.2 运行 focused tests、typecheck、相关单元/集成测试、Prettier、ESLint、边界检查及 `git diff --check`
- [x] 5.3 运行 `npm run check` 并记录真实结果
- [ ] 5.4 完成真实 DSH 导入人工测试后再创建 Draft PR；本变更不创建 PR、不修改 Issue #72
