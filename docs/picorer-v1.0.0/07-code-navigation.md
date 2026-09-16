# 07 · 从职责找到代码和测试

这一章用于维护代码。遇到问题，先确认它属于原文保存、检索、Agent 决策、交接还是评测，然后进入相应模块。不要因为问题在 benchmark 中暴露，就把修复直接写进某个数据集的脚本。

## 1. 产品代码地图

| 目录 | 实现职责 | 修改时应保持的边界 |
|---|---|---|
| [`src/memory`](../../src/memory) | 记录、作用域、会话等数据模型，存储端口 | 不引入模型调用和 benchmark 评分规则 |
| [`src/platform/sqlite`](../../src/platform/sqlite) | SQLite 表、原文读写、FTS、向量编码和索引状态 | scope、来源身份与一致性必须在持久化层落实 |
| [`src/retrieval/model`](../../src/retrieval/model) | 查询、候选、算子定义、组合契约与检索元数据 | 候选排序分数不是答案置信度 |
| [`src/retrieval/ports`](../../src/retrieval/ports) | 搜索存储、embedding、向量索引等接口 | 把可替换的外部能力放在端口后面 |
| [`src/retrieval/use-cases`](../../src/retrieval/use-cases) | 搜索流程、混合检索、passage 定位和运行指标 | 保持来源坐标，避免将展示裁剪当作原文 |
| [`src/retrieval/adapters`](../../src/retrieval/adapters) | SQLite、Qdrant、embedding 服务及具体算子执行 | 外部返回值需要校验，不直接当作可信原文 |
| [`src/evidence-agent/model`](../../src/evidence-agent/model) | 候选与证据账本、来源片段、选择结果、工作记忆及实验目录 | 保存和验证身份，不代替模型判断关系是否正确 |
| [`src/evidence-agent/adapters/pi`](../../src/evidence-agent/adapters/pi) | 工具 schema、prompt、工具执行、上下文转换、Agent 循环 | 每个工具保持局部职责，不把所有逻辑堆进主循环 |
| [`src/evidence-agent/adapters/docker`](../../src/evidence-agent/adapters/docker) | 受限的只读导航实现 | 沙箱读取与最终证据取得是不同动作 |
| [`src/composition`](../../src/composition) | 装配存储、后端、算子、模型和单题入口 | 在入口选择具体实现，避免模块内部偷偷换配置 |
| [`src/platform/pi`](../../src/platform/pi) | Pi 模型运行时、消息和传输适配 | 保留 provider 异常、实际模型及 usage 信息 |
| [`src/platform/http`](../../src/platform/http) | HTTP 连接、请求策略和非流式运行支持 | 区分请求限制与整题预算 |
| [`src/platform/concurrency`](../../src/platform/concurrency) | 并发池与请求门限 | 等待队列与执行并发不是同一个指标 |
| [`src/platform/filesystem`](../../src/platform/filesystem) | 文件层辅助 | 持久化结果应明确写入时点与失败行为 |
| [`src/platform/security`](../../src/platform/security) | 环境变量等安全边界 | 不把任意环境配置和密钥透传给不需要它的组件 |
| [`src/agent-runtime`](../../src/agent-runtime) | 记忆工具与外部业务工具共存的交互会话 | 外部动作回执要与待执行动作匹配 |
| [`src/entrypoints`](../../src/entrypoints) | CLI、MemoryArena API、LDBD API、Tau bridge | 只解析协议和装配，不复制核心检索逻辑 |
| [`src/benchmark`](../../src/benchmark) | benchmark 模型、语料和问题适配、执行及交接 | 评分信息与检索输入分离 |

`index.ts` 通常用于对外导出，顶层 `cli.ts` 等文件提供兼容入口。找实现时应顺着它们进入实际模块，不要把一个导出文件当成完整功能。

## 2. 装配层的几个入口

[`create-retrieval-context.ts`](../../src/composition/create-retrieval-context.ts) 依据 profile 创建实际检索 store 和算子 registry。[`create-search-operator-registry.ts`](../../src/composition/create-search-operator-registry.ts) 注册基础算子；插件加载另有入口。因此改 schema、算子目录描述和执行器时，需要一起检查模型看到的名字是否仍对应同一个实现。

[`ingest-memory-workspace.ts`](../../src/composition/ingest-memory-workspace.ts) 组织本地工作区入库；[`run-question.ts`](../../src/composition/run-question.ts) 打开数据库，装配模型和只读导航，再运行本题 Agent，最后关闭存储。

