# Evidence–sufficiency dynamics study

## 数据与口径

主分析使用 64 道无已知 official-gold 冲突的 FactConsolidation-MH 题目：192 条 Qwen3.6-27B 自然轨迹、1,181 个逐状态测量，以及 760 个受控证据条件。自然状态与受控条件的回答均为当前固定 evidence package 上的 5 次独立回答。原生充分性以 sufficient 相对 insufficient 的 logit margin（M）分析，图中显示其二状态 likelihood（S）。题目是统计独立单位；置信区间按题目重采样 5,000 次。

## Experiment 1：Evidence sensitivity

同题、同顺序和同证据槽数量下，以一条 gold fact 替换无关事实，共形成 1,072 个相邻配对。任意缺失 gold fact 的加入使 likelihood 平均增加 0.449（95% CI 0.429–0.467），当前证据包回答正确率增加 0.444（0.419–0.467）。补齐最后一条 gold fact 时，likelihood 增加 0.288，回答正确率增加 0.517。受控结果支持充分性信号会响应真正有用的证据。

## Experiment 2：Evidence specificity

192 条自然轨迹产生 989 次相邻状态变化，其中 287 次增加了 gold coverage。按题目先计算条件比例再等权平均：有 support gain 时 margin 上升的概率为 0.864（0.822–0.904）；margin 上升时同时出现 support gain 的概率只有 0.391（0.358–0.423）。没有 support gain 时，margin 上升的概率仍为 0.720。

连续 margin 变化预测 support gain 的 AUPRC 为 0.360，题目等权的 support-gain 基线为 0.349。因此，该信号对证据增加敏感，但一次充分性上涨本身并不能可靠指示 gold evidence 确实增加。

在 evidence package 完全不变的 608 次变化中，有 382 次 margin 上涨；按题目先求比例再平均为 0.716。这里的“不变”只指 retained evidence package；搜索结果、工具回执和对话历史仍可能变化。

## Experiment 3：Onset and persistence

以 M>0（等价于 S>0.5）定义首次 sufficiency onset。192 条轨迹中，133 条在完整 coverage 之前出现 onset，1 条与完整 coverage 同时出现，54 条出现 onset 但终止前始终没有达到完整 coverage，4 条两个事件都没有出现；没有轨迹先达到完整 coverage、再首次偏向 sufficient。

首次偏向 sufficient 时，当前 evidence package 的五次回答正确率均值只有 0.014；首次达到完整 coverage 时为 0.878。这表明 native sufficiency onset 通常明显早于当前证据包实际可稳定回答的时点。

在首次 onset 后仍有后续状态的轨迹中，question-weighted reversal rate 为 0.175（0.106–0.254）。充分性往往持续，但并非不可逆状态。

## 结论

现有数据支持三点：gold evidence 的受控增加会提高充分性；自然轨迹中的充分性上涨经常没有对应的 gold coverage 增长；充分性通常在 annotated evidence 完整之前形成，并在多数后续状态中保持。这里的 specificity 结论针对 annotated gold evidence，不能排除未标注但有用的信息或上下文变化。

## 主要产物

- `results/evidence-sufficiency-coupling.csv`：正文紧凑表。
- `figures/sufficiency-around-evidence-completion.pdf`：以首次完整 coverage 对齐的主图。
- `results/threshold-sensitivity.csv`、`hop-stratified.csv`、`full100-sensitivity.csv`：阈值、跳数和全量样本敏感性。
- `results/transition-regression.csv`、`answer-predictiveness.csv`：回归控制及逐状态回答预测结果。回归只分析 evidence package 发生变化的 381 次 transition，因为 package 不变时 gold support 不可能增加。
