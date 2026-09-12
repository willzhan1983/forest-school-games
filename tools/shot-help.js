/*
 * tools/shot-help.js —— 玩法说明面板的视觉验收截图
 *
 *   node tools/shot-help.js
 *
 * 拍这几张（输出到 shots/help-*.png）：
 *   H1..H6  6 款游戏的说明页（横屏），逐张检查五块内容是否都在画面内
 *   H7      竖屏说明页（取内容最长的一款 —— 竖屏最挤，它不溢出就都安全）
 *   H8      菜单（横屏）：卡片右上角「?」圆钮，未读橙色 / 已读白底
 *   H9      菜单（竖屏）：同上
 *
 * 每张都顺带做一次几何体检（内容底边 vs 按钮顶边），
 * 因为面板高度是 clamp 过的：文案一长，按钮就会压到正文上，
 * 截图看得见但只有肉眼盯着才发现。这里直接算出来打日志。
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/index.html';
const OUT = path.join(__dirname, '..', 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERR', e.message));
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await wait(900);

  const shoot = async (name, note) => {
    await page.screenshot({ path: path.join(OUT, 'help-' + name + '.png') });
    console.log('  ✓ shots/help-' + name + '.png  ' + note);
  };

  /* 几何体检：正文最后一行底边 与 主按钮顶边 的间隙。
     <0 就是压住了。另外报一下面板是否被 clamp（顶到 H-24）。 */
  const geo = () => page.evaluate(() => {
    const f = window.__fsm, m = f.helpMetrics();
    const p = f.helpPanel(), b = f.helpBtnRects();
    const blocks = f.helpBlocks(f.Help.gameId);
    let contentH = 0;
    for (const bl of blocks) contentH += m.labelH + bl.lines.length * m.lineH + m.blockGap;
    const contentBottom = p.y + m.padV + m.titleH + contentH;
    const btnTop = b.primary.y;
    const inCv = r => r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= f.W + 0.5 && r.y + r.h <= f.H + 0.5;
    return {
      gap: Math.round(btnTop - contentBottom),
      clamped: Math.round(p.h) >= f.H - 24,
      panelH: Math.round(p.h), H: f.H, W: f.W, panelW: Math.round(p.w),
      lines: blocks.reduce((a, bl) => a + bl.lines.length, 0),
      inPanel: inCv(p), inBtn: inCv(b.primary) && inCv(b.second),
      btnH: b.primary.h
    };
  });

  const openHelp = async (id) => {
    await page.evaluate((gid) => {
      const f = window.__fsm;
      f.Game.state = 'menu';
      f.closeHelp();
      f.openHelp(gid, 'peek');
    }, id);
    await wait(420);
  };

  const ids = await page.evaluate(() => window.__fsm.GAMES.map(g => g.id));
  const names = await page.evaluate(() => window.__fsm.GAMES.map(g => g.name));

  /* H1..H6 横屏逐款 */
  console.log('\n[横屏]');
  for (let i = 0; i < ids.length; i++) {
    await openHelp(ids[i]);
    const g = await geo();
    const bad = [];
    if (g.gap < 0) bad.push('正文压住按钮 ' + g.gap + 'px');
    if (!g.inPanel) bad.push('面板出界');
    if (!g.inBtn) bad.push('按钮出界');
    console.log(`  ${ids[i].padEnd(8)} 面板 ${g.panelW}×${g.panelH} 行数${String(g.lines).padStart(2)} ` +
      `间隙${String(g.gap).padStart(3)}px 按钮高${g.btnH} ${g.clamped ? '[clamp]' : ''} ${bad.length ? '❌ ' + bad.join(' / ') : '✓'}`);
    await shoot('L-' + ids[i], names[i] + ' 横屏说明页');
  }

  /* H7 竖屏（挑行数最多的一款） */
  console.log('\n[竖屏 420×860]');
  const longest = await page.evaluate(() => {
    const f = window.__fsm;
    let best = null, bestN = -1;
    f.GAMES.forEach(g => {
      f.Help.gameId = g.id;
      const n = f.helpBlocks(g.id).reduce((a, bl) => a + bl.lines.length, 0);
      if (n > bestN) { bestN = n; best = g.id; }
    });
    return best;
  });
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 1 });
  await wait(700);
  await openHelp(longest);
  const gp = await geo();
  console.log(`  ${longest}（行数最多）面板 ${gp.panelW}×${gp.panelH} 行数${gp.lines} ` +
    `间隙${gp.gap}px 按钮高${gp.btnH} ${gp.clamped ? '[clamp]' : ''} ` +
    `${gp.gap < 0 || !gp.inPanel || !gp.inBtn ? '❌ 溢出' : '✓'}`);
  await shoot('P-' + longest, names[ids.indexOf(longest)] + ' 竖屏说明页');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await wait(600);

  /* H8/H9 菜单圆钮：只读过第一款，看橙/白对比 */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.closeHelp();
    f.Help.seen = { acorn: 1 };
    f.Game.state = 'menu';
    f.selectGame('memory');
  });
  await wait(500);
  await shoot('menu-L', '菜单横屏：卡片「?」圆钮（acorn 已读=白底，其余橙色）');

  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 1 });
  await wait(650);
  await shoot('menu-P', '菜单竖屏：卡片「?」圆钮');

  await browser.close();
  console.log('\n截图完成 → shots/');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
