"""Decode and verify the synthetic GIFs without invoking any service."""
from pathlib import Path
import hashlib,json
from PIL import Image,ImageStat
ROOT=Path(__file__).resolve().parent
reports=[]
for name,count in [('validation.json',13),('light-validation.json',13)]:
 data=json.loads((ROOT/name).read_text());assert len(data['artifacts'])==count;dark=data['theme']=='dark'
 assert not data.get('layout_issues',[])
 for item in data['artifacts']:
  p=ROOT/'output'/item['file'];assert p.name.endswith('-dark.gif' if dark else '-light.gif')
  assert hashlib.sha256(p.read_bytes()).hexdigest()==item['sha256']
  im=Image.open(p);size=tuple(item.get('dimensions',[item.get('width'),item.get('height')]))
  assert im.size==size and im.info['loop']==0
  elapsed=0;maximum=0
  for i in range(im.n_frames):
   im.seek(i);rgb=im.convert('RGB');rgb.load();elapsed+=im.info['duration']
   corner=rgb.getpixel((10,rgb.height-10))  # The instruction bar: the camera moves everything above it.
   assert (max(corner)<70 if dark else min(corner)>230),(p.name,i,'outer canvas')
   maximum=max(maximum,ImageStat.Stat(rgb.convert('L')).mean[0])
  assert (maximum<150 if dark else maximum>200),(p.name,maximum)
  assert elapsed==item['duration_ms'],(p.name,elapsed)
  reports.append({'file':p.name,'frames':im.n_frames,'duration_ms':elapsed,'maximum_mean_luminance':round(maximum,2)})
def luminance(c):
 v=[int(c[i:i+2],16)/255 for i in (1,3,5)]
 return sum((x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4)*w for x,w in zip(v,(.2126,.7152,.0722)))
pairs=[]
for fg,bg in [('#f5f6fa','#262a36'),('#bcc3d2','#262a36'),('#c9b8ff','#1b1e27'),('#6ee7b0','#262a36'),('#ffc061','#262a36'),('#14102a','#c9b8ff'),('#1d1b29','#ffffff'),('#625d75','#ffffff'),('#5b43b5','#f4f3f9'),('#16764d','#ffffff'),('#ffffff','#5b43b5')]:
 low,high=sorted([luminance(fg),luminance(bg)]);ratio=(high+.05)/(low+.05);assert ratio>=4.5
 pairs.append({'foreground':fg,'background':bg,'ratio':round(ratio,2)})
(ROOT/'audit.json').write_text(json.dumps({'artifacts':reports,'contrast_pairs':pairs,'scope':'Synthetic illustrations only; selected palette pairs, not a complete UI accessibility audit or live acceptance test.'},indent=2)+'\n')
print(json.dumps({'passed':True,'gifs':len(reports),'frames':sum(x['frames'] for x in reports)}))
