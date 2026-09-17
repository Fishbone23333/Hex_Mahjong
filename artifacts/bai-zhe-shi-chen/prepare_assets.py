from pathlib import Path
from PIL import Image
import numpy as np, cv2
root=Path(__file__).resolve().parent
src_img=Image.open(root/'source-transparent.png').convert('RGBA')
src=np.array(src_img); rgb=src[:,:,:3]; source_alpha=src[:,:,3]
H,W=rgb.shape[:2]
hsv=cv2.cvtColor(rgb,cv2.COLOR_RGB2HSV); V=hsv[:,:,2]; y,x=np.indices((H,W))
# Subject: isolate the complete upper time-reversal emblem, leaving the card frame in the background.
roi=(x>=205)&(x<=820)&(y>=72)&(y<=720)
raw=((V.astype(np.int16)>43)&roi).astype(np.uint8)
num,labels,stats,cent=cv2.connectedComponentsWithStats(raw,8)
keep=np.zeros((H,W),np.uint8)
for i in range(1,num):
    x0,y0,w,h,area=stats[i]; cx,cy=cent[i]
    if area>=7 and x0<825 and x0+w>200 and y0<725 and cy<665:
        keep[labels==i]=255
keep=cv2.dilate(keep,np.ones((3,3),np.uint8),iterations=1)
alpha=np.clip((V.astype(np.float32)-24)*5,0,255).astype(np.uint8)
alpha=np.minimum(alpha,keep);alpha=cv2.GaussianBlur(alpha,(0,0),0.8);alpha=np.minimum(alpha,source_alpha);alpha[:108,:]=0
Image.fromarray(np.dstack([rgb,alpha]).astype(np.uint8),'RGBA').save(root/'assets'/'subject.png')
# Background: rebuild the dark panel below the emblem while preserving the original full border and transparent corners.
rgbf=rgb.astype(np.float32)
samples=np.concatenate([rgbf[:,125:220,:],rgbf[:,804:899,:]],axis=1)
row=np.median(samples,axis=1);row=cv2.GaussianBlur(row.reshape(H,1,3),(0,0),22).reshape(H,3)
Y,X=np.mgrid[:H,:W];dx=(X-W/2)/(W/2);dy=(Y-660)/1100;vign=(1-0.08*np.clip(dx*dx+0.32*dy*dy,0,1))[...,None]
grad=np.clip(row[:,None,:]*vign,0,255)
mask=np.zeros((H,W),np.float32);cv2.ellipse(mask,(W//2,365),(350,325),0,0,360,1,-1);mask=cv2.GaussianBlur(mask,(0,0),28)
mask[:54,:]=0;mask[:,:78]=0;mask[:,W-78:]=0;mask[735:,:]=0
bg=rgbf*(1-mask[...,None])+grad*mask[...,None]
halo=np.exp(-(((X-W/2)/420)**2+((Y-340)/360)**2)*1.8)[...,None]
bg=np.clip(bg+halo*np.array([1,3,7]),0,255).astype(np.uint8)
Image.fromarray(np.dstack([bg,source_alpha]),'RGBA').save(root/'assets'/'background.png')
# Registered etched line layer for the subject only.
gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY);edge=cv2.Canny(gray,55,135);edge[alpha<12]=0;edge=np.maximum(edge,cv2.Canny(alpha,35,100));edge=cv2.dilate(edge,np.ones((2,2),np.uint8),iterations=1)
line=np.full((H,W),255,np.uint8);line[edge>0]=25;soft=cv2.GaussianBlur(edge.astype(np.float32),(0,0),0.7);line=np.minimum(line,(255-soft*.88).astype(np.uint8))
Image.fromarray(line,'L').convert('RGB').save(root/'assets'/'lineart.png')
print('canvas',W,H,'source alpha',source_alpha.min(),source_alpha.max(),'subject bbox',Image.fromarray(alpha).getbbox())
