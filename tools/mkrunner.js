/*
 * tools/mkrunner.js —— 把跑酷游戏（forest-school-runner）的官方素材
 * 转成本仓库单文件 HTML 用的 base64 素材（src/rn_*.b64.txt）
 *
 *   node tools/mkrunner.js
 *
 * 源目录：/Users/mac/Desktop/涞儿的任务/游戏/跑酷游戏
 *   assets/chars/fuzzy/v1-test/*.png   14 张动作帧（256×256 带 alpha）
 *   assets/chars/doodle/v1-test/*.png  13 张动作帧（doodle 没有 dash，有 glide）
 *   assets/items/v2-test/*.png          5 张道具（acorn/book/double/magnet/shield）
 *   assets/backgrounds/<scene>/v1-test/distant-*.png  三张场景远景（当背景图用）
 *
 * 产出命名（大写 + 下划线，merge.js 自动登记）：
 *   rn_fz_idle.b64.txt → 占位符 __RN_FZ_IDLE_B64__
 *   rn_dd_glide.b64.txt → __RN_DD_GLIDE_B64__
 *   rn_it_acorn.b64.txt → __RN_IT_ACORN_B64__
 *   rn_bg_forest.b64.txt → __RN_BG_FOREST_B64__
 *
 * 尺寸策略（单文件 HTML 要控体积）：
 *   动作帧：先去透明边 → 缩到最长边 200 → 调色板量化 128 色。
 *     游戏内显示最大 ~128 逻辑 px，200 给高 DPI 留了余量。
 *   道具：最长边 160（显示 56-96 px）。
 *   背景：宽 720（拼图/找不同是分块显示，720 够）。
 * 同时输出 raw-items/out/contact-runner.png 拼版供人眼验收。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_ROOT = '/Users/mac/Desktop/涞儿的任务/游戏/跑酷游戏';
const OUT_DIR = path.join(__dirname, '..', 'src');
const SHEET = path.join(__dirname, '..', 'raw-items', 'out', 'contact-runner.png');

/* 要转的动作帧。名字里的数字保留：run_01 → run1 */
const CHAR_FRAMES = [
  'idle', 'run_01', 'run_02', 'run_03', 'run_04',
  'jump', 'fall', 'land', 'slide', 'hurt', 'win',
  'dash_01', 'dash_02', 'dash_03',   /* fuzzy 有 dash；doodle 没有 */
  'glide'                             /* doodle 有 glide；fuzzy 没有 */
];

const ITEMS = ['acorn', 'book', 'double', 'magnet', 'shield'];

const BACKGROUNDS = [
  ['forest',    'forest',    'distant-lake.png'],
  ['classroom', 'classroom', 'distant-classroom.png'],
  ['treehouse', 'treehouse', 'distant-treehouses.png']
];

const CHAR_BOX = 200;
const ITEM_BOX = 160;
const BG_W = 720;

function outName(rn) { return path.join(OUT_DIR, rn + '.b64.txt'); }

async function writeAsset(rn, buf) {
  const b64 = buf.toString('base64');
  if (b64.indexOf('iVBOR') !== 0 && b64.indexOf('/9j/') !== 0) {
    throw new Error(rn + ' 不是可识别的图片');
  }
  fs.writeFileSync(outName(rn), b64);
  return b64.length;
}

/* 动作帧：去透明边 → 缩放进 box → 量化。
   trim 用 alpha 通道自动裁掉四周空白，避免不同动作帧的留白不一致导致
   在游戏里"跳一下位置就飘"。 */
async function procChar(file) {
  return sharp(file)
    .ensureAlpha()
    .trim({ threshold: 12 })
    .resize(CHAR_BOX, CHAR_BOX, { fit: 'inside', kernel: 'lanczos3' })
    .png({ palette: true, colours: 128, compressionLevel: 9, effort: 8 })
    .toBuffer();
}

async function procItem(file) {
  return sharp(file)
    .ensureAlpha()
    .trim({ threshold: 12 })
    .resize(ITEM_BOX, ITEM_BOX, { fit: 'inside', kernel: 'lanczos3' })
    .png({ palette: true, colours: 128, compressionLevel: 9, effort: 8 })
    .toBuffer();
}

