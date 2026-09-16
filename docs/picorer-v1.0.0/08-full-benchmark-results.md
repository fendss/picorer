# 08 · 正式全量测评结果

## 实验目的

本轮实验考察 Picorer v1.0.0 在不同模型和长期记忆任务上的实际表现，重点回答三个问题：系统在各类任务上表现如何；不同骨干模型呈现出哪些能力差异；当语料规模扩大或任务需要多步推理时，哪些能力更容易下降。

报告覆盖 AgentMemoryBench、BEAM 100K、BEAM 10M 和 LoCoMo。除题数外，表中分数均按百分制呈现。

## 实验计划

实验分为三个部分：

1. 使用 AgentMemoryBench 检查问答、分类、推荐、摘要、事实更新和多跳推理。
2. 使用 BEAM 100K 与 BEAM 10M 检查十类长期记忆能力，并观察更大语料规模下的变化。
3. 使用 LoCoMo 检查长对话中的单跳、多跳、时间和开放域问答。

各模型使用相同的 Picorer 版本，并复用相同的既有语料和索引。检索模型与回答模型保持一致。并非每个模型都运行了所有数据集，“未测”表示本轮没有该组合的完整结果。

| 模型 | 实际评测题数 | AgentMemoryBench Overall | BEAM 100K | BEAM 10M | LoCoMo |
|---|---|---|---|---|---|
| Qwen3.6-27B | 4,211 | 65.35 | 76.67 | 66.88 | 88.57 |
| GPT-4o-mini | 2,071 | 49.17 | 未测 | 未测 | 未测 |
| GPT-4.1-mini | 2,140 | 未测 | 72.52 | 60.49 | 86.95 |
| GPT-5-mini | 4,211 | 61.12 | 76.45 | 67.06 | 90.00 |

不同 benchmark 的任务构成和指标不同，因此不计算跨 benchmark 的混合平均分。AgentMemoryBench Overall 按论文主表层级汇总；BEAM 和 LoCoMo 分别沿用各自的配套计分方法。

## 子实验一：AgentMemoryBench

### 子实验目的

AgentMemoryBench 用于检查系统在多种记忆任务上的综合能力。它既包含直接检索，也包含测试时学习、长文本摘要、知识更新和多跳事实推理，因此可以观察同一系统在不同能力类型上的强弱分布。

### 子实验做法

本轮运行 Qwen3.6-27B、GPT-4o-mini 和 GPT-5-mini，共覆盖 14 个子任务。各任务先计算自己的原生指标，再按论文主表聚合为五个中间结果：

- AR：RULER QA1、RULER QA2、LongMemEval-S 和 EventQA 的平均分。
- MCC：五个分类任务的平均分。
- TTL：MCC 与 ReDial Recall@5 的平均分。
- LRU：InfBench-Sum 与 Detective-QA 的平均分。
- SF：Fact-SH 与 Fact-MH 的平均分。

最终 Overall 是 AR、TTL、LRU 和 SF 的不加权平均。MCC 同时作为分类结果展示，但不再单独进入 Overall，以免被重复计算。

### 实验结果呈现

#### 论文主表层级

| 能力单元 | Qwen3.6-27B | GPT-4o-mini | GPT-4.1-mini | GPT-5-mini |
|---|---|---|---|---|
| AR | 85.18 | 73.35 | 未测 | 85.27 |
| MCC | 89.40 | 78.80 | 未测 | 85.60 |
| TTL | 52.20 | 47.36 | 未测 | 50.38 |
| LRU | 59.03 | 44.97 | 未测 | 52.32 |
| SF | 65.00 | 31.00 | 未测 | 56.50 |
| Overall | 65.35 | 49.17 | 未测 | 61.12 |

#### 14 个子任务

