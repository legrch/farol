"""Build the dark setup GIFs with a guiding camera; synthetic scenes only, no services used.

Scenes are rendered from a disposable copy of the onboarding package at twice the
resolution. Each frame is a crop that follows the action, so the interface reads at
roughly its real size on the page, with a large instruction bar under it.
"""
from pathlib import Path
import hashlib,json,os,re,shutil,subprocess,sys,tempfile
from bs4 import BeautifulSoup
from fontTools.ttLib import TTFont
from PIL import Image,ImageChops,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output';OUT.mkdir(exist_ok=True)
REPO=ROOT.parents[2]
W,H,BAR=1320,860,104
VIEW_H=H-BAR
# The app window inside each 1320 x 900 scene; everything outside it is the old page chrome.
WINDOW=(40,145,1280,797)
MIN_ZOOM=max(W/(WINDOW[2]-WINDOW[0]),VIEW_H/(WINDOW[3]-WINDOW[1]))
FOCUS_ZOOM=1.5
# Centre of the content column: staying on it avoids slicing headings and sentences at the edge.
COLUMN=755
SCALE=2
BAR_BG='#14171f';TEXT='#f5f6fa';MUTED='#b9c0d0';ACCENT='#c9b8ff';INK='#14102a';RING=(201,184,255)

def geist(scratch):
 path=Path(scratch)/'Geist.ttf'
 font=TTFont(REPO/'design-lab/fonts/geist/Geist-Variable.woff2');font.flavor=None;font.save(path)
 return path
class Camera:
 def __init__(self):self.x,self.y,self.z=(WINDOW[0]+WINDOW[2])/2,(WINDOW[1]+WINDOW[3])/2,MIN_ZOOM
 def view(self,x=None,y=None,z=None):
  x=self.x if x is None else x;y=self.y if y is None else y;z=self.z if z is None else z
  w,h=W/z,VIEW_H/z
  x=min(max(x,WINDOW[0]+w/2),WINDOW[2]-w/2);y=min(max(y,WINDOW[1]+h/2),WINDOW[3]-h/2)
  return x-w/2,y-h/2,x+w/2,y+h/2
 def clamp(self):
  a,b,c,d=self.view();self.x,self.y=(a+c)/2,(b+d)/2
def contains(view,box,margin):
 a,b,c,d=view;mx,my=(c-a)*margin,(d-b)*margin
 return box[0]>=a+mx and box[1]>=b+my and box[2]<=c-mx and box[3]<=d-my
def focus_x(box,z):
 half=W/z/2
 if box[0]>=COLUMN-half+12 and box[2]<=COLUMN+half-12:return COLUMN
 return (box[0]+box[2])/2
def changed(previous,current):
 """Bounding box of what changed inside the app window, in scene pixels."""
 crop=tuple(v*SCALE for v in WINDOW)
 box=ImageChops.difference(previous.crop(crop),current.crop(crop)).convert('L').point(lambda v:255 if v>24 else 0).getbbox()
 if not box:return None
 return box[0]/SCALE+WINDOW[0],box[1]/SCALE+WINDOW[1],box[2]/SCALE+WINDOW[0],box[3]/SCALE+WINDOW[1]
