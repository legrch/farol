"""Global palette GIFs; moving request/result dots and quiet cross-fades."""
from pathlib import Path
import hashlib
import json
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
W, H, FPS, COUNT = 1320, 740, 20, 300
def ease(x):
    return x*x*(3-2*x)
def dot(image, start, end, progress, color):
    if not 0 <= progress <= 1:
        return
    x = start + (end-start)*ease(progress)
    draw = ImageDraw.Draw(image)
    draw.ellipse((x-7,371,x+7,385), fill=color, outline='white', width=2)

manifest = []
for kind, basename in [('read','Farol-how-it-works-light'), ('edit','Farol-read-and-edit-light')]:
    scenes = [Image.open(ROOT/'captures'/f'{kind}-{i}.png').convert('RGB') for i in range(4)]
    atlas = Image.new('RGB',(660,370*4))
    for i, scene in enumerate(scenes):
        atlas.paste(scene.resize((660,370)),(0,370*i))
    palette = atlas.quantize(254, method=Image.Quantize.MEDIANCUT)
    colors = palette.getpalette()[:762] + [103,80,184,47,117,85]
    palette.putpalette(colors)
    frames = []
    for index in range(COUNT):
        t = index/FPS
        stage = min(int(t/3.5),3)
        image = scenes[stage].copy()
        if stage and stage*3.5 <= t < stage*3.5+.25:
            image = Image.blend(scenes[stage-1], image, (t-stage*3.5)/.25)
        # Requests travel towards the Mac; results return towards ChatGPT.
        dot(image,384,599,(t-4.0)/1.15,'#6750b8')
        dot(image,747,872,(t-5.55)/.9,'#6750b8')
        dot(image,872,747,(t-8.5)/.85,'#2f7555')
        dot(image,599,384,(t-9.45)/1.05,'#2f7555')
        if t>=14.0:
            image=Image.blend(scenes[3],scenes[0],min((t-14)/.65,1))
        frames.append(image.quantize(palette=palette,dither=Image.Dither.NONE))
    path=ROOT/'output'/f'{basename}.gif'
    frames[0].save(path,save_all=True,append_images=frames[1:],duration=50,loop=0,optimize=True,disposal=1)
    gif=Image.open(path);duration=0
    for i in range(gif.n_frames):
        gif.seek(i);duration+=gif.info['duration']
    sheet=Image.new('RGB',(1320,740),(246,245,249))
    for i,scene in enumerate(scenes):
        sheet.paste(scene.resize((660,370)),((i%2)*660,(i//2)*370))
    sheet.save(ROOT/'output'/f'{basename}-contact-sheet.png')
    decoded=Image.new('RGB',(1320,740),(246,245,249))
    for stage,at in enumerate((0,4200,7700,11200)):
        gif.seek(0);elapsed=0
        for frame in range(gif.n_frames):
            gif.seek(frame)
            if elapsed+gif.info['duration']>at: break
            elapsed+=gif.info['duration']
        decoded.paste(gif.convert('RGB').resize((660,370)),((stage%2)*660,(stage//2)*370))
    decoded.save(ROOT/'output'/f'{basename}-decoded-contact-sheet.png')
    manifest.append({'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,'dimensions':[W,H],'frames':gif.n_frames,'duration_ms':duration,'loop':0,'stages':4,'fps_before_frame_coalescing':FPS})
(ROOT/'validation.json').write_text(json.dumps({'artifacts':manifest,'illustrative':True,'live_acceptance':False},indent=2)+'\n')
print(json.dumps(manifest,indent=2))
