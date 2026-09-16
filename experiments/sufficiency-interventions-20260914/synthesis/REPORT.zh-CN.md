# Picorer 充分性实验：从轨迹相关到证据干预

2026-09-14｜Qwen3.6-27B｜整合上一版 R–S 报告与三组新增实验

## 先说结果

**原生充分性信号确实会对证据内容作出反应，但目前还不能把它当成“当前证据包已经足够回答”的可靠指标。**

上一版报告发现：检索过程中，证据覆盖率与充分性信号总体正相关。新增实验把这件事推进了两步：在同一道题的受控上下文中，用标准事实替换无关事实，充分性信号显著提高；保持证据包完全不变，只改变搜索预览，它也会显著变化。这说明该信号不仅受到包内证据影响，也受到包外可见信息影响。

但第三组实验没有建立其额外预测价值：在未参与拟合的题目上，给 Coverage 加上 likelihood 或原始分数，都没有显示出稳定的答题预测改善。

因此，当前最重要的区分是：**检索模型看见了什么，与回答阶段实际收到什么，不是同一件事。** 这是理解 R 与充分性信号不一致的重要线索，而不是已经证明的全部原因。

下文按“先前观察—证据干预—预览干预—答题验证”组织。J 不纳入任何分析。

## 1. 新旧实验怎样接起来

整合基线是[上一版 R–S 报告（analysis-rs-v5）](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/REPORT.zh-CN.md>)。该报告使用 100 道题、每题三次检索，共 300 条轨迹、2,150 个状态。

这次没有重新检索，也没有训练模型。新增测量包括：

| 新增实验 | 实际收集内容 | 用来回答的问题 |
|---|---|---|
| 改变证据组合 | 1,528 个条件；3,056 次原生测量、7,640 次回答 | 标准证据增加是否会改变充分性信号和答案？ |
| 改变搜索预览 | 6,340 个条件；12,680 次原生测量 | 证据包不变，包外信息是否仍影响信号？ |
| 对真实状态分别回答 | 全部 2,150 个状态，每个回答 5 次，共 10,750 次 | 当前状态的信号能否预测当前证据包的答题效果？ |

合计 **34,126 个逻辑推理任务，全部完成，最终缺失为 0**。两个服务是同一个 Qwen3.6-27B 模型的副本，不是跨模型验证。逐状态回答复用原有 R 和分数；本次独立核对确认 2,150 个状态一一对应，R 完全一致，分数仅有 CSV 浮点精度级差异。因此，不能把自然轨迹部分称为一次独立重复实验。[完成审计](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/output-audit.json>)；[本次独立核验](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/synthesis/evidence-checks.json>)。

新实验按预先确定的规则，以 **64 道无已知标准证据版本冲突的题目**为主分析，另保留全部 100 题及 36 道已知冲突题的结果。主分析有 1,181 个真实状态；二、三、四跳题分别只有 49、7、8 道。尤其不能把三、四跳的小样本结果推广为普遍规律。以下新增结果除另行说明外，均来自这 64 道题。

### 两个量始终保持同一含义

**R 是每个状态当前证据包的标准事实覆盖率**：包内匹配到的不同标准事实数，除以该题标准事实总数。它不是包内条目总数，不是只在最终提交时才存在的量，也不是模型可见全部信息的覆盖率。状态在下一次 action 执行前取样；该 action 新读入的内容在后续状态计入。

**原始 S 是 sufficient 相对 insufficient 的 logit margin。** 图中使用的 Sufficiency likelihood 是这两个合法 status 的归一化概率；先平均两个副本的 margin，再做概率转换。它不是选择 finish 动作的概率，更没有预先被校准成“答案正确的概率”。正文不再用变换函数名作图例。

## 2. 上一版报告告诉了我们什么

上一版首先发现，两者总体随检索推进而上升。在全部 100 题上，全部状态等权的 Pearson 相关为：R 与原始 S **0.450**，R 与 likelihood **0.321**；两种尺度的秩相关同为 **0.424**。在轨迹内部去均值并令轨迹等权后，Pearson 分别为 **0.686、0.517**。