| 任务 | 题数 | Qwen3.6-27B | GPT-4o-mini | GPT-4.1-mini | GPT-5-mini |
|---|---|---|---|---|---|
| Banking77 | 100 | 94.00 | 89.00 | 未测 | 92.00 |
| CLINC150 | 100 | 98.00 | 88.00 | 未测 | 96.00 |
| NLU | 100 | 87.00 | 84.00 | 未测 | 87.00 |
| TREC Coarse | 100 | 90.00 | 72.00 | 未测 | 89.00 |
| TREC Fine | 100 | 78.00 | 61.00 | 未测 | 64.00 |
| RULER QA1 | 100 | 92.00 | 82.00 | 未测 | 92.00 |
| RULER QA2 | 100 | 76.00 | 67.00 | 未测 | 77.00 |
| EventQA Full | 500 | 96.40 | 80.40 | 未测 | 91.40 |
| Detective-QA | 71 | 80.28 | 63.38 | 未测 | 76.06 |
| Fact-SH 262K | 100 | 90.00 | 52.00 | 未测 | 84.00 |
| Fact-MH 262K | 100 | 40.00 | 10.00 | 未测 | 29.00 |
| LongMemEval-S | 300 | 76.33 | 64.00 | 未测 | 80.67 |
| ReDial Full Recall@5 | 200 | 15.00 | 15.92 | 未测 | 15.17 |
| InfBench-Sum F1 | 100 | 37.79 | 26.56 | 未测 | 28.58 |

#### LongMemEval-S 题型小分

| 题型 | 题数 | Qwen3.6-27B | GPT-4o-mini | GPT-5-mini |
|---|---|---|---|---|
| Single-session user | 45 | 93.33 | 88.89 | 93.33 |
| Single-session assistant | 30 | 96.67 | 93.33 | 96.67 |
| Single-session preference | 30 | 20.00 | 23.33 | 40.00 |
| Temporal reasoning | 75 | 81.33 | 57.33 | 86.67 |
| Multi-session | 75 | 69.33 | 48.00 | 76.00 |
| Knowledge update | 45 | 86.67 | 84.44 | 82.22 |

#### InfBench-Sum 小分

| 指标 | Qwen3.6-27B | GPT-4o-mini | GPT-5-mini |
|---|---|---|---|
| 综合 F1（主指标） | 37.79 | 26.56 | 28.58 |
| Recall | 41.54 | 18.80 | 23.06 |
| Precision | 59.46 | 68.21 | 53.78 |
| Fluency | 80.00 | 100.00 | 100.00 |

InfBench 的综合分是逐题 F1 的宏平均。Recall 与 Precision 同样按题目做宏平均，不能用表中的两个平均数重新计算综合分。

#### ReDial 推荐小分

| 指标 | Qwen3.6-27B | GPT-4o-mini | GPT-5-mini |
|---|---|---|---|
| Recall@1 | 3.33 | 6.33 | 4.50 |
| Recall@5（主指标） | 15.00 | 15.92 | 15.17 |
| Recall@10 | 20.92 | 23.50 | 24.92 |

ReDial 评价最终推荐列表前若干项对标准电影的覆盖率。这里的 Recall@5 与 Picorer 检索候选的 Recall@5 不是同一个概念。

### 实验结果解读

Qwen3.6-27B 的 AgentMemoryBench Overall 为 65.35，高于 GPT-5-mini 的 61.12 和 GPT-4o-mini 的 49.17。Qwen 与 GPT-5-mini 的 AR 几乎相同，Overall 差距主要来自 SF 和 LRU；Qwen 在事实推理、摘要和分类任务上更高。

LongMemEval-S 中，GPT-5-mini 得分最高，为 80.67。三个模型在 single-session assistant 和 single-session user 上都较强，但 preference 明显偏低。在本轮设置下，从对话中提炼稳定偏好比提取明确事实更困难。

ReDial 是三个模型共同的低分项，Recall@5 都在 15 左右。更换模型没有带来明显变化，表明当前推荐任务的限制不能简单归因于模型规模。InfBench-Sum 中 Qwen 得分最高，但三个模型的综合分都不高，长文本摘要仍然是系统的薄弱环节。

Fact-SH 始终高于 Fact-MH。Qwen 的两项分别为 90.00 和 40.00；GPT-5-mini 为 84.00 和 29.00；GPT-4o-mini 为 52.00 和 10.00。这个差距与多跳证据推进较弱的判断一致；具体损失发生在查询、读取还是证据交付，仍需结合轨迹判断。

## 子实验二：BEAM

### 子实验目的

BEAM 用于检查语料规模扩大后，不同长期记忆能力是否保持稳定。十个维度分别覆盖拒答、冲突消解、事件排序、信息提取、指令遵循、知识更新、多会话推理、偏好遵循、摘要和时间推理。

### 子实验做法

本轮在 BEAM 100K 上评测 400 题，在 BEAM 10M 上评测 200 题，比较 Qwen3.6-27B、GPT-4.1-mini 和 GPT-5-mini。九个维度按题目 rubric 评分；event ordering 根据输出事件顺序计算 Kendall tau-b。由于排序指标与一般问答指标含义不同，报告同时给出总分和分维度结果。

