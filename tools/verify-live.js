/*
 * 线上复验（部署后跑，本地测过不算数）
 *
 *   NODE_PATH=/Users/mac/.workbuddy/binaries/node/workspace/node_modules \
 *   /Users/mac/.workbuddy/binaries/node/versions/22.22.2-2/bin/node tools/verify-live.js
 *   # 或指定地址：TARGET_URL=https://... node tools/verify-live.js
 *
 * 为什么不能只信本地测试：
 *   本地跑的是 merge 出来的 index.html，线上跑的是 Pages 构建产物。
 *   base64 在构建环节被截断、素材路径写错、SW 缓存住旧版本 —— 这些
 *   本地全都看不出来。尤其 SW 是 network-first，缓存没更新时线上
 *   会一直跑旧代码，页面却显示正常。
 *
 * 检查项 V1~V10：加载健康度 + 素材解码 + 尺寸/速度机制 + 像素级渲染 + 竖屏。
 */
const puppeteer = require('puppeteer-core');

const URL = process.env.TARGET_URL || 'https://willzhan1983.github.io/forest-school-games/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const rows = [];
function rec(id, name, pass, detail) {
  rows.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  :: ' + detail : ''}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const errs = [], warns = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error') errs.push(m.text());
    if (m.type() === 'warning') warns.push(m.text());
  });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await wait(1500);   /* 等素材解码 + SW 注册 */

  /* V1 加载健康度 */
  rec('V1', '线上加载零错误零警告', errs.length === 0 && warns.length === 0,
    `error=${errs.length} warning=${warns.length}${errs[0] ? ' | ' + errs[0].slice(0, 90) : ''}`);

  /* V2 素材完整。立绘和道具都是 new Image() 建的，既不在 DOM 里也不挂在
     window 上，没法直接枚举 —— 改成把线上 HTML 抓回来，抠出里面的 base64
     逐个解码。这样验的是「用户真正拿到的那个文件」，SW 返回缓存也算进来。
     base64 在构建环节被截断的话，本地测试看不出来，只有这一步能抓到。 */
  /* 两个坑都改掉了：
     1) list.length < 12 的上限是只有 5 张素材时写的，现在一共 18 张，
        不提上限就只能验到前 12 张，后加的动物图线上坏了也发现不了
     2) 正则只认 png，找不同的背景图是 JPEG，整张被漏掉 —— 改成整条
        data URI 一起抓，mime 跟着走，不会把 JPEG 当 png 解不出来。 */
  const imgs = await page.evaluate(async () => {
    const html = await (await fetch(location.href)).text();
    const re = /data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]{200,}/g;
    const list = []; let m;
    while ((m = re.exec(html)) !== null && list.length < 40) {
      const d = await new Promise(r => {
        const im = new Image();
        im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => r({ w: 0, h: 0 });
        im.src = m[0];
      });
      list.push(d);
    }
    return list;
  });
  /* 第三个坑：分档口径要能兜住所有素材，不然新加的图线上坏了也统计不到。
     之前按 h 在 110~130 才算小素材，找不同的 bush(128×79)、cloud(128×83)、
     butterfly(128×105) 三张整张漏验。改成按「比立绘小、比 50px 大」划档，
     并加一条 unclassified 兜底：有任何一张没被归类就直接判失败。 */
  const bigOnes = imgs.filter(d => d.w > 300);                      /* 场景背景 640×560 */
  const chars = imgs.filter(d => d.w >= 150 && d.w <= 300 && d.h >= 150);   /* 猫头鹰立绘 */
  const items = imgs.filter(d => d.w > 50 && d.w < 150 && d.h < 150);       /* 道具/动物/景物 */
  const unclassified = imgs.length - bigOnes.length - chars.length - items.length;
  const imgsOk = imgs.every(d => d.w > 0 && d.h > 0) &&
    chars.length >= 2 && items.length >= 23 && bigOnes.length >= 1 && unclassified === 0;
  rec('V2', '全部素材（2 立绘 + 23 小图 + 1 背景）线上完整可解码', imgsOk,
    `共 ${imgs.length} 张（立绘 ${chars.length} / 小图 ${items.length} / 背景 ${bigOnes.length}` +
    `${unclassified ? ' / 未归类 ' + unclassified : ''}）：` +
    imgs.map(d => d.w > 0 ? `${d.w}×${d.h}` : 'DECODE-FAIL').join(' '));

  /* V3 掉落物尺寸。写死过 34，后来按画布短边改成 48。 */
  const szLand = await page.evaluate(() => ({ s: window.__fsm.itemSize(), W: window.__fsm.W, H: window.__fsm.H }));
  rec('V3', '横屏掉落物 48px（旧版 34px）', szLand.s === 48,
    `${szLand.W}×${szLand.H} -> ${szLand.s}px`);

  /* V4 竖屏尺寸一致 —— 短边都是 540，两个朝向必须一样大 */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await wait(800);
  const szPort = await page.evaluate(() => ({
    s: window.__fsm.itemSize(), W: window.__fsm.W, H: window.__fsm.H,
    owlY: Math.round(window.__fsm.H * 0.785)
  }));
  rec('V4', '竖屏掉落物同样 48px，猫头鹰不悬空（owlY=754）',
    szPort.s === 48 && szPort.owlY === 754,
    `${szPort.W}×${szPort.H} -> ${szPort.s}px  owlY=${szPort.owlY}`);

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await wait(600);

  /* V5 难度爬升机制：ramp 从 ~1 涨到 >1.4（普通档配 1.60） */
  await page.evaluate(() => {
    const f = window.__fsm;
    f.selectGame('acorn'); f.selectDiff('normal'); f.startCurrent();
  });
  await wait(400);
  const ramp = await page.evaluate(() => {
    const f = window.__fsm, A = f.Acorn;
    A.left = A.timeLimit * 0.98; const early = f.acornRamp();
    A.left = A.timeLimit * 0.02; const late = f.acornRamp();
    A.left = A.timeLimit * 0.9;
    return { early: +early.toFixed(3), late: +late.toFixed(3) };
  });
  rec('V5', '线上速度倍率随进度爬升', ramp.late > ramp.early * 1.4 && ramp.early < 1.05,
    `开局 ×${ramp.early} -> 局末 ×${ramp.late}`);

  /* V6 速度条真的画出来了（像素采样，不看变量） */
  const pips = await page.evaluate(async () => {
    const f = window.__fsm, A = f.Acorn;
    const cv = document.getElementById('game'), c = cv.getContext('2d');
    const sx = cv.width / f.W, sy = cv.height / f.H;
    const count = async (ratio) => {
      A.nuts.length = 0; A.spawnT = 1e9; f.Game.banner = 0;
      A.left = A.timeLimit * ratio;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const d = c.getImageData(Math.round(76 * sx), Math.round(82 * sy), Math.round(84 * sx), Math.round(20 * sy)).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r > 150 && g < 170 && b < 110 && r > b + 60) lit++;
      }
      return lit;
    };
    const early = await count(0.98), late = await count(0.02);
    A.left = A.timeLimit * 0.9;
    return { early, late };
  });
  rec('V6', '速度条档位线上可见（亮像素递增）', pips.late > pips.early * 1.8,
    `开局 ${pips.early} -> 局末 ${pips.late}`);

  /* V7 三个道具颜色可分 —— 分不清的话「别碰坏东西」这条规则就废了 */
  const colors = await page.evaluate(async () => {
    const f = window.__fsm, A = f.Acorn;
    A.nuts.length = 0; A.spawnT = 1e9; f.Game.banner = 0;
    /* 必须清掉「加速啦！」：它画在 (W/2, H*0.30)，正好压在中间那个采样点上。
       不清的话采到的是红字不是毛毛虫，断言却可能照样过 —— 假绿灯比红灯更危险。 */
    A.flash = 0; A.left = A.timeLimit * 0.9;
    const W = f.W;
    const items = [['acorn', W * 0.28], ['bug', W * 0.50], ['shroom', W * 0.72]];
    for (const [k, x] of items) A.nuts.push({ x, y: 260, vy: 0, kind: k, rot: 0, vr: 0, swing: 0 });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cv = document.getElementById('game'), c = cv.getContext('2d');
    const sx = cv.width / f.W, sy = cv.height / f.H;
    const out = {};
    for (const [k, x] of items) {
      const d = c.getImageData(Math.round((x - 7) * sx), Math.round((260 - 7) * sy), Math.round(14 * sx), Math.round(14 * sy)).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      out[k] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    }
    return out;
  });
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const dAB = dist(colors.acorn, colors.bug), dAS = dist(colors.acorn, colors.shroom), dBS = dist(colors.bug, colors.shroom);
  /* 除了「两两分得开」，还要看色相方向对不对：橡果偏棕、虫偏绿、菇偏红。
     只比色差的话，哪天把毛毛虫换成紫色的照样能过 —— 而紫色和毒蘑菇的红
     在小尺寸下对孩子来说就是同一个「别碰」，分辨成本白加了。 */
  const hueOk =
    colors.acorn[0] > colors.acorn[1] && colors.acorn[1] > colors.acorn[2] &&
    colors.bug[1] > colors.bug[0] && colors.bug[1] > colors.bug[2] &&
    colors.shroom[0] > colors.shroom[1] && colors.shroom[0] > colors.shroom[2];
  rec('V7', '三道具线上色彩可分且色相正确（棕/绿/红）',
    dAB > 80 && dAS > 80 && dBS > 80 && hueOk,
    `橡果 rgb(${colors.acorn}) 虫 rgb(${colors.bug}) 菇 rgb(${colors.shroom}) | 色差 ${dAB}/${dAS}/${dBS} 色相${hueOk ? '对' : '错'}`);

  /* V8 坏道具机制线上生效：接到坏东西要扣分 + 断连击 + 掉命 */
  const bad = await page.evaluate(async () => {
    const f = window.__fsm, A = f.Acorn;
    f.selectGame('acorn'); f.selectDiff('normal'); f.startCurrent();
    await new Promise(r => setTimeout(r, 200));
    A.nuts.length = 0; A.spawnT = 1e9;
    A.nuts.push({ x: A.owlX, y: 405, vy: 0.6, kind: 'acorn', rot: 0, vr: 0, swing: 0 });
    await new Promise(r => setTimeout(r, 400));
    const afterGood = { s: f.Game.score, c: A.combo };
    A.nuts.length = 0;
    A.nuts.push({ x: A.owlX, y: 405, vy: 0.6, kind: 'bug', rot: 0, vr: 0, swing: 0 });
    await new Promise(r => setTimeout(r, 400));
    return { afterGood, s: f.Game.score, c: A.combo, lv: A.lives };
  });
  rec('V8', '坏道具机制线上生效（扣分 + 断连击 + 掉命）',
    bad.afterGood.s > 0 && bad.afterGood.c >= 1 && bad.s < bad.afterGood.s && bad.c === 0 && bad.lv === 2,
    `接好 score=${bad.afterGood.s} combo=${bad.afterGood.c}；接坏后 score=${bad.s} combo=${bad.c} lives=${bad.lv}`);

  /* V9 菜单能正常开游戏（构建产物最容易在这里断掉） */
  const flow = await page.evaluate(async () => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('memory'); f.selectDiff('g44'); f.startCurrent();
    await new Promise(r => setTimeout(r, 300));
    return { state: f.Game.state, id: f.curGame().id, n: f.Mem.cards.length };
  });
  rec('V9', '菜单能开局（翻牌 4×4 = 16 张）',
    flow.state === 'play' && flow.id === 'memory' && flow.n === 16,
    `state=${flow.state} game=${flow.id} cards=${flow.n}`);

  /* V11 翻牌的 12 张动物位图线上真的画出来了。
     只查「图有没有解码」是不够的 —— 解码成功但代码没画（或索引错位）
     照样是矢量脸，状态位却全绿。所以直接采翻开卡片的像素：
     矢量脸是几块纯色拼的（色彩数 ~12），AI 位图有毛发渐变和描边（~104），
     差一个量级，一眼分得出来。 */
  const memArt = await page.evaluate(async () => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('memory'); f.selectDiff('g43'); f.startCurrent();
    await new Promise(r => setTimeout(r, 300));
    f.Mem.cards[0].k = 0;      /* 白猫：浅色主体，色彩数偏低，最保守的用例 */
    f.Mem.cards[0].open = true; f.Mem.first = -1;
    await new Promise(r => setTimeout(r, 1200));
    const r = f.memRect(0);
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const d = cv.getContext('2d').getImageData(
      Math.round((r.x + 20) * sx), Math.round((r.y + 20) * sy),
      Math.round((r.w - 40) * sx), Math.round((r.h - 40) * sy)).data;
    let n = 0; const uniq = new Set();
    for (let i = 0; i < d.length; i += 4) {
      n++;
      if (n % 7 === 0) uniq.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
    }
    return {
      colors: uniq.size,
      decoded: f.ANIMAL_IMG.filter(function (im) { return im.naturalWidth > 0; }).length
    };
  });
  rec('V11', '翻牌 12 张动物位图线上解码且真画在卡片上',
    memArt.decoded === 12 && memArt.colors >= 40,
    `解码 ${memArt.decoded}/12 张，卡片色彩数 ${memArt.colors}（矢量兜底约 12，阈值 ≥40）`);

  /* V12 找不同面板背景线上生效。同样不查状态查像素：
     画面上部必须是天空（蓝多于红），下部必须是草地（绿多于红）。
     背景图没加载时走的是纯色渐变，两个色带关系一样成立，
     所以还要确认背景图本身解码出来了（naturalWidth > 0）。 */
  const spotArt = await page.evaluate(async () => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('spot'); f.selectDiff('easy'); f.startCurrent();
    await new Promise(r => setTimeout(r, 500));
    const p = f.spotPanel(0);
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const c = cv.getContext('2d');
    const band = (y, h) => {
      const d = c.getImageData(Math.round((p.x + 8) * sx), Math.round((p.y + y) * sy),
        Math.round((p.w - 16) * sx), Math.max(1, Math.round(h * sy))).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    };
    return { up: band(8, p.h * 0.35), dn: band(p.h * 0.62, p.h * 0.34), bgW: f.SPOT_BG_IMG.naturalWidth };
  });
  rec('V12', '找不同面板背景线上生效（上蓝天下草地）',
    spotArt.bgW > 0 && spotArt.up[2] > spotArt.up[0] + 4 && spotArt.dn[1] > spotArt.dn[0] + 4,
    `背景图宽 ${spotArt.bgW}px 上部 rgb(${spotArt.up.join(',')}) 下部 rgb(${spotArt.dn.join(',')})`);

  /* V13 找不同的 8 类景物位图线上真的画出来了。
     判据同样不能用整幅面板的变化率 —— 面板 444×396，9 个景物才占一成多面积，
     背景一摊薄只剩 5%，画没画上去都测不出来。逐个景物在自己的包围盒中心取样。 */
  const propArt = await page.evaluate(async () => {
    const f = window.__fsm;
    const cv = document.getElementById('game');
    const sx = cv.width / 960, sy = cv.height / 540;
    const c = cv.getContext('2d');
    const p0 = f.spotPanel(0);
    const props = f.Spot.L.filter(p => !p.gone).map(p => ({ t: p.t, x: p.x, y: p.y, s: p.s }));
    const grab = () => props.map(p => {
      const a = f.SPOT_ART[p.t];
      const h = a.drawH * p.s, w = h * a.pxW / a.pxH;
      const bw = Math.max(2, Math.round(w * sx)), bh = Math.max(2, Math.round(h * sy * 0.5));
      const cx = (p0.x + p.x) * sx, cy = (p0.y + p.y - h * a.ay + h / 2) * sy;
      return Array.from(c.getImageData(Math.round(cx - bw / 2), Math.round(cy - bh / 2), bw, bh).data);
    });
    const A = grab();
    for (const k of Object.keys(f.SPOT_ART)) f.SPOT_ART[k].ready = false;
    await new Promise(r => setTimeout(r, 500));
    const B = grab();
    for (const k of Object.keys(f.SPOT_ART)) f.SPOT_ART[k].ready = true;
    const pct = A.map((a, i) => {
      const b = B[i];
      let diff = 0, n = 0;
      for (let k = 0; k < Math.min(a.length, b.length); k += 4) {
        n++;
        if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > 24) diff++;
      }
      return n ? Math.round(diff / n * 100) : 0;
    });
    const decoded = Object.keys(f.SPOT_ART)
      .filter(k => f.SPOT_ART[k].img && f.SPOT_ART[k].img.naturalWidth > 0);
    return { pct: pct, n: props.length, decoded: decoded.length };
  });
  const avgPct = propArt.pct.reduce((a, b) => a + b, 0) / (propArt.pct.length || 1);
  rec('V13', '找不同 8 类景物位图线上解码且真画在场景里',
    propArt.decoded === 8 && propArt.n > 0 && propArt.pct.every(p => p > 20) && avgPct > 40,
    `解码 ${propArt.decoded}/8 类，${propArt.n} 个景物差异率 ${propArt.pct.join('%,')}%，` +
    `平均 ${avgPct.toFixed(0)}%（阈值 每个 >20%、平均 >40%）`);

  /* V14 景物染色后各档颜色线上仍然分得开。
     这是位图方案最脆的一环：调色板或染色算法一动，两档染完可能几乎一样，
     那处差异就永远找不到了，而「图有没有解码」这类检查全都是绿的。 */
  const tintLive = await page.evaluate(() => {
    const f = window.__fsm;
    const d3 = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
    const out = [];
    for (const type of Object.keys(f.SPOT_ART)) {
      const a = f.SPOT_ART[type];
      if (a.hue < 0) continue;          /* 云/石头不做 color 差异 */
      const pal = f.SPOT_PAL[type], avg = [];
      for (let i = 0; i < pal.length; i++) {
        const cv = f.spotTinted(type, i);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let p = 0; p < d.length; p += 4) if (d[p + 3] >= 128) { r += d[p]; g += d[p + 1]; b += d[p + 2]; n++; }
        avg.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      }
      let minD = 1e9;
      for (let i = 0; i < avg.length; i++) for (let j = i + 1; j < avg.length; j++) {
        minD = Math.min(minD, d3(avg[i], avg[j]));
      }
      out.push({ type: type, minD: +minD.toFixed(1) });
    }
    return out;
  });
  const worstLive = tintLive.reduce((a, b) => (b.minD < a.minD ? b : a), { minD: 1e9, type: '-' });
  rec('V14', '景物染色后各档颜色线上仍肉眼可分（最差 ≥ 35）',
    tintLive.length === 6 && tintLive.every(t => t.minD >= 35),
    tintLive.map(t => `${t.type} ${t.minD}`).join(' ') + ` ← 最差 ${worstLive.type} ${worstLive.minD}`);

  /* V10 全程结束仍零错误（跑完上面这些操作后复检） */
  rec('V10', '复验全程零运行时错误', errs.length === 0 && warns.length === 0,
    `error=${errs.length} warning=${warns.length}${errs[0] ? ' | ' + errs[0].slice(0, 90) : ''}`);

  const passed = rows.filter(r => r.pass).length;
  console.log(`\n===== ${passed} / ${rows.length} PASS  =====  ${URL}`);
  if (passed !== rows.length) {
    console.log('FAILED:');
    rows.filter(r => !r.pass).forEach(r => console.log(`  ${r.id} ${r.name} :: ${r.detail}`));
  }
  await browser.close();
  process.exit(passed === rows.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
