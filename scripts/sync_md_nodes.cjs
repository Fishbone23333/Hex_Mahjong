/*
 * Keep the HTML draw rules in sync with hex_mahjong_hexes.md.
 * Run from the project directory with: node scripts/sync_md_nodes.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mdPath = path.join(root, 'hex_mahjong_hexes.md');
const htmlPath = path.join(root, 'index.html');
const md = fs.readFileSync(mdPath, 'utf8');
let html = fs.readFileSync(htmlPath, 'utf8');

const labelToPhases = {
  '仅开局': ['opening'],
  '通用': ['opening', 'listen', 'firstWin', 'secondWin'],
  '听牌后': ['listen'],
  '胡牌后': ['firstWin'],
  '第二家胡牌后': ['secondWin'],
  '开局、听牌后、胡牌后': ['opening', 'listen', 'firstWin'],
  '开局、通用': ['opening', 'listen', 'firstWin', 'secondWin'],
  '听牌后、通用': ['opening', 'listen', 'firstWin', 'secondWin'],
  '胡牌后、第二家胡牌后': ['firstWin', 'secondWin']
};

const rules = {};
for (const line of md.split(/\r?\n/)) {
  const match = line.match(/^\|\s*((?:P|N)\d+)\s*\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|/);
  if (!match) continue;
  const [, id, , label] = match;
  if (!labelToPhases[label]) throw new Error(`无法识别 ${id} 的节点标签：“${label}”`);
  rules[id] = labelToPhases[label];
}

const cardIds = [...html.matchAll(/\{id:'((?:P|N)\d+)'/g)].map(match => match[1]);
const missing = cardIds.filter(id => !rules[id]);
const extra = Object.keys(rules).filter(id => !cardIds.includes(id));
if (missing.length || extra.length) {
  throw new Error(`卡牌节点不一致。HTML 缺少：${missing.join(', ') || '无'}；Markdown 多出：${extra.join(', ') || '无'}`);
}

// 节点标签写回每张卡自己的 tags 字段，运行时只读取这些元数据。
const allPhases = ['opening', 'listen', 'firstWin', 'secondWin'];
const tagsFor = phases => phases.length === allPhases.length ? ['any'] : phases;
html = html.split(/\r?\n/).map(line => {
  const card = line.match(/\{id:'((?:P|N)\d+)'/);
  if (!card || !rules[card[1]]) return line;
  return line.replace(/tags:\[[^\]]*\]/, `tags:${JSON.stringify(tagsFor(rules[card[1]]))}`);
}).join('\n');
const marker = /    \/\* MD_NODE_RULES_START \*\/\n[\s\S]*?    \/\* MD_NODE_RULES_END \*\/\n?/;
html = html.replace(marker, '');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`已同步 ${Object.keys(rules).length} 张卡牌的可抽取节点。`);
