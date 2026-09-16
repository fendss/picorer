# 刚启动的 full 实验是否使用 working memory

核查日期：2026-09-11。只读检查运行目录 `qwen36-v100-full-redial-factmh-20260911` 的 `runtime/memory-service/wrap-audits.jsonl`，按 retrieval.runId 去重。ReDial 尚在运行，以下是读取日志当时的快照。

| 数据集 | 已有检索审计的题数 | 提交过非空 workingMemory 的题数 | 非空提交次数 | 原样出现在当次工具 observation 的次数 |
|---|---:|---:|---:|---:|
| Fact-MH 262K | 100 | 58 | 117 | 117 |
| ReDial | 142 | 74 | 102 | 95 |

Fact-MH 有36题提交多次。所有117次笔记均出现在工具返回文本，且后面还有模型发出的动作。其余42题没有提交非空笔记。不能把没有提交解释为程序没有提供该能力。

ReDial 7次未出现在工具结果的提交需逐条检查，不能据此宣称全部102次更新均被接受；本次未对它们做进一步归因。

源码闭环：search/read 调用 `recordWorkingMemory`；`memory-observation.ts` 保存替换后的字符串，并在 `Model working state (confirmed facts and unresolved needs)` 下呈现；默认 current-window 的 `ephemeral-context.ts` 保留当前工具批次供下一次模型调用使用。这里核对了工具记录与上下文构造代码，没有抓取提供商收到的原始 HTTP 请求。

具体例子：Fact-MH Q5（`context-0/factconsolidation_mh_262k_no5`）在第3步 read 的笔记中写下 CBS CEO 是 Les Moonves、配偶新事实是 Louis Aragon，缺口是 Louis Aragon 的国籍以及该国官方语言；第4步 search 实际查询 `Louis Aragon citizen`。第6步笔记继续记录 France 与 Italy 的编号冲突，并留下核查 Italy 官方语言新版事实的缺口。这支持“笔记有写、有展示、后续动作与其中信息一致”，不单独证明笔记带来的因果收益。

解释区别：full 具有可选的文字 workingMemory，默认使用 current-window；`working-memory-rewrite` 是另一套显式上下文策略，附带自己的工具包装、记录回执和旧工具输出处理。未开启后者不等于没有工作笔记。full 默认结果也未必有顶层 `workingMemory` 字段，应该检查工具参数与 observation。
