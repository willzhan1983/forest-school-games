/*
 * 翻牌卡片尺寸体检（多视口 × 多棋盘）
 *
 *   NODE_PATH=/Users/mac/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node tools/measure-mem.js
 *   # 或指定地址：TARGET_URL=https://... node tools/measure-mem.js
 *
 * 为什么要有这个脚本：
 *   卡片尺寸是「逻辑坐标 × 画布缩放」的结果，只看 Mem.cw 的逻辑值会得出
 *   错误结论 —— 竖屏下各设备逻辑画布都是 540 宽，Mem.cw 全一样，
 *   但真实触摸目标差一倍多。必须换算成 CSS 像素再判断。
 *   儿童游戏的可点目标建议 ≥44px（iOS HIG 下限），低于这个值小孩点不准。
 *
 * 输出：每个视口 × 每个棋盘的单卡 CSS 尺寸、卡片间距、是否达标。
 */
const puppeteer = require('puppeteer-core');

const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 120000);

/* 竖屏小屏是 worst case：375 宽的手机要把 540 逻辑宽压到 0.69 倍。 */
const VIEWS = [
  { id: 'SE竖',   w: 375,  h: 667,  dsf: 2 },
  { id: 'iP14竖', w: 390,  h: 844,  dsf: 3 },
  { id: 'iPad竖', w: 768,  h: 1024, dsf: 2 },
  { id: 'SE横',   w: 667,  h: 375,  dsf: 2 },
  { id: 'iPad横', w: 1024, h: 768,  dsf: 2 },
  { id: '桌面',   w: 1440, h: 900,  dsf: 1 }
];
const GRIDS = ['g43', 'g44', 'g54', 'g64'];
const MIN_TAP = 44;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const out = [];

  for (const v of VIEWS) {
    await page.setViewport({ width: v.w, height: v.h, deviceScaleFactor: v.dsf });
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT });
    await page.waitForFunction('window.__fsm && window.__fsm.Game', { timeout: 20000 });
    await wait(120);

    const row = { view: v.id, grids: {} };
    for (const g of GRIDS) {
      const m = await page.evaluate((gid) => {
        const f = window.__fsm;
        f.selectGame('memory');
        f.selectDiff(gid);
        f.startCurrent();
        const cv = document.querySelector('canvas');
        const r = cv.getBoundingClientRect();
        const scale = r.width / (f.VIEW.portrait ? f.H * 0 + 540 : 960);
        const k = f.VIEW.portrait ? 540 : 960;
        const s = r.width / k;
        const M = f.Mem;
        return {
          cw: M.cw, ch: M.ch, cols: M.cols, rows: M.rows,
          w: +(M.cw * s).toFixed(1),
          h: +(M.ch * s).toFixed(1),
          gapX: +(10 * s).toFixed(1),
          gapY: +(8 * s).toFixed(1),
          boardW: +(((M.cw + 10) * M.cols - 10) * s).toFixed(1),
          boardH: +(((M.ch + 8) * M.rows - 8) * s).toFixed(1),
          left: +(M.x0 * s).toFixed(1),
          bottom: +((M.y0 + ((M.ch + 8) * M.rows - 8)) * s).toFixed(1),
          vw: window.innerWidth, vh: window.innerHeight,
          canvasW: +r.width.toFixed(1), canvasH: +r.height.toFixed(1)
        };
      }, g);
      row.grids[g] = m;
      row.canvasW = m.canvasW; row.canvasH = m.canvasH;
      row.vw = m.vw; row.vh = m.vh;
    }
    out.push(row);
  }

  console.log('\n=== 翻牌卡片尺寸体检（CSS 像素）===');
  for (const r of out) {
    console.log(`\n[${r.view}]  视口 ${r.vw}×${r.vh}  画布 ${r.canvasW}×${r.canvasH}`);
    for (const g of GRIDS) {
      const m = r.grids[g];
      const ok = m.w >= MIN_TAP && m.h >= MIN_TAP ? 'OK ' : '小!';
      console.log(
        `  ${ok} ${g}  ${m.cols}×${m.rows}  卡片 ${m.w}×${m.h}  ` +
        `间距 ${m.gapX}/${m.gapY}  棋盘 ${m.boardW}×${m.boardH}  ` +
        `左留白 ${m.left}  底部 ${m.bottom}`
      );
    }
  }

  console.log('\n=== 最小卡片（越小越危险）===');
  let worst = null;
  for (const r of out) for (const g of GRIDS) {
    const m = r.grids[g];
    const side = Math.min(m.w, m.h);
    if (!worst || side < worst.side) worst = { side, view: r.view, g, m };
  }
  console.log(`  最小单卡 ${worst.side}px  @ ${worst.view} / ${worst.g}  ` +
    `(${worst.m.w}×${worst.m.h}, 阈值 ${MIN_TAP}px)`);

  const bad = [];
  for (const r of out) for (const g of GRIDS) {
    const m = r.grids[g];
    if (Math.min(m.w, m.h) < MIN_TAP) bad.push(`${r.view}/${g} ${Math.min(m.w, m.h)}px`);
  }
  console.log(bad.length ? `\n  未达 ${MIN_TAP}px 的组合：${bad.join(' , ')}` : `\n  全部 ≥ ${MIN_TAP}px`);

  await browser.close();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
