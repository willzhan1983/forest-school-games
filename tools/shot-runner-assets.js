/*
 * tools/shot-runner-assets.js —— 跑酷官方素材接入后的视觉验收截图
 *
 *   node tools/shot-runner-assets.js
 *
 * 拍这几张（输出到 shots/runner-*.png）：
 *   R1 菜单（横屏）：6 张卡片立绘是否变成跑酷 idle 帧
 *   R2 记忆翻牌：牌面池里有没有道具图标与新动作帧
 *   R3 接橡果：Doodle 是不是 glide 帧、橡果是不是官方图
 *   R4 打地鼠：冒头的有没有新素材
 *   R5 拼图：三张场景图（森林/教室/树屋）能不能用
 *   R6 节奏游戏：舞者是不是跑动帧
 *   R7 菜单（竖屏 420×860）：6 卡片不溢出
 *
 * 必须走 selectGame → selectDiff → startCurrent（直接赋 Game.diff 会被覆盖）。
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
    await page.screenshot({ path: path.join(OUT, 'runner-' + name + '.png') });
    console.log('  ✓ shots/runner-' + name + '.png  ' + note);
  };
  const start = async (game, diff) => {
    await page.evaluate(([g, d]) => {
      const f = window.__fsm;
      f.Game.state = 'menu';
      f.selectGame(g);
      f.selectDiff(d);
      f.startCurrent();
    }, [game, diff]);
    await wait(500);
  };

  /* R1 菜单 */
  await page.evaluate(() => { window.__fsm.Game.state = 'menu'; window.__fsm.selectGame('memory'); });
  await wait(500);
  await shoot('menu', '菜单 + 卡片立绘');

  /* R2 记忆翻牌：翻两张亮出来看牌面 */
  await start('memory', 'g44');
  await page.evaluate(() => {
    const f = window.__fsm;
    /* 直接把牌全翻开，看整副牌面 */
    f.Mem.cards.forEach(c => { c.open = true; });
  });
  await wait(400);
  await shoot('memory', '整副牌面（含道具图标 + 动作帧）');

  /* R3 接橡果 */
  await start('acorn', 'normal');
  await wait(1600);
  await shoot('acorn', 'Doodle glide + 官方橡果');

  /* R4 打地鼠 */
  await start('whack', 'normal');
  await wait(2500);
  await shoot('whack', '冒头目标素材');

  /* R5 拼图（三张场景图轮转） */
  for (let i = 0; i < 3; i++) {
    await start('puzzle', 'p33');
    await wait(900);
    await shoot('puzzle-' + (i + 1), '第 ' + (i + 1) + ' 张场景图');
  }

  /* R6 节奏游戏 */
  await start('rhythm', 'easy');
  await wait(1500);
  await shoot('rhythm', '舞者跑动帧');

  /* R7 竖屏菜单 */
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 1 });
  await wait(600);
  await page.evaluate(() => { window.__fsm.Game.state = 'menu'; window.__fsm.selectGame('memory'); });
  await wait(600);
  await shoot('menu-portrait', '竖屏 6 卡片');

  await browser.close();
  console.log('\n截图完成 → shots/');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