这支持“二者有关”，但还没有回答“加入证据是否导致信号上升”。因为检索时间、题目难度、预览内容和证据包都可能一起变化。

旧的[时间均值图](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/01-mean-trajectories.png>)还显示：进度中点的 likelihood 为 0.588，R 为 0.169。不过两条曲线的纵向差不能直接叫“过度自信”；两个量没有本应相等的校准关系。终点对齐也会影响曲线形状。

上一版的一个限制仍需保留：控制轨迹和时间后，原始 S 的 R 系数稳定为正，likelihood 的系数却随时间模型变化而变号，区间均包含零。概率转换保留排序，却不保留线性回归结果。新实验并没有使这项旧限制消失，而是用受控干预回答了另一个、更直接的问题。[旧相关与区间](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/correlations.csv>)；[旧时间控制回归](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v5/within-trajectory-regression.csv>)。

## 3. 实验一：标准证据本身会提高充分性信号

### 实验动机

排除“只是检索越往后，两者恰好一起变高”的解释，直接检查证据内容的影响。

### 论证逻辑

对每道题枚举全部标准事实子集，使用正序和逆序两种排列。固定证据槽数量、模板和检索预算；缺少的标准事实用近似等长的无关事实占位。配对条件只替换一条事实，而不是简单把提示写得更长。

这里使用重新构造的干净 Picorer 上下文，不是原轨迹的未经修改状态。实验估计的是“用标准事实替换无关事实”的效果，不能无条件推广为任意自然检索操作的效果。

### 实验效果

| 同题配对操作 | likelihood 平均变化 | 答题正确率平均变化 |
|---|---:|---:|
| 用一条标准事实替换无关事实 | +0.449（0.428 至 0.466） | +44.4 个百分点（41.7 至 46.6） |
| 补齐最后一条缺失的标准事实 | +0.288（0.247 至 0.331） | +51.7 个百分点（46.5 至 56.7） |

括号为 95% 题目级重采样区间。likelihood 的变化在 0–1 尺度上计算，不是答题正确率的变化；两列不能互相替代。先在题内平均配对变化，再跨题平均，组合更多的题目不会获得更大总权重。

![图 1：受控证据组合中的 Coverage 与 Sufficiency likelihood](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/01-coverage-likelihood.png>)

图 1｜相同覆盖率下先平均一道题的事实组合和排列，再跨题平均；阴影是逐点 95% 题目级区间。二、三、四跳分别为 49、7、8 道固定题目，所有覆盖点都包含该组全部题目。连线连接离散实验条件，不表示测过所有连续覆盖率。

这次的均值曲线比自然轨迹更容易解释：同组不同覆盖点不再由不同题目组成。题目等权的 R–likelihood Pearson 相关为 **0.793（0.778 至 0.808）**；相同 64 题的自然状态为 **0.484（0.400 至 0.552）**。两者使用相同类型的题目等权估计，但上下文和覆盖率分布不同，不能把相关系数差值全归因于某一个因素。旧报告的 0.321 又采用了不同题目集合及状态等权，不能拿来声称相关性“从 0.321 提升到了 0.793”。

长度检查也支持这不是简单的字数效应：题目等权的平均输入变化约为 **+0.03 token**，平均绝对变化约为 **1.71 token**，并非每个配对都等长；加入题目固定效应和实际 token 数后，R 的系数仍为 **+0.986（0.963 至 1.004）**。不过近似等长不等于语义、词汇和难度完全匹配，这个回归也不是概率校准检验。

![图 2：受控证据组合中的 Coverage 与答题正确率](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/02-coverage-accuracy.png>)

图 2｜每个组合独立回答五次，按原 benchmark 评分，再使用与图 1 相同的题内、题间聚合。三、四跳完整组的观测正确率为 100%，但各只有 7、8 道题；这不是总体正确率必为 100% 的证明。

