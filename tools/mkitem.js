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

/* ---------------- 背景图：不去背，只去水印 ----------------
 * 找不同的面板背景是整幅不透明图，水印没法靠"转透明"去掉。
 * 直接裁掉底部 15%（水印区 y>0.86 才有效），再合成、缩放、出 JPEG。
 * 输出尺寸 BG_W×BG_H：面板在屏上最大 ~444×396，2 倍屏 888×792，
 * 640×560 的 JPEG 足够覆盖，还能把体积压到 PNG 的零头。 */
const BG_W = 640, BG_H = 560, BG_SKY = 0.55;

async function buildSpotBg(skyFile, grassFile, outName){
  const cut = async (f) => {
    const m = await sharp(f).metadata();
    const h = Math.floor(m.height * 0.85);            /* 底部 15% 连水印一起裁掉 */
    return sharp(f).extract({ left: 0, top: 0, width: m.width, height: h }).toBuffer();
  };
  const sky = await cut(skyFile), grass = await cut(grassFile);
  /* 天空占上 55%，草地占下 45%，各自 cover 各自那一截 */
  const skyH = Math.round(BG_H * BG_SKY), grassH = BG_H - skyH;
  const skyB = await sharp(sky).resize(BG_W, skyH, { fit: 'cover' }).toBuffer();
  const grassB = await sharp(grass).resize(BG_W, grassH, { fit: 'cover' }).toBuffer();
  const buf = await sharp({ create: { width: BG_W, height: BG_H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: skyB, left: 0, top: 0 }, { input: grassB, left: 0, top: skyH }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const b64 = buf.toString('base64');
  fs.writeFileSync(path.join(ROOT, 'src', outName + '.b64.txt'), b64);
  fs.mkdirSync(path.join(RAW, 'out'), { recursive: true });
  fs.writeFileSync(path.join(RAW, 'out', outName + '.jpg'), buf);
  console.log(`  ${outName}: ${BG_W}x${BG_H} jpg=${(buf.length / 1024).toFixed(1)}KB b64=${(b64.length / 1024).toFixed(1)}KB（天空${skyH}px + 草地${grassH}px）`);
  return buf.length;
}

/* RGB 三通道欧氏距离。
   这里踩过坑：早期写成两参数版 sqrt((a-c)^2+(b-d)^2)，调用却传了 6 个分量，
   实际算的是 (R-B)^2 + (G-bgR)^2 —— 把蓝通道当成对比的红通道。
   背景偏灰时误差小，看不出来；浣熊/小熊/小鸡的暖背景（235,204,183）算出来
   距离 50+，泛洪直接全灭（"去背 0%"）。所以必须三通道都算。 */
function dist(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

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

  /* 1b) 自适应容差：AI 出图的背景常带暗角/纸纹渐变，固定 TOL 会漏。
     从 46 起，泛洪去不掉 15% 以上就升一档，直到 90 封顶。
     主体色和背景差普遍 >120，升档啃不进主体。
     羽化容差跟着 TOL 走（TOL+16），保持过渡带成比例。 */
  const isBgLike = new Uint8Array(w * h);
  let TOL_used = TOL, FEATHER_TOL_used = FEATHER_TOL;
  for (const t of [46, 56, 66, 76]) {
    isBgLike.fill(0);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const p = y * w + x;
      if (isBgLike[p]) return;
      const i = p * 3;
      if (dist(data[i], data[i + 1], data[i + 2], bg[0], bg[1], bg[2]) > t) return;
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
    let n = 0;
    for (let p = 0; p < w * h; p++) n += isBgLike[p];
    TOL_used = t; FEATHER_TOL_used = t + 16;
    const pct = (n / (w * h) * 100).toFixed(0);
    console.log(`  ${outName}: ${w}x${h} 背景色 rgb(${bg.join(',')}) TOL=${t} 去背 ${pct}%`);
    if (n / (w * h) >= 0.15) break;
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
      if (cd < FEATHER_TOL_used) {
        a = Math.round(255 * (cd / FEATHER_TOL_used) * (de / (FEATHER + 1)));
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
  /* 输出名必须和代码里的占位符一致：src/<name>.b64.txt → __<NAME>_B64__ */
  const JOBS = [
    /* p2 接橡果：掉落道具（透明 PNG） */
    ['A_single_cute_cartoon_acorn__c_2026-09-01T14-42-11.png', 'acorn'],
    ['A_single_cute_cartoon_caterpil_2026-09-01T14-42-10.png', 'bug'],
    ['A_single_cute_cartoon_poisonou_2026-09-01T14-42-11.png', 'shroom'],
    /* p3 翻牌记忆：12 种动物脸（透明 PNG，索引顺序 = ANIMALS 数组顺序） */
    ['Front_facing_cute_white_cat_he_2026-09-01T17-17-32.png',    'an0'],
    ['Front_facing_cute_fluffy_yello_2026-09-01T17-17-31.png',    'an1'],
    ['Front_facing_cute_orange_fox_h_2026-09-01T17-17-32.png',    'an2'],
    ['Front_facing_cute_white_bunny__2026-09-01T17-17-32.png',    'an3'],
    ['Front_facing_cute_brown_bear_h_2026-09-01T17-17-33.png',    'an4'],
    ['Front_facing_cute_green_frog_h_2026-09-01T17-17-32.png',    'an5'],
    ['Front_facing_cute_brown_hedgeh_2026-09-01T17-17-57.png',    'an6'],
    ['Front_facing_cute_small_bluebi_2026-09-01T17-17-55.png',    'an7'],
    ['Front_facing_cute_grey_raccoon_2026-09-01T17-17-55.png',    'an8'],
    ['Front_facing_cute_panda_head_p_2026-09-01T17-17-56.png',    'an9'],
    ['Front_facing_cute_pink_piglet__2026-09-01T17-17-55.png',    'an10'],
    ['Front_facing_cute_brown_otter__2026-09-01T17-17-57.png',    'an11'],
  ];
  let total = 0;
  for (const [file, name] of JOBS) {
    const p = path.join(RAW, file);
    if (!fs.existsSync(p)) throw new Error('缺少源图: ' + p);
    total += await strip(p, name);
  }
  /* g-spot 找不同：面板背景（不透明 JPEG，天空上 55% + 草地下 45%） */
  total += await buildSpotBg(
    path.join(RAW, 'Children_s_picture_book_illust_2026-09-01T17-18-14.png'),  /* 天空 */
    path.join(RAW, 'Children_s_picture_book_illust_2026-09-01T17-18-15.png'),  /* 草地 */
    'spotbg');
  console.log('素材总计 ' + (total / 1024).toFixed(1) + 'KB');
})();
