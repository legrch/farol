from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageChops
import json,hashlib,math
R=Path(__file__).parent.parent;B=json.loads((R/'source/boxes.json').read_text());O=R/'output';C=R/'captures';W,H=1320,900
font=ImageFont.truetype(str(R/'source/LiberationSans-Bold.ttf'),24)
def openim(n):return Image.open(C/(n+'.png')).convert('RGB')
def center(n,t):
 b=B[n][t];return b['x']+b['w']/2,b['y']+b['h']/2
# Hand-drawn cursor and click rings are tutorial graphics, not app UI.
def annotate(im,pos,ripple=None):
 if pos is None:return im
 im=im.copy().convert('RGBA');lay=Image.new('RGBA',im.size);d=ImageDraw.Draw(lay);x,y=pos
 if ripple is not None:
  rr=10+25*ripple;alpha=int(160*(1-ripple));d.ellipse((x-rr,y-rr,x+rr,y+rr),fill=(147,115,243,int(alpha*.20)),outline=(135,93,229,alpha),width=3)
 points=[(x,y),(x+1,y+26),(x+7,y+20),(x+14,y+32),(x+20,y+28),(x+13,y+17),(x+23,y+16)]
 d.polygon([(a+1.5,b+2) for a,b in points],fill=(0,0,0,45));d.polygon(points,fill=(28,26,34,255),outline=(255,255,255,255),width=2)
 return Image.alpha_composite(im,lay).convert('RGB')
def make(name,events,theme=''):
 events=[(n+theme,t,ms,click) for n,t,ms,click in events];imgs={n:openim(n) for n,_,_,_ in events};atlas=Image.new('RGB',(660,450*(len(imgs)+1)),(246,245,249))
 for i,im in enumerate(imgs.values()):atlas.paste(im.resize((660,450)),(0,450*i))
 icon=Image.open(R/'source/farol-sunrise.png').convert('RGBA').resize((430,430),Image.Resampling.LANCZOS);atlas.paste(icon,(10,450*len(imgs)),icon)
 pal=atlas.quantize(240,method=Image.Quantize.MEDIANCUT)
 colors=['ff6058','febc2e','28c840','4285f4','6750b8','2f7555','b0a2fb','90ccb0','ffffff','1c1a22','875de5','c9bdf5','333333','f6f5f9','8ec9ed','eae4f6']
 palette=pal.getpalette()[:720]+[int(c[i:i+2],16) for c in colors for i in (0,2,4)];pal.putpalette(palette)
 frames=[];dur=[];timeline=[];elapsed=0;pos=(1130,810);first=None
 def put(im,ms,p=None,ring=None):
  nonlocal elapsed
  frame=annotate(im,p,ring).quantize(palette=pal,dither=Image.Dither.NONE);frames.append(frame);dur.append(ms);elapsed+=ms
 for n,target,hold,click in events:
  im=imgs[n];timeline.append({'scene':n,'at_ms':elapsed,'target':target,'click':click,'target_center':center(n,target) if target else None})
  put(im,hold,pos if target else None)
  if target:
   dest=center(n,target)
   assert 40<=dest[0]<=1280 and 145<=dest[1]<=797,(n,target,dest)
   for i in range(1,13):
    t=i/12;t=t*t*(3-2*t);p=(pos[0]+(dest[0]-pos[0])*t,pos[1]+(dest[1]-pos[1])*t);put(im,50,p)
   pos=dest;put(im,220,pos)
   if click:
    for i in range(6):put(im,50,pos,i/6)
   else:put(im,700,pos)
  else:put(im,700)
 put(imgs[events[-1][0]],1300,pos)
 firstim=imgs[events[0][0]];lastim=imgs[events[-1][0]]
 for i in range(1,9):put(Image.blend(lastim,firstim,i/8),50)
 put(firstim,500,(1130,810))
 path=O/(name+'.gif');frames[0].save(path,save_all=True,append_images=frames[1:],duration=dur,loop=0,optimize=True,disposal=1)
 g=Image.open(path);length=0
 for i in range(g.n_frames):g.seek(i);length+=g.info['duration']
 data=path.read_bytes();entry={'file':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'width':W,'height':H,'frames':g.n_frames,'duration_ms':length,'loop':g.info.get('loop'),'timeline':timeline}
 print(json.dumps({k:v for k,v in entry.items() if k!='timeline'}),flush=True);return entry
