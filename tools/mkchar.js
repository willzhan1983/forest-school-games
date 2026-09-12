/*
 * 角色素材处理：官方角色设定图 → 透明 RGBA 小图（供 merge.js 内联）
 *
 *   NODE_PATH=/Users/mac/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/mac/.workbuddy/binaries/node/versions/22.22.2-3/bin/node tools/mkchar.js
 *
 * 输入：raw-items/fd-src/{fuzzy,doodle}_sheet.png
 *       —— 女儿 IP《Fuzzy & Doodle》官方角色设定图（1448×1086 / 1536×1024），
 *          白底 + 三视图 + 五张表情脸的排版稿，原始文件在
 *          ~/Documents/Cat_Owl_Diary_S1E1_Final_Assets/ 下。
 * 输出：src/<name>.b64.txt（base64，merge.js 自动注入）+ raw-items/out/<name>.png
 *
 * 和 mkitem.js 的区别：mkitem 处理的是「一张图一个道具」，
 * 这里处理的是「一张设定图里切出 N 个角色」，所以多两步定位：
 *   1) 定位 —— 在给定区域内二值化，取最大连通块的外接框（文字标签、
 *              感叹号装饰都是独立小块，会被自动排除），再留 6% 余量
 *   2) 裁切 —— 按外接框裁出来，之后走和 mkitem 一样的
 *              去背 → 羽化 → trim → 缩放 → base64
 * 白底 + 黑色描边的图，从边界泛洪去背不会啃进角色内部
 * （肚子是白的，但被描边圈住了，泛洪进不去）。
 *
 * 改素材只要调 CELLS 里的区域比例，不用改算法。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'raw-items', 'fd-src');
const OUT_DIR = path.join(ROOT, 'raw-items', 'out');
const PAD = 2;
const FEATHER = 2;

/* 区域用「整张图的比例」写，换分辨率不用重算。
   x0,y0,x1,y1 只要把目标框住就行 —— 真正的边界由连通块自己找。 */
const SHEETS = {
  fuzzy:  { file: 'fuzzy_sheet.png',
            body: { y0: 0.10, y1: 0.56, x: [[0.19, 0.45], [0.46, 0.68], [0.69, 0.99]] },
            face: { y0: 0.65, y1: 0.88, x: [[0.00, 0.17], [0.18, 0.35], [0.36, 0.54], [0.55, 0.74], [0.75, 1.00]] } },
  doodle: { file: 'doodle_sheet.png',
            body: { y0: 0.11, y1: 0.58, x: [[0.24, 0.46], [0.47, 0.72], [0.72, 0.99]] },
            face: { y0: 0.64, y1: 0.90, x: [[0.00, 0.16], [0.19, 0.37], [0.38, 0.56], [0.57, 0.75], [0.76, 1.00]] } }
};

/* 每个角色的输出名 + 目标边长。
 *   body = 三视图全身（正/侧/背），菜单立绘和游戏内主体用，192 够 2 倍屏
 *   face = 表情脸特写，只用在 40~90px 的位置，132 足够
 * 顺序：body 依次 正面/侧面/背面，face 依次 开心/笑眯眯/惊讶/委屈(发呆)/吃 */
const JOBS = [
  ['fuzzy',  'body', 0, 'fz_front', 192],
  ['fuzzy',  'body', 1, 'fz_side',  192],
  ['fuzzy',  'body', 2, 'fz_back',  192],
  ['doodle', 'body', 0, 'dd_front', 192],
  ['doodle', 'body', 1, 'dd_side',  192],
  ['doodle', 'body', 2, 'dd_back',  192],
  ['fuzzy',  'face', 0, 'fz_happy', 132],
  ['fuzzy',  'face', 1, 'fz_smile', 132],
  ['fuzzy',  'face', 2, 'fz_wow',   132],
  ['fuzzy',  'face', 3, 'fz_sad',   132],
  ['fuzzy',  'face', 4, 'fz_fish',  132],
  ['doodle', 'face', 0, 'dd_happy', 132],
  ['doodle', 'face', 1, 'dd_smile', 132],
  ['doodle', 'face', 2, 'dd_wow',   132],
  ['doodle', 'face', 3, 'dd_daze',  132],
  ['doodle', 'face', 4, 'dd_apple', 132]
];

