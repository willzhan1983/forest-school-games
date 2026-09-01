/*
 * 道具素材处理：AI 生成的 PNG → 透明 RGBA 小图（供 merge.js 内联）
 *
 *   NODE_PATH=/Users/mac/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node tools/mkitem.js
 *
 * 输入：raw-items/*.png（AI 生成，浅色背景 + 右下角水印）
 * 输出：src/<name>.b64.txt（base64，供 merge.js 注入）
 *
 * 处理五步：
 *   1) 去背   —— 四角采样背景色，从边界 BFS 泛洪，容差内全部转透明
 *   2) 去水印 —— 右下角低饱和度灰色文字，只杀灰的，不伤主体（主体饱和度高）
 *   3) 羽化   —— 只处理贴着透明区的 2px 边缘：颜色越接近背景色，alpha 越低。
 *                 少了这步，物体外圈会留一圈灰白描边（AI 出图的抗锯齿混了背景色）。
 *                 只动边缘、不动内部，所以眼白、高光这类内部浅色不会被打穿
 *   4) trim   —— 裁到内容边界，再留 2px 呼吸边
 *   5) 缩放   —— 等比缩到 SIZE×SIZE 以内，转 PNG，编 base64
 *
 * 依赖：sharp（装在 managed workspace，用 NODE_PATH 指过去）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'raw-items');
const SIZE = 128;      // 素材最终边长。游戏里道具约 30~40px，2 倍屏也够用
const TOL = 46;        // 背景色容差（0-255 欧氏距离），太小会留白边，太大会啃掉描边
const PAD = 2;         // trim 后留的边
const FEATHER = 2;     // 羽化作用的边缘宽度（px）
const FEATHER_TOL = 62;// 羽化容差，比 TOL 松，让过渡连续而不是一刀切

/* 右下角水印区（相对比例）。只清这个框里的灰色像素。 */
const WM = { x0: 0.55, y0: 0.86 };

function dist(a, b, c, d) { return Math.sqrt((a - c) ** 2 + (b - d) ** 2); }

function sat(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

async function strip(srcPath, outName) {
  const img = sharp(srcPath);
  const { width: w, height: h } = await img.metadata();

  /* 拿原始 RGB（去掉可能的 alpha 通道，统一按 3 通道处理） */
  const { data } = await sharp(srcPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (data.length !== w * h * 3) throw new Error('raw 长度不符: ' + data.length);

  /* 1) 采样四角，取中位色当背景色 */
  const corners = [];
  for (const [cx, cy] of [[3, 3], [w - 4, 3], [3, h - 4], [w - 4, h - 4]]) {
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const i = ((cy + dy) * w + (cx + dx)) * 3;
      corners.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  corners.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  const bg = corners[Math.floor(corners.length / 2)];
  console.log(`  ${outName}: ${w}x${h} 背景色 rgb(${bg.join(',')})`);

  /* BFS 从四条边泛洪，标记背景（连通 + 容差内） */
  const isBgLike = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (isBgLike[p]) return;
    const i = p * 3;
    if (dist(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) > TOL) return;
    isBgLike[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p - x) / w;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  /* 2) 水印：右下角框内 + 低饱和 + 非极暗 → 判为水印 */
  const wmx = Math.floor(w * WM.x0), wmy = Math.floor(h * WM.y0);
  let wmCount = 0;
  for (let y = wmy; y < h; y++) for (let x = wmx; x < w; x++) {
    const p = y * w + x, i = p * 3;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (sat(r, g, b) < 0.18 && r > 60 && r < 225) { isBgLike[p] = 1; wmCount++; }
  }

  /* 3) 距离变换：每个像素到最近背景像素的距离（多源 BFS），用于边缘羽化 */
  const dEdge = new Int16Array(w * h).fill(-1);
  let queue = [];
  for (let p = 0; p < w * h; p++) if (isBgLike[p]) { dEdge[p] = 0; queue.push(p); }
  for (let d = 0; d <= FEATHER && queue.length; d++) {
    const next = [];
    for (const p of queue) {
      const x = p % w, y = (p - x) / w;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (dEdge[q] !== -1) continue;
        dEdge[q] = d + 1;
        next.push(q);
      }
    }
    queue = next;
  }

  /* 4) 合成 RGBA：背景 alpha=0，主体 alpha=255，边缘 FEATHER px 内按色差衰减 */
  const rgba = Buffer.alloc(w * h * 4);
  let minX = w, minY = h, maxX = -1, maxY = -1, feathered = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 3, o = p * 4;
    rgba[o] = data[i]; rgba[o + 1] = data[i + 1]; rgba[o + 2] = data[i + 2];
    if (isBgLike[p]) { rgba[o + 3] = 0; continue; }

    let a = 255;
    const de = dEdge[p];
    if (de > 0 && de <= FEATHER) {
      const cd = dist(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]);
      if (cd < FEATHER_TOL) {
        a = Math.round(255 * (cd / FEATHER_TOL) * (de / (FEATHER + 1)));
        feathered++;
      }
    }
    rgba[o + 3] = a;
    if (a < 8) continue;   // 羽化到几乎全透明的不再算内容边界

    const x = p % w, y = (p - x) / w;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw new Error('整张都被判成背景了，调 TOL');

  /* 5) trim + 留边 */
  const tx = Math.max(0, minX - PAD), ty = Math.max(0, minY - PAD);
  const tw = Math.min(w - tx, maxX - tx + 1 + PAD);
  const th = Math.min(h - ty, maxY - ty + 1 + PAD);

  /* 4) 缩放输出 */
  const buf = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: tx, top: ty, width: tw, height: th })
    .resize(SIZE, SIZE, { fit: 'inside', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const info = await sharp(buf).metadata();
  const b64 = buf.toString('base64');
  fs.writeFileSync(path.join(ROOT, 'src', outName + '.b64.txt'), b64);
  fs.mkdirSync(path.join(ROOT, 'raw-items', 'out'), { recursive: true });
  fs.writeFileSync(path.join(RAW, 'out', outName + '.png'), buf);
  console.log(`  → ${info.width}x${info.height} png=${(buf.length / 1024).toFixed(1)}KB b64=${(b64.length / 1024).toFixed(1)}KB 水印=${wmCount} 羽化=${feathered} 内容框=${tw}x${th}`);
  return buf.length;
}

(async () => {
  const JOBS = [
    /* 输出名必须和代码里的 kind 一致（ITEM_IMG / ITEM_AR 的 key） */
    ['A_single_cute_cartoon_acorn__c_2026-09-01T14-42-11.png', 'acorn'],
    ['A_single_cute_cartoon_caterpil_2026-09-01T14-42-10.png', 'bug'],
    ['A_single_cute_cartoon_poisonou_2026-09-01T14-42-11.png', 'shroom'],
  ];
  let total = 0;
  for (const [file, name] of JOBS) {
    const p = path.join(RAW, file);
    if (!fs.existsSync(p)) throw new Error('缺少源图: ' + p);
    total += await strip(p, name);
  }
  console.log('素材总计 ' + (total / 1024).toFixed(1) + 'KB PNG');
})();