/* 背景是 opaque 的整幅远景，转 JPEG 比 PNG 小很多 */
async function procBg(file) {
  return sharp(file)
    .resize(BG_W, null, { fit: 'inside', kernel: 'lanczos3' })
    .jpeg({ quality: 82, progressive: true, mozjpeg: true })
    .toBuffer();
}

(async () => {
  const jobs = [];   /* { rn, buf } 供拼版 */

  /* --- 角色动作 --- */
  for (const who of ['fuzzy', 'doodle']) {
    for (const f of CHAR_FRAMES) {
      const base = f.replace(/_(\d\d)$/, '$1').replace(/^run_/, 'run').replace(/^dash_/, 'dash');
      const file = path.join(SRC_ROOT, 'assets', 'chars', who, 'v1-test', f + '.png');
      if (!fs.existsSync(file)) continue;   /* doodle 没 dash / fuzzy 没 glide */
      const tag = who === 'fuzzy' ? 'fz' : 'dd';
      const rn = 'rn_' + tag + '_' + base;
      const buf = await procChar(file);
      const len = await writeAsset(rn, buf);
      jobs.push({ rn, buf, kind: 'char' });
      console.log('  ' + rn.padEnd(16) + (len / 1024).toFixed(1).padStart(6) + ' KB');
    }
  }

  /* --- 道具 --- */
  for (const it of ITEMS) {
    const file = path.join(SRC_ROOT, 'assets', 'items', 'v2-test', it + '.png');
    if (!fs.existsSync(file)) { console.log('  缺道具: ' + it); continue; }
    const rn = 'rn_it_' + it;
    const buf = await procItem(file);
    const len = await writeAsset(rn, buf);
    jobs.push({ rn, buf, kind: 'item' });
    console.log('  ' + rn.padEnd(16) + (len / 1024).toFixed(1).padStart(6) + ' KB');
  }

  /* --- 背景 --- */
  for (const [id, dir, fname] of BACKGROUNDS) {
    const file = path.join(SRC_ROOT, 'assets', 'backgrounds', dir, 'v1-test', fname);
    if (!fs.existsSync(file)) { console.log('  缺背景: ' + dir); continue; }
    const rn = 'rn_bg_' + id;
    const buf = await procBg(file);
    const len = await writeAsset(rn, buf);
    jobs.push({ rn, buf, kind: 'bg' });
    console.log('  ' + rn.padEnd(16) + (len / 1024).toFixed(1).padStart(6) + ' KB');
  }

  /* --- 验收拼版：动作帧 + 道具一排排铺开，背景单独一列 --- */
  const cell = 120, cols = 10, pad = 8;
  const chars = jobs.filter(j => j.kind !== 'bg');
  const bgs = jobs.filter(j => j.kind === 'bg');
  const rows = Math.ceil(chars.length / cols);
  const sheetW = cols * (cell + pad) + pad;
  const sheetH = rows * (cell + pad) + pad + bgs.length * (cell + pad);
  const composites = [];
  let idx = 0;
  for (const j of chars) {
    const x = pad + (idx % cols) * (cell + pad);
    const y = pad + Math.floor(idx / cols) * (cell + pad);
    composites.push({
      input: await sharp(j.buf).resize(cell, cell, { fit: 'inside' }).toBuffer(),
      left: x, top: y
    });
    idx++;
  }
  let by = pad + rows * (cell + pad);
  for (const j of bgs) {
    composites.push({
      input: await sharp(j.buf).resize(cell * 3, cell, { fit: 'inside' }).toBuffer(),
      left: pad, top: by
    });
    by += cell + pad;
  }
  await sharp({
    create: { width: sheetW, height: sheetH, channels: 4, background: { r: 245, g: 245, b: 240, alpha: 1 } }
  }).composite(composites).png().toFile(SHEET);

  const total = jobs.reduce((s, j) => s + fs.statSync(outName(j.rn)).size, 0);
  console.log('\n共 ' + jobs.length + ' 张，合计 ' + (total / 1024).toFixed(0) + ' KB（base64 后约 ' +
    (total * 1.34 / 1024).toFixed(0) + ' KB）');
  console.log('拼版: ' + path.relative(process.cwd(), SHEET));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
