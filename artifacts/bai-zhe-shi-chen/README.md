# 败者食尘 · 棱彩全息卡

通用制作流程、分层标准、主站接入方式和踩坑记录见项目根目录的 `闪卡制作流程与踩坑记录.md`。本目录作为后续海克斯闪卡的标准样卡工程。

本项目使用 Holo Card Studio 的 holographic foil 路线制作。原图保持完整的 1024×1536 尺寸，四个角的深色底改为真实透明 Alpha，卡体、背面和网页 GLB 使用一致的透明圆角轮廓。

- `source-transparent.png`：保留完整边框的透明角原始卡面
- `assets/`：背景、主体透明层、线稿层和文字层
- `card.blend`：可编辑的 Blender 场景
- `renders/hero.png`：正面成品预览
- `renders/angle-left.png`、`renders/angle-right.png`：左右倾斜预览
- `web/`：Three.js 全息卡网页查看器

卡面文字只保留海克斯名称和效果说明。坐标由 `card-config.json` 的 `textLayout.elements` 控制，可以直接调整 `x`、`y`、字号、宽度和自动换行。

预览：

```powershell
cd web
node server.mjs
```

打开命令输出的 `http://127.0.0.1:4173`，可拖动卡片查看视差和闪烁效果。
