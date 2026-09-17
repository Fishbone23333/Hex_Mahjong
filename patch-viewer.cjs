const fs=require('fs');
const root='D:/pyproject/HAX/artifacts/jing-shui-jian-yu/web/';
let p=root+'index.html',s=fs.readFileSync(p,'utf8');
s=s.replace('<div id="loading" role="status">正在加载卡牌…</div>','<img id="fallback-art" src="./assets/preview.png" alt="静水监狱卡面预览"><div id="loading" role="status">正在加载卡牌…</div>'); fs.writeFileSync(p,s);
p=root+'style.css'; s=fs.readFileSync(p,'utf8'); s=s.replace('#stage canvas{display:block;width:100%;height:100%}','#stage canvas{display:block;width:100%;height:100%;position:relative;z-index:1}#fallback-art{position:absolute;z-index:0;left:12%;top:4%;width:76%;height:92%;object-fit:contain;border-radius:18px;box-shadow:0 30px 80px #18203140}'); fs.writeFileSync(p,s);
p=root+'app.js'; s=fs.readFileSync(p,'utf8'); s=s.replace('setupControls();new ResizeObserver(resize).observe(stage);resize();loading.remove();','setupControls();new ResizeObserver(resize).observe(stage);resize();document.querySelector(\'#fallback-art\')?.remove();loading.remove();'); fs.writeFileSync(p,s);