两个图还揭示了概率尺度的压缩：四跳题在 R=0.75 时，平均 likelihood 已为 **0.941**，答题正确率为 **74.4%**；补齐后分别接近 **1.000、100%**。因此，likelihood 接近 1 不能直接读成下游几乎必然答对。与此同时，标准证据链未必是唯一的最小充分集合，不能反过来把 R<1 时答对一概当成异常。

本实验支持的结论是：**原生信号对标准证据内容具有明确的响应，而不只是与检索进度共同变化。** [配对效应与长度回归](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/unconflicted-coverage-effects.csv>)；[均值与样本数](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/unconflicted-coverage-means.csv>)；[相关系数](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/correlations.csv>)。

## 4. 实验二：包内 Coverage 不变，包外预览仍能大幅改变信号

### 实验动机

解释自然轨迹中为什么会出现包内标准证据尚未齐全、likelihood 却已经很高的状态。

### 论证逻辑

保持同一真实状态的证据包、工作笔记、预算和其余历史不变，只改变搜索候选项的预览正文。主要比较“包含尚未入包标准事实的相关预览”和“无关预览”；两者的 R 完全相同。

只有通过文本排除检查的状态才加入相关预览条件：目标标准陈述及对应 hop answer 的字面文本，原先不能出现在预览以外上下文及包内。该检查不能排除一切语义改写或模型已有知识。

### 实验效果

| 只修改预览的配对比较 | likelihood 平均变化 | 真实状态数 |
|---|---:|---:|
| 相关预览 − 无关预览 | **+0.661（0.594 至 0.725）** | 564 |
| 删除预览 − 原始预览 | −0.319（−0.348 至 −0.288） | 943 |
| 无关预览 − 原始预览 | −0.374（−0.402 至 −0.341） | 943 |

三项均覆盖 64 道题。主要比较使用符合额外条件的 564 个状态，不能把它与另外两行当成完全相同样本。先在同一状态做差，再在运行、题目内平均，最后跨题平均。

![图 3：证据包固定时，改变搜索预览对 Sufficiency likelihood 的影响](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/03-preview-effect.png>)

图 3｜灰点是题目级配对效果；深色点和横线为均值及 95% 区间。零线表示预览修改前后信号不变。相关预览是主要内容对照；删除预览还会改变文本长度，因此不宜单独归结为纯语义效应。

**这是新增实验最重要的机制证据：R 只测包内证据，原生充分性信号却会使用包外可见信息。** 所以，R 与 likelihood 不一致，不能直接说明信号“不懂证据”或“只是乱自信”。

但这项实验没有让模型自由选择下一步动作，也没有把预览传给回答模型后重新作答。因此，它没有证明预览会导致实际提前停止，更没有证明这部分信号必然有害。相关预览本来就包含有用信息，信号提高可能是合理反应。[逐题效果与汇总](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/unconflicted-preview-effects.csv>)。

## 5. 实验三：尚未证明信号能在 R 之外改善答题预测

### 实验动机

前两组证明了信号会变化。接下来要问的是：这种变化是否有助于判断“用当前证据包能不能答对”，而不只是在描述模型对上下文的反应？

### 论证逻辑

对每个真实状态恢复当时的精确证据包，独立回答五次。回答只接收这份包，不自动展开原始长文，也不传入包外预览。使用原 benchmark 评分器，不新增语言模型裁判。

将题目分为五折，同题的三次运行、所有状态和答案始终在同一折。分别用 R、likelihood、两者联合，以及 R 与原始 S 联合，预测未参与拟合题目的答题结果。联合模型含交互项。统计时每道题总权重相同。

这里特意把回答证据与 R 对齐；但原生分数仍来自完整检索上下文。这个信息范围差异正是结果的解释边界，不能假装两者使用了完全相同的输入。

### 实验效果

| 用于预测的变量 | 留出题目的平均对数损失，越低越好 |
|---|---:|
| 仅 R | **0.135** |
| 仅 likelihood | 0.423 |
| R + likelihood | 0.141 |
| R + 原始 S | 0.136 |