function dist(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/* 在区域里找主体：非白像素二值化 → 最大连通块 → 外接框（含 6% 余量）。
   返回 {left, top, width, height}（绝对像素）。 */
function locate(data, w, h, region) {
  const { x0, y0, x1, y1 } = region;
  const rx0 = Math.max(0, Math.floor(x0 * w)), rx1 = Math.min(w, Math.ceil(x1 * w));
  const ry0 = Math.max(0, Math.floor(y0 * h)), ry1 = Math.min(h, Math.ceil(y1 * h));
  const rw = rx1 - rx0, rh = ry1 - ry0;
  const seen = new Uint8Array(rw * rh);
  let best = null;
  const isFg = (x, y) => {
    const i = (y * w + x) * 3;
    return dist(data[i], data[i + 1], data[i + 2], 255, 255, 255) > 60;
  };
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const p = y * rw + x;
      if (seen[p] || !isFg(rx0 + x, ry0 + y)) continue;
      /* BFS 一个连通块 */
      const stack = [p]; seen[p] = 1;
      let n = 0, minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const q = stack.pop(); n++;
        const qx = q % rw, qy = (q - qx) / rw;
        if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
        const nb = [[qx + 1, qy], [qx - 1, qy], [qx, qy + 1], [qx, qy - 1]];
        for (const [nx, ny] of nb) {
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const r = ny * rw + nx;
          if (seen[r] || !isFg(rx0 + nx, ry0 + ny)) continue;
          seen[r] = 1; stack.push(r);
        }
      }
      if (!best || n > best.n) best = { n, minX, maxX, minY, maxY };
    }
  }
  if (!best) throw new Error('区域内没找到主体，检查 CELLS 比例');
  const bx = rx0 + best.minX, by = ry0 + best.minY;
  const bw = best.maxX - best.minX + 1, bh = best.maxY - best.minY + 1;
  const mx = Math.round(bw * 0.06), my = Math.round(bh * 0.06);
  return {
    left: Math.max(0, bx - mx),
    top: Math.max(0, by - my),
    width: Math.min(w - Math.max(0, bx - mx), bw + mx * 2),
    height: Math.min(h - Math.max(0, by - my), bh + my * 2)
  };
}

/* 去背 + 羽化 + trim + 缩放。和 mkitem.js 的 strip() 同一套原理，
   只是背景固定是纯白，容差不用自适应。 */
