# Picorer 充分性实验结果

> 当前修订版本：[2026-09-14 完整报告](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v4/REPORT.zh-CN.md>)。下面的统计与历史入口保留用于追溯；证据包定义、预览统计和结论解释以修订版为准。

> **最新版本：** 已在完整 2,150 个状态上完成十轮深度分析，包括测量可靠性、J 负对照、事件时序、搜索预览、相邻状态变化、S 反转、跨题目预测分解、终止门槛、同题配对和选择性作答。见 [《Picorer 充分性动力学：十轮深度分析报告》](../../analysis-rs-v3/ten-pass/REPORT.zh-CN.md)。下文保留原始统计报告，便于核对分析演进。

2026 年 9 月 13 日  
系统：Picorer v1.0.0  
模型：Qwen3.6-27B  
任务：AgentMemoryBench Fact-MH 262K

## 一句话结论

模型读到的标准证据越完整，就越倾向于判断“现有证据已经充分”。但是，证据尚未读齐时，这种判断也经常出现，而且这些轨迹大多答错。因此，Picorer 的原生充分性信号确实包含证据信息，但目前还不能把它直接当作“证据已经足够”的可靠判据。

## 我们测了什么

同一组 100 道多跳问题独立运行了三次，共得到 300 条真实检索轨迹和 2,150 个决策状态。每个状态都在两个本地模型服务上重复测量。两个服务运行的是同一个模型，用于检查测量是否稳定，并不是两个模型之间的对比。

全文只使用三个符号：

- **R：标准证据覆盖率。** R 等于 0，表示还没有读到标准证据；R 等于 1，表示标准证据链已经全部读到。
- **S：原生充分性分数。** S = log P（“充分”）− log P（“不足”）。S 大于 0，表示模型更偏向“充分”；S 小于或等于 0，表示模型没有偏向“充分”。现有图中的 native logit margin 或 m 都是这个 S。
- **J：显式判断。** 我们额外询问模型“证据是否足够”，重复采样后得到 J。由于提问方式可能影响回答，J 不作为本报告的真值。

R 只检查标准证据是否曾经出现在模型实际读到的原文中。搜索结果预览不计入，读取时被截掉的内容也不计入。R 不衡量模型是否真正理解或正确使用了这些证据。

S 是在 Picorer 原生结束协议已经给定的条件下，对“充分”和“不足”两个状态的相对评分。它不等于模型在搜索、读取和结束等所有动作中主动选择结束的概率。

## 结果一：检索推进时，R 和 S 都会上升

图 1 展示标准证据覆盖率随检索过程的变化。横轴把每条轨迹从开始到结束统一缩放到 0 至 1，纵轴是平均 R。检索前半段读到的标准证据较少，更多证据出现在后半段和最后一步。

![图 1：标准证据覆盖率随检索过程变化](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/01-coverage-over-acquisition.png>)

**图 1｜标准证据覆盖率随检索过程变化。** 实线是 100 道题在三次运行中的平均趋势，浅色区域表示统计不确定范围。终点平均 R 为 0.763，说明许多轨迹结束时仍没有读齐标准证据。

图 2 展示同一过程中 S 的变化。S 从明显偏向“不足”逐渐转为偏向“充分”，并在检索末尾继续升高。对照图 1 可以看到，S 上升时，R 仍处于较低水平。这提示 S 除了响应标准证据，还与检索过程中的其他变化有关。

![图 2：原生充分性分数随检索过程变化](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/02-margin-over-acquisition.png>)

**图 2｜原生充分性分数随检索过程变化。** 虚线 0 是判断边界，高于 0 表示偏向“充分”。这张图只描述平均时序。轨迹长度在结束后才知道，曲线还使用了插值，因此不能根据曲线过零的位置断言模型精确提前了多少步。

为了区分“证据增加”和“检索继续推进”，我们在同一条轨迹内同时考虑 R 和检索位置。控制检索位置后，R 从 0 增加到 1，与 S 平均增加 2.57 相关；控制 R 后，越接近轨迹末尾，S 也越高。这说明 S 的变化同时与证据覆盖率和检索位置有关。由于后期上下文、推理内容和工具结果也在变化，这个统计结果不能单独说明具体原因。

## 结果二：证据越完整，S 总体越高

图 3 不再按时间排列，而是按照 R 对状态分组。为了避免长轨迹占更大权重，我们先在每条轨迹内平均，再在同一道题的三次运行间平均。

![图 3：不同证据覆盖率下的原生充分性分数](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/03-margin-by-coverage.png>)

**图 3｜不同证据覆盖率下的 S。** 小点表示各道问题，白色圆点表示平均值，竖线表示平均值的不确定范围。R 从 0 增加到 1 时，平均 S 从 −1.28 上升到 6.00，整体关系明确为正。中间几个覆盖率的顺序并不严格单调，因为它们对应的问题数量和证据链长度不同，例如 R = 0.5 既可能表示两条证据读到一条，也可能表示四条证据读到两条。

相邻状态的比较得到相同方向的结果，如图 4 所示。读到新的标准证据时，S 平均增加 2.99；没有读到新的标准证据时，S 也平均增加 2.43。两者相差 0.56。也就是说，新标准证据会伴随额外的 S 上升，但检索继续推进本身也伴随明显上升。

![图 4：读到新标准证据时原生充分性分数的变化](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/05-margin-shift-at-evidence-gain.png>)

**图 4｜相邻状态之间 S 的变化。** 左侧是没有新增标准证据的步骤，右侧是新增标准证据的步骤。图中的 Δm 表示下一状态的 S 减去上一状态的 S。这个比较仍然是观察结果，因为读到新证据时，工具返回内容和上下文长度也会同时改变。