### 实验结果呈现

#### 总体结果

| 数据集 | 题数 | Qwen3.6-27B | GPT-4o-mini | GPT-4.1-mini | GPT-5-mini |
|---|---|---|---|---|---|
| BEAM 100K | 400 | 76.67 | 未测 | 72.52 | 76.45 |
| BEAM 10M | 200 | 66.88 | 未测 | 60.49 | 67.06 |

#### BEAM 100K 分维度

| 维度 | 题数 | Qwen3.6-27B | GPT-4.1-mini | GPT-5-mini |
|---|---|---|---|---|
| Abstention | 40 | 85.00 | 87.50 | 67.50 |
| Contradiction resolution | 40 | 85.62 | 69.38 | 86.25 |
| Event ordering | 40 | 27.56 | 29.01 | 45.76 |
| Information extraction | 40 | 91.41 | 90.73 | 89.74 |
| Instruction following | 40 | 89.38 | 85.00 | 87.50 |
| Knowledge update | 40 | 72.50 | 55.00 | 68.75 |
| Multi-session reasoning | 40 | 70.86 | 70.73 | 70.10 |
| Preference following | 40 | 88.12 | 93.12 | 92.50 |
| Summarization | 40 | 80.04 | 75.40 | 76.35 |
| Temporal reasoning | 40 | 76.25 | 69.38 | 80.00 |
| Overall | 400 | 76.67 | 72.52 | 76.45 |

#### BEAM 10M 分维度

| 维度 | 题数 | Qwen3.6-27B | GPT-4.1-mini | GPT-5-mini |
|---|---|---|---|---|
| Abstention | 20 | 80.00 | 82.50 | 95.00 |
| Contradiction resolution | 20 | 64.38 | 62.50 | 72.50 |
| Event ordering | 20 | 27.10 | 31.28 | 31.50 |
| Information extraction | 20 | 80.00 | 75.00 | 72.50 |
| Instruction following | 20 | 76.25 | 68.75 | 75.00 |
| Knowledge update | 20 | 78.75 | 67.50 | 72.50 |
| Multi-session reasoning | 20 | 39.21 | 23.58 | 45.83 |
| Preference following | 20 | 78.75 | 68.33 | 72.08 |
| Summarization | 20 | 86.88 | 84.19 | 86.17 |
| Temporal reasoning | 20 | 57.50 | 41.25 | 47.50 |
| Overall | 200 | 66.88 | 60.49 | 67.06 |

### 实验结果解读

在 BEAM 100K 上，Qwen3.6-27B 与 GPT-5-mini 分别得到 76.67 和 76.45，差距只有 0.22 分；GPT-4.1-mini 为 72.52。在 BEAM 10M 上，GPT-5-mini 与 Qwen 仍然接近，分别为 67.06 和 66.88；GPT-4.1-mini 为 60.49。

三个模型在 10M 上都低于 100K。Qwen、GPT-4.1-mini 和 GPT-5-mini 的总体差值分别为 9.79、12.03 和 9.39 分。下降最集中的维度是 multi-session reasoning；temporal reasoning 也明显降低。结果提示跨会话组织和时间关系维护可能比单条信息抽取更容易受到大规模语料影响。不过，两档题集的数量与构成并不完全相同，这里不能把全部分差都归因于语料规模。

Event ordering 是最特殊的维度。三个模型在两个规模上的得分普遍低于一般 rubric 任务，即使 GPT-5-mini 在 100K 达到 45.76，仍与其信息提取和偏好遵循存在较大差距。因此，BEAM 总分应与事件排序小分一起阅读。

## 子实验三：LoCoMo

### 子实验目的

LoCoMo 用于检查系统在长对话中恢复人物事实、连接多条对话信息、理解时间关系并回答开放域问题的能力。

### 子实验做法

本轮使用 1,540 道正式问题，不包含 adversarial category。评测比较 Qwen3.6-27B、GPT-4.1-mini 和 GPT-5-mini，并分别统计 Single-Hop、Multi-Hop、Temporal 和 Open-Domain 四类结果。

### 实验结果呈现

