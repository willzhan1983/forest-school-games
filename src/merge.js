/*
 * 构建脚本：把源片段合并成单文件 index.html
 *
 *   node src/merge.js
 *
 * 输出：仓库根目录 index.html
 * 依赖：src/p1~p3.html（框架）、src/g-*.html（各小游戏）、src/p4.html（输入与主循环，必须最后）
 *       src/cat.b64.txt、src/owl.b64.txt（立绘 base64）
 *
 * 片段顺序见下面的 PARTS：p* 是框架，g-* 是每个小游戏。
 * p4 里有 IIFE 收尾和 </script></body></html>，所以必须排在最后。
 *
 * 加新小游戏：新建 src/g-<id>.html，往 PARTS 里插一行（放在 p3 之后、p4 之前）。
 *
 * 注意：index.html 是构建产物，不要直接编辑它。要改就改 src/ 下的片段，然后跑本脚本。
 */
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.join(SRC, '..', 'index.html');

function readB64(name) {
  const s = fs.readFileSync(path.join(SRC, name), 'utf8').trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(s) || s.length < 1000) {
    throw new Error(name + ' base64 异常，长度=' + s.length);
  }
  return s;
}

const cat = readB64('cat.b64.txt');
const owl = readB64('owl.b64.txt');

/* 掉落道具。key 是 src 里的占位符，value 是素材文件。
   加新道具：tools/mkitem.js 产一张图 → 这里加一行 → p2 的 ITEM_IMG/ITEM_AR 登记 key。 */
const ITEMS = {
  __ACORN_B64__: 'acorn.b64.txt',
  __BUG_B64__: 'bug.b64.txt',
  __SHROOM_B64__: 'shroom.b64.txt'
};
const itemB64 = {};
for (const [ph, file] of Object.entries(ITEMS)) itemB64[ph] = readB64(file);

/* 拼接顺序。p4 必须最后（含 IIFE 收尾 + 关闭标签）。 */
const PARTS = ['p1', 'p2', 'p3', 'g-spot', 'p4'];

const parts = PARTS.map(function (n) {
  const f = path.join(SRC, n + '.html');
  if (!fs.existsSync(f)) throw new Error('缺少源片段: ' + f);
  return fs.readFileSync(f, 'utf8');
});

let html = parts.join('\n');

html = html.replace('__CAT_B64__', cat).replace('__OWL_B64__', owl);
for (const [ph, b64] of Object.entries(itemB64)) {
  if (html.indexOf(ph) < 0) throw new Error('占位符 ' + ph + ' 不见了');
  html = html.replace(ph, b64);
}

/* 全量复查：任何一个占位符没被替掉，说明 src 和素材对不上，直接失败 */
var left = html.match(/__[A-Z0-9]+_B64__/g);
if (left) throw new Error('占位符替换后仍有残留: ' + left.join(','));

fs.writeFileSync(OUT, html);
console.log('written', path.relative(process.cwd(), OUT), html.length, 'chars');
console.log('cat b64', cat.length, '| owl b64', owl.length);
console.log('items', Object.keys(itemB64).map(function (k) {
  return k.replace(/_B64__/, '') + '=' + itemB64[k].length;
}).join(' '));