加入 likelihood 相对仅 R 的损失变化为 **+0.0065（−0.0023 至 +0.0218）**；加入原始 S 为 **+0.0013（−0.0082 至 +0.0152）**。负值才表示改善；两项区间都跨零。另一个概率预测误差指标 Brier score 也没有给出联合模型更好的点估计。[完整留出结果与区间](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/unconflicted-heldout-metrics.csv>)。

因此，准确表述是：**当前样本和预测模型下，尚未检测到分数在 R 之外的增量预测收益。** 不能说已经证明分数完全无用，也不能仅凭联合模型点估计稍差，就说它显著损害预测。

从原始状态分组也能看出 R 为什么具有很强的区分力：

| 当前包内标准证据 | 状态数 | 五次回答合计数 | 实际平均正确率 |
|---|---:|---:|---:|
| 不完整 | 974 | 4,870 | 1.3% |
| 完整 | 207 | 1,035 | 91.0% |

这张表是主分析样本的状态等权描述，不是题目等权的留出估计；状态受检索策略选择，也不是同一批题目的随机干预。它不能取代实验一，或证明 R=1 是回答的逻辑必要条件。[分组核验表](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/synthesis/state-descriptives.csv>)。

本次的[样本内正确率回归图](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/04-state-answer-regression.png>)保留作补充。部分范围的不确定性很大，交互项区间很宽；正文采用留出结果表，不把一条不稳定拟合曲线当成机制结论。

### 这是否推翻上一版“完整组内高分更容易答对”？

不构成同一实验的直接反转，但需要收紧原先的解释。上一版使用全部 100 题的 300 个终止状态、每条轨迹一次原始最终答案，做样本内描述性回归；本次使用无已知冲突的 64 题全部状态、每状态五次回答，并在题目之间做留出测试。回答包装和采样口径也不完全相同。

旧结果仍可作为“终止状态内部存在关联”的描述；它不能继续被用作“分数有独立且可泛化的预测价值”的证据。即使观察到样本内关联，加入一个与 R 重叠的信息量，未必能改善新题预测。

另外，R 需要标准证据标注，通常不能在线计算。它在这里是有标注条件下的参照变量，不意味着线上系统可以直接用 R 替换原生分数。

## 6. 合起来，哪些结论成立，哪些还不成立

| 问题 | 目前结论 |
|---|---|
| R 与原生充分性信号是否相关？ | 是。自然轨迹和受控证据组合均支持正向关系。 |
| 标准证据内容是否会影响信号？ | 是。在本次受控上下文中，单事实替换给出明确的正向配对效果。 |
| 信号是否只反映当前证据包？ | 不是。固定包和 R，预览变化仍有很大影响。 |
| likelihood 是否等于“当前包足够回答”的概率？ | 没有建立这种校准关系，不能如此使用。 |
| 它是否提供超越 R 的稳定答题预测收益？ | 本次按题留出测试未检测到，包括原始 S 版本。 |
| 用它决定何时停止，是否能省检索又不降准确率？ | 尚未测试，不能从以上结果直接推出。 |

**系统层面的解释是：当前信号与完整检索上下文中的证据内容有关，而 R 和本次答案对应的是可交接证据包。** 新增的预览干预证明这种信息范围差异确实会影响信号；它为“高信号、低包内覆盖”提供了一个实证支持的解释，但还没有量化它能解释多少自然状态或多少答题错误。

因此，下一步不应只是继续堆叠相关系数。最直接的验证是：对同一状态，固定完整可见事实，比较“仅当前证据包回答”与“把已有相关预览也交接后回答”；再观察分数与各自正确性的对应关系。随后才是让模型自由决策、测量检索成本与准确率的停止实验。本报告没有启动这些新实验。

## 7. 稳健性、数据质量与可复现材料

### 不只保留有利子集

将全部 100 题纳入，三项主要判断没有反转：

