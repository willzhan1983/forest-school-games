/* ============================================================
 * tests/test-rhythm.js — 节奏游戏「小猫的舞步」专项测试
 * ------------------------------------------------------------
 * 设计思路：
 *   节奏游戏的核心是「时间精度」，不能用 rAF 等待，
 *   测点击命中逻辑时直接构造拍点 + 设置 el + 调用 rhythmTap。
 *
 *   测三档配置生效、计分公式、容差边界。
 *   测完成后只挂浏览器，不进主测试。
 * ========================================================== */
const puppeteer = require('puppeteer-core');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const W = 960, H = 540;

const results = [];
function rec(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + id + '  ' + name + (detail ? '  :: ' + detail : ''));
}
async function clickAt(page, lx, ly) {
  const pt = await page.evaluate(([x, y]) => {
    const r = document.getElementById('game').getBoundingClientRect();
    const W = window.__fsm.W, H = window.__fsm.H;
    return { x: r.left + x * (r.width / W), y: r.top + y * (r.height / H) };
  }, [lx, ly]);
  await page.mouse.click(pt.x, pt.y);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const errs = [];
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  page.on('pageerror', e => { errs.push(e.message); console.log('PAGEERR', e.message); });
  page.on('console', m => { if (m.type() === 'error') { errs.push(m.text()); console.log('CONS-ERR', m.text()); } });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await wait(400);

  /* ---- R1 启动节奏游戏：state=play / gameId=rhythm ---- */
  await page.evaluate(() => {
    window.__fsm.Game.state = 'menu';
    window.__fsm.selectGame('rhythm');
    window.__fsm.selectDiff('easy');
    window.__fsm.startCurrent();
  });
  await wait(300);
  const r1 = await page.evaluate(() => ({
    state: window.__fsm.Game.state, g: window.__fsm.Game.gameId, d: window.__fsm.Game.diff
  }));
  rec('R1', '节奏游戏：选卡+点开始按钮进入 play 态',
    r1.state === 'play' && r1.g === 'rhythm' && r1.d === 'easy',
    `state=${r1.state} game=${r1.g} diff=${r1.d}`);

  /* ---- R2 三档配置生效：segs / beatsPerSeg / bpm / base ---- */
  const cfgs = {};
  for (const d of ['easy', 'normal', 'hard']) {
    await page.evaluate(diff => {
      window.__fsm.Game.state = 'menu';
      window.__fsm.selectGame('rhythm');
      window.__fsm.selectDiff(diff);
      window.__fsm.startCurrent();
    }, d);
    await wait(150);
    cfgs[d] = await page.evaluate(() => {
      const f = window.__fsm, c = f.rhythmCfg();
      return {
        bpm: c.bpm, segs: c.segs, beatsPerSeg: c.beatsPerSeg,
        syncop: c.syncop, base: c.base,
        beats: f.Rhythm.beats.length,
        perfectMs: c.perfectMs, okMs: c.okMs
      };
    });
  }
  const easyOK = cfgs.easy.bpm === 80 && cfgs.easy.segs === 4 && cfgs.easy.beatsPerSeg === 4 && cfgs.easy.base === 480 && !cfgs.easy.syncop && cfgs.easy.beats === 16;
  const normalOK = cfgs.normal.bpm === 100 && cfgs.normal.segs === 6 && cfgs.normal.beatsPerSeg === 4 && cfgs.normal.base === 720 && !cfgs.normal.syncop && cfgs.normal.beats === 24;
  const hardOK = cfgs.hard.bpm === 110 && cfgs.hard.segs === 6 && cfgs.hard.beatsPerSeg === 8 && cfgs.hard.base === 1080 && cfgs.hard.syncop === true && cfgs.hard.beats > 48;
  rec('R2', '节奏游戏：三档配置生效（BPM/segs/beatsPerSeg/base/syncop）',
    easyOK && normalOK && hardOK,
    `easy: ${cfgs.easy.bpm}BPM×${cfgs.easy.segs}×${cfgs.easy.beatsPerSeg}=${cfgs.easy.beats}拍 base=${cfgs.easy.base} | ` +
    `normal: ${cfgs.normal.bpm}BPM×${cfgs.normal.segs}×${cfgs.normal.beatsPerSeg}=${cfgs.normal.beats}拍 base=${cfgs.normal.base} | ` +
    `hard: ${cfgs.hard.bpm}BPM×${cfgs.hard.segs}×${cfgs.hard.beatsPerSeg}=${cfgs.hard.beats}拍 base=${cfgs.hard.base} syncop=${cfgs.hard.syncop}`);

  /* ---- R3 完美命中：直接构造「拍点 -0ms 触发」场景 ---- */
  await page.evaluate(() => {
    window.__fsm.Game.state = 'menu';
    window.__fsm.selectGame('rhythm');
    window.__fsm.selectDiff('easy');
    window.__fsm.startCurrent();
  });
  await wait(200);
  await page.evaluate(() => {
    /* 让第一拍正好「现在」触发，el=1.2 即等于 beats[0].t */
    const f = window.__fsm, b = f.Rhythm.beats[0];
    f.Rhythm.el = b.t;  // 拍点瞬间
    f.Rhythm.active = b;
    const r = f.rhythmBoard();
    f.rhythmTap(r.cx, r.cy);
  });
  await wait(150);
  const r3 = await page.evaluate(() => ({
    perfect: window.__fsm.Rhythm.perfect,
    good: window.__fsm.Rhythm.good,
    score: window.__fsm.Game.score,
    combo: window.__fsm.Rhythm.combo,
    beat0Judged: window.__fsm.Rhythm.beats[0].judged
  }));
  rec('R3', '节奏游戏：拍点正中央点击 → 完美 +30 / combo 1',
    r3.perfect === 1 && r3.score === 30 && r3.combo === 1 && r3.good === 0 && r3.beat0Judged,
    `perfect=${r3.perfect} good=${r3.good} score=${r3.score} combo=${r3.combo} beat0Judged=${r3.beat0Judged}`);

  /* ---- R4 良好命中：拍点后 100ms 点击（超出 perfectMs=60 但在 okMs=150 内）---- */
  await page.evaluate(() => {
    window.__fsm.Game.state = 'menu';
    window.__fsm.selectGame('rhythm');
    window.__fsm.selectDiff('easy');
    window.__fsm.startCurrent();
  });
  await wait(200);
  await page.evaluate(() => {
    const f = window.__fsm, b = f.Rhythm.beats[0];
    f.Rhythm.el = b.t + 0.1;  // 拍点 +100ms
    f.Rhythm.active = b;
    const r = f.rhythmBoard();
    f.rhythmTap(r.cx, r.cy);
  });
  await wait(150);
  const r4 = await page.evaluate(() => ({
    perfect: window.__fsm.Rhythm.perfect,
    good: window.__fsm.Rhythm.good,
    score: window.__fsm.Game.score,
    miss: window.__fsm.Rhythm.miss
  }));
  rec('R4', '节奏游戏：拍点后 100ms 点击 → 良好 +15（容差 ±150ms 内）',
    r4.good === 1 && r4.score === 15 && r4.perfect === 0 && r4.miss === 0,
    `good=${r4.good} score=${r4.score} perfect=${r4.perfect} miss=${r4.miss}`);

  /* ---- R5 离拍点过远：当漏（完美 +30 / 良好 +15 都不给）---- */
  await page.evaluate(() => {
    window.__fsm.Game.state = 'menu';
    window.__fsm.selectGame('rhythm');
    window.__fsm.selectDiff('easy');
    window.__fsm.startCurrent();
  });
  await wait(200);
  await page.evaluate(() => {
    const f = window.__fsm, b = f.Rhythm.beats[0];
    f.Rhythm.el = b.t + 0.25;  // 拍点 +250ms，超出 okMs=150
    f.Rhythm.active = b;
    const r = f.rhythmBoard();
    f.rhythmTap(r.cx, r.cy);
  });
  await wait(150);
  const r5 = await page.evaluate(() => ({
    perfect: window.__fsm.Rhythm.perfect,
    good: window.__fsm.Rhythm.good,
    miss: window.__fsm.Rhythm.miss,
    score: window.__fsm.Game.score,
    combo: window.__fsm.Rhythm.combo
  }));
  rec('R5', '节奏游戏：拍点后 250ms（超容差）点击 → 漏拍 +0（不扣分）',
    r5.miss === 1 && r5.score === 0 && r5.perfect === 0 && r5.good === 0 && r5.combo === 0,
    `miss=${r5.miss} score=${r5.score} combo=${r5.combo}（不惩罚「来不及」铁律）`);

  /* ---- R6 点空：tap 不在圆环上忽略（不消耗拍点） ---- */
  await page.evaluate(() => {
    window.__fsm.Game.state = 'menu';
    window.__fsm.selectGame('rhythm');
    window.__fsm.selectDiff('easy');
    window.__fsm.startCurrent();
  });
  await wait(200);
  const r6 = await page.evaluate(() => {
    const f = window.__fsm, b = f.Rhythm.beats[0];
    f.Rhythm.el = b.t;
    f.Rhythm.active = b;
    /* 点 (0, 0)，离圆环很远的角落 */
    f.rhythmTap(0, 0);
    return {
      beat0Judged: b.judged,
      score: window.__fsm.Game.score,
      perfect: window.__fsm.Rhythm.perfect
    };
  });
  rec('R6', '节奏游戏：点空（远离圆环）不消耗拍点',
    r6.beat0Judged === false && r6.score === 0 && r6.perfect === 0,
    `beat0Judged=${r6.beat0Judged} score=${r6.score}`);

  /* ---- R7 完成一局：所有拍点 judged 后进结算 ---- */
  await page.evaluate(() => {
    window.__fsm.Game.state = 'menu';
    window.__fsm.selectGame('rhythm');
    window.__fsm.selectDiff('easy');
    window.__fsm.startCurrent();
  });
  await wait(200);
  /* 把 el 推到所有拍点后 +0.5s，让 updateRhythm 跑完所有漏拍判定 */
  await page.evaluate(() => {
    const f = window.__fsm;
    /* 把所有未判定的拍点设为完美命中（拍点 +0），全部 +30 */
    for (let i = 0; i < f.Rhythm.beats.length; i++) {
      const b = f.Rhythm.beats[i];
      if (b.judged) continue;
      f.Rhythm.el = b.t;
      f.Rhythm.active = b;
      const r = f.rhythmBoard();
      f.rhythmTap(r.cx, r.cy);
    }
    /* 然后把 el 推到全部判完之后，让进结算逻辑触发 */
    const last = f.Rhythm.beats[f.Rhythm.beats.length - 1];
    f.Rhythm.el = last.t + 0.6;
  });
  await wait(400);
  const r7 = await page.evaluate(() => ({
    state: window.__fsm.Game.state,
    score: window.__fsm.Game.score,
    perfect: window.__fsm.Rhythm.perfect,
    judgedAll: window.__fsm.Rhythm.beats.every(b => b.judged)
  }));
  /* easy 完美玩法 = 16 × 30 = 480 */
  rec('R7', '节奏游戏：所有拍点完美命中 → 进结算且得分 = 满分（easy 480）',
    r7.state === 'result' && r7.score === 480 && r7.perfect === 16 && r7.judgedAll,
    `state=${r7.state} score=${r7.score}（满分=480） perfect=${r7.perfect} allJudged=${r7.judgedAll}`);

  /* ---- R8 圆环位置：横屏 / 竖屏均位于画布中央底部 1/3 区域 ---- */
  for (const [name, vw, vh] of [['横屏', 1440, 900], ['竖屏', 375, 667]]) {
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });
    await wait(300);
    const r8 = await page.evaluate(() => {
      const f = window.__fsm;
      const portrait = f.VIEW.portrait;
      const b = f.rhythmBoard();
      const cv = document.getElementById('game');
      const r = cv.getBoundingClientRect();
      /* 把逻辑坐标转 CSS px */
      const sx = r.width / (portrait ? 540 : 960);
      const sy = r.height / (portrait ? 960 : 540);
      const cxCss = r.left + b.cx * sx;
      const cyCss = r.top + b.cy * sy;
      const rCss = b.r * Math.min(sx, sy);
      return {
        cxCss, cyCss, rCss,
        screenW: window.innerWidth, screenH: window.innerHeight,
        canvasW: r.width, canvasH: r.height,
        portrait,
        cxRatio: b.cx / (portrait ? 540 : 960),
        cyRatio: b.cy / (portrait ? 960 : 540)
      };
    });
    /* 圆环水平居中（cxRatio ≈ 0.5），垂直位于底部 1/3（cyRatio ≥ 0.6）*/
    const cxOK = Math.abs(r8.cxRatio - 0.5) < 0.01;
    const cyOK = r8.cyRatio >= 0.6 && r8.cyRatio <= 0.8;
    /* 圆环 CSS 半径 ≥ 50px（移动端单手可触） */
    const rOK = r8.rCss >= 50;
    rec('R8', `节奏游戏 圆环布局 ${name}：水平居中 + 底部 1/3 + 半径够大`,
      cxOK && cyOK && rOK,
      `cxRatio=${r8.cxRatio.toFixed(2)} cyRatio=${r8.cyRatio.toFixed(2)} rCss=${r8.rCss.toFixed(1)}px（阈值 50）`);
  }
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await wait(200);

  /* ---- R10 回归：漏掉一拍后游戏不锁死 ----
     真实时间等第一拍自然漏掉（1.2s 拍点 + 0.3s 判定窗），
     断言 active 被释放、第二拍仍能出环并命中。
     这是上线首日玩家必踩的路径：开局没准备好 → 漏第一拍。 */
  await page.evaluate(() => {
    window.__fsm.Game.state = 'menu';
    window.__fsm.selectGame('rhythm');
    window.__fsm.selectDiff('easy');
    window.__fsm.startCurrent();
  });
  await wait(2100);   /* 第一拍 t=1.2s 已漏（1.5s 判定窗），第二拍 t=1.95s 也已漏，第三拍 t=2.7s 未到 */
  const r10a = await page.evaluate(() => {
    const f = window.__fsm, R = f.Rhythm;
    return { b0Missed: R.beats[0].judged && R.beats[0].missed, activeReleased: R.active === null || !R.active.judged };
  });
  /* 第三拍 t=2.7s：把 el 推到拍点瞬间，直接命中 */
  const r10b = await page.evaluate(() => {
    const f = window.__fsm, R = f.Rhythm;
    const b2 = R.beats[2];
    if (b2.judged) return { perfect: -1, b1Judged: false, skip: true };
    R.el = b2.t; R.active = b2;
    const r = f.rhythmBoard();
    f.rhythmTap(r.cx, r.cy);
    return { perfect: R.perfect, b1Judged: b2.judged && !b2.missed };
  });
  rec('R10', '节奏游戏：漏第一拍后 active 释放，第二拍仍可命中（不锁死）',
    r10a.b0Missed && r10a.activeReleased && r10b.perfect >= 1 && r10b.b1Judged,
    `b0Missed=${r10a.b0Missed} activeReleased=${r10a.activeReleased} b1Perfect=${r10b.perfect}`);

  /* ---- R9 零运行时错误 ---- */
  rec('R9', '节奏游戏全程零运行时错误', errs.length === 0, errs.slice(0, 2).join(' | ') || '0 error');

  await browser.close();
  const pass = results.filter(r => r.pass).length;
  console.log('\n===== ' + pass + ' / ' + results.length + ' PASS =====');
  if (pass < results.length) {
    console.log('FAILED:');
    results.filter(r => !r.pass).forEach(r => console.log('  ' + r.id + ' ' + r.name + ' :: ' + r.detail));
    process.exit(1);
  }
})().catch(e => { console.error('RUNNER ERROR:', e); process.exit(2); });