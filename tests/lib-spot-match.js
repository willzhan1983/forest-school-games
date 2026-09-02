/*
 * 找不同「景物到底画的是位图还是矢量」的比对库
 * tests/test-art.js 的 ART9 和 tools/verify-live.js 的 V13 共用。
 *
 * ---------- 为什么不直接算整屏差异率 ----------
 * 最早的做法是：取样每个景物包围盒，比「位图版」和「强制 ready=false 后的矢量版」
 * 差了多少像素。两个毛病：
 *   1. 采样区里混着背景图，9 个景物才占面板一成多面积，信号一摊薄就没了
 *   2. bush 这类形状颜色跟矢量版接近的元素只有 27%，线上还出现过正好卡在
 *      阈值 20 的 —— 判据带临界值就一定会偶发翻车
 *
 * ---------- 现在怎么做 ----------
 * 拿位图自己的 alpha 当 mask，只挑实心像素，反算它在主画布上的位置，比对颜色：
 *   - 画的是位图 → 屏幕像素就是这张图的颜色，误差几乎为 0
 *   - 走的是矢量 → 形状颜色都对不上，误差极大
 * 中间没有模糊地带。实测位图版每类 0~3.4%、矢量版 22.5~88.7%，隔开 6 倍多。
 *
 * ---------- 三个必须复刻的细节（少一个底噪就压不下去）----------
 *   1. 期望图要走一遍与主画布完全相同的 drawImage。不能直接拿 128px 原图比：
 *      rock 只有 28 逻辑像素高，位图要缩 3 倍，重采样本身就能造出 20% 误差
 *   2. 期望图要复刻 drawSpotScene 的 clip（面板内缩 3px 的圆角矩形），
 *      否则贴边被切掉一角的景物全是假误差，一个边缘灌木能贡献 18%
 *   3. 源像素取中心 (px+0.5)/pxW，不是左边缘。位图缩到屏幕是 0.5 倍，
 *      半个源像素就是一个设备像素，用左边缘等于全程采邻居点
 *
 * 另外景物之间会互相遮挡（树冠盖住旁边的灌木），被盖住的 bad% 能到 77%，
 * 所以先按绘制顺序算出每个像素归谁，采样时跳过不属于自己的点。
 */

/* 固定场景：一局随机只出现 5~6 类，8 类永远验不全。
   这里把 Spot.L 换成每类一个、分两排摆开，列距都大于元素宽度，互不遮挡。
   只动 L —— R 和 spots 不动，测试也不点击，不影响其它用例。 */
function sceneScript() {
  const f = window.__fsm;
  f.Game.state = 'menu';
  f.selectGame('spot');
  f.startCurrent();
}
function fixedSceneScript() {
  const f = window.__fsm;
  const L = [];
  ['cloud', 'bird', 'butterfly'].forEach(function (t, i) {
    L.push({ t: t, x: 70 + i * 100, y: 80, s: 1, c: 0, f: 1, gone: false });
  });
  ['tree', 'bush', 'mushroom', 'flower', 'rock'].forEach(function (t, i) {
    L.push({ t: t, x: 60 + i * 82, y: 320, s: 1, c: 0, f: 1, gone: false });
  });
  f.Spot.L = L;
}

/* 采样：返回每个景物的 { t, n, badPct, avgErr }
   n 是有效采样点数，<30 的说明整个被邻居盖住或被面板裁掉，判据里要剔除。 */
