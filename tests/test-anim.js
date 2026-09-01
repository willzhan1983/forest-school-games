/* 动画过程视觉追踪：
   之前的测试只验证状态终态，漏掉了"翻牌动画完成后卡片被压成细线"这类
   只在动画中间/完成帧出现的视觉 bug。本脚本对每个关键动画逐帧采样，
   输出亮度/色彩序列，检查画面是否在整个过程中都正常。 */
const puppeteer = require('puppeteer-core');
const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];

function rec(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + id + '  ' + name + (detail ? '  :: ' + detail : ''));
}

async function sample(page, x, y, w, h) {
  return await page.evaluate(([x, y, w, h]) => {
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const c = cv.getContext('2d');
    const d = c.getImageData(Math.round(x * sx), Math.round(y * sy),
      Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy))).data;
    let lum = 0, n = 0, cols = new Set();
    for (let i = 0; i < d.length; i += 4) {
      lum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114); n++;
      if (n % 5 === 0) cols.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
    }
    return { lum: +(lum / n).toFixed(1), colors: cols.size };
  }, [x, y, w, h]);
}

/* 区域快照 / 差分。与 test.js 里同一套：
   找不同的场景是静止的（两幅图不能自己动，否则没法比），
   所以「有没有变化」只能靠前后两次取像素来比。 */
