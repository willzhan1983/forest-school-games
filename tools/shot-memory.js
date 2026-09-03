/*
 * 翻牌卡片尺寸的视觉验收截图（人工看图用，不进 CI）
 *
 *   NODE_PATH=/Users/mac/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node tools/shot-memory.js
 *
 * 数值测试（T55）只能证明「尺寸算对了」，证明不了「看着舒不舒服、卡片会不会
 * 挤成一条缝」。输出 shots/M1~M5.png：
 *   M1 iPhone SE 竖屏 6×4（最挤的一档，改 maxW 前后对比就看这张）
 *   M2 iPhone SE 竖屏 4×3（最松的一档，确认放大后没顶到边缘）
 *   M3 iPad 竖屏 6×4
 *   M4 桌面横屏 6×4（回归：横屏卡片尺寸不应被竖屏改动影响）
 *   M5 桌面横屏 4×3
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve(__dirname, '..', 'shots');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const SHOTS = [
  { file: 'M1-memory-g64-se-portrait.png',  dev: 'iPhone SE 竖',  vw: 375,  vh: 667,  dsf: 2, grid: 'g64' },
  { file: 'M2-memory-g43-se-portrait.png',  dev: 'iPhone SE 竖',  vw: 375,  vh: 667,  dsf: 2, grid: 'g43' },
  { file: 'M3-memory-g64-ipad-portrait.png',dev: 'iPad 竖',       vw: 768,  vh: 1024, dsf: 2, grid: 'g64' },
  { file: 'M4-memory-g64-desktop.png',      dev: '桌面横屏',      vw: 1440, vh: 900,  dsf: 2, grid: 'g64' },
  { file: 'M5-memory-g43-desktop.png',      dev: '桌面横屏',      vw: 1440, vh: 900,  dsf: 2, grid: 'g43' }
];

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

  for (const s of SHOTS) {
    await page.setViewport({ width: s.vw, height: s.vh, deviceScaleFactor: s.dsf });
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction('window.__fsm && window.__fsm.Game', { timeout: 20000 });
    await wait(300);
    const info = await page.evaluate((gid) => {
      const f = window.__fsm;
      f.Game.state = 'menu';
      f.selectGame('memory');
      f.selectDiff(gid);
      f.startCurrent();
      f.Game.banner = 0;
      /* 翻开前 6 张 + 标记 2 张已配对，一屏看到背面/正面/已配对三种样式 */
      const M = f.Mem;
      for (let i = 0; i < Math.min(6, M.cards.length); i++) { M.cards[i].open = true; M.cards[i].anim = 1; }
      if (M.cards.length > 2) { M.cards[0].done = true; M.cards[1].done = true; M.cards[0].open = false; M.cards[1].open = false; }
      M.matched = 2;
      const cv = document.getElementById('game');
      const sc = cv.getBoundingClientRect().width / (f.VIEW.portrait ? 540 : 960);
      return { card: +(M.cw * sc).toFixed(1) + '×' + (M.ch * sc).toFixed(1),
               cols: M.cols, rows: M.rows, portrait: f.VIEW.portrait };
    }, s.grid);
    await wait(500);
    await page.screenshot({ path: path.join(OUT, s.file) });
    console.log(`${s.file}  ${s.dev} ${s.grid} ${info.cols}×${info.rows}  单卡 ${info.card}px  portrait=${info.portrait}`);
  }

  console.log(errs.length ? `\n运行时错误 ${errs.length} 条：\n` + errs.join('\n') : '\n零运行时错误');
  await browser.close();
})().catch(e => { console.error(e); process.exit(2); });
