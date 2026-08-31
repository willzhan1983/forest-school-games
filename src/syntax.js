/*
 * 语法检查辅助：从 index.html 抽出内嵌 <script>，交给 node --check 校验
 *
 *   node src/syntax.js && node --check src/_extracted.js
 *
 * 输入：仓库根目录 index.html（构建产物）
 * 输出：src/_extracted.js（临时文件，已在 .gitignore 中忽略）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const re = /<script>([\s\S]*?)<\/script>/g;
let m, i = 0, all = [];
while ((m = re.exec(html))) { all.push(m[1]); i++; }

console.log('script blocks:', i);
if (i !== 1) console.log('WARN: 预期只有 1 个 script 块');

const out = path.join(__dirname, '_extracted.js');
fs.writeFileSync(out, all.join('\n;\n'));
console.log('js chars:', all.join('').length);
