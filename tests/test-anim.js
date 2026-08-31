/* 动画过程视觉追踪：
   之前的测试只验证状态终态，漏掉了"翻牌动画完成后卡片被压成细线"这类
   只在动画中间/完成帧出现的视觉 bug。本脚本对每个关键动画逐帧采样，
   输出亮度/色彩序列，检查画面是否在整个过程中都正常。 */
const puppeteer = require('puppeteer-core');
const URL = process.env.TARGET_URL || 'http://127.0.0.1:8931/forest-recess.html';
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

  const enter = async (id) => {
    await page.evaluate(g => {
      window.__fsm.Game.state = 'menu';
      window.__fsm.Game.gameId = g;
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
    A.nuts.push({ x: A.owlX, y: 410, vy: 0.4, rot: 0, vr: 0, swing: 0 });
  });
  await wait(400);
  const fxAfter = await page.evaluate(() => window.__fsm.Acorn.catchFx.length);
  await wait(1200);
  const fxGone = await page.evaluate(() => window.__fsm.Acorn.catchFx.length);
  rec('A4', '接取飘字出现后自行消失（不残留）', fxAfter >= 1 && fxGone === 0,
    `接住后=${fxAfter} 1.2秒后=${fxGone}`);

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

  /* ---------- A6 松鼠冲刺：撞击特效消失 ---------- */
  await enter('dash');
  await page.evaluate(() => {
    const D = window.__fsm.Dash;
    D.fx.push({ x: 400, y: 400, vx: -2, vy: -4, life: 24, max: 24, c: '#a9703f' });
    D.fx.push({ x: 420, y: 400, vx: 2, vy: -3, life: 24, max: 24, c: '#a9703f' });
  });
  await wait(300);
  const fxDash1 = await page.evaluate(() => window.__fsm.Dash.fx.length);
  await wait(1500);
  const fxDash2 = await page.evaluate(() => window.__fsm.Dash.fx.length);
  rec('A6', '冲刺特效出现后自行消失（不残留）', fxDash1 >= 1 && fxDash2 === 0,
    `0.3秒后=${fxDash1} 1.8秒后=${fxDash2}`);

  /* ---------- A7 松鼠冲刺：跳跃过程中角色始终可见 ---------- */
  await enter('dash');
  const jumpTrace = [];
  await page.evaluate(() => { window.__fsr = null; });
  await page.keyboard.press('Space');
  for (let i = 0; i < 12; i++) {
    jumpTrace.push(await sample(page, 150, 360, 90, 140));
    await wait(60);
  }
  const jumpMin = Math.min(...jumpTrace.map(t => t.lum));
  rec('A7', '跳跃全过程角色始终可见', jumpMin > 60,
    'lum序列=' + jumpTrace.map(t => t.lum).join(' '));

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