| 结果 | 主分析 64 题 | 全部 100 题 |
|---|---:|---:|
| 单事实替换的 likelihood 变化 | +0.449 | +0.410 |
| 相关预览相对无关预览的变化 | +0.661 | +0.602 |
| 加入 likelihood 后的留出损失变化 | +0.0065 | +0.0021 |

全部 100 题的第三项区间为 −0.0059 至 +0.0128，仍未检测到预测改善。36 道已知冲突题的单独结果亦保留；没有按本次答案是否正确重新选择题目。[全部题的证据效应](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/all-coverage-effects.csv>)；[预览效应](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/all-preview-effects.csv>)；[留出结果](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analysis/all-heldout-metrics.csv>)。

### 区间和分数应怎样读

新实验使用 2,000 次题目级重采样；同题状态、运行、组合和重复答案不是独立题目。均值曲线是逐点区间，不是整条曲线的同时置信带。留出损失区间对本次固定的五折预测按题重采样，并未在每次重采样中重新划分和拟合模型，不能涵盖全部训练过程不确定性。

旧报告系统最终正确率为 133/300，即 44.3%。本次对全部 300 个终止状态的五次回答合计为 665/1,500，也恰为 44.3%，但回答口径不同，且并非逐题逐次相同，不应将相同均值解释为包装变化没有影响。全部 2,150 个状态的回答正确率为 11.8%，包含大量早期证据不足状态；这不是系统最终准确率降到了 11.8%。这些总分使用全部 100 题，与正文 64 题主分析不同。

### 回退、重试和输入检查

18,390 个答案中有 1,527 个使用了预先规定的空输出 no-thinking 回退，占 8.3%。其中证据组合实验为 1,092/7,640（14.3%），真实状态回答为 435/10,750（4.0%）。正确性结果对应“含回退的回答流程”，不是全部由同一种单次 thinking 路径生成；尚未做足以排除回退相关偏差的完整敏感性分析。

另有 28 个任务按原参数补齐，保留 44 份未完成归档记录；调度切换的中断另有记录，不计为独立样本。不因答错而重试。初始字段顺序有误的 pilot 已隔离，正文仅使用正式 v2 数据。

正式原始状态重放有 3,512 次历史 token 前缀匹配。重放的 margin 相对旧测量平均绝对差为 0.105、最大 0.750，说明执行结果存在数值差异；不能声称重新推理的 logits 逐位相同。本次自然轨迹分析仍使用旧分数，预览效果采用本次重放条件之间的配对比较。

本次整理独立重算并核对了三种题目集合的证据配对效果、预览效果及其区间，检查了全部回答聚合、题目分折与留出损失；共 27 项主要对比通过核验。该检查基于已收集汇总数据，不替代对所有原始模型响应的逐条人工检查。

### 文件与图表

- [冻结实验方案及运行变更](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/PROTOCOL.zh-CN.md>)
- [条件级数据](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/summary/units.csv>)、[逐次回答与评分](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/summary/answers.csv>)
- [原统计和绘图实现](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/analyze.py>)、[本次独立核验脚本](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/synthesis/verify_synthesis.py>)
- [核验结果及来源 SHA-256](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/synthesis/evidence-checks.json>)、[结论与图表检查记录](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-interventions-20260914/synthesis/REVIEW.md>)

正文三个新增图均为独立单图，图内英文、Times New Roman，并有同名矢量 PDF。本次查看了三个正文图、补充回归图及旧时间图；未将自动导出检查写成全部补充图都已通过人工检查。报告保留原始图和原报告，不覆盖既有结果。

报告采用 academic-writing 的“实验动机—论证逻辑—实验效果”结构、research-paper-writing 的结论与证据核对，以及 scientific-visualization 的图表来源与人工复核流程。后者的软件方法参考为 Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026), [Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents](https://arxiv.org/abs/2609.00065)。该参考只说明整理和可视化流程，不是 Picorer 实验结论的外部证据。