MemoryArena HTTP 服务在 [`benchmark/memoryarena-public/composition/create-runtime.ts`](../../src/benchmark/memoryarena-public/composition/create-runtime.ts) 装配长生命周期组件，包括代次管理、审计、持久化身份和服务锁。它不能简单等同于“对每个 HTTP 请求调用一次本地 CLI”。

Qdrant 的全局装配和按 scope 装配分别在 [`qdrant-retrieval.ts`](../../src/composition/qdrant-retrieval.ts) 与 [`scoped-qdrant-retrieval.ts`](../../src/composition/scoped-qdrant-retrieval.ts)。向量索引是可替换组件；原文仍以 SQLite 中的来源为准。

## 3. benchmark 代码不止一层

`src/benchmark` 包含 TypeScript 的问题、执行和来源交接逻辑；`integrations` 包含数据集协议、Python runner 及外部工程桥接；服务器上的 `question_pipeline` 则负责跨题派发、阶段状态与导出。这三部分可能独立演进，不能只记录产品 Git 标签。

| 位置 | 用途 |
|---|---|
| [`benchmark/longmemeval`](../../src/benchmark/longmemeval) | LongMemEval 记录、题目及运行适配 |
| [`benchmark/memoryagentbench`](../../src/benchmark/memoryagentbench) | MemoryAgentBench 本地接入 |
| [`benchmark/amabench`](../../src/benchmark/amabench) | AMA 专用任务适配，与 AgentMemoryBench 的简称应区分 |
| [`benchmark/tau-knowledge`](../../src/benchmark/tau-knowledge) | 需要知识与业务动作的任务桥接 |
| [`benchmark/memoryarena-public`](../../src/benchmark/memoryarena-public) | 通用 memory HTTP 后端、证据交接和审计 |
| [`benchmark/label-firewall.ts`](../../src/benchmark/label-firewall.ts) | 约束评测标签与系统输入的边界 |
| [`integrations/memoryagentbench`](../../integrations/memoryagentbench) | YAML 启动、任务配置、分块、HTTP adapter 与评分 |
| [`integrations/memoryarena-public`](../../integrations/memoryarena-public) | 上游数据准备和 MemoryArena runner |
| [`integrations/tau-knowledge`](../../integrations/tau-knowledge) | Python 环境到交互 Agent 的桥接 |
| [`question_pipeline`](_audit/pipeline/question_pipeline) | 当前部署的三阶段题目队列，不属于 v1.0.0 标签 |

BEAM 和 LoCoMo 在这轮使用 OmniMemEval 路径；不能因为也调用相同 memory service，就套用 MemoryAgentBench 的评分 prompt。详情见 [评测框架](04-evaluation-framework.md)。

## 4. 典型修改对应哪些测试

| 改动 | 重点验证 |
|---|---|
| 原文存储和入库 | 同 ID 重复写入、不同内容冲突、scope 隔离、记录顺序、重启后可读 |
| 词法与向量混合 | 排名稳定性、单一通道降级、scope 内回查、embedding 维度和索引状态 |
| 算子与组合 | schema 和 registry 一致、预算是否按实际检索执行计数、融合去重、来源不丢 |
| passage 与 read | 坐标越界、hash 不匹配、同 parent 多片段合并、文本预算、已读账本完整性 |
| full 与 compact | 实际 system prompt、工具参数、候选视图、当前批次可见性和旧结果处理 |
| working memory | 合法替换、空值和超限、动作失败时的更新行为、下一次模型输入是否真能看到 |
| finish 与回答交接 | 引用存在、批次约束、全部已读来源提交、parent 展开预算、实际答案输入 |
| 服务并发 | 同用户读写排队、公平性、相同请求合并、异常后的锁释放 |
| 队列 | 崩溃恢复、重复消息、依赖阶段放行、失败重试、缺评测凭据的等待状态 |

现有测试可从 [`test`](../../test) 和 [队列 tests](_audit/pipeline/tests) 进入。测试名只是入口，判断覆盖范围要读具体断言。例如来源校验测试通过，只证明伪造引用会被拒绝，不证明模型一定选择正确来源。

## 5. 保持代码可维护的实际做法

先写明本次修复改变的边界。例如“让已取得片段在相同 parent 的多次 read 中合并”是可以验证的工程改动；“让 Agent 不再提前停止”则需要说明具体接口和观测证据，不能只加一段越来越长的 prompt。

模型行为变化需要独立比较。调整 interface、历史窗口、提示、读取预算、重试和模型参数都会影响轨迹；同时改动以后，只能报告整个版本的效果，不能把收益归给单独一项。

代码路径也应保持单一来源：来源管理交给账本，存储隔离交给存储与服务，模型提示只说明使用方法。不要再要求模型复制程序已经掌握的来源坐标，或用笔记“修复”丢失的原文。
