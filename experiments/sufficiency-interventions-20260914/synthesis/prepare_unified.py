"""Analyze the same primary cohort across natural states and interventions."""
from pathlib import Path
import hashlib
import json
import sys
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
import statsmodels.api as sm

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
OUT = BASE/'unified'
sys.path.insert(0, str(ROOT))
from analyze import STYLE, interval, export_figure


def time_means(d, aligned=False):
    grid = np.linspace(0 if aligned else .05, 1, 21 if aligned else 20)
    records=[]
    for (qid,run),g in d.groupby(['question_id','run']):
        g=g.sort_values('step')
        time=((g.step-1)/(g.trajectory_length-1) if aligned else g.tau).to_numpy()
        for v in grid:
            k=np.searchsorted(time,v+1e-12,side='right')-1
            if k<0: continue
            row=g.iloc[k]
            records.append(dict(question_id=qid,run=run,progress=v,r=row.r,likelihood=row.likelihood,margin=row.margin))
    sampled=pd.DataFrame(records)
    q=sampled.groupby(['question_id','progress'])[['r','likelihood','margin']].mean().reset_index()
    rows=[]
    for (progress,),g in q.groupby(['progress']):
        for metric in ['r','likelihood','margin']:
            mean,lo,hi=interval(g[metric])
            rows.append(dict(progress=progress,metric=metric,mean=mean,low=lo,high=hi,
                             questions=len(g),trajectories=len(sampled[np.isclose(sampled.progress,progress)])))
    name='aligned' if aligned else 'temporal'
    q.to_csv(OUT/f'natural-{name}-question-means.csv',index=False)
    result=pd.DataFrame(rows)
    result.to_csv(OUT/f'natural-{name}-means.csv',index=False)
    return result


def fe(d):
    rows=[]
    for outcome in ['margin','likelihood']:
        for controls in [['r','tau'],['r','tau','tau2']]:
            columns=controls+[outcome]
            centered=d[columns]-d.groupby(['question_id','run'])[columns].transform('mean')
            x=centered[controls].to_numpy(); y=centered[outcome].to_numpy()
            w=(1/d.groupby(['question_id','run']).step.transform('size')).to_numpy()
            fit=sm.WLS(y,x,weights=w).fit()
            matrices=[];vectors=[]
            for ids in d.groupby('question_id').indices.values():
                matrices.append(x[ids].T@(w[ids,None]*x[ids]));vectors.append(x[ids].T@(w[ids]*y[ids]))
            a=np.asarray(matrices);b=np.asarray(vectors);n=len(a)
            counts=np.random.default_rng(20260914).multinomial(n,np.full(n,1/n),size=2000)
            ba=np.einsum('bq,qij->bij',counts,a);bb=counts@b
            beta=np.linalg.solve(a.sum(0),b.sum(0))
            assert np.allclose(beta,fit.params)
            boot=np.linalg.solve(ba,bb[...,None])[...,0]
            lo,hi=np.percentile(boot,[2.5,97.5],axis=0)
            for i,term in enumerate(controls):
                rows.append(dict(outcome=outcome,controls='+'.join(controls),term=term,estimate=beta[i],low=lo[i],high=hi[i],questions=n,states=len(d)))
    result=pd.DataFrame(rows)
    result.to_csv(OUT/'natural-time-regression.csv',index=False)
    return result


def export(fig,name,source):
    export_figure(fig,OUT/name,formats=['png','pdf'],dpi=400,bbox_inches=None,overwrite=True,
        provenance={'input':str(ROOT/'summary/units.csv'),'input_sha256':hashlib.sha256((ROOT/'summary/units.csv').read_bytes()).hexdigest(),
            'sample':'64 questions without known gold-evidence version conflict; 192 trajectories; 1181 states',
            'source_table':source,'uncertainty':'95% pointwise question bootstrap; 2000 draws; seed 20260914'})
    plt.close(fig)


