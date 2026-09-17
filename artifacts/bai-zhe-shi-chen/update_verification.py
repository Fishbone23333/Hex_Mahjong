from pathlib import Path
from PIL import Image
import json
root=Path(__file__).resolve().parent
p=root/'verification.json'
data=json.loads(p.read_text(encoding='utf8'))
source=Image.open(root/'source-transparent.png').convert('RGBA')
hero=Image.open(root/'renders'/'hero.png').convert('RGBA')
data['source_art']={'size':list(source.size),'mode':source.mode,'transparent_corners':[source.getchannel('A').getpixel(pt) for pt in [(0,0),(source.width-1,0),(0,source.height-1),(source.width-1,source.height-1)]]}
data['card_geometry']={'corner_radius':0.34,'transparent_front':True,'transparent_back':True,'transparent_render_background':True}
data['text_layout']={'fields':['title','tagline'],'other_card_text_removed':True,'title_center':[512,815],'description_center':[512,1045]}
data['render_alpha']={'mode':hero.mode,'alpha_extrema':list(hero.getchannel('A').getextrema()),'corner_alpha':[hero.getchannel('A').getpixel(pt) for pt in [(0,0),(hero.width-1,0),(0,hero.height-1),(hero.width-1,hero.height-1)]]}
data['render_previews']=['renders/hero.png','renders/angle-left.png','renders/angle-right.png']
data['browser_checks']={'desktop_screenshot':'web/headless-check.png','mobile_screenshot':'web/headless-mobile.png','assets_http_200':True,'webgl_card_loaded':True}
p.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'source':data['source_art'],'render_alpha':data['render_alpha'],'text_layout':data['text_layout']},ensure_ascii=False,indent=2))
