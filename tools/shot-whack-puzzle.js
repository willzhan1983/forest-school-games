/*
 * 打地鼠 + 拼图的视觉验收截图（人工看图用，不进 CI）
 *
 *   NODE_PATH=/Users/mac/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node tools/shot-whack-puzzle.js
 *
 * 逻辑测试只能证明「数值对了」，证明不了「画得对不对、孩子看不看得清」。
 * 输出 shots/WP1~WP6.png：
 *   WP1 横屏菜单（5 张卡片：接橡果 / 翻牌 / 找不同 / 打地鼠 / 拼图）
 *   WP2 横屏打地鼠（冒头中 / 完全露出 / 毛毛虫 / 毒蘑菇 / 缩回中 同屏）
 *   WP3 竖屏打地鼠（洞阵在小屏上够不够大）
 *   WP4 横屏拼图 4×4（棋盘 + 参考图 + 角标 + 选中金框）
 *   WP5 竖屏拼图 4×4
 *   WP6 竖屏菜单（5 张卡片 + 难度按钮 + 底部提示是否都在画面内 —— T26 那次越界就是这么看出来的）
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve(__dirname, '..', 'shots');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 });
  await wait(1000);

  /* WP1 横屏菜单 */
  await page.evaluate(() => { window.__fsm.Game.state = 'menu'; });
  await wait(300);
  await page.screenshot({ path: path.join(OUT, 'WP1-menu-landscape.png') });

  /* WP2 横屏打地鼠：把 5 个洞摆成不同状态，一屏看全所有视觉分支 */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.selectGame('whack'); f.selectDiff('normal'); f.startCurrent();
  });
  await wait(400);
  const w2 = await page.evaluate(() => {
    const f = window.__fsm, Wk = f.Whack;
    Wk.spawnT = 1e9;
    f.Game.banner = 0;
    f.Game.score = 240;
    Wk.combo = 5; Wk.best = 7; Wk.mult = 2; Wk.hit = 12; Wk.bad = 1;
    Wk.timeLeft = 31;
    const set = (i, o) => Object.assign(Wk.holes[i], o);
    set(0, { st: 1, t: 4,  isBad: false, k: 3 });
    set(1, { st: 2, t: 12, isBad: false, k: 7 });
    set(2, { st: 2, t: 14, isBad: false, k: 11 });
    set(3, { st: 2, t: 12, isBad: true,  k: 0 });
    set(4, { st: 2, t: 12, isBad: true,  k: 1 });
    set(7, { st: 2, t: 28, isBad: false, k: 5 });
    const b = f.whackBoard ? f.whackBoard() : null;
    return { board: b, hole0: f.whackHoleRect(0), n: Wk.holes.length };
  });
  await wait(120);
  await page.screenshot({ path: path.join(OUT, 'WP2-whack-landscape.png') });

  /* WP3 竖屏打地鼠 */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await wait(700);
  await page.evaluate(() => {
    const f = window.__fsm, Wk = f.Whack;
    Wk.spawnT = 1e9; f.Game.banner = 0;
    const set = (i, o) => Object.assign(Wk.holes[i], o);
    set(0, { st: 2, t: 12, isBad: false, k: 9 });
    set(3, { st: 2, t: 12, isBad: true,  k: 0 });
    set(5, { st: 1, t: 5,  isBad: false, k: 2 });
  });
  await wait(120);
  await page.screenshot({ path: path.join(OUT, 'WP3-whack-portrait.png') });

  /* WP4 横屏拼图 4×4 + 选中一格 */
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await wait(700);
  const p4 = await page.evaluate(async () => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('puzzle'); f.selectDiff('p44'); f.startCurrent();
    await new Promise(r => setTimeout(r, 900));
    f.Game.banner = 0; f.Puz.moves = 6; f.Puz.sel = 5;
    const L = f.puzLayout();
    return { L, n: f.Puz.n, min: f.Puz.minSwaps, imgW: f.puzImg() ? f.puzImg().naturalWidth : 0 };
  });
  await wait(400);
  await page.screenshot({ path: path.join(OUT, 'WP4-puzzle-landscape.png') });

  /* WP5 竖屏拼图 */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await wait(700);
  await page.evaluate(() => { window.__fsm.Game.banner = 0; window.__fsm.Puz.sel = 9; });
  await wait(300);
  await page.screenshot({ path: path.join(OUT, 'WP5-puzzle-portrait.png') });

  /* WP6 竖屏菜单：5 张卡片 + 难度按钮 + 底部提示是否全在画面内 */
  await page.evaluate(() => { window.__fsm.Game.state = 'menu'; window.__fsm.selectGame('puzzle'); });
  await wait(400);
  const m6 = await page.evaluate(() => {
    const f = window.__fsm;
    const cm = f.cardMetrics(), dm = f.diffMetrics();
    return {
      n: f.GAMES.length, W: f.W, H: f.H, portrait: f.VIEW.portrait,
      lastCardBottom: Math.round(cm.y0 + (cm.h + cm.gap) * (f.GAMES.length - 1) + cm.h),
      diffTop: Math.round(dm.y), diffBottom: Math.round(dm.y + dm.h),
      label: f.optsLabel(f.curGame(), false)
    };
  });
  await page.screenshot({ path: path.join(OUT, 'WP6-menu-portrait.png') });

  console.log('WP2 打地鼠几何', JSON.stringify(w2));
  console.log('WP4 拼图几何', JSON.stringify(p4));
  console.log('WP6 竖屏菜单', JSON.stringify(m6));
  console.log('运行时错误', errs.length, errs.slice(0, 3).join(' | '));
  console.log('截图输出 ->', OUT);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });