# 海克斯麻将

一个面向线下麻将牌局的网页端全局海克斯抽取系统。房间内的抽卡、场地效果、随机牌面和倒计时会通过 WebSocket 实时同步。

## 本地运行

```bash
npm install
npm start
```

默认服务地址为 `http://127.0.0.1:3000/`。

## 测试

```bash
npm run test:conflicts
npm run test:recent-cards
npm run test:battle-royale
npm run test:timer
npm run test:security
npm run test:settlement
```

## 主要文件

- `index.html`：网页界面与前端交互。
- `server.mjs`：房间、实时同步、抽卡和计时服务。
- `cards.json`：服务器使用的官方卡池和卡牌元数据。
- `hex_mahjong_hexes.md`：完整海克斯图鉴和规则说明。
- `更新日志.md`：项目更新记录。

闪卡制作使用独立的 `holo-card-studio` 工具，工具仓库不作为本项目运行依赖提交。