def main():
    OUT.mkdir(exist_ok=True)
    font_manager.findfont('Times New Roman',fallback_to_default=False)
    u=pd.read_csv(ROOT/'summary/units.csv')
    d=u[u.experiment.eq('state_answers') & ~u.conflicted].copy().reset_index(drop=True)
    assert len(d)==1181 and d.question_id.nunique()==64
    d['tau']=d.step/d.trajectory_length;d['tau2']=d.tau**2
    d.to_csv(OUT/'natural-states.csv',index=False)
    t=time_means(d);a=time_means(d,True)
    q=d.groupby(['question_id','run','gold_hops','r'])[['likelihood','margin']].mean().reset_index()
    q=q.groupby(['question_id','gold_hops','r'])[['likelihood','margin']].mean().reset_index()
    q.to_csv(OUT/'natural-coverage-question-means.csv',index=False)
    rows=[]
    for (h,r),g in q.groupby(['gold_hops','r']):
        for metric in ['likelihood','margin']:
            mean,lo,hi=interval(g[metric]);rows.append(dict(hops=h,r=r,metric=metric,mean=mean,low=lo,high=hi,questions=len(g)))
    c=pd.DataFrame(rows);c.to_csv(OUT/'natural-coverage-means.csv',index=False)
    reg=fe(d)
    settings=STYLE|{'font.size':11,'figure.figsize':(5.7,3.8)}
    with plt.rc_context(settings):
        for name,frame in [('natural-temporal',t),('natural-aligned',a)]:
            fig,ax=plt.subplots(figsize=(5.7,3.8),layout='constrained')
            for metric,label,color,marker,ls in [('likelihood','Sufficiency likelihood','#B21F32','o','-'),('r','Evidence coverage','#245C7C','s','--')]:
                g=frame[frame.metric.eq(metric)].sort_values('progress')
                ax.plot(g.progress,g['mean'],label=label,color=color,marker=marker,ls=ls,lw=1.8,ms=4,markevery=2,mfc='white')
                ax.fill_between(g.progress,g.low,g.high,color=color,alpha=.1,linewidth=0)
            if name=='natural-temporal':
                cutoff=frame[frame.trajectories.eq(192)].progress.min()
                ax.axvspan(0,cutoff-.025,color='#777777',alpha=.07,lw=0,zorder=-2)
            ax.set(xlim=(0,1),ylim=(-.02,1.02),xlabel='Normalized acquisition progress (t/T)' if name=='natural-temporal' else 'Endpoint-aligned acquisition progress',ylabel='Mean')
            ax.set_xticks([0,.25,.5,.75,1]);ax.set_yticks([0,.25,.5,.75,1]);ax.grid(axis='y',alpha=.12)
            ax.legend(loc='lower center',bbox_to_anchor=(.5,1.02),frameon=False,ncol=2,fontsize=10)
            export(fig,name,f'{name}-means.csv')
        fig,ax=plt.subplots(figsize=(5.3,3.8),layout='constrained')
        for h,color,marker,ls in [(2,'#245C7C','o','-'),(3,'#B21F32','s','--'),(4,'#626262','^',':')]:
            g=c[c.hops.eq(h)&c.metric.eq('likelihood')].sort_values('r')
            ax.errorbar(g.r,g['mean'],yerr=[g['mean']-g.low,g.high-g['mean']],label=f'{h}-hop',color=color,marker=marker,ls=ls,lw=1.6,ms=4,capsize=2,elinewidth=.8)
        ax.set(xlim=(-.025,1.025),ylim=(-.02,1.02),xlabel='Evidence coverage',ylabel='Sufficiency likelihood')
        ax.set_xticks([0,.25,.5,.75,1]);ax.set_yticks([0,.25,.5,.75,1]);ax.grid(axis='y',alpha=.12)
        ax.legend(loc='lower center',bbox_to_anchor=(.5,1.02),frameon=False,ncol=3)
        export(fig,'natural-coverage','natural-coverage-means.csv')
    summary={'temporal_midpoint':t[np.isclose(t.progress,.5)].to_dict('records'),
             'temporal_terminal':t[np.isclose(t.progress,1)].to_dict('records'),
             'full_support_from':float(t[t.trajectories.eq(192)].progress.min()),
             'coverage_samples':c[c.metric.eq('likelihood')][['hops','r','questions']].to_dict('records'),
             'time_regression_r':reg[reg.term.eq('r')].to_dict('records')}
    (OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
