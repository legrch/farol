"""Build synthetic dark workflow stories; no accounts, files or live tools used."""
from pathlib import Path
import hashlib,json,math,textwrap,sys
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output';OUT.mkdir(exist_ok=True)
FONTS=ROOT.parent/'workflow/source'
W,H,FPS=1320,820,10
BG='#0b1020';PANEL='#141e32';INNER='#10182a';LINE='#354562';TEXT='#f0f3ff';MUTED='#afbdd7';ACCENT='#bba5ff';GREEN='#85e0b6'
THEME='light' if '--light' in sys.argv else 'dark'
if THEME=='light':
 BG='#f6f5f9';PANEL='#ffffff';INNER='#eeebf5';LINE='#d8d5e1';TEXT='#29292f';MUTED='#686274';ACCENT='#6750b8';GREEN='#2f7555'
class ThemedDraw:
 def __init__(self,image):self.draw=ImageDraw.Draw(image)
 def __getattr__(self,name):
  operation=getattr(self.draw,name)
  def invoke(*args,**kwargs):
   if THEME=='light':
    palette={'#292346':'#eee8fa','#63518c':'#b9a8df','#282244':'#eee8fa','#58477d':'#b9a8df','#243047':'#eee8fa'}
    for key in ['fill','outline']:
     if isinstance(kwargs.get(key),str):kwargs[key]=palette.get(kwargs[key],kwargs[key])
   return operation(*args,**kwargs)
  return invoke
def font(size,bold=False):return ImageFont.truetype(str(FONTS/('LiberationSans-Bold.ttf' if bold else 'LiberationSans-Regular.ttf')),size)
def wrapped(d,text,xy,width=31,size=21,color=TEXT):
 for n,line in enumerate(textwrap.wrap(text,width=width)):d.text((xy[0],xy[1]+n*(size+9)),line,font=font(size),fill=color)
def pill(d,box,text,color=ACCENT):
 d.rounded_rectangle(box,12,fill='#292346',outline='#63518c');d.text((box[0]+12,box[1]+7),text,font=font(15),fill=color)