signin=[('s00','start',900,True),('s01','signin',1000,True),('s02','google',1300,True),('s03','account',1500,True),('s04','return',1300,True),('s05','checksignin',1300,True),('s06',None,900,False),('s07','continue',1300,True),('s08',None,1400,False)]
workspace=[('w00','add',1100,True),('w01','sample-folder',1000,True),('w02','openfolder',1000,True),('w03',None,1200,False),('w04','access',1500,False),('w05','continue',1600,True)]
access=[('a00','access',1500,True),('a01','read-write-option',1500,True),('a02',None,1200,False),('a03',None,1500,False),('a04','commands',1600,True),('a05',None,1700,False),('a06',None,2300,False)]
tunnel=[('t00','opentunnels',1000,True),('t01','opencreate',1100,True),('t02','tunnelname',900,True),('t03',None,100,False),('t04','description',700,True),('t05','workspace',1000,True),('t06','selectworkspace',1000,True),('t07','create',1500,True),('t08','copy',1500,True),('t09',None,1100,False),('t10','tunnelid',1600,True),('t11',None,1600,False)]
key=[('k00','opencreate',1000,True),('k01','keyname',900,True),('k02',None,3200,False),('k02b','restricted',2200,True),('k03','tunnelpermissions',1200,True),('k04','readperm',1000,True),('k05','useperm',1000,True),('k06',None,1500,False),('k07','createkey',1600,True),('k08','copy',1500,True),('k09','keydone',1800,True),('k10',None,1300,False)]
connect=[('c00',None,1300,False),('c01','runtimekey',1300,True),('c02','connect',1500,True),('c03',None,1300,False),('c04','continue',1600,True)]
plugin=[('p00','pluginadd',900,True),('p01','custommcp',900,True),('p02','pluginname',900,True),('p03','tunneltype',900,True),('p04','plugintunnel',900,True),('p05','pluginauth',1000,True),('p06','noauth',1000,True),('p07','riskcheck',2600,True),('p08','createplugin',1800,True),('p09','connectplugin',4500,True),('p09a',None,900,False),('p10','pluginsearch',1000,True),('p11','pluginmore',1000,True),('p12','manageplugin',1000,True),('p13','permissionrow',1300,True),('p14',None,3000,False),('p15',None,3600,False),('p16',None,1300,False)]
test=[('v00','test',1800,True),('v01',None,900,False),('v02',None,1600,False),('v03','return',1600,True),('v04','finish',1600,True),('v05',None,1800,False)]
manifest=[]
for name,events in [('01-sign-in',signin),('02-workspace',workspace),('02b-edits-and-commands',access),('03-create-tunnel',tunnel),('04-restricted-key',key),('05-connect-this-mac',connect),('06-add-plugin',plugin),('07-test-connection',test)]:
 manifest.append(make('Farol-'+name+'-light',events))
(R/'validation.json').write_text(json.dumps({'artifacts':manifest,'layout_issues':json.loads((R/'source/layout-checks.json').read_text())['issues'],'provenance':'Code-rendered UI recreation based on Farol source and inspected service forms. All accounts, IDs, keys, files and outcomes are synthetic. Provider, macOS picker, restricted-key permission summary and connection progress are illustrative; tunnel/key result layouts also use supplied reference captures. No live setup test or credential generation.','source_settings_blob':'0d31a9630e23edb1e62eb22f318aa3e35a45de75','source_shell_blob':'4e0acf3ef93b6f6dbb9351105568274f9d19a761','source_setup_gate_blob':'bbe12899ec6c87cd314a02732d81180e3bf6f986'},indent=2))
