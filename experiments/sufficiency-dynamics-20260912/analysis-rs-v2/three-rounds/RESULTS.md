# Three-round R–S analysis

## Scope

The combined dataset contains 100 benchmark questions, three independent
acquisition trajectories per question, 2,150 frozen agent states, and 4,300
state-replica measurements. Each state has two model replicas; the native
sufficiency readout is

```text
m = log p(sufficient) - log p(insufficient),  native sufficient iff m > 0.
```

Replica measurements are averaged within a state. Coverage-conditioned states
are averaged within a trajectory and then across rounds of the same benchmark
question. All reported intervals are 95% percentile intervals from 5,000
question-cluster bootstrap draws. The controlled model uses trajectory fixed
effects and equal total weight per trajectory.

## Main findings

### 1. Native sufficiency is evidence-responsive, but acquisition time is the stronger driver

The pooled correlation between coverage and native margin is 0.450 (Spearman
0.424), and the within-trajectory correlation is 0.603. In the
question-balanced fixed-effect analysis, increasing coverage from 0 to 1 is
associated with a **+2.57** margin change (95% CI **[+1.83, +3.30]**) after
controlling normalized acquisition time. Increasing normalized time from 0 to
1 is associated with **+7.19** (95% CI **[+5.83, +8.55]**) after controlling
coverage.

The coverage coefficient is independently positive in every run:

- Run 1: +2.73 [1.76, 3.72]
- Run 2: +2.39 [1.12, 3.60]
- Run 3: +2.59 [1.60, 3.54]

This supports an evidence-sensitive component in the native finish signal, but
also shows that the signal cannot be interpreted as a pure readout of gold
evidence completeness. It contains a substantially larger progress-dependent
component.

### 2. Acquiring gold evidence produces an additional local increase in native margin

The question-balanced mean adjacent-state margin change is +2.99 at transitions
where new gold evidence becomes available and +2.43 otherwise. The paired
difference is **+0.56** (95% CI **[+0.21, +0.90]**). A within-trajectory model
that additionally controls the event's normalized position estimates a
gold-evidence-gain coefficient of **+0.76** (95% CI **[+0.38, +1.15]**).

This is observational evidence of local coupling, not a causal effect: tool
outcomes and context changes co-occur with evidence acquisition. Controlled
evidence interventions are still required for a causal claim.

### 3. Native sufficiency frequently leads or disagrees with annotated coverage

Across incomplete-coverage states, 1,007/1,850 (**54.4%**) already have a
positive native margin. Conversely, 61/300 (**20.3%**) full-coverage states have
a non-positive margin.

The terminal mismatch is especially informative:

- Incomplete terminal coverage: 127 trajectories, 4.7% accuracy, but 77.2%
  positive native margin.
- Full terminal coverage: 173 trajectories, 73.4% accuracy and 94.2% positive
  native margin.

Thus a positive native finish margin is not equivalent to complete annotated
evidence, and a large part of terminal confidence can be present in incorrect
trajectories.

### 4. Coverage is more informative about final correctness than native margin

For discriminating terminal correctness, terminal coverage reaches AUC
**0.834** (95% CI **[0.785, 0.882]**), versus **0.712**
**[0.641, 0.777]** for terminal native margin.

Among the 34 questions that have both correct and incorrect outcomes across the
three independent runs, the correct trajectory has on average **+0.314** more
terminal coverage [0.223, 0.402] and **+1.54** more native margin
[0.25, 2.99] than the incorrect trajectory. Both signals matter within the
same question, but coverage is the stronger outcome anchor.

### 5. The result is not explained by model-replica noise or LWW-conflicted questions

Only 14/2,150 states (**0.65%**) have different margin signs across the two
model replicas. The median between-replica margin standard deviation is 0.088.

After excluding all 36 questions flagged as official-gold/LWW conflicted, the
controlled coverage coefficient remains positive: **+1.77**
**[+0.75, +2.74]**. The central R–S association therefore survives this dataset
sensitivity check.

## Current interpretation

The cleanest supported interpretation is:

> Picorer's native finish margin contains an evidence-responsive sufficiency
> component, but it is also strongly driven by acquisition progress. It is a
> useful endogenous stopping signal, not a calibrated ground-truth measure of
> evidence completeness.

The high-margin/incomplete and low-margin/complete states are the appropriate
targets for controlled evidence interventions. Such interventions can test
whether changing the available evidence while holding the rest of the state
fixed moves the native margin in the predicted direction.

## Data-quality checks

- All three runs contain exactly 100 questions.
- All 2,150 states have exactly two replica measurements.
- Every explicit probe result contains 101 samples.
- All 4,300 native likelihoods are finite.
- Coverage is in [0, 1], is monotone within every trajectory, and begins at 0.
- Every read memory ID and excerpt range used to compute coverage was resolved
  and validated.