function matchScript() {
  const f = window.__fsm;
  const main = document.getElementById('game');
  const mc = main.getContext('2d');
  const sx = main.width / 960, sy = main.height / 540;
  const p0 = f.spotPanel(0);
  const props = f.Spot.L.filter(function (p) { return !p.gone; });

  /* 模块的 roundRect 画的是全局 ctx，离屏调不动，这里照抄一份（逻辑坐标） */
  const rr = function (c, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  };
  const INSET = 3;
  const paint = function (c, p) {
    const a = f.SPOT_ART[p.t];
    const w = a.drawH * a.pxW / a.pxH;
    c.save();
    rr(c, p0.x + INSET, p0.y + INSET, p0.w - INSET * 2, p0.h - INSET * 2, 12);
    c.clip();
    c.translate(p0.x + p.x, p0.y + p.y);
    c.scale(p.s * p.f, p.s);
    c.drawImage(f.spotTinted(p.t, p.c), -w / 2, -a.drawH * a.ay, w, a.drawH);
    c.restore();
  };

  /* 遮挡 owner：每个像素记下最后画上去的景物下标 */
  const own = new Int16Array(main.width * main.height).fill(-1);
  const tmp = document.createElement('canvas');
  tmp.width = main.width; tmp.height = main.height;
  const tc = tmp.getContext('2d');
  tc.setTransform(sx, 0, 0, sy, 0, 0);
  props.forEach(function (p, idx) {
    const a = f.SPOT_ART[p.t];
    const w = a.drawH * a.pxW / a.pxH;
    tc.clearRect(0, 0, 960, 540);
    paint(tc, p);
    tc.setTransform(1, 0, 0, 1, 0, 0);
    const bw2 = Math.ceil(w * p.s * sx) + 2, bh2 = Math.ceil(a.drawH * p.s * sy) + 2;
    const bx2 = Math.max(0, Math.floor((p0.x + p.x) * sx - bw2 / 2));
    const by2 = Math.max(0, Math.floor((p0.y + p.y - a.drawH * a.ay * p.s) * sy));
    const ww = Math.min(tmp.width - bx2, bw2), hh = Math.min(tmp.height - by2, bh2);
    if (ww > 0 && hh > 0) {
      const d = tc.getImageData(bx2, by2, ww, hh).data;
      for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
        if (d[(y * ww + x) * 4 + 3] > 200) own[(by2 + y) * main.width + (bx2 + x)] = idx;
      }
    }
    tc.setTransform(sx, 0, 0, sy, 0, 0);
  });

  return props.map(function (p, IDX) {
    const a = f.SPOT_ART[p.t];
    const w = a.drawH * a.pxW / a.pxH;

    const cv2 = document.createElement('canvas');
    cv2.width = a.pxW; cv2.height = a.pxH;
    const c2 = cv2.getContext('2d');
    c2.drawImage(f.spotTinted(p.t, p.c), 0, 0);
    const src = c2.getImageData(0, 0, a.pxW, a.pxH).data;

    /* 实心 mask：自身 alpha 满、四邻域也都满。
       只判自身不够 —— 2px 羽化边和描边旁边的像素 alpha 也是满的，
       重采样后跟邻近色混在一起，误差大得离谱，把信号搅浑。 */
    const solid = new Uint8Array(a.pxW * a.pxH);
    for (let py = 1; py < a.pxH - 1; py++) {
      for (let px = 1; px < a.pxW - 1; px++) {
        const i = py * a.pxW + px;
        if (src[i * 4 + 3] < 250) continue;
        if (src[(i - 1) * 4 + 3] < 250 || src[(i + 1) * 4 + 3] < 250 ||
          src[(i - a.pxW) * 4 + 3] < 250 || src[(i + a.pxW) * 4 + 3] < 250) continue;
        solid[i] = 1;
      }
    }

    const hw = w * p.s / 2;
    const top = -a.drawH * a.ay * p.s, bot = a.drawH * (1 - a.ay) * p.s;
    const bx = Math.max(0, Math.floor((p0.x + p.x - hw) * sx) - 1);
    const by = Math.max(0, Math.floor((p0.y + p.y + top) * sy) - 1);
    const bw = Math.min(main.width - bx, Math.ceil(w * p.s * sx) + 2);
    const bh = Math.min(main.height - by, Math.ceil((bot - top) * p.s * sy) + 2);
    const dst = mc.getImageData(bx, by, bw, bh).data;

    const sim = document.createElement('canvas');
    sim.width = bw; sim.height = bh;
    const sc = sim.getContext('2d');
    sc.imageSmoothingEnabled = true;
    sc.setTransform(sx, 0, 0, sy, -bx, -by);
    paint(sc, p);
    const exp = sc.getImageData(0, 0, bw, bh).data;

    let n = 0, bad = 0, sumErr = 0;
    for (let py = 1; py < a.pxH - 1; py += 2) {
      for (let px = 1; px < a.pxW - 1; px += 2) {
        const i = py * a.pxW + px;
        if (!solid[i]) continue;
        const X = p0.x + p.x + ((px + 0.5) / a.pxW - 0.5) * w * p.s * p.f;
        const Y = p0.y + p.y + ((py + 0.5) / a.pxH - a.ay) * a.drawH * p.s;
        const gx = Math.round(X * sx), gy = Math.round(Y * sy);
        if (own[gy * main.width + gx] !== IDX) continue;   /* 被盖住了，不算 */
        const cx = gx - bx, cy = gy - by;
        if (cx < 0 || cy < 0 || cx >= bw || cy >= bh) continue;
        const di = (cy * bw + cx) * 4;
        const err = Math.abs(exp[di] - dst[di]) + Math.abs(exp[di + 1] - dst[di + 1]) +
          Math.abs(exp[di + 2] - dst[di + 2]);
        n++;
        sumErr += err;
        if (err > 60) bad++;
      }
    }
    return {
      t: p.t, c: p.c, n: n,
      badPct: n ? +(bad / n * 100).toFixed(1) : -1,
      avgErr: n ? +(sumErr / n).toFixed(1) : -1
    };
  });
}

