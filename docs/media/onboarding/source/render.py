from pathlib import Path
import re,json,sys
from bs4 import BeautifulSoup
from weasyprint import HTML
import subprocess,tempfile
R=Path(__file__).parent
rendercss='''
@page{size:1320px 900px;margin:0}.heading{display:block;position:relative;height:39px}.heading h1{white-space:nowrap;display:block;width:1000px}.heading>span{position:absolute;right:0;top:11px}.setup-welcome>.ui-button{width:111px}.traffic-light-space i{display:block;flex:none;width:11px;height:11px;margin-right:7px}.traffic-light-space{gap:0}html,body{width:1320px;height:900px;margin:0}.desktop{display:block;position:relative;height:652px}.toolbar{position:absolute;left:0;top:0;width:1240px;height:48px;display:block;border-bottom:1px solid var(--line)}.navigation-chrome{position:absolute;left:0;top:0;height:48px}.toolbar-title{position:absolute;left:208px;top:15px;width:310px}.toolbar-title strong,.toolbar-title span{flex:none;overflow:visible}.search-trigger{position:absolute;right:18px;top:8px}.sign-in-context{position:absolute;right:20px;top:8px}.rail{position:absolute;left:0;top:48px;width:190px;height:604px;display:block}.rail .ui-button{margin-bottom:4px;display:flex;align-items:center;height:37px}.rail-footer{position:absolute;left:10px;right:10px;bottom:18px}.stage{position:absolute;left:190px;top:48px;width:1050px;height:604px;display:block;overflow:hidden}.setup-wizard{width:850px;max-width:850px;margin:25px auto;padding:0 26px 20px}.setup-progress{display:flex;flex-wrap:nowrap;width:798px}.setup-progress li{flex:none}.setup-progress-step{white-space:nowrap}.ui-button{display:inline-block;min-height:34px;line-height:18px}.ui-button[data-disabled]{opacity:.5}.setup-overview-step{display:flex;min-height:63px;width:100%;align-items:center;gap:14px}.setup-overview-marker{display:block;width:28px;height:28px;text-align:center;line-height:28px;flex:none;margin-right:14px}.setup-overview-copy{display:block;flex:1}.setup-overview-copy>strong,.setup-overview-copy>.description{display:block}.setup-overview-copy>.description{margin-top:4px}.setup-overview-state{display:block}.setup-welcome>.ui-button{display:block;width:111px}.setup-wizard-footer{position:relative;display:block;height:50px;padding:8px 0}.setup-wizard-footer>.primary{position:absolute;right:0;top:8px}.setup-workspace-row{display:block;position:relative;height:130px}.workspace-row-path{position:absolute;left:0;top:20px;width:310px}.setup-workspace-row>label{position:absolute;top:18px;display:block;padding-top:4px}.setup-workspace-row>label.access-wrap{left:352px}.setup-workspace-row>label.workspace-commands{left:608px;padding-top:11px}.workspace-row-result{position:absolute;left:0;top:68px;display:block}.workspace-row-result .text-button{margin-left:12px}.setup-workspace-row>.text-button{position:absolute;left:0;top:101px}.ui-select{display:inline-block;background:var(--sheet);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-left:8px;width:150px}.ui-checkbox{display:inline-block;width:15px;height:15px;border:1px solid #aaa;border-radius:3px;margin-right:8px;vertical-align:middle;background:var(--sheet)}.ui-checkbox.checked{background:#6750b8;border-color:#6750b8;color:#fff;font-size:11px;text-align:center;line-height:13px}.authpage{position:relative;display:block;height:604px}.authcard{position:absolute;top:95px;left:350px;transform:none;width:350px}.authcard .ui-button{display:block}.authcard .google{display:flex}.provider-note{left:0;width:1050px;text-align:center}.account-card{position:absolute;left:280px;top:113px}.account-card .ui-button{display:flex;width:100%}.account-card .ui-button>span:last-child{display:block}.account-card .ui-button strong,.account-card .ui-button small{display:block}.chat-ready{position:relative;display:block;height:604px;text-align:center;padding-top:180px}.composer{margin:27px auto 0;text-align:left}.returnhelp{display:inline-block}.shade{display:block;position:absolute;left:0;top:0;width:1240px;height:652px}.picker{position:absolute;left:238px;top:116px}.picker-head{display:block;position:relative}.picker-head>span:first-child{position:absolute;left:22px;top:16px}.picker-head>span:last-child{position:absolute;right:22px;top:16px}.picker-location{position:absolute;left:260px;top:10px}.picker-body{display:block;position:relative}.picker-side{position:absolute;left:0;top:0;height:307px}.picker-list{position:absolute;left:155px;top:0}.picker-foot{position:relative;display:block;padding-top:14px}.picker-foot .ui-button{position:absolute;right:112px;top:14px;min-height:29px}.picker-foot .primary{right:20px}.access-menu{left:52px;top:43px}.caption{display:flex}.caption>b{display:block;line-height:30px;text-align:center;flex:none;margin-right:12px}.brand img{margin-right:12px}.brand small{margin-left:auto}.heading h1{margin-right:20px}.window{box-shadow:none}.ui-input{display:block;padding:8px 10px;border:1px solid var(--line);border-radius:6px}.connection-check-return{display:flex}
'''
(R/'render.css').write_text(rendercss)
names=json.loads((R/'scenes.json').read_text())
names=[n for n in names if len(sys.argv)<2 or (sys.argv[1] in n if len(sys.argv)==2 else n in sys.argv[1:])]
boxes=json.loads((R/"boxes.json").read_text()) if (R/"boxes.json").exists() else {};issues=[]
for name in names:
 soup=BeautifulSoup((R/(name+'.html')).read_text(),'html.parser')
 for svg in soup.find_all('svg'):
  svg['fill']='none';svg['stroke']='#77717f';svg['stroke-width']='1.65'
 for b in soup.find_all('button'):
  b.name='div';b['class']=b.get('class',[])+['ui-button']
  if b.has_attr('disabled'):b['data-disabled']='true'
 for b in soup.find_all('input'):
  typ=b.get('type','text');b.name='div';b.can_be_empty_element=False;b['class']=b.get('class',[])+(['ui-checkbox'] if typ=='checkbox' else ['ui-input'])
  if b.has_attr('checked'):b['class']+=['checked'];b.string='✓'
 for b in soup.find_all('select'):
  value=b.find('option').get_text();b.name='div';b.clear();b.string=value+'  ⌄';b['class']=b.get('class',[])+['ui-select']
 for link in soup.find_all('link',rel='stylesheet'):
  c=(R/link['href']).read_text();c=re.sub(r'(?<![-\w])button(?![-\w])','.ui-button',c).replace('.ui-button:disabled','.ui-button[data-disabled]');st=soup.new_tag('style');st.string=c;link.replace_with(st)
 st=soup.new_tag('style');st.string=rendercss;soup.head.append(st)
 doc=HTML(string=str(soup),base_url=str(R)).render();page=doc.pages[0];bbox={}
 for b in page._page_box.descendants():
  if b.element is not None and b.element.get('id') and type(b).__name__ not in ['TextBox','LineBox']:
   ident=b.element.get('id')
   if ident not in bbox:bbox[ident]={'x':b.border_box_x(),'y':b.border_box_y(),'w':b.border_width(),'h':b.border_height()}
 boxes[name]={k:{"x":v[0],"y":v[1],"w":v[2]-v[0],"h":v[3]-v[1]} for k,v in page.anchors.items()}
 pdf=doc.write_pdf()
 with tempfile.TemporaryDirectory() as td:
  pdfpath=Path(td)/'page.pdf';pdfpath.write_bytes(pdf)
  subprocess.run(['pdftoppm','-r','96','-f','1','-singlefile','-png',str(pdfpath),str(R/'../captures'/name)],check=True)
 if len(doc.pages)>1:issues.append({'scene':name,'pages':len(doc.pages)})
 print(name,len(doc.pages),flush=True)
(R/'boxes.json').write_text(json.dumps(boxes,indent=2));(R/'layout-checks.json').write_text(json.dumps({'issues':issues},indent=2))
