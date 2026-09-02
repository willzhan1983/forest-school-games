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

  rec('ART8', '配图流程零运行时错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '0 error');

  await browser.close();
  const pass = results.filter(r => r.pass).length;
  console.log('\n===== ' + pass + ' / ' + results.length + ' PASS =====');
  if (pass < results.length) {
    console.log('FAILED:');
    results.filter(r => !r.pass).forEach(r => console.log('  ' + r.id + ' ' + r.name + ' :: ' + r.detail));
    process.exit(1);
  }
})().catch(e => { console.error('RUNNER ERROR:', e); process.exit(2); });
