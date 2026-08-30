## Context

本地 DeepSeek Adapter 已连接用户当前 DSH Web profile，并通过公开 Host API 创建、恢复和读取 Session。标准 codexhost Thread ownership 只来自 Mapping Store；`thread/list` 也只聚合 Mapping Store 中的 ready External Thread，因此未映射的 DSH Session 不能直接进入 Codex Thread 列表。

锁定的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` 提供 `sessions.list({})`。每个 `SessionSummary` 有真实 `sessionId`、`updatedAt`、`running`、`blank`，可选 `cwd`、`origin`、`parentSessionId` 和 projection baseline；标题仅可能来自 `projections.values.title`，协议没有 preview。`running` 只是调用时的 Agent running 快照，不是 attach/claim/lease；协议也没有 Session close/delete/detach 或原子 import 操作。

现有 `ExternalThreadRepository.commitDerivedSnapshot()` 已能为 provisional Thread 的完整 Native Snapshot 分配稳定 Host Turn ID，并在一次 Mapping Store `commitReady()` 中提交 Native Session identity 和全部 Turn mappings。冷恢复的 `alignSnapshot()` 会按 Native Turn identity 复用旧 Host Turn ID并为新增 Native Turn 分配新 ID。

## Goals / Non-Goals

**Goals:**

- 只关联当前 DSH profile、当前工作区精确 cwd、尚未映射的普通 DSH Session。
- Host 在 durable commit 前重新验证所有来自 Renderer 的 Session ID、cwd 和显示元数据。
- 保留 Native Session 当前 Model、Thinking、Permission Mode、完整历史和空历史语义。
- 重复点击、并发关联、映射竞争和陈旧 UI 响应不产生重复 Thread或打开错误 Thread。
- 任一 pre-commit 阶段失败均清理 Host provisional/runtime，不主动修改或删除 DSH Native 数据。
- 关联后复用标准 Thread list、read/resume、继续对话、重启恢复和历史对齐。

**Non-Goals:**

- 其他 Harness 的通用 Session import/list 抽象。
- 独立会话管理页、路由、批量关联、跨 cwd 关联、搜索、归档或 Native Session 删除。
- Transcript、Prompt、preview、Tool output 或 Diff 的第二份持久化。
- 通过磁盘扫描、DSH JSONL、current-only DSH `0.1.2-alpha` API 或猜测的 attached 状态实现发现。
- 用新任务的 Model、Thinking 或 Permission 默认值覆盖既有 Native Session。

## Decisions

### 1. 候选目录属于 concrete DeepSeek Adapter

`DeepSeekHarnessAdapter` 增加 DSH-only 的候选读取能力，内部调用并依赖锁定协议真实 `sessions.list` Schema。公共 `HarnessAdapter` 不增加 Session 目录能力。Adapter 只返回严格的 SDK-free 候选：Native Session ID、真实 cwd、真实标题或 null、更新时间、`blank` 和瞬时 `running`。

缺失、空白、相对或非法 cwd 无法证明与工作区匹配，发现时排除、关联时拒绝。`origin: "subagent"` 排除；只有 `parentSessionId` 的普通 Fork Session仍可候选。标题缺失时 Renderer 使用本地化“未命名会话”并显示原生 Session ID，不把 Prompt 当标题，也不额外读取历史生成 preview。

### 2. cwd 来自固定 draft policy，但 Host 仍失败关闭复查

Desktop Control 已独占受支持 Renderer 的官方 Request bridge，并已通过受控 Composer/Fiber 检查定位该 bridge。policy 的 `currentCwd()` 在同一次受控范围内动态收集当前 Composer 上与选中 Host 匹配的直接 cwd 标记：唯一非空值可用，空值或多个不同值失败关闭；这样即使官方 prewarm 缓存已经消费或清空，当前草稿仍能恢复工作区。没有 Composer cwd 标记时，policy 才回退到注入时唯一的官方 `prewarmedThreadManager` 缓存键或之后非 ephemeral 的直接 `thread/start` / `prewarmThreadStart` 参数。任意 ephemeral `thread/start` 不得设置或替换回退值。冻结 policy 只暴露 `currentCwd()`；Renderer Extension 不扫描 DOM/Fiber、不使用 Node API，也不允许用户编辑该值。

该 cwd 穿过 Renderer 后仍视为不可信。Host 要求绝对路径，并让 Adapter 对当前 profile 的新鲜 `sessions.list` 结果做平台原生精确比较。关联 Request 不接受 title、updatedAt、running、blank、Model、Thinking 或 Permission metadata。手写 Session ID只有在最终重列中仍属于相同 cwd 候选时才能继续。

Windows 比较使用平台原生 `path.resolve` 和 `path.relative(...) === ""`，覆盖盘符大小写、`/`/`\\`、尾分隔符和词法点段；POSIX 保持大小写敏感。不调用 `realpath`，因此 symlink/junction 等价性不在本变更声明范围内。

### 3. Mapping Store 是映射排除和唯一性的唯一事实源

Host 每次发现与关联都读取 `repository.list()`，用现有 ready Native refs 排除已映射 Session；不建立第二份持久索引。关联最终仍由 Mapping Store 的 `(harnessId, nativeSessionId)` 唯一检查裁决。

当前 Mapping Store 按 Host Thread 分片串行写；两个不同 provisional Thread 并发提交同一 Native Session 时存在跨队列校验窗口。本变更把 record 写操作收窄为一个 Store 级串行队列，使 durable replace 前的全局唯一检查与索引提交不可交错。该保守队列是已知吞吐上限；只有实际 Mapping Store 写吞吐成为问题时才需要多键锁。

### 4. 关联复用现有 provisional 与 Snapshot 首次提交

固定数据流为：

```text
Renderer list
→ Host strict parse cwd
→ DeepSeek Adapter sessions.list + cwd/type filter
→ Mapping Store mapped exclusion
→ Renderer selects Native Session ID
→ Renderer clears draft prewarm
→ Host strict parse + in-flight guard
→ DeepSeek Adapter fresh sessions.list final revalidation
→ Mapping Store fresh mapped recheck
→ createProvisional(new Host Thread ID, native title, cwd)
→ adapter.open(resume, exact NativeSessionRef, cwd)
→ session.readSnapshot()
→ repository.commitDerivedSnapshot()
→ ExternalThreadRuntime.register()
→ response { threadId }
→ thread/started
→ Renderer opens matching standard sidebar row
```

`open(resume)` 不接收 draft Model、Thinking 或 Permission。Adapter 从 `sessions.models()` 与 history-tail projection读取当前原生状态。导入记录初始只使用通用 DeepSeek Harness transport carrier 表达 Harness ownership，不把 draft 默认值写入 carrier；关联当次及该通用 carrier 仍被持久化时的冷恢复，都不重放配置选择，以 Session initial state 与 fresh Snapshot state 为当前 Native 配置权威。只有用户之后在 Desktop 显式选择 Model、Thinking 或 Permission Mode 时，现有配置确认流程才更新 carrier，后续冷恢复继续沿用既有 carrier 恢复语义。空 Snapshot以 ready record、空 Turn mappings 和可继续的 loaded Session提交。

### 5. 最终 resume 复查阻止候选绕过

Host link 在 provisional 前重新发现一次；DeepSeek `open(resume)` 又使用相同的 `sessions.list` 校验存在、cwd、subagent 和瞬时 running。这使其他 Host resume 调用也不能绕过边界。

`running=true` 时发现行显示 disabled，最终关联返回可重试 busy。由于 rc.2 没有 claim/lease，复查与恢复间仍存在竞态；若原生随后返回 `agent-busy` 或其他拒绝，以该原生结果为准，不发明 attached 判断。

### 6. 失败回滚按 durable commit 边界划分

- provisional 前失败：不写 Host 状态。
- provisional 后的 resume、readSnapshot、状态校验、alignment 或 commit 失败：关闭本地 HarnessSession（解除订阅），删除 provisional。
- commit 成功但 runtime registration 失败：移除 runtime、关闭本地 Session并删除 ready record。
- cleanup 失败只写诊断，不覆盖主错误；不得返回半成功。
- response 写失败发生在完整 ready commit和 runtime registration 后；Thread 仍可由标准列表/冷恢复读取。

codexhost 在关联路径不调用 DSH create/fork/delete/prompt/cancel/selectModel/selectThinking/permission 命令。需要如实记录：rc.2 恢复 cold Agent 时，DSH 自身可能追加并持久化 `session/end-seed`；协议没有 byte-preserving attach 原语，因此失败后的原生日志逐字节零变化无法由 codexhost 保证。该原生 marker 不复制、删除或改写 Transcript。

### 7. Renderer 使用一个轻量原生 Dialog

入口只在 `agent=deepseek-harness`、Composer 为 draft、目标为 default 时显示；Adapter/cwd 未 ready 时可见但 disabled，其他 Harness及 locked conversation 完全隐藏。原生 `<dialog>` 承载以下最小状态：

```text
loading → empty | error | ready → linking → opening
```

Dialog 提供 `aria-labelledby`/`aria-describedby`、status/alert、单选列表、Arrow/Home/End、Enter/Space、Escape、Tab、disabled 状态和关闭后的 opener 焦点恢复。所有用户文案进入现有 Renderer Harness 本地化目录。

每次 open/retry/close/dispose 递增 generation，使旧 list/link 响应失效，并通过 AbortController 中止旧 sidebar 导航。list 与 link 结果只有在 Composer identity、default target、Agent、Host、cwd、选择和 generation 全部仍匹配时才能应用。Host 已提交但 UI 变陈旧时，Thread 留在标准列表但不得自动打开。

Sidebar 导航复用现有 Fork 的 MutationObserver 等待逻辑，并同时匹配 Host ID 与 Thread ID；超时、Abort 或 dispose 都清理 observer/timer，避免不同 Host 同 ID 行被点击。

### 8. 标准 Thread 行为不分叉

ready Mapping Store record 自动进入现有聚合 `thread/list`。首次关联的 Turn mappings由完整 Snapshot分配；后续 live Turn 走 `persistTurn()`。重启或再次打开走 `adapter.open(resume) → readSnapshot → alignSnapshot → reconcileTurnMappings`，保留已有 Host Turn ID并补齐 DSH 外部新增的 Native Turn。初始通用 carrier 不重放 Model 或 Permission Mode，fresh Snapshot state 为权威；用户后续显式配置产生了已确认 carrier 后，则保持现有冷恢复语义。

`thread/delete` 继续只删除 Mapping Store record并关闭本地 Session，不调用 DSH delete；Native Session 数据继续由 DSH profile拥有。

## Error Model

- invalid params、非法 cwd/type/identity、已映射、Session 消失：不可重试当前选择；重新发现可得到新状态。
- DSH transport unavailable/process exited、瞬时 busy、Mapping Store I/O：可重试。
- malformed DSH protocol、identity/history/state mismatch：不可自动重试，防止在不可信状态下提交。
- 重复点击：Renderer single-flight；Host 同 Session in-flight guard 返回 busy；跨 Host竞争最终由 Store 唯一索引只允许一个 commit。
- cancel/close：未提交则 cleanup；已提交且 UI generation 失效则不导航，Thread 保留在标准列表。

## Migration Plan

无持久化格式迁移。已有 mapped DeepSeek Threads继续按原路径恢复；未映射 Session 只有用户显式关联后才获得新的 Host Thread record。回滚删除固定方法、候选能力和 Renderer控件即可；已关联 record仍是合法 V1 ready record，可继续按 NativeSessionRef 冷恢复。
