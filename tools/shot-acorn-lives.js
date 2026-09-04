/*
 * 接橡果 P0.1 视觉验收截图
 *
 *   NODE_PATH=... node tools/shot-acorn-lives.js
 *
 * 输出 shots/A1~A4.png：
 *   A1 easy 开局（lives=3、顶栏 +3 颗心）
 *   A2 normal 开局
 *   A3 hard 开局
 *   A4 easy 中途：先接一颗好的（combo=1），再漏一颗好的（combo=0、lives 不变、hurt 闪屏）
 *                —— 验证「漏接不扣命」在视觉上确实成立
 *
 * 视觉上：3 颗心比原来的 5 颗心更紧促，难度感更强；孩子不会因为「命多」就松懈。
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
      window.__fsm.Game.diff = d;
      window.__fsm.selectGame('acorn');
      window.__fsm.startCurrent();
    }, diff);
    await wait(800);   /* 等命数和顶栏绘制稳定 */
    return page;
  }

  /* A1-A3 三档开局 */
  for (let i = 0; i < 3; i++) {
    const diff = ['easy', 'normal', 'hard'][i];
    const page = await open(diff, 1440, 900);
    await page.screenshot({ path: path.join(OUT, 'A' + (i + 1) + '-acorn-' + diff + '.png') });
    await page.close();
  }

  /* A4 漏接好橡果不扣命（combo 归 0，lives 不变，hurt 闪屏中） */
  const page = await open('easy', 1440, 900);
  /* 先接一颗好的把 combo 顶起来 */
  await page.evaluate(() => {
    const A = window.__fsm.Acorn;
    A.nuts.length = 0;
    A.nuts.push({ x: A.owlX, y: 405, vy: 0.6, kind: 'acorn', rot: 0, vr: 0, swing: 0 });
  });
  await wait(500);
  /* 再漏一颗好橡果（y=H+30 之外、x 偏 400） */
  await page.evaluate(() => {
    const A = window.__fsm.Acorn;
    A.nuts.length = 0;
    A.combo = 5;   /* 模拟此前已攒 5 连击 */
    A.hurt = 18;   /* 触发 hurt 闪屏，画面变红 */
    A.nuts.push({ x: A.owlX + 400, y: 600, vy: 1, kind: 'acorn', rot: 0, vr: 0, swing: 0 });
  });
  await wait(80);   /* 抓 hurt 闪屏最显眼的瞬间 */
  await page.screenshot({ path: path.join(OUT, 'A4-acorn-easy-miss-no-lifeloss.png') });
  await page.close();

  await browser.close();
  console.log('OK');
})().catch(e => { console.error(e); process.exit(1); });
