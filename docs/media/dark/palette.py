"""Declaration-aware dark palette for synthetic setup recreations, not pixel inversion."""
import re
from bs4 import BeautifulSoup
BG='#0b1020';TEXT='#f0f3ff';MUTED='#b0bed8';ACCENT='#c3afff'
COLORS=re.compile(r'#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|\bwhite\b|\bblack\b')
def color(raw,property):
 raw=raw.lower()
 if raw in ('white','black'):raw={'white':'#ffffff','black':'#000000'}[raw]
 digits=raw[1:]
 if len(digits) in (3,4):digits=''.join(x*2 for x in digits)
 if len(digits)==8:return raw  # Preserve overlay alpha and native shadow intent.
 r,g,b=(int(digits[n:n+2],16) for n in (0,2,4));light=(r+g+b)/3
 fg=property in ('color','fill','stroke','--fg','--muted','--good','--warn','--accent')
 if fg:
  if min(r,g,b)>235:return TEXT
  if g>r*1.12 and g>b*.85:return '#85e0b6'
  if b>r*1.12 and b>g*1.12:return ACCENT
  if max(r,g,b)-min(r,g,b)>70:return raw
  return TEXT if light<75 else MUTED
 if 'border' in property or property=='--line':return '#3b4b69'
 if property in ('box-shadow','text-shadow'):return raw
 if light>238:return '#141e32' if property not in ('--bg','--rail') else BG
 if light>205:
  return '#292346' if b>r+3 else '#1b2940'
 if light>155 and max(r,g,b)-min(r,g,b)<40:return '#354562'
 return raw
DECL=re.compile(r'([\w-]+)\s*:\s*([^;{}]+)')
def css(text):
 return DECL.sub(lambda m:m[1]+':'+COLORS.sub(lambda c:color(c[0],m[1]),m[2]),text)
def document(html):
 soup=BeautifulSoup(html,'html.parser')
 for style in soup.find_all('style'):style.string=css(style.get_text())
 for tag in soup.find_all(style=True):tag['style']=css(tag['style'])
 extra=soup.new_tag('style');extra.string='''html,body,.story{background:#0b1020!important;color:#f0f3ff!important}.brand small,.heading span,.footer,.provider-note{color:#b0bed8!important}.primary,.sitebtn:not(.secondary),.folder-entry.selected{background:#6750b8!important;color:#fff!important}.text-button{color:#c3afff!important}.ui-input,.ui-select{color:#f0f3ff!important}.webcheck.checked{background:#6750b8!important;color:white!important}''';soup.head.append(extra)
 return str(soup)
