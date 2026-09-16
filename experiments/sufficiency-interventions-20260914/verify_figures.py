"""Mechanical export audit; manual visual review remains a separate step."""
import argparse
import json
import re
from pathlib import Path
from PIL import Image
from pypdf import PdfReader

ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,required=True);ap.add_argument('--pilot',action='store_true')
a=ap.parse_args();out=a.root/('pilot-analysis' if a.pilot else 'analysis');checks=[]
for p in sorted(out.glob('*.pdf')):
    reader=PdfReader(p);text='\n'.join(page.extract_text() for page in reader.pages);fonts=[]
    for page in reader.pages:
        for font in page['/Resources'].get('/Font',{}).get_object().values():
            obj=font.get_object();fonts.append(str(obj['/BaseFont']))
            if '/DescendantFonts' in obj:
                for child in obj['/DescendantFonts']:
                    descriptor=child.get_object()['/FontDescriptor'].get_object()
                    assert '/FontFile2' in descriptor,('font not embedded',p)
    assert fonts and all('TimesNewRoman' in f.replace('-','') for f in fonts),(p,fonts)
    assert not re.search(r'[\u4e00-\u9fff]',text),(p,'Chinese in figure')
    assert 'sigmoid' not in text.lower(),(p,'unwanted legend terminology')
    with Image.open(p.with_suffix('.png')) as im:
        checks.append({'file':p.name,'fonts':fonts,'pixels':list(im.size),'dpi':im.info.get('dpi'),
                       'pdf_page_points':[float(reader.pages[0].mediabox.width),float(reader.pages[0].mediabox.height)]})
assert checks,'No figures generated'
(out/'export-validation.json').write_text(json.dumps({'checks':checks,'manual_visual_review':'pending'},indent=2))
print(json.dumps({'verified_figures':len(checks),'manual_visual_review':'pending'}))
