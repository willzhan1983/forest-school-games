/*
 * 构建脚本：把四个源片段合并成单文件 index.html
 *
 *   node src/merge.js
 *
 * 输出：仓库根目录 index.html
 * 依赖：src/p1~p4.html（源片段）、src/cat.b64.txt、src/owl.b64.txt（立绘 base64）
 *
 * 注意：index.html 是构建产物，不要直接编辑它。要改就改 src/pN.html，然后跑本脚本。
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

const parts = ['p1', 'p2', 'p3', 'p4'].map(function (n) {
  const f = path.join(SRC, n + '.html');
  if (!fs.existsSync(f)) throw new Error('缺少源片段: ' + f);
  return fs.readFileSync(f, 'utf8');
});

let html = parts.join('\n');

if (html.indexOf('__CAT_B64__') < 0) throw new Error('占位符 __CAT_B64__ 不见了');
if (html.indexOf('__OWL_B64__') < 0) throw new Error('占位符 __OWL_B64__ 不见了');
html = html.replace('__CAT_B64__', cat).replace('__OWL_B64__', owl);

if (html.indexOf('__CAT_B64__') >= 0 || html.indexOf('__OWL_B64__') >= 0) {
  throw new Error('占位符替换后仍有残留');
}

fs.writeFileSync(OUT, html);
console.log('written', path.relative(process.cwd(), OUT), html.length, 'chars');
console.log('cat b64', cat.length, '| owl b64', owl.length);