/* 判据阈值。两边是同一个数：位图必须低于它，矢量必须高于它。
   这么设比「位图<8 且 矢量>10」严密 —— 万一哪类其实没画位图，位图版和矢量版
   就是同一个数，不可能同时 <8 和 >8，必挂一条。
   实测（固定场景，每次结果一致）：位图最高 rock 3.4、矢量最低 tree 22.5。 */
const TH = 8;
const MIN_N = 30;

/* 按类型聚合，每类取最小值 */
function byType(pairs, key, field) {
  const m = {};
  pairs.forEach(function (x) {
    const r = x[key], v = r[field];
    m[r.t] = (m[r.t] === undefined ? v : Math.min(m[r.t], v));
  });
  return m;
}

/* 摆好固定场景，分别采一次位图版和一次矢量版。
   wait 由调用方传进来 —— 两个脚本的等待实现不一样。 */
async function collect(page, wait, onVec) {
  await page.evaluate(sceneScript);
  await wait(1500);
  await page.evaluate(fixedSceneScript);
  await wait(800);
  const bmp = await page.evaluate(matchScript);
  await page.evaluate(function () {
    const A = window.__fsm.SPOT_ART;
    for (const k of Object.keys(A)) A[k].ready = false;
  });
  await wait(600);
  const vec = await page.evaluate(matchScript);
  /* 还停在矢量版状态 —— 兜底相关的取样（比如 ART10）得趁这时候做 */
  if (onVec) await onVec(page);
  await page.evaluate(function () {
    const A = window.__fsm.SPOT_ART;
    for (const k of Object.keys(A)) A[k].ready = true;
  });
  await wait(400);

  /* 采样点太少的景物不进判据：整个被盖住或整只被裁掉时 n=0、bad%=-1，
     会把整类拖 FAIL。 */
  const pairs = bmp.map(function (b, i) {
    return { b: b, v: vec[i] || { t: b.t, n: 0, badPct: -1, avgErr: -1 } };
  }).filter(function (x) { return x.b.n >= MIN_N; });
  const bm = byType(pairs, 'b', 'badPct'), vm = byType(pairs, 'v', 'badPct');
  const types = Object.keys(bm);
  const worstB = types.length ? types.reduce(function (a, t) { return bm[t] > bm[a] ? t : a; }, types[0]) : '-';
  const worstV = types.length ? types.reduce(function (a, t) { return vm[t] < vm[a] ? t : a; }, types[0]) : '-';
  return {
    types: types, bm: bm, vm: vm, worstB: worstB, worstV: worstV,
    thin: bmp.filter(function (b) { return b.n < MIN_N; }).map(function (b) { return b.t + '(' + b.n + ')'; }),
    /* 8 类全验到 + 位图全低于阈值 + 矢量全高于阈值 */
    pass: types.length === 8 &&
      types.every(function (t) { return bm[t] < TH; }) &&
      types.every(function (t) { return vm[t] > TH; })
  };
}

function detail(r) {
  if (!r.types.length) return '没有任何一类采到有效样本';
  return '位图 bad% ' + r.types.map(function (t) { return t + ' ' + r.bm[t]; }).join(' ') +
    ' ｜ 矢量 ' + r.types.map(function (t) { return t + ' ' + r.vm[t]; }).join(' ') +
    '（阈值 ' + TH + '，位图最高 ' + r.worstB + ' ' + r.bm[r.worstB] +
    ' / 矢量最低 ' + r.worstV + ' ' + r.vm[r.worstV] + '）' +
    (r.thin.length ? ' ｜ 采样不足 ' + r.thin.join(' ') : '');
}

module.exports = { collect: collect, detail: detail, TH: TH, MIN_N: MIN_N };
