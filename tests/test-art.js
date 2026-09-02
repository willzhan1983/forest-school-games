/*
 * 配图回归测试：翻牌的 12 张动物位图 + 找不同的面板背景图
 *
 *   node tests/test-art.js
 *   （需要先在 8931 端口起好本地服务器：python3 -m http.server 8931）
 *
 * 只查「素材有没有解码成功」是不够的 —— 图解码了但代码没画、或者画错了索引，
 * 状态位一样是绿的。所以这里一律做像素比对：
 *   位图版 vs 强制禁用后的矢量兜底版，色彩丰富度必须拉开差距。
 * 反过来，兜底路径也要验 —— 位图挂了不能开天窗。
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const spotMatch = require('./lib-spot-match.js');

const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
function rec(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + id + '  ' + name + (detail ? '  :: ' + detail : ''));
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* 采样一块区域：平均亮度 lum + 色彩数 colors（每 7 个像素取一个，量化到 4bit） */
async function sample(page, x, y, w, h) {
  return await page.evaluate(([x, y, w, h]) => {
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const c = cv.getContext('2d');
    const d = c.getImageData(Math.round(x * sx), Math.round(y * sy),
      Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy))).data;
    let lum = 0, n = 0, r = 0, g = 0, b = 0, uniq = new Set();
    for (let i = 0; i < d.length; i += 4) {
      lum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      if (n % 7 === 0) uniq.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
    }
    return {
      lum: +(lum / n).toFixed(1), colors: uniq.size,
      r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n)
    };
  }, [x, y, w, h]);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    protocolTimeout: 600000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('window.__fsm && window.__fsm.Game', { timeout: 20000 });
  await wait(1200);

  const IDX_MEM = await page.evaluate(() => window.__fsm.GAMES.findIndex(g => g.id === 'memory'));
  const IDX_SPOT = await page.evaluate(() => window.__fsm.GAMES.findIndex(g => g.id === 'spot'));

  /* ---- ART1 12 张动物位图全部解码成功 ---- */
  const imgs = await page.evaluate(() => window.__fsm.ANIMAL_IMG.map(function (im) {
    return { w: im.naturalWidth, h: im.naturalHeight, ok: im.complete && im.naturalWidth > 0 };
  }));
  rec('ART1', '翻牌 12 张动物位图全部解码成功',
    imgs.length === 12 && imgs.every(i => i.ok),
    imgs.map((i, k) => k + ':' + i.w + 'x' + i.h).join(' '));

  /* ---- ART2 卡片上画的确实是位图（不是悄悄走了矢量兜底）----
     判据：位图版卡片区域的色彩数必须明显高于矢量版。
     矢量脸是几块纯色拼的，AI 出图有毛发渐变和描边，色彩数差一个量级。 */
  /* selectGame 收的是游戏 id（'memory' / 'spot'），不是 GAMES 下标。
     翻牌的档位是 GRIDS（棋盘尺寸），不先 selectDiff 的话 startCurrent 会用上一次的残留值。 */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('memory'); f.selectDiff('g43'); f.startCurrent();
  });
  await wait(300);
  await page.evaluate(() => {
    const M = window.__fsm.Mem;
    M.cards[0].k = 0;            /* 白猫：浅色主体，色彩数偏低，是最保守的用例 */
    M.cards[0].open = true;
    M.first = -1;
  });
  await wait(1200);
  const r0 = await page.evaluate(() => window.__fsm.memRect(0));
  const sBmp = await sample(page, r0.x + 20, r0.y + 20, r0.w - 40, r0.h - 40);

  /* 禁用位图：src 清空后 naturalWidth 归零，drawAnimalFace 走矢量分支。
     原 src 先存下来，测完要还原。 */
  await page.evaluate(() => {
    window.__artSrc = window.__fsm.ANIMAL_IMG.map(im => im.src);
    window.__fsm.ANIMAL_IMG.forEach(im => { im.src = ''; });
  });
  await wait(400);
  const sVec = await sample(page, r0.x + 20, r0.y + 20, r0.w - 40, r0.h - 40);
  rec('ART2', '卡片画的是 AI 位图（色彩数明显高于矢量兜底）',
    sBmp.colors > sVec.colors * 1.3,
    `位图 colors=${sBmp.colors} lum=${sBmp.lum} / 矢量 colors=${sVec.colors} lum=${sVec.lum}`);

  /* ---- ART3 位图挂了也不能开天窗：矢量兜底必须画得出来 ---- */
  rec('ART3', '位图失效时矢量兜底仍画出完整动物脸',
    sVec.colors > 8 && sVec.lum > 130,
    `colors=${sVec.colors} lum=${sVec.lum}（阈值 colors>8 lum>130）`);

  /* 还原位图，验证能切回来 */
  await page.evaluate(() => {
    window.__fsm.ANIMAL_IMG.forEach((im, i) => { im.src = window.__artSrc[i]; });
  });
  await wait(600);
  const sBack = await sample(page, r0.x + 20, r0.y + 20, r0.w - 40, r0.h - 40);
  rec('ART4', '位图还原后卡片回到位图渲染', sBack.colors >= sBmp.colors * 0.9,
    `还原后 colors=${sBack.colors}（原位图 ${sBmp.colors}）`);

  /* ---- ART5 找不同面板背景用的是 AI 场景图 ----
     判据一：背景图版面板的色彩数高于纯色渐变版
     判据二：面板上半部偏天空（蓝多于红）、下半部偏草地（绿多于红）*/
  await page.evaluate(() => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('spot'); f.selectDiff('easy'); f.startCurrent();
  });
  await wait(500);
  const p0 = await page.evaluate(() => window.__fsm.spotPanel(0));
  const bgUp = await sample(page, p0.x + 8, p0.y + 8, p0.w - 16, p0.h * 0.35);
  const bgDn = await sample(page, p0.x + 8, p0.y + p0.h * 0.62, p0.w - 16, p0.h * 0.34);
  const bgAll = await sample(page, p0.x + 8, p0.y + 8, p0.w - 16, p0.h - 16);

  /* 禁用背景图用 'data:,'（无效图像）而不是 ''：src='' 在 Chrome 里会被解析成
     当前页面 URL，complete 仍是 true、naturalWidth 可能不归零，画面根本没变。
     判据用像素差分而不是色彩数 —— 面板里还画着 9 个景物，色彩数被它们淹没，
     背景换了都看不出来。 */
  await page.evaluate(([x, y, w, h]) => {
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    window.__snapBg = cv.getContext('2d').getImageData(
      Math.round(x * sx), Math.round(y * sy),
      Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy))).data.slice();
    window.__bgSrc = window.__fsm.SPOT_BG_IMG.src;
    window.__fsm.SPOT_BG_IMG.src = 'data:,';
  }, [p0.x + 8, p0.y + 8, p0.w - 16, p0.h - 16]);
  await wait(500);
  const off = await page.evaluate(() => window.__fsm.SPOT_BG_IMG.naturalWidth);
  const bgDiff = await page.evaluate(([x, y, w, h]) => {
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const cur = cv.getContext('2d').getImageData(
      Math.round(x * sx), Math.round(y * sy),
      Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy))).data;
    const old = window.__snapBg;
    let changed = 0, n = 0;
    for (let i = 0; i < cur.length; i += 4) {
      n++;
      if (Math.abs(cur[i] - old[i]) + Math.abs(cur[i + 1] - old[i + 1]) +
          Math.abs(cur[i + 2] - old[i + 2]) > 24) changed++;
    }
    return { changed: changed, total: n };
  }, [p0.x + 8, p0.y + 8, p0.w - 16, p0.h - 16]);
  const gradAll = await sample(page, p0.x + 8, p0.y + 8, p0.w - 16, p0.h - 16);
  rec('ART5', '找不同面板用的是 AI 背景图（禁用后画面明显变化）',
    off === 0 && bgDiff.changed / bgDiff.total > 0.3,
    `禁用后 naturalWidth=${off}（应为 0） 变化像素 ${bgDiff.changed}/${bgDiff.total}` +
    ` = ${(bgDiff.changed / bgDiff.total * 100).toFixed(0)}%（阈值 >30%）`);
  rec('ART6', '背景图上蓝天下草地（上部偏蓝、下部偏绿）',
    bgUp.b > bgUp.r + 4 && bgDn.g > bgDn.r + 4,
    `上部 rgb(${bgUp.r},${bgUp.g},${bgUp.b}) 下部 rgb(${bgDn.r},${bgDn.g},${bgDn.b})`);

  /* ---- ART7 背景图失效时渐变兜底仍可见，且两幅一致 ---- */
  rec('ART7', '背景图失效时渐变兜底仍能铺满面板',
    gradAll.colors >= 2 && gradAll.lum > 120,
    `colors=${gradAll.colors} lum=${gradAll.lum}`);
  await page.evaluate(() => { window.__fsm.SPOT_BG_IMG.src = window.__bgSrc; });
  await wait(500);

  /* ================= 找不同：8 类景物位图 ================= */

  /* ---- ART8 8 类景物位图全部解码 ---- */
  const artImgs = await page.evaluate(() => {
    const out = {};
    for (const k of Object.keys(window.__fsm.SPOT_ART)) {
      const a = window.__fsm.SPOT_ART[k];
      out[k] = { ok: !!(a.ready && a.img && a.img.naturalWidth > 0), w: a.img ? a.img.naturalWidth : 0, h: a.img ? a.img.naturalHeight : 0 };
    }
    return out;
  });
  const artKeys = Object.keys(artImgs);
  rec('ART8', '找不同 8 类景物位图全部解码成功',
    artKeys.length === 8 && artKeys.every(k => artImgs[k].ok),
    artKeys.map(k => k + ':' + artImgs[k].w + 'x' + artImgs[k].h).join(' '));

  /* ---- ART9 / ART10 景物位图 ----
     比对逻辑全在 tests/lib-spot-match.js 里（线上复验 V13 用的是同一份），
     这里只负责取结果和判。collect 会摆一个 8 类各一个的固定场景 ——
     随机一局只出现 5~6 类，永远验不全。
     它内部采完位图版会把 ready 置 false 再采矢量版，趁那个状态用 onVec
     顺手把 ART10 的兜底样本取了。 */
  let vecAll = null;
  const art9 = await spotMatch.collect(page, wait, async (pg) => {
    const p0v = await pg.evaluate(() => window.__fsm.spotPanel(0));
    vecAll = await sample(pg, p0v.x + 8, p0v.y + 8, p0v.w - 16, p0v.h - 16);
  });
  rec('ART9', '8 类景物画的都是 AI 位图（位图 alpha 做 mask 逐像素比对）',
    art9.pass, spotMatch.detail(art9));

  rec('ART10', '位图失效时矢量兜底仍能画出完整场景',
    !!vecAll && vecAll.colors > 10 && vecAll.lum > 120,
    vecAll ? `colors=${vecAll.colors} lum=${vecAll.lum}（阈值 colors>10 lum>120）` : '取样失败');

  /* ---- ART11 染色后每档颜色仍然分得开（核心回归）----
     景物换成位图后，「换个颜色」这个差异全靠染色实现。
     调色板或染色算法一旦改动，很容易出现两档染完几乎一样 ——
     那样这处差异就是白出的，孩子永远找不到。所以这里逐对量色差，
     取每类最差的一对，要求 ≥ 35（两个色在这个距离上肉眼可分）。 */
  const tintStat = await page.evaluate(() => {
    const f = window.__fsm;
    const d3 = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    const hueOf = (r, g, b) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d === 0) return -1;
      let h = mx === r ? ((g - b) / d) % 6 : (mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
      h *= 60;
      return h < 0 ? h + 360 : h;
    };
    const hexHue = (h) => hueOf(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));
    const out = [];
    for (const type of Object.keys(f.SPOT_ART)) {
      const a = f.SPOT_ART[type];
      if (a.hue < 0) continue;              /* 云/石头不做 color 差异 */
      const pal = f.SPOT_PAL[type];
      const avg = [], cols = [], brown = [], dstHue = [];
      for (let i = 0; i < pal.length; i++) {
        const cv = f.spotTinted(type, i);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let r = 0, g = 0, b = 0, n = 0, br = 0;
        const uniq = new Set();
        for (let p = 0; p < d.length; p += 4) {
          if (d[p + 3] < 128) continue;
          r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
          uniq.add((d[p] >> 4) + ',' + (d[p + 1] >> 4) + ',' + (d[p + 2] >> 4));
          const mx = Math.max(d[p], d[p + 1], d[p + 2]), mn = Math.min(d[p], d[p + 1], d[p + 2]);
          if (mx > 0 && (mx - mn) / mx > 0.3) {
            const h = hueOf(d[p], d[p + 1], d[p + 2]);
            if (h >= 20 && h <= 45) br++;   /* 棕色系：树干/花蕊/鸟喙，不该被染成主体色 */
          }
        }
        avg.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
        cols.push(uniq.size);
        brown.push(+(br / n * 100).toFixed(1));
        dstHue.push(Math.round(hexHue(pal[i])));
      }
      let minD = 1e9, worst = '';
      for (let i = 0; i < avg.length; i++) for (let j = i + 1; j < avg.length; j++) {
        const dd = d3(avg[i], avg[j]);
        if (dd < minD) { minD = dd; worst = '#' + i + '/#' + j; }
      }
      out.push({ type: type, minD: +minD.toFixed(1), worst: worst, cols: cols, brown: brown, dstHue: dstHue });
    }
    return out;
  });
  const TINT_MIN = 35;
  const worstTint = tintStat.reduce((a, b) => (b.minD < a.minD ? b : a));
  rec('ART11', '染色后每档颜色仍肉眼可分（最差一对 ≥ ' + TINT_MIN + '）',
    tintStat.every(t => t.minD >= TINT_MIN),
    tintStat.map(t => `${t.type} 最差${t.minD}(${t.worst})`).join(' ') +
    ` ← 全场最差 ${worstTint.type} ${worstTint.minD}`);

  /* ---- ART12 染色保留明暗层次（不是糊成一块纯色剪影）----
     只换色相的话高光和暗部全没了，图会变得很平。
     色彩数就是这个的探针：纯色剪影只有个位数，有明暗过渡的有几十上百。 */
  const minCols = tintStat.map(t => Math.min.apply(null, t.cols));
  rec('ART12', '染色保留明暗层次（各档色彩数 > 8）',
    minCols.every(c => c > 8),
    tintStat.map(t => t.type + ':[' + t.cols.join(',') + ']').join(' '));

  /* ---- ART13 非主体色没被一起染掉 ----
     树的基准色是绿（hue 105），树干是棕（hue 20-45），色相差得远，
     染成红/紫/蓝之后树干必须还是棕的 —— 否则整棵树一个色，既假又难看。

     判据要看「染成非棕色时」的棕色占比：tree 的橙/赭两档目标色本身就是棕色，
     整棵树染完都是棕的，占比自然接近 100%，不能拿来判。真正要证明的是
     染成绿/墨绿/黄绿时树干的棕色像素一动不动 —— 这几档之间占比极差必须很小。 */
  const treeStat = tintStat.find(t => t.type === 'tree');
  const nb = treeStat ? treeStat.brown.filter((v, i) => treeStat.dstHue[i] < 20 || treeStat.dstHue[i] > 45) : [];
  const nbSpread = nb.length ? +(Math.max.apply(null, nb) - Math.min.apply(null, nb)).toFixed(1) : 99;
  rec('ART13', '树干等次要色没被一起染掉（染成非棕色时棕色占比稳定）',
    nb.length >= 2 && Math.min.apply(null, nb) > 0.5 && nbSpread < 5,
    treeStat ? `tree 棕色占比 ${treeStat.brown.join('%, ')}%（目标色相 ${treeStat.dstHue.join(',')}）；` +
      `非棕色目标档 [${nb.join('%, ')}%] 极差 ${nbSpread}%（阈值 >0.5% 且极差 <5%）` : '没找到 tree');

  /* ---- ART14 位图的 flip 差异生效 ----
     hard 难度才有 flip。位图靠 ctx.scale(-1,1) 翻转，
     验证方式：同一只鸟，f=1 和 f=-1 画出来的像素必须明显不同（不是镜像就全等）。 */
  const flipStat = await page.evaluate(() => {
    const f = window.__fsm;
    const a = f.SPOT_ART.bird;
    const cv = f.spotTinted('bird', 0);
    const draw = (fl) => {
      const c = document.createElement('canvas');
      c.width = 80; c.height = 80;
      const g = c.getContext('2d');
      g.save();
      g.translate(40, 40);
      g.scale(a.drawH / a.pxH * fl, a.drawH / a.pxH);   /* 与 drawSpotProp 同样的变换 */
      g.drawImage(cv, -a.pxW / 2, -a.pxH * a.ay, a.pxW, a.pxH);
      g.restore();
      return g.getImageData(0, 0, 80, 80).data;
    };
    const A = draw(1), B = draw(-1);
    let diff = 0, n = 0, opaque = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (A[i + 3] > 40) opaque++;
      n++;
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 40) diff++;
    }
    return { diff: diff, opaque: opaque, total: n };
  });
  rec('ART14', '位图的水平翻转差异生效',
    flipStat.opaque > 100 && flipStat.diff > flipStat.opaque * 0.3,
    `不透明像素=${flipStat.opaque} 翻转后差异像素=${flipStat.diff}` +
    `（阈值 差异 > 不透明的 30%）`);

  rec('ART15', '配图流程零运行时错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '0 error');

  await browser.close();
  const pass = results.filter(r => r.pass).length;
  console.log('\n===== ' + pass + ' / ' + results.length + ' PASS =====');
  if (pass < results.length) {
    console.log('FAILED:');
    results.filter(r => !r.pass).forEach(r => console.log('  ' + r.id + ' ' + r.name + ' :: ' + r.detail));
    process.exit(1);
  }
})().catch(e => { console.error('RUNNER ERROR:', e); process.exit(2); });
