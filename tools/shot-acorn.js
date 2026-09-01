/*
 * 接橡果道具视觉验收截图（人工看图用，不进 CI）
 *
 *   NODE_PATH=/Users/mac/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node tools/shot-acorn.js
 *
 * 输出 shots/A1~A3.png：
 *   A1 菜单（看接橡果卡片上的新橡果图标）
 *   A2 横屏接橡果，橡果/毛毛虫/毒蘑菇同屏（看三个道具的辨识度 + 左上角图例）
 *   A3 竖屏接橡果（看猫头鹰位置 —— owlY 写死 424 的话，竖屏会悬在半空）
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
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(900);

  /* A1 菜单 */
  await page.screenshot({ path: path.join(OUT, 'A1-menu.png') });

  /* A2 横屏：三道具同屏 */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.selectGame('acorn'); f.selectDiff('hard'); f.startCurrent();
  });
  await wait(400);
  await page.evaluate(() => {
    const f = window.__fsm, A = f.Acorn;
    A.nuts.length = 0; A.spawnT = 1e9;   // 停掉自动生成，画面里只有摆好的这三个
    f.Game.banner = 0;                    // 开场横幅会盖住上面一排
    f.Game.score = 120; A.combo = 4; A.lives = 3; A.dodged = 7;
    const W = f.W;
    A.nuts.push({ x: W * 0.28, y: 170, vy: 0, kind: 'acorn', rot: 0.25, vr: 0, swing: 0 });
    A.nuts.push({ x: W * 0.50, y: 170, vy: 0, kind: 'bug', rot: 0, vr: 0, swing: 0 });
    A.nuts.push({ x: W * 0.72, y: 170, vy: 0, kind: 'shroom', rot: 0, vr: 0, swing: 0 });
  });
  await wait(350);
  await page.screenshot({ path: path.join(OUT, 'A2-acorn-items.png') });

  /* A3 竖屏：看猫头鹰落位 */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await wait(700);
  await page.evaluate(() => {
    const f = window.__fsm, A = f.Acorn;
    A.nuts.length = 0; A.spawnT = 1e9; f.Game.banner = 0;
    A.lives = 3; f.Game.score = 60;
    const W = f.W;
    A.nuts.push({ x: W * 0.30, y: 240, vy: 0, kind: 'acorn', rot: 0.2, vr: 0, swing: 0 });
    A.nuts.push({ x: W * 0.68, y: 380, vy: 0, kind: 'bug', rot: 0, vr: 0, swing: 0 });
  });
  await wait(350);
  await page.screenshot({ path: path.join(OUT, 'A3-acorn-portrait.png') });

  const geo = await page.evaluate(() => {
    const f = window.__fsm;
    return { W: f.W, H: f.H, portrait: f.VIEW.portrait, owlY: Math.round(f.H * 0.785) };
  });
  console.log('竖屏几何', JSON.stringify(geo));
  console.log('运行时错误', errs.length, errs.slice(0, 3).join(' | '));
  console.log('截图输出 ->', OUT);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