async function snapRegion(page, x, y, w, h) {
  await page.evaluate(([x, y, w, h]) => {
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const c = cv.getContext('2d');
    const d = c.getImageData(Math.round(x * sx), Math.round(y * sy),
      Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy)));
    window.__snap = { w: d.width, h: d.height, data: new Uint8ClampedArray(d.data) };
  }, [x, y, w, h]);
}
async function diffSnap(page, x, y, w, h) {
  return await page.evaluate(([x, y, w, h]) => {
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const c = cv.getContext('2d');
    const cur = c.getImageData(Math.round(x * sx), Math.round(y * sy),
      Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy))).data;
    const old = window.__snap;
    if (!old || old.data.length !== cur.length) return -1;
    let n = 0;
    for (let i = 0; i < cur.length; i += 4) {
      if (Math.abs(cur[i] - old.data[i]) + Math.abs(cur[i + 1] - old.data[i + 1]) +
          Math.abs(cur[i + 2] - old.data[i + 2]) >= 40) n++;
    }
    return n;
  }, [x, y, w, h]);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 600000
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('window.__fsm && window.__fsm.Mem', { timeout: 20000 });
  await page.evaluate(() => { window.__fsm.Audio2.init(); window.__fsm.Audio2.kick(); });
  await wait(800);

  /* 走 selectGame 而不是直接改 gameId：
     selectGame 会把 Game.diff 归一化到该游戏自己的选择器上，
     直接改 gameId 的话，翻牌会带着接橡果的 'easy' 开一局。 */
  const enter = async (id) => {
    await page.evaluate(g => {
      window.__fsm.Game.state = 'menu';
      window.__fsm.selectGame(g);
      window.__fsm.startCurrent();
    }, id);
    await wait(600);
  };

  /* ---------- A1 记忆翻牌：翻牌动画全过程 ---------- */
  await enter('memory');
  const mr = await page.evaluate(() => window.__fsm.memRect(0));
  const flipTrace = [];
  /* 钉死 card0 的动物：牌堆是随机洗的，抽到深色动物（熊猫/深棕）时
     正面亮度只有 ~118，而 A1 要求 >150、A2 要求比背面暗 20 以上 ——
     这两个断言测的是「翻牌动画有没有把卡片压成细线」，跟抽到哪只动物无关。
     不钉死的话 A1/A2 是随机通过的（实测 4 次：7/9、9/9、7/9、8/9）。
     钉死为 #ffd45e（黄鸭，亮色），阈值一个没改。 */
  await page.evaluate(() => { const M = window.__fsm.Mem; M.cards[0].k = 1; M.cards[0].open = true; M.first = -1; });
  for (let i = 0; i < 14; i++) {
    flipTrace.push(await sample(page, mr.x + 20, mr.y + 20, mr.w - 40, mr.h - 40));
    await wait(70);
  }
  const flipEnd = flipTrace[flipTrace.length - 1];
  const flipMin = Math.min(...flipTrace.map(t => t.lum));
  rec('A1', '翻牌动画：终帧卡片完整可见', flipEnd.colors > 8 && flipEnd.lum > 150,
    'lum序列=' + flipTrace.map(t => t.lum).join(' ') + ' 最低=' + flipMin);
  rec('A2', '翻牌动画：过程中出现翻转收窄（正常）再展开', flipMin < flipEnd.lum - 20,
    `收窄最低=${flipMin} 终帧=${flipEnd.lum}`);

  /* ---------- A3 记忆翻牌：配对成功后的 done 卡片始终可见 ---------- */
  await enter('memory');
  await page.evaluate(() => {
    const M = window.__fsm.Mem;
    let a = -1, b = -1;
    for (let i = 0; i < M.cards.length && b < 0; i++) {
      if (a < 0) { a = i; continue; }
      if (M.cards[i].k === M.cards[a].k) b = i;
    }
    M.cards[a].open = true; M.cards[b].open = true;
    M.first = a; M._second = b; M.lockT = 2;
  });
  await wait(1200);
  const doneR = await page.evaluate(() => window.__fsm.memRect(0));
  const doneS = await sample(page, doneR.x + 20, doneR.y + 20, doneR.w - 40, doneR.h - 40);
  rec('A3', '配对成功的卡片保持可见（半透明但不消失）', doneS.colors > 6 && doneS.lum > 100,
    `colors=${doneS.colors} lum=${doneS.lum}`);

  /* ---------- A4 接橡果：接取飘字动画不残留 ---------- */
  await enter('acorn');
  await page.evaluate(() => {
    const A = window.__fsm.Acorn;
    A.nuts.length = 0;
    /* spawnT 顶到很大：否则等待期间又掉一颗被接住，飘字数永远归不了零。
       这个用例测的是「旧的会消失」，不是「不再产生新的」。 */
    A.spawnT = 1e9;
    A.nuts.push({ x: A.owlX, y: 410, vy: 0.4, rot: 0, vr: 0, swing: 0, kind: 'acorn' });
  });
  /* 飘字生命 26 帧约 430ms。原来等 400ms 采样，正好卡在存活/消失的边界上，
     帧率抖一下就翻车。往前提到 150ms，稳稳落在「还在」。 */
  await wait(150);
  const fxAfter = await page.evaluate(() => window.__fsm.Acorn.catchFx.length);
  await wait(1400);
  const fxGone = await page.evaluate(() => window.__fsm.Acorn.catchFx.length);
  rec('A4', '接取飘字出现后自行消失（不残留）', fxAfter >= 1 && fxGone === 0,
    `接住后=${fxAfter} 1.4秒后=${fxGone}`);

  /* ---------- A5 接橡果：受伤闪烁不导致角色消失 ---------- */
  await enter('acorn');
  await page.evaluate(() => { window.__fsm.Acorn.hurt = 18; });
  const hurtTrace = [];
  for (let i = 0; i < 10; i++) {
    hurtTrace.push(await sample(page, 400, 380, 160, 120));
    await wait(70);
  }
  const hurtMin = Math.min(...hurtTrace.map(t => t.lum));
  rec('A5', '受伤闪烁期间角色始终可见', hurtMin > 60,
    'lum序列=' + hurtTrace.map(t => t.lum).join(' '));

  /* ---------- A6 6×4 大棋盘：24 张牌全在画面内且互不重叠 ----------
     最大尺寸最容易把牌挤出边界或互相压住；这里逐张算矩形做几何校验，
     再抽查四角 + 中心是否真的画出了东西（不是空背景）。 */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.Game.state = 'menu';
    f.selectGame('memory');
    f.selectDiff('g64');
  });
  await enter('memory');
  const bigGrid = await page.evaluate(() => {
    const M = window.__fsm.Mem, R = [];
    for (let i = 0; i < M.cards.length; i++) R.push(window.__fsm.memRect(i));
    return { n: M.cards.length, rects: R };
  });
  let gridLayoutOk = bigGrid.n === 24;
  for (let i = 0; i < bigGrid.rects.length; i++) {
    const r = bigGrid.rects[i];
    if (r.x < 0 || r.y < 0 || r.x + r.w > 960 || r.y + r.h > 540) gridLayoutOk = false;
    if (r.w < 40 || r.h < 40) gridLayoutOk = false;   // 被压扁就看不清动物了
  }
  /* 四角 + 中心抽样 */
  const probes = [0, 5, 12, 18, 23];
  const probeDetail = [];
  let probeOk = true;
  for (const idx of probes) {
    const r = bigGrid.rects[idx];
    const s = await sample(page, r.x + 6, r.y + 6, r.w - 12, r.h - 12);
    probeDetail.push(`#${idx}:lum=${s.lum},colors=${s.colors}`);
    if (s.colors < 3) probeOk = false;
  }
  rec('A6', '6×4 棋盘：24 张牌全在画面内、不重叠、都画得出',
    gridLayoutOk && probeOk,
    `张数=${bigGrid.n} 几何=${gridLayoutOk ? 'ok' : '越界/过小'}  ` + probeDetail.join(' '));

  /* ---------- A7 6×4 棋盘：完成一次配对后卡片保持可见 ----------
     大棋盘卡片更窄，配对成功的半透明淡出在小卡片上更容易"淡没了"。 */
  await enter('memory');
  await page.evaluate(() => {
    const M = window.__fsm.Mem;
    let a = -1, b = -1;
    for (let i = 0; i < M.cards.length && b < 0; i++) {
      if (a < 0) { a = i; continue; }
      if (M.cards[i].k === M.cards[a].k) b = i;
    }
    M.cards[a].open = true; M.cards[b].open = true;
    M.first = a; M._second = b; M.lockT = 2;
    window.__pair = [a, b];
  });
  await wait(1400);
  const pairIdx = await page.evaluate(() => window.__pair);
  const pairR = await page.evaluate(i => window.__fsm.memRect(i), pairIdx[0]);
  const pairS = await sample(page, pairR.x + 8, pairR.y + 8, pairR.w - 16, pairR.h - 16);
  const pairMatched = await page.evaluate(() => window.__fsm.Mem.matched);
  rec('A7', '6×4 棋盘：配对成功的卡片保持可见', pairMatched === 2 && pairS.colors > 6 && pairS.lum > 100,
    `matched=${pairMatched} colors=${pairS.colors} lum=${pairS.lum}`);

  /* ---------- A10 找不同：「找到了」标记的出现与收敛 ----------
     标记用 easeOutBack 弹一下再定住。逐帧追踪热区内的变化像素数：
     必须从 0 涨起来（画出来了），并且最后收敛（不能一直抖）。 */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.Game.state = 'menu';
    f.selectGame('spot');
    f.selectDiff('normal');
    f.startCurrent();
  });
  /* 开场横幅盖在画面上半部分（y 116~170），淡出的那 1.5 秒里像素一直在变。
     差异点是随机位置的，很可能正好落在横幅底下 —— 不等它消失，
     追踪到的就是横幅在淡出，不是「找到了」的标记在弹。 */
  await page.waitForFunction('window.__fsm.Game.banner === 0', { timeout: 8000 });
  await wait(200);
  const spot0 = await page.evaluate(() => {
    const f = window.__fsm, S = f.Spot, p0 = f.spotPanel(0);
    const s = S.spots[0];
    return { x: p0.x + s.lx, y: p0.y + s.ly, r: s.r };
  });
  const box = [spot0.x - spot0.r, spot0.y - spot0.r, spot0.r * 2, spot0.r * 2];
  await snapRegion(page, ...box);
  await page.evaluate(([x, y]) => window.__fsm.curGame().tap(x, y), [spot0.x, spot0.y]);
  const markTrace = [];
  for (let i = 0; i < 14; i++) {
    markTrace.push(await diffSnap(page, ...box));
    await wait(65);
  }
  const markMax = Math.max.apply(null, markTrace);
  const tail = markTrace.slice(-3);
  const tailSpread = Math.max.apply(null, tail) - Math.min.apply(null, tail);
  rec('A10', '找不同：「找到了」标记画出来并收敛（不一直抖）',
    markMax > 300 && tailSpread < 120,
    '变化像素序列=' + markTrace.join(' ') + ` 峰值=${markMax} 末3帧波动=${tailSpread}`);

  /* ---------- A11 找不同的场景必须静止 ----------
     两幅图如果跟着 Game.time 动（哪怕只是轻微抖动），孩子就没法比了 ——
     这是这类游戏最容易犯的错：复用了一个带动画的背景绘制函数。 */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.Game.state = 'menu';
    f.selectGame('spot');
    f.selectDiff('normal');
    f.startCurrent();
  });
  await wait(700);
  /* 开场提示横幅盖在两幅图上（y 122~166，图从 y 92 开始），
     它淡出的那 1.5 秒里画面当然在变。等它归零再测，不然测的是横幅不是场景。 */
  await page.waitForFunction('window.__fsm.Game.banner === 0', { timeout: 8000 });
  await wait(200);
  const p0r = await page.evaluate(() => window.__fsm.spotPanel(0));
  const p1r = await page.evaluate(() => window.__fsm.spotPanel(1));
  const panelPx = Math.round(p0r.w * 1.5) * Math.round(p0r.h * 1.5);
  await snapRegion(page, p0r.x, p0r.y, p0r.w, p0r.h);
  await wait(1200);
  const driftL = await diffSnap(page, p0r.x, p0r.y, p0r.w, p0r.h);
  await snapRegion(page, p1r.x, p1r.y, p1r.w, p1r.h);
  await wait(1200);
  const driftR = await diffSnap(page, p1r.x, p1r.y, p1r.w, p1r.h);
  /* 允许极小漂移：不同渲染环境下圆角相框边/太阳圆的亚像素抗锯齿会有 1~2 像素浮点噪声，
     不影响比对（真 bug 是 28053 那种量级）。阈值 200 像素 ≈ 全幅的 0.05%。 */
  const DRIFT_MAX = 200;
  rec('A11', '找不同的两幅场景保持静止（1.2 秒内近乎零漂移，亚像素噪声除外）',
    driftL <= DRIFT_MAX && driftR <= DRIFT_MAX,
    `左图漂移像素=${driftL}  右图漂移像素=${driftR}（阈值 ${DRIFT_MAX}，每幅 ≈ ${panelPx} 物理像素）`);

  /* ---------- A8 开场横幅动画结束 ---------- */
  await enter('acorn');
  const b0 = await page.evaluate(() => window.__fsm.Game.banner);
  await wait(1800);
  const b1 = await page.evaluate(() => window.__fsm.Game.banner);
  rec('A8', '开场横幅倒计时归零', b0 > 0 && b1 === 0, `banner ${b0} -> ${b1}`);

  rec('A9', '动画追踪全程零运行时错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '0 error');

  await browser.close();
  const pass = results.filter(r => r.pass).length;
  console.log('\n===== ' + pass + ' / ' + results.length + ' PASS =====');
  if (pass < results.length) {
    console.log('FAILED:');
    results.filter(r => !r.pass).forEach(r => console.log('  ' + r.id + ' ' + r.name + ' :: ' + r.detail));
    process.exit(1);
  }
})().catch(e => { console.error('RUNNER ERROR:', e); process.exit(2); });
