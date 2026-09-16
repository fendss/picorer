"""Read-only verification of source results; writes only derived audit artifacts here."""
from pathlib import Path
import hashlib
import json
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
NEW = HERE.parent
OLD = NEW.parent / 'sufficiency-dynamics-20260912' / 'analysis-rs-v5'
SEED, BOOT = 20260914, 2000


def interval(values):
    x = np.asarray(values, dtype=float)
    rng = np.random.default_rng(SEED)
    means = rng.choice(x, (BOOT, len(x)), replace=True).mean(axis=1)
    return [float(x.mean()), *np.percentile(means, [2.5, 97.5]).tolist()]


def main():
    u = pd.read_csv(NEW / 'summary/units.csv')
    a = pd.read_csv(NEW / 'summary/answers.csv')
    o = pd.read_csv(OLD / 'states-with-sigmoid.csv')
    assert u.id.is_unique and u.complete.all()
    assert not a.duplicated(['unit', 'sample']).any()
    assert len(a) == 18390 and a.fallback.sum() == 1527
    counts = a.groupby('unit').size()
    assert counts.eq(5).all()
    answered = u[u.experiment.isin(['coverage', 'state_answers'])].set_index('id')
    assert set(counts.index) == set(answered.index)
    recomputed = a.groupby('unit').official_score.mean().reindex(answered.index)
    assert np.allclose(recomputed, answered.official_score)

    s = u[u.experiment.eq('state_answers')].copy()
    o['run'] = o['round'].str.extract(r'(\d+)').astype(int)
    j = s.merge(o, left_on=['question_id', 'run', 'step'],
                right_on=['question_id', 'run', 'decision_step'], validate='one_to_one')
    assert len(j) == len(s) == len(o) == 2150
    match = {name: float((j[left] - j[right]).abs().max()) for name, left, right in [
        ('coverage_max_abs_difference', 'r', 'committed_r'),
        ('margin_max_abs_difference', 'margin', 'native_s'),
        ('likelihood_max_abs_difference', 'likelihood', 'p')]}
    assert max(match.values()) < 1e-12

    checks = []
    sources = [NEW / 'summary/units.csv', NEW / 'summary/answers.csv',
               OLD / 'states-with-sigmoid.csv', NEW / 'output-audit.json']
    for sample, d in [('unconflicted', u[~u.conflicted]), ('all', u), ('conflicted', u[u.conflicted])]:
        # Reconstruct paired interventions independently from the condition-level CSV.
        pairs = []
        for (_, _), g in d[d.experiment.eq('coverage')].groupby(['question_id', 'order']):
            by_mask = {int(row['mask']): row for row in g.to_dict('records')}
            for mask, left in by_mask.items():
                for bit in range(int(left['gold_hops'])):
                    if mask & (1 << bit):
                        continue
                    right = by_mask[mask | (1 << bit)]
                    pairs.append({'question_id': left['question_id'], 'last': right['r'] == 1,
                                  'likelihood': right['likelihood'] - left['likelihood'],
                                  'official_score': right['official_score'] - left['official_score']})
        pairs = pd.DataFrame(pairs)
        effects_path = NEW / f'analysis/{sample}-coverage-effects.csv'
        effects = pd.read_csv(effects_path)
        for label, frame in [('all_additions', pairs), ('last_missing_hop', pairs[pairs['last']])]:
            q = frame.groupby('question_id')[['likelihood', 'official_score']].mean()
            for metric in q:
                computed = interval(q[metric])
                ref = effects[effects.comparison.eq(label) & effects.metric.eq(metric)].iloc[0]
                assert np.allclose(computed, ref[['estimate', 'low', 'high']].astype(float))
                checks.append(dict(sample=sample, comparison=label, metric=metric, values=computed))

        preview = d[d.experiment.eq('preview')].pivot(
            index=['question_id', 'run', 'parent_state'], columns='condition', values='likelihood')
        preview_path = NEW / f'analysis/{sample}-preview-effects.csv'
        preview_ref = pd.read_csv(preview_path)
        for treatment, control, label in [('relevant', 'irrelevant', 'Relevant vs. unrelated'),
                ('removed', 'original', 'Removed vs. original'),
                ('irrelevant', 'original', 'Unrelated vs. original')]:
            delta = (preview[treatment] - preview[control]).dropna()
            q = delta.groupby(['question_id', 'run']).mean().groupby('question_id').mean()
            computed = interval(q)
            ref = preview_ref[preview_ref.comparison.eq(label)].iloc[0]
            assert np.allclose(computed, ref[['mean', 'low', 'high']].astype(float))
            checks.append(dict(sample=sample, comparison=label, metric='likelihood', values=computed))

        cv_path = NEW / f'analysis/{sample}-heldout-predictions.csv'
        cv = pd.read_csv(cv_path)
        assert cv.groupby('question_id').fold.nunique().eq(1).all()
        assert cv.groupby('unit').model.nunique().eq(4).all()
        assert set(cv.unit) == set(d[d.experiment.eq('state_answers')].id)
        y, p = cv.observed, cv.prediction
        assert np.allclose(cv.log_loss, -y * np.log(p) - (1-y) * np.log1p(-p))
        assert np.allclose(cv.brier, y * (1-p)**2 + (1-y) * p**2)
        cv_ref_path = NEW / f'analysis/{sample}-heldout-metrics.csv'
        cv_ref = pd.read_csv(cv_ref_path)
        qloss = cv.groupby(['question_id', 'model'])[['log_loss', 'brier']].mean()
        for model in cv.model.unique():
            for metric in ['log_loss', 'brier']:
                computed = interval(qloss.xs(model, level='model')[metric])
                ref = cv_ref[cv_ref.model.eq(model) & cv_ref.metric.eq(metric)].iloc[0]
                assert np.allclose(computed, ref[['estimate', 'low', 'high']].astype(float))
        wide = qloss.log_loss.unstack('model')
        for model in ['Coverage + likelihood', 'Coverage + margin']:
            computed = interval(wide[model] - wide['Coverage'])
            ref = cv_ref[cv_ref.model.eq(model + ' minus Coverage')].iloc[0]
            assert np.allclose(computed, ref[['estimate', 'low', 'high']].astype(float))
            checks.append(dict(sample=sample, comparison=model + ' minus Coverage',
                               metric='heldout_log_loss', values=computed))
        sources.extend([effects_path, preview_path, cv_path, cv_ref_path])

    count_table = u.groupby(['experiment', 'conflicted']).agg(
        units=('id', 'size'), questions=('question_id', 'nunique'),
        answers=('answer_n', 'sum'), fallbacks=('fallback_n', 'sum')).reset_index()
    count_table.to_csv(HERE / 'data-counts.csv', index=False)
    primary = s[~s.conflicted]
    descriptives = primary.assign(complete_package=primary.r.eq(1)).groupby('complete_package').agg(
        states=('id', 'size'), questions=('question_id', 'nunique'),
        mean_answer_score=('official_score', 'mean'), mean_likelihood=('likelihood', 'mean')).reset_index()
    descriptives['answers'] = descriptives.states * 5
    descriptives.to_csv(HERE / 'state-descriptives.csv', index=False)
    pair_source = NEW / 'analysis/unconflicted-coverage-pairs.csv'
    pair_table = pd.read_csv(pair_source)
    abs_token_change = pair_table.assign(abs_change=pair_table.token_change.abs()).groupby('question_id').abs_change.mean().mean()
    sources.append(pair_source)
    audit = {'status': 'passed', 'old_new_state_identity': match, 'verified_contrasts': checks,
             'primary_question_mean_absolute_token_change': float(abs_token_change),
             'primary_state_count': len(primary),
             'primary_hop_question_counts': primary.drop_duplicates('question_id').gold_hops.value_counts().to_dict(),
             'scope': 'Local summary-level independent checks, not a new raw-response audit or inference run.',
             'heldout_interval_scope': 'Question bootstrap of fixed out-of-fold predictions; models/folds not refit in bootstrap.',
             'sources_sha256': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}}
    (HERE / 'evidence-checks.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'contrasts': len(checks), 'old_new': match}, ensure_ascii=False))


if __name__ == '__main__':
    main()
