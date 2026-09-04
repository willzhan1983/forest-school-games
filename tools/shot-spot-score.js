/*
 * 找不同 P0.3 + P0.4 视觉验收截图
 *
 *   NODE_PATH=... node tools/shot-spot-score.js
 *
 * 输出 shots/S1~S4.png：
 *   S1 easy 开局（HUD 0 分，不是 900）
 *   S2 easy 找到 1 处（HUD 120 分，+120 是 100% 涨幅，反馈可见）
 *   S3 easy 结算（2010 = base900 + 3处×120 + 5命×150）
 *   S4 hard 开局（HUD 0 分 + 倒计时 75s 可见）
 *
 * P0.4 之前：开局 HUD 就挂着 base（900），找到一处 +120 只有 13% 涨幅。
 * P0.4 之后：HUD 从 0 开始，找到一处即从 0 跳到 120，涨幅 100%。
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

  async function open(diff, w, h) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate((d) => {
      const f = window.__fsm;
      f.Game.state = 'menu';
      f.selectGame('spot');
      f.selectDiff(d);      /* 必须走 selectDiff：直接赋值 Game.diff 会被 startCurrent 覆盖 */
      f.startCurrent();
    }, diff);
    await wait(900);   /* 等开场横幅走完、顶栏绘制稳定 */
    return page;
  }

  /* S1 easy 开局：HUD 应为 0 */
  let page = await open('easy', 1440, 900);
  const s1 = await page.evaluate(() => window.__fsm.Game.score);
  await page.screenshot({ path: path.join(OUT, 'S1-spot-easy-start-hud0.png') });
  console.log('S1 easy 开局 HUD =', s1, '(期望 0)');
  await page.close();

  /* S2 easy 找到 1 处：HUD 应为 120 */
  page = await open('easy', 1440, 900);
  await page.evaluate(() => {
    const f = window.__fsm, S = f.Spot, p0 = f.spotPanel(0);
    f.curGame().tap(p0.x + S.spots[0].lx, p0.y + S.spots[0].ly);
  });
  await wait(700);   /* 等对勾动画画完 */
  const s2 = await page.evaluate(() => window.__fsm.Game.score);
  await page.screenshot({ path: path.join(OUT, 'S2-spot-easy-found1-hud120.png') });
  console.log('S2 easy 找到 1 处 HUD =', s2, '(期望 120)');
  await page.close();

  /* S3 easy 全部找齐进结算：应为 2010 */
  page = await open('easy', 1440, 900);
  await page.evaluate(async () => {
    const f = window.__fsm, S = f.Spot, p0 = f.spotPanel(0);
    for (let i = 0; i < S.spots.length; i++) {
      const s = S.spots[i];
      f.curGame().tap(p0.x + s.lx, p0.y + s.ly);
      await new Promise(r => setTimeout(r, 150));
    }
  });
  await wait(900);
  const s3 = await page.evaluate(() => ({ sc: window.__fsm.Game.score, st: window.__fsm.Game.state }));
  await page.screenshot({ path: path.join(OUT, 'S3-spot-easy-result-2010.png') });
  console.log('S3 easy 结算 =', s3.sc, 'state =', s3.st, '(期望 2010 / result)');
  await page.close();

  /* S4 hard 开局：HUD 0 + 倒计时 75s 可见 */
  page = await open('hard', 1440, 900);
  const s4 = await page.evaluate(() => ({ sc: window.__fsm.Game.score, left: window.__fsm.Spot.left }));
  await page.screenshot({ path: path.join(OUT, 'S4-spot-hard-start-hud0-timer.png') });
  console.log('S4 hard 开局 HUD =', s4.sc, '倒计时 =', s4.left, '(期望 0 / ~75)');
  await page.close();

  await browser.close();
  console.log('done -> shots/S1~S4');
})().catch(e => { console.error(e); process.exit(1); });
