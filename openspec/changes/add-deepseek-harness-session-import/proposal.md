## Why

codexhost 当前只恢复已由自身创建并写入 Mapping Store 的 DeepSeek Harness Native Session。用户在同一工作目录中通过 DSH Web/CLI 创建的既有会话虽然仍由同一个本地 DSH profile 持久化，却没有显式入口可以与 Codex Thread 建立映射，因此无法在 Codex Desktop 中查看完整历史并继续对话。

## What Changes

- 在新任务选择 DeepSeek Harness 时增加“打开已有会话”，只发现当前 DSH profile 中与当前工作区 cwd 精确匹配、尚未映射且不是 DSH Subagent 的 Native Session。
- 通过 DSH 锁定协议的 `sessions.list` 读取真实 Session ID、标题、更新时间、cwd、空白和瞬时 running 状态；不扫描 Session 文件，不读取历史伪造 preview。
- 增加 DSH-only 的固定候选发现和关联契约；不扩展通用 `HarnessAdapter` Session 目录抽象，不向 Renderer 暴露 DSH SDK 或任意 Request bridge。
- 用户选择后创建新的 Host Thread ID，并仅持久化该 Thread 与既有 DSH Native Session 的映射及稳定 Turn mappings；不复制 Transcript，不创建、迁移、删除或配置该 DSH Session。
- 复用现有 `open(resume)`、`readSnapshot()`、历史投影、`ExternalThreadRepository.commitDerivedSnapshot()`、Mapping Store 唯一索引及冷恢复对齐。
- 加固 DeepSeek `open(resume)` 的 Session 存在性、cwd、类型和 busy 复查，并修复 Mapping Store 跨 Host Thread 并发提交时的 Native Session 唯一性窗口。
- 导入成功后进入标准 `thread/list` 并立即打开；失败关闭本地 HarnessSession、清理 provisional/ready Host 状态，保留 DSH Native Transcript。

## Capabilities

### New Capabilities

- `deepseek-native-session-link`: DeepSeek Harness 既有 Native Session 的候选发现、显式关联、事务回滚和恢复语义。

### Modified Capabilities

- `local-deepseek-harness-session`: 将旧的单向可见性收窄为“未显式关联的 Session 不进入 codexhost；显式关联后仍由 Mapping Store 驱动”。
- `external-thread-mapping-store`: 保证不同 provisional Host Thread 并发提交同一 Native Session 时仍只有一个成功。
- `shared-runtime-contracts`: 增加浏览器安全、严格且 DSH-only 的候选与关联契约。
- `versioned-renderer-agent-routing`: 增加只在 DeepSeek 新任务中出现的“打开已有会话”入口、选择 Dialog 和陈旧响应保护。

## Impact

- `packages/adapters/deepseek-harness`: `sessions.list` 候选投影、resume 最终复查及协议测试。
- `packages/shared-contracts`: DSH-only 固定 Request/Result Schema。
- `packages/mapping-store`: Store 级写串行与并发唯一性测试；不改变 V1 记录格式。
- `packages/host-runtime`: 候选排除、关联事务、标准 Thread 注册及失败回滚。
- `packages/desktop-control`、`packages/renderer-extension`: 从官方 draft `thread/start`/prewarm 参数只读捕获 cwd，提供本地化可访问 Dialog，并打开关联后的标准 Thread。
- README 与 Harness 实现文档更新；不增加依赖、路由、独立会话管理页或 DSH Native 数据迁移。