async function cut(srcFile, box, outName, size) {
  const crop = await sharp(srcFile).extract(box).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const w = crop.info.width, h = crop.info.height, data = crop.data;

  const TOL = 46, FTOL = 62;
  const isBg = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (isBg[p]) return;
    const i = p * 3;
    if (dist(data[i], data[i + 1], data[i + 2], 255, 255, 255) > TOL) return;
    isBg[p] = 1; stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p - x) / w;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  /* 到最近背景像素的距离（多源 BFS），只用来做 2px 边缘羽化 */
  const dEdge = new Int16Array(w * h).fill(-1);
  let q = [];
  for (let p = 0; p < w * h; p++) if (isBg[p]) { dEdge[p] = 0; q.push(p); }
  for (let d = 0; d <= FEATHER && q.length; d++) {
    const next = [];
    for (const p of q) {
      const x = p % w, y = (p - x) / w;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const r = ny * w + nx;
        if (dEdge[r] !== -1) continue;
        dEdge[r] = d + 1; next.push(r);
      }
    }
    q = next;
  }

  const rgba = Buffer.alloc(w * h * 4);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let p = 0; p < w * h; p++) {
    const i = p * 3, o = p * 4;
    rgba[o] = data[i]; rgba[o + 1] = data[i + 1]; rgba[o + 2] = data[i + 2];
    if (isBg[p]) { rgba[o + 3] = 0; continue; }
    let a = 255;
    const de = dEdge[p];
    if (de > 0 && de <= FEATHER) {
      const cd = dist(data[i], data[i + 1], data[i + 2], 255, 255, 255);
      if (cd < FTOL) a = Math.round(255 * (cd / FTOL) * (de / (FEATHER + 1)));
    }
    rgba[o + 3] = a;
    if (a < 8) continue;
    const x = p % w, y = (p - x) / w;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw new Error(outName + ': 整块都被判成背景');

  const tx = Math.max(0, minX - PAD), ty = Math.max(0, minY - PAD);
  const tw = Math.min(w - tx, maxX - tx + 1 + PAD), th = Math.min(h - ty, maxY - ty + 1 + PAD);
  const buf = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: tx, top: ty, width: tw, height: th })
    .resize(size, size, { fit: 'inside', kernel: 'lanczos3' })
    /* 调色板压缩：设定图是平涂卡通风，256 色足够，体积只有真彩的 1/4。
       16 张角色全塞进单文件 HTML，真彩要多背 ~400KB，孩子手机上不值得。 */
    .png({ compressionLevel: 9, palette: true, colours: 256, dither: 0.6 })
    .toBuffer();

  const info = await sharp(buf).metadata();
  fs.writeFileSync(path.join(ROOT, 'src', outName + '.b64.txt'), buf.toString('base64'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, outName + '.png'), buf);
  return { bytes: buf.length, w: info.width, h: info.height };
}

(async () => {
  const sheets = {};
  for (const k of Object.keys(SHEETS)) {
    const p = path.join(SRC_DIR, SHEETS[k].file);
    if (!fs.existsSync(p)) throw new Error('缺少设定图: ' + p);
    const raw = await sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    sheets[k] = { data: raw.data, w: raw.info.width, h: raw.info.height, path: p };
  }
  let total = 0;
  const done = [];
  for (const [sheet, kind, idx, name, size] of JOBS) {
    const s = sheets[sheet], spec = SHEETS[sheet][kind];
    const region = {
      x0: spec.x[idx][0], x1: spec.x[idx][1],
      y0: spec.y0, y1: spec.y1
    };
    const box = locate(s.data, s.w, s.h, region);
    const r = await cut(s.path, box, name, size);
    done.push({ name, ...r, box });
    total += r.bytes;
    console.log(`  ${name.padEnd(9)} ${r.w}x${r.h} ${(r.bytes / 1024).toFixed(1)}KB`
      + `（定位 ${box.left},${box.top} ${box.width}x${box.height}）`);
  }

  /* 目检用拼版：16 张排一行，一眼看出有没有切歪、留白边、被裁掉耳朵 */
  const cell = 200, cols = 8, rows = Math.ceil(done.length / cols);
  const tiles = [];
  for (let i = 0; i < done.length; i++) {
    const b = await sharp(path.join(OUT_DIR, done[i].name + '.png'))
      .resize(cell - 16, cell - 16, { fit: 'inside' }).toBuffer();
    const m = await sharp(b).metadata();
    tiles.push({ input: b, left: Math.round((i % cols) * cell + (cell - m.width) / 2), top: Math.round(Math.floor(i / cols) * cell + (cell - m.height) / 2) });
  }
  const sheetBuf = await sharp({
    create: { width: cols * cell, height: rows * cell, channels: 4, background: { r: 236, g: 240, b: 234, alpha: 1 } }
  }).composite(tiles).png().toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'contact-characters.png'), sheetBuf);
  console.log('素材总计 ' + (total / 1024).toFixed(1) + 'KB，拼版 raw-items/out/contact-characters.png');
})();
