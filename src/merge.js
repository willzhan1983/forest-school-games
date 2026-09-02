/*
 * 构建脚本：把源片段合并成单文件 index.html
 *
 *   node src/merge.js
 *
 * 输出：仓库根目录 index.html
 * 依赖：src/p1~p3.html（框架）、src/g-*.html（各小游戏）、src/p4.html（输入与主循环，必须最后）
 *       src/*.b64.txt（素材 base64，由 tools/mkitem.js 产出，自动全部注入）
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

/* 素材自动登记：src 目录下每一个 *.b64.txt 都算一份素材，
   占位符 = 文件名（去掉 .b64.txt）转大写，前后加 __ / _B64__。
   例：cat.b64.txt → __CAT_B64__，an0.b64.txt → __AN0_B64__，spotbg.b64.txt → __SPOTBG_B64__。
   加新素材只要 tools/mkitem.js 出一张图丢进 src/，不用再动本文件。 */
const ASSET_FILES = fs.readdirSync(SRC).filter(function (f) { return f.endsWith('.b64.txt'); });
if (!ASSET_FILES.length) throw new Error('src/ 下没有找到 .b64.txt 素材');

/* 只校验格式，返回裸 base64 —— data URI 的 mime 前缀由 src 片段自己写
   （p2/p3 写 png，g-spot 写 jpeg），这里再拼一次就会变成
   "data:image/png;base64,data:image/png;base64,..." 直接 ERR_INVALID_URL。
   PNG 开头是 iVBOR，JPEG 开头是 /9j/，认不出来的素材宁可抛错也别硬塞。 */
function checkFormat(b64) {
  if (b64.indexOf('iVBOR') === 0 || b64.indexOf('/9j/') === 0) return b64;
  throw new Error('认不出图片格式，开头是: ' + b64.slice(0, 8));
}

const assets = {};
for (const f of ASSET_FILES) {
  const ph = '__' + f.replace(/\.b64\.txt$/, '').toUpperCase() + '_B64__';
  assets[ph] = checkFormat(readB64(f));
}

/* 拼接顺序。p4 必须最后（含 IIFE 收尾 + 关闭标签）。 */
const PARTS = ['p1', 'p2', 'p3', 'g-spot', 'p4'];

const parts = PARTS.map(function (n) {
  const f = path.join(SRC, n + '.html');
  if (!fs.existsSync(f)) throw new Error('缺少源片段: ' + f);
  return fs.readFileSync(f, 'utf8');
});

let html = parts.join('\n');

const used = [];
for (const [ph, uri] of Object.entries(assets)) {
  if (html.indexOf(ph) < 0) continue;   /* 有素材没用上：不报错，最后列出来提醒 */
  html = html.replace(ph, uri);
  used.push(ph);
}

/* 全量复查：任何一个占位符没被替掉，说明 src 和素材对不上，直接失败 */
var left = html.match(/__[A-Z0-9]+_B64__/g);
if (left) throw new Error('占位符替换后仍有残留: ' + left.join(','));

fs.writeFileSync(OUT, html);
console.log('written', path.relative(process.cwd(), OUT), html.length, 'chars');
console.log('注入素材 ' + used.length + '/' + Object.keys(assets).length + ':',
  used.map(function (k) { return k.replace(/^__/, '').replace(/_B64__$/, ''); }).join(' '));
const unused = Object.keys(assets).filter(function (k) { return used.indexOf(k) < 0; });
if (unused.length) console.log('未被引用: ' + unused.join(' '));