## 结果三：R 和 S 经常不一致

在全部 2,150 个状态中，有 1,850 个状态尚未读齐标准证据。其中 1,007 个状态的 S 已经大于 0，占 54.4%。反过来，在 300 个已经读齐标准证据的状态中，还有 61 个状态的 S 小于或等于 0，占 20.3%。

这些比例按状态计数，长轨迹会贡献更多状态。它们说明 R 和 S 并不等价，但不能仅凭这种不一致判定谁对谁错。模型可能误以为证据已经足够，也可能基于标准证据链之外的信息作出判断。

## 结果四：证据没读齐却判断充分，是最明显的失败区

三次运行共作答 300 次，答对 133 次，正确率为 44.3%。检索结束时，证据是否读齐与答案正确性关系很强。

| 检索结束时的情况 | 轨迹数 | 答对 | 正确率 | S 大于 0 |
|---|---:|---:|---:|---:|
| R 小于 1 | 127 | 6 | 4.7% | 77.2% |
| R 等于 1 | 173 | 127 | 73.4% | 94.2% |

第一行是当前最重要的发现：证据没有读齐的 127 条轨迹中，有 98 条的 S 已经大于 0，而这 98 条中有 93 条最后答错。原生信号偏向“充分”，并不能保证模型已经具备答对所需的信息。

第二行也说明，读齐标准证据并不保证答对。R 等于 1 的 173 条轨迹中仍有 46 条答错，后续还可能在理解证据、处理事实冲突、交接证据或生成答案时失败。

图 5 把每条轨迹的最终 R、最终 S 和答案正确性放在一起。大多数正确答案集中在 R 等于 1 的右侧区域；错误答案分布更广，其中相当一部分虽然 R 不完整，S 却已经很高。

![图 5：检索结束时的证据覆盖率、充分性分数与答案正确性](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/06-terminal-state-map.png>)

**图 5｜300 条轨迹的最终状态。** 红色菱形表示答对，灰色空心圆表示答错；横轴是最终 R，纵轴是最终 S。虚线以上表示原生信号偏向“充分”。

如果只用一个数给正确和错误答案排序，最终 R 的区分分数为 0.834，最终 S 为 0.712。0.5 相当于随机排序，1 表示完全区分。因此，在这批数据中，最终 R 与答案正确性的关系更强。当前分析没有直接检验这两个分数之差，所以这里不把它写成经过显著性检验的优劣结论。

## J 在这份结果里处于什么位置

每个状态在每个模型服务上都进行了 101 次显式判断，总计 434,300 次，数据已经收齐。J 受额外问题的措辞影响，而 S 来自 Picorer 原生协议；两者都只是对模型状态的观察窗口。目前没有独立真值能够证明其中一个等于“模型真正感到充分”。

这份报告因此先回答 R、S 与正确答案之间的关系。J 更适合单独做提示词敏感性分析，例如更换问法、交换“充分”和“不足”的选项顺序，再检查 J 是否稳定。

## 现在可以得出什么结论

现有数据支持三个结论。

1. S 与标准证据覆盖率存在稳定的正相关；这一关系在三次独立运行中都出现，排除 36 道证据规则有冲突的问题后仍然存在。
2. S 还会随着检索过程推进而上升，因此它不是标准证据完整程度的直接替代。
3. 最值得研究的是 R 不完整而 S 已经为正的状态，因为这种情况在检索终点通常伴随错误答案。

现在还不能断言 S 是好或坏的充分性指标。我们真正缺少的是干预证据：在同一个状态中只改变证据内容，S 是否会随之改变，以及这种变化是否会提高答题正确率。

下一步应从 R 不完整、S 大于 0 的状态中抽样，固定问题和此前上下文，补入缺失证据；再从 R 等于 1 的状态中移除一条必要证据。同时加入等长度的无关文本作为对照。这样才能区分 S 对证据内容的反应和它对文本长度、检索步数或其他上下文变化的反应。

## 统计数值核对表

正文只保留了理解结论需要的数字。下面列出几项关键估计的 95% 置信范围。

| 比较 | 估计值 | 95% 置信范围 |
|---|---:|---:|
| 同时考虑检索位置后，R 从 0 到 1 对应的 S 变化 | +2.57 | +1.83 至 +3.30 |
| 新增标准证据相对于未新增证据的额外 S 变化 | +0.56 | +0.21 至 +0.90 |
| 用最终 R 区分答案正确与错误 | 0.834 | 0.785 至 0.882 |
| 用最终 S 区分答案正确与错误 | 0.712 | 0.641 至 0.777 |
| 排除 36 道规则冲突问题后，R 对应的 S 变化 | +1.77 | +0.75 至 +2.74 |

三次独立运行分别保存 694、718、738 个状态，分别答对 48、41、44 道题。2,150 个状态都在两个模型服务上完成测量；只有 14 个状态在两个服务上的 S 正负方向不一致，占 0.65%。置信范围以 100 道问题为抽样单位计算，使用 5,000 次重复抽样。

完整数字见 [机器可读结果](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/analysis-summary.json>)，状态数据见 [状态汇总表](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/states-collapsed.csv>)，分析方法见 [分析脚本](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analyze_rs_dynamics.py>)。

补充图表包括：[三次运行的一致性](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/07-replication-controlled-effect.png>)、[R 与检索位置的条件关联](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/08-controlled-drivers.png>)、[最终状态对正确答案的区分分数](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/09-terminal-correctness-auc.png>)和[排除规则冲突问题后的结果](</Users/johnnychiu/Documents/memory harness from the first principle/picorer/experiments/sufficiency-dynamics-20260912/analysis-rs-v2/three-rounds/10-lww-clean-sensitivity.png>)。