| 类别 | 题数 | Qwen3.6-27B | GPT-4.1-mini | GPT-5-mini |
|---|---|---|---|---|
| Single-Hop | 841 | 92.39 | 92.03 | 92.27 |
| Multi-Hop | 282 | 87.94 | 79.79 | 89.36 |
| Temporal | 321 | 88.47 | 85.98 | 88.16 |
| Open-Domain | 96 | 57.29 | 66.67 | 78.12 |
| Overall | 1540 | 88.57 | 86.95 | 90.00 |

### 实验结果解读

三个模型在 Single-Hop 上几乎没有差距，分数都在 92 左右。在 LoCoMo 的单跳设置中，骨干模型差异很小；更明显的差距出现在需要组织和解释多条信息的题目。

GPT-5-mini 的 Overall 为 90.00，Qwen3.6-27B 为 88.57，GPT-4.1-mini 为 86.95。GPT-5-mini 的优势主要来自 Multi-Hop 和 Open-Domain；Qwen 在 Multi-Hop 上接近 GPT-5-mini，但 Open-Domain 只有 57.29。

LoCoMo 与 Fact-MH 呈现出不同现象：LoCoMo 的多跳得分较高，而 Fact-MH 明显偏低。两者的数据组织、证据更新方式和答案形式不同，因此不能把“多跳”当作完全相同的能力标签。后续研究应比较两类任务的真实轨迹，确认差异来自查询规划、版本选择、证据交付还是答案形式。

## 实验设置

| 项目 | AgentMemoryBench | BEAM 与 LoCoMo |
|---|---|---|
| Picorer 版本 | v1.0.0 | v1.0.0 |
| Agent 交互 | 紧凑候选界面 | 重写式工作记忆上下文 |
| 检索算子 | 内置算子及组合能力 | 内置算子及组合能力 |
| 最大搜索次数 | 8 | 8 |
| 候选数量 | 由任务适配和算子配置决定 | 每次最多展示 20 条 |
| 证据交付 | 保存 Agent 已读原文并交给回答模型 | 保存检索所得上下文并交给回答模型 |
| 工作记忆成本 | 不增加独立模型调用 | 不增加独立模型调用 |

| 模型 | 检索与回答 | 推理强度 | 评测范围 |
|---|---|---|---|
| Qwen3.6-27B | 本地部署的同一模型 | low | AgentMemoryBench、BEAM、LoCoMo |
| GPT-4o-mini | 同一模型承担检索与回答 | off | AgentMemoryBench |
| GPT-4.1-mini | 同一模型承担检索与回答 | off | BEAM、LoCoMo |
| GPT-5-mini | 同一模型承担检索与回答 | medium | AgentMemoryBench、BEAM、LoCoMo |

工作记忆用于记录当前题目的检索进度，不作为最终证据。最终回答以实际交付的原文和检索上下文为依据。本轮没有重新入库，各模型复用相同的数据与索引。

## 结果解释的边界

第一，并非所有模型都覆盖所有数据集，因此空缺组合不能根据相邻结果推算。第二，各模型的推理强度并不完全一致，本轮比较反映的是实际运行配置下的系统结果，不是严格控制所有变量后的模型能力排名。第三，需要模型裁判的指标存在单次采样波动，小于一个百分点的差异不宜单独形成强结论。

总分只能指出问题集中在哪里，不能直接说明问题发生在检索、Agent 决策、证据交付还是回答阶段。要解释某一类退化，仍需回到逐题轨迹，检查必要事实何时进入候选、是否被读取、是否进入最终证据，以及模型是否据此继续搜索。

## 总结

Qwen3.6-27B 在 AgentMemoryBench 上取得本轮最高 Overall，并在 Fact-SH、Fact-MH、EventQA、InfBench 和分类任务上表现较好。GPT-5-mini 在 LongMemEval-S、BEAM 10M 和 LoCoMo 上领先，对长对话、多会话信息和开放域问题的综合处理更强。GPT-4o-mini 在分类任务上仍有一定能力，但在 Fact-MH 上明显受限；GPT-4.1-mini 在 BEAM 100K 上保持了较好表现，在 10M 的多会话和时间推理上下降较多。

跨模型共同出现的薄弱点更值得关注：ReDial 的 Recall@5 都在 15 左右；BEAM event ordering 普遍偏低；Fact-MH 明显落后于 Fact-SH。这些结果将后续研究范围收敛到三个问题：推荐结果的生成与排序、多事件顺序恢复，以及多跳证据链在检索、读取和交付过程中的稳定传递。
