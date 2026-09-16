"""Exercise analysis/export using actual pilot rows; never a final result."""
import argparse
import json
from pathlib import Path
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import analyze as a

ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,required=True);args=ap.parse_args();root=args.root
d=pd.read_csv(root/'summary/units.csv');d=d[d.complete].copy()
out=root/'_qa';out.mkdir(exist_ok=True)
a.BOOT=20
checks={}
if d[d.experiment.eq('coverage')].question_id.nunique()>=2:
    q,means=a.coverage_means(d,'software_test')
    pairs,effects=a.coverage_effects(d,'software_test')
    checks['coverage_functions']=len(effects)>0
    corr=a.correlation_table(d,'software_test');checks['correlation_functions']=len(corr)>0
if d[d.experiment.eq('preview')].question_id.nunique()>=2:
    raw,effects=a.preview_effects(d,'software_test');checks['preview_functions']=len(effects)>0
if d[d.experiment.eq('state_answers')].question_id.nunique()>=3:
    coef,curves,cv,metrics=a.real_state_regression(d,'software_test')
    assert np.isfinite(cv.prediction).all()
    checks['regression_and_question_heldout_functions']=True
for font in (root/'fonts').glob('*.ttf'):a.font_manager.fontManager.addfont(str(font))
a.font_manager.findfont('Times New Roman',fallback_to_default=False)
c=d[d.experiment.eq('coverage')]
with a.style_context('default'),plt.rc_context(a.STYLE):
    fig,ax=plt.subplots(figsize=(5.3,3.8),layout='constrained')
    if len(c):
        qid=c.iloc[0].question_id;observed=c[c.question_id.eq(qid)].groupby('r').likelihood.mean()
        ax.scatter(observed.index,observed.values,color=a.COLORS[0],s=25)
    ax.set(xlabel='Evidence coverage',ylabel='Sufficiency likelihood',xlim=(-.025,1.025),ylim=(-.025,1.025),
        title='Pilot layout check — not final results')
    a.export_figure(fig,out/'layout-check',formats=['pdf','png'],dpi=200,bbox_inches=None,
        provenance={'purpose':'software and layout QA only','data':'incomplete actual pilot; one question','not_final_results':True},write_manifest=True,overwrite=True)
    plt.close(fig)
checks['export_and_font_loading']=True
(out/'component-tests.json').write_text(json.dumps({'checks':checks,'completed_questions':int(d.question_id.nunique()),
    'bootstrap_draws_for_software_test_only':20,'not_final_results':True},indent=2))
print(json.dumps(checks))