def frame(kind,t):
 edit=kind=='edit';im=Image.new('RGB',(W,H),BG);d=ThemedDraw(im)
 prompt='Add a greeting(name) function.' if edit else 'Explain this project.'
 stage=min(int(t//4),5)
 titles=['Type your request','Send it to your Mac','Read the selected file','Apply the requested change' if edit else 'Find the project context','Return the result','Check the result']
 d.text((48,42),'Make a change. See it in your file.' if edit else 'Ask about your project. Get a grounded answer.',font=font(35,True),fill=TEXT)
 d.text((48,100),'Illustrated file editing with an existing Read & write grant.' if edit else 'Read from one folder you approve. Start with Read only.',font=font(20),fill=MUTED)
 d.rounded_rectangle((520,180,1272,650),22,fill=INNER,outline=LINE,width=2)
 d.text((548,198),'ON YOUR MAC',font=font(14,True),fill=MUTED)
 d.rounded_rectangle((48,206,456,630),20,fill=PANEL,outline=LINE,width=2)
 d.text((74,230),'ChatGPT',font=font(26,True),fill=TEXT)
 d.line((74,272,430,272),fill=LINE,width=1)
 d.rounded_rectangle((72,294,432,393),14,fill='#282244',outline='#58477d')
 typed=prompt[:min(len(prompt),int(max(t,0)*15))] if stage==0 else prompt
 wrapped(d,typed+('│' if stage==0 and int(t*3)%2==0 else ''),(90,313),width=27,size=21)
 d.ellipse((398,356,422,380),fill=ACCENT)
 d.polygon([(405,368),(410,361),(415,368)],fill=BG)
 d.line((456,340,592,340),fill=LINE,width=3);d.polygon([(465,335),(456,340),(465,345)] if stage>=4 else [(589,335),(598,340),(589,345)],fill=GREEN if stage>=4 else ACCENT)
 d.line((680,340,780,340),fill=LINE,width=3);d.polygon([(689,335),(680,340),(689,345)] if stage>=4 else [(771,335),(780,340),(771,345)],fill=GREEN if stage>=4 else ACCENT)
 # Flat monochrome reinterpretation of Farol's concentric light: no bitmap or blur.
 d.rounded_rectangle((598,302,674,378),19,fill=PANEL,outline=ACCENT,width=2)
 pulse=3 if stage in (1,2,3,4) and int(t*3)%2 else 2
 d.ellipse((613,317,659,363),outline=ACCENT,width=pulse)
 d.ellipse((627,331,645,349),fill=ACCENT)
 d.text((606,401),'Farol',font=font(23,True),fill=TEXT)
 d.text((589,433),'Local bridge',font=font(16),fill=MUTED)
 d.text((470,301),'Request',font=font(14),fill=MUTED)
 d.rounded_rectangle((780,238,1240,578),17,fill=PANEL,outline=ACCENT if stage in (2,3) else LINE,width=2)
 d.text((804,260),'my-project',font=font(25,True),fill=TEXT)
 pill(d,(804,307,965 if edit else 913,340),'Read & write' if edit else 'Read only')
 d.text((804,369),'greeting.py' if edit else 'README.md',font=font(20,True),fill=ACCENT if stage in (2,3) else TEXT)
 d.line((804,407,1216,407),fill=LINE,width=1)
 if edit:
  lines=['# greeting.py','','# Add your greeting here'] if stage<3 else ['def greeting(name):','    return f"Hello, {name}!"']
  if stage==3:
   code='\n'.join(lines);shown=code[:int((t-12)*32)];lines=shown.split('\n')
  for n,line in enumerate(lines):d.text((804,430+n*30),line,font=font(21),fill=GREEN if stage>=3 else MUTED)
 else:
  for n,line in enumerate(['# My project','A small greeting library.','Source: greeting.py']):
   if stage in (2,3):d.rounded_rectangle((798,426+n*31,1218,455+n*31),5,fill='#243047')
   d.text((804,430+n*31),line,font=font(20),fill=TEXT if stage>=2 else MUTED)
 d.text((804,601),'Only the selected workspace is shown.',font=font(16),fill=MUTED)
 if stage>=2 and stage<4:
  d.text((74,431),'Reading greeting.py…' if edit else 'Reading README.md…',font=font(19),fill=ACCENT)
 if stage>=4:
  d.text((74,431),'File updated' if edit else 'Based on README.md',font=font(20,True),fill=GREEN)
  response='Added greeting(name). Review the change in greeting.py.' if edit else 'A small greeting library. Its source is greeting.py.'
  if stage==4:response=response[:int(max(0,t-16)*28)]
  wrapped(d,response,(74,475),width=30,size=20)
 # Data moves along connector-only coordinates, never through captions or text.
 if 4<=t<6:
  x=456+(598-456)*(t-4)/2;d.ellipse((x-6,334,x+6,346),fill=ACCENT)
 if 6<=t<8:
  x=680+100*(t-6)/2;d.ellipse((x-6,334,x+6,346),fill=ACCENT)
 if 16<=t<17:
  x=780-100*(t-16);d.ellipse((x-6,334,x+6,346),fill=GREEN)
 if 17<=t<18.5:
  x=598-(598-456)*(t-17)/1.5;d.ellipse((x-6,334,x+6,346),fill=GREEN)
 d.text((48,697),f'0{stage+1}',font=font(26,True),fill=ACCENT)
 d.text((106,697),titles[stage],font=font(26,True),fill=TEXT)
 for i in range(6):d.rounded_rectangle((48+i*38,746,76+i*38,750),2,fill=ACCENT if i==stage else LINE)
 d.text((48,778),'Synthetic illustration · Not a screen recording · Requested contents and results return to ChatGPT.',font=font(15),fill=MUTED)
 return im
entries=[]
for kind,name in [('read','Farol-how-it-works-'+THEME),('edit','Farol-read-and-edit-'+THEME)]:
 frames=[frame(kind,i/FPS) for i in range(240)]
 atlas=Image.new('RGB',(660,410*6))
 for n,i in enumerate([0,50,90,130,175,220]):atlas.paste(frames[i].resize((660,410)),(0,n*410))
 palette=atlas.quantize(256,method=Image.Quantize.MEDIANCUT)
 images=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
 path=OUT/(name+'.gif');images[0].save(path,save_all=True,append_images=images[1:],duration=100,loop=0,optimize=True)
 entries.append({'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,'dimensions':[W,H],'duration_ms':24000,'stages':6,'illustrative':True})
 sheet=Image.new('RGB',(1320,820*3))
 for n,i in enumerate([0,50,90,130,175,220]):sheet.paste(frames[i].resize((660,410)),((n%2)*660,(n//2)*410))
 sheet.crop((0,0,1320,1230)).save(OUT/(name+'-contact-sheet.png'))
 print(name,flush=True)
(ROOT/('validation.json' if THEME=='dark' else 'light-validation.json')).write_text(json.dumps({'theme':THEME,'artifacts':entries},indent=2)+'\n')