def make(name,events,captures,boxes,captions,fonts,palette_source):
 images={n:Image.open(captures/f'{n}.png').convert('RGB') for n,_,_,_ in events}
 camera=Camera();frames=[];durations=[];timeline=[];elapsed=0
 pos=((WINDOW[0]+WINDOW[2])*.8,(WINDOW[1]+WINDOW[3])*.8)
 big,small=fonts
 def bar(text,number):
  layer=Image.new('RGB',(W,BAR),BAR_BG);d=ImageDraw.Draw(layer)
  d.ellipse((28,34,64,70),fill=ACCENT);label=str(number)
  d.text((46,52),label,font=small,fill=INK,anchor='mm')
  lines=[];line=''
  for word in text.split():
   probe=(line+' '+word).strip()
   if d.textlength(probe,font=big)>W-110:lines.append(line);line=word
   else:line=probe
  lines.append(line);y=52-(len(lines)-1)*18
  for n,part in enumerate(lines):d.text((80,y+n*36),part,font=big,fill=TEXT,anchor='lm')
  return layer
 def compose(scene,view,cursor=None,ring=None,click=None):
  crop=tuple(round(v*SCALE) for v in view)
  frame=Image.new('RGB',(W,H),BAR_BG)
  frame.paste(images[scene].crop(crop).resize((W,VIEW_H),Image.Resampling.LANCZOS),(0,0))
  frame.paste(bars[scene],(0,VIEW_H))
  d=ImageDraw.Draw(frame);k=W/(view[2]-view[0])
  map_x=lambda v:(v-view[0])*k;map_y=lambda v:(v-view[1])*k
  if ring:
   d.rounded_rectangle((map_x(ring[0])-6,map_y(ring[1])-6,map_x(ring[2])+6,map_y(ring[3])+6),10,outline=RING,width=3)
  if cursor:
   x,y=map_x(cursor[0]),map_y(cursor[1])
   if click is not None:
    r=14+26*click;d.ellipse((x-r,y-r,x+r,y+r),outline=RING,width=3)
   points=[(x,y),(x,y+30),(x+8,y+23),(x+15,y+37),(x+22,y+33),(x+15,y+20),(x+26,y+19)]
   d.polygon(points,fill=(255,255,255),outline=(20,22,30),width=2)
  return frame
 def put(frame,ms):
  nonlocal elapsed
  frames.append(frame);durations.append(ms);elapsed+=ms
 def pan(scene,x,y,z,cursor):
  start=(camera.x,camera.y,camera.z);goal=Camera();goal.x,goal.y,goal.z=x,y,z;goal.clamp()
  if max(abs(goal.x-start[0]),abs(goal.y-start[1]))<3 and abs(goal.z-start[2])<.02:return
  for i in range(1,6):
   t=i/5;t=t*t*(3-2*t)
   camera.x,camera.y,camera.z=start[0]+(goal.x-start[0])*t,start[1]+(goal.y-start[1])*t,start[2]+(goal.z-start[2])*t
   put(compose(scene,camera.view(),cursor),80)
 bars={}
 count=0
 for n,target,_,click in events:
  count+=1;bars[n]=bar(captions[n],count)
 previous=None
 for n,target,hold,click in events:
  box=None
  if target:
   b=boxes[n][target];box=(b['x'],b['y'],b['x']+b['w'],b['y']+b['h'])
  timeline.append({'scene':n,'at_ms':elapsed,'target':target,'click':click,'target_center':[(box[0]+box[2])/2,(box[1]+box[3])/2] if box else None})
  delta=changed(images[previous],images[n]) if previous else None
  if box:
   # Stay put while the next target is comfortably in view; otherwise move in close.
   if not contains(camera.view(),box,.08) or camera.z<FOCUS_ZOOM-.01:
    if not previous:put(compose(n,camera.view(),pos),700)
    pan(n,focus_x(box,FOCUS_ZOOM),(box[1]+box[3])/2,FOCUS_ZOOM,pos)
  elif delta and not contains(camera.view(),delta,.02):
   # A result appeared outside the view: frame it, as tight as it allows.
   w,h=delta[2]-delta[0]+80,delta[3]-delta[1]+80
   z=max(MIN_ZOOM,min(FOCUS_ZOOM,W/w,VIEW_H/h))
   pan(n,focus_x(delta,z),(delta[1]+delta[3])/2,z,pos)
  view=camera.view()
  put(compose(n,view,pos if target else None),hold)
  if box:
   dest=((box[0]+box[2])/2,(box[1]+box[3])/2)
   for i in range(1,8):
    t=i/7;t=t*t*(3-2*t);put(compose(n,view,(pos[0]+(dest[0]-pos[0])*t,pos[1]+(dest[1]-pos[1])*t)),60)
   pos=dest;put(compose(n,view,pos,box),360)
   if click:
    for i in range(4):put(compose(n,view,pos,box,i/4),70)
   else:put(compose(n,view,pos,box),800)
  else:put(compose(n,view),500)
  previous=n
 put(compose(events[-1][0],camera.view(),pos),2200)
 sample=Image.new('RGB',(W,H*min(len(frames),24)))
 picks=frames[::max(1,len(frames)//24)][:24]
 for i,f in enumerate(picks):sample.paste(f,(0,H*i))
 palette=sample.resize((W//2,H*len(picks)//2)).quantize(256,method=Image.Quantize.MEDIANCUT)
 coded=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
 path=OUT/f'Farol-{name}-dark.gif'
 coded[0].save(path,save_all=True,append_images=coded[1:],duration=durations,loop=0,optimize=True,disposal=1)
 data=path.read_bytes();check=Image.open(path)
 return {'file':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'width':W,'height':H,'frames':check.n_frames,'duration_ms':sum(durations),'loop':0,'timeline':timeline}

with tempfile.TemporaryDirectory(prefix='farol-dark-setup-') as scratch:
 media=Path(scratch)
 shutil.copytree(ROOT.parent/'onboarding',media/'onboarding',ignore=shutil.ignore_patterns('output','captures','.venv','__pycache__'))
 shutil.copytree(ROOT,media/'dark',ignore=shutil.ignore_patterns('output','__pycache__','stories'))
 package=media/'onboarding'
 for folder in ['output','captures']:(package/folder).mkdir()
 # Render at twice the resolution in the disposable copy; the published light pipeline stays as it is.
 render=package/'source/render.py';source=render.read_text();assert "'-r','96'" in source
 # Cyclic GC can finalize Pango's font map mid-run and crash on Homebrew Pango 1.57.
 render.write_text('import gc;gc.disable()\n'+source.replace("'-r','96'",f"'-r','{96*SCALE}'"))
 env=dict(os.environ,FAROL_MEDIA_THEME='dark')
 for script in ['build_remaining.py','render.py']:
  subprocess.run([sys.executable,str(package/'source'/script)],cwd=package,env=env,check=True,stdout=subprocess.DEVNULL)
 # Reuse the event lists without running the old assembler.
 assembler=(package/'source/assemble.py').read_text().split('manifest=[]')[0]
 scope={'__file__':str(package/'source/assemble.py')};exec(assembler,scope)
 boxes=json.loads((package/'source/boxes.json').read_text())
 captions={}
 for html in (package/'source').glob('*.html'):
  tag=BeautifulSoup(html.read_text(),'html.parser').select_one('.caption')
  if tag:
   number=tag.find('b')
   if number:number.extract()
   captions[html.stem]=' '.join(tag.get_text(' ').split())
 font=geist(scratch)
 big=ImageFont.truetype(str(font),29);big.set_variation_by_axes([600])
 small=ImageFont.truetype(str(font),19);small.set_variation_by_axes([700])
 entries=[]
 for name,events in [('01-sign-in','signin'),('02-workspace','workspace'),('02b-edits-and-commands','access'),('03-create-tunnel','tunnel'),('04-restricted-key','key'),('05-connect-this-mac','connect'),('06-add-plugin','plugin'),('07-test-connection','test')]:
  entry=make(name,scope[events],package/'captures',boxes,captions,(big,small),None);entries.append(entry)
  print(entry['file'],round(entry['bytes']/1048576,2),'MiB',flush=True)
 issues=json.loads((package/'source/layout-checks.json').read_text())['issues']
 (ROOT/'setup-validation.json').write_text(json.dumps({'theme':'dark','layout_issues':issues,'artifacts':entries},indent=2)+'\n')
