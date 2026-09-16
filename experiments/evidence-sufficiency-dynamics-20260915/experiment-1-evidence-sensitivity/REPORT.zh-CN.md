# Experiment 1 — Evidence sensitivity

## 问题与设计

本实验检验：在其他条件保持一致时，补入一条缺失的 annotated support 是否会提高 native sufficiency。主样本为 64 道无已知 official-gold 冲突的 FactConsolidation-MH 题目，共 760 个受控条件。每个条件有两次 native logit read 和五次只使用当前 evidence package 的回答。

从原始条件重新构造了 1,072 个配对。配对固定题目、evidence order、槽位数量和原有 mask，仅将一个 irrelevant slot 替换为一条缺失的 gold fact。其中 302 个配对补入的是最后一条缺失证据，使 coverage 首次达到完整。

题目是独立统计单位。所有配对先在题目内聚合，再对题目等权平均；区间来自 10,000 次题目 bootstrap。方向检验使用 200,000 次题目级 paired sign-flip，并对六个主要检验进行 Holm 校正。

## 主结果

加入任意一条缺失 support 后，native margin 平均增加 **5.890**（95% CI 5.479–6.287），sufficiency likelihood 增加 **0.449**（0.429–0.467），当前 evidence package 的回答正确率增加 **0.444**（0.419–0.467）。对应的题目等权正向配对概率分别为 0.985、0.985 和 0.521。回答变化的正向比例低于其平均效应，是因为五次回答形成的离散正确率使大量配对变化恰好为零；其题目等权零变化和负向变化概率分别为 0.476 和 0.003。

补入最后一条缺失 support 时，native margin 增加 **6.690**（6.319–7.057），sufficiency likelihood 增加 **0.288**（0.245–0.331），回答正确率增加 **0.517**（0.469–0.565）。最后一条证据的 margin 效应更大，但 likelihood 效应更小，这是 likelihood 接近上界时的饱和结果，因此变化分析以 margin 为主。所有六个主要方向检验经 Holm 校正后均为 p≤0.000030。

## 稳健性检查

两个 evidence order 下的 likelihood 效应分别为 0.448 和 0.450；第二个顺序减第一个顺序的差为 0.002（-0.005–0.010）。按 hop 数分层的 likelihood 效应为：2-hop 0.485 [0.472, 0.494]；3-hop 0.375 [0.366, 0.385]；4-hop 0.293 [0.281, 0.306]。各层方向一致，但 3-hop 只有 7 道题、4-hop 只有 8 道题，区间仅用于敏感性检查。

加入 support 后的平均输入长度变化为 0.031 tokens（-0.368–0.430），不存在能够解释主效应的系统性 token 增长。

## 当前结论

在受控 evidence package 中，用缺失的 annotated support 替换 matched irrelevant evidence，会系统性提高 native sufficiency，并同时提高当前证据包的回答正确率。因此实验一支持的严格结论是：**the native sufficiency signal is sensitive to useful evidence**。本实验尚不回答自然轨迹中的 sufficiency rise 是否具有 evidence specificity；该问题留给实验二。
