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
const spotMatch = require('../tests/lib-spot-match.js');

const URL = process.env.TARGET_URL || 'https://willzhan1983.github.io/forest-school-games/';
/* 导航超时。原来写死 60s，首页涨到 1.36MB 又碰上网络慢（实测单请求 7~13s），
   networkidle0 等不到就整个脚本挂掉，看着像线上坏了其实是网络抖。
   默认放宽到 120s，急的时候用 NAV_TIMEOUT=30000 收紧。 */
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 120000);
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
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT });
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
        data URI 一起抓，mime 跟着走，不会把 JPEG 当 png 解不出来。
     3) 直接 fetch(location.href) 拿到的是 CDN 缓存里的旧文件。上线后第一次
        复验就撞上了：页面本身跑的是新版（V13 的 8 类景物位图全部解码成功），
        但 fetch 回来只有 18 张素材，比构建产物少 8 张 —— 缓存 key 相同，
        CDN 照旧把上一版 HTML 递了回来。所以取两份：带时间戳的那份绕开缓存
        用来判，原 URL 那份只作参考，不一致说明缓存还没追上，提示但不判失败。 */
  const imgs = await page.evaluate(async () => {
    const bust = (u) => u + (u.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now();
    const grab = async (url) => {
      const html = await (await fetch(url)).text();
      const re = /data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]{200,}/g;
      const list = []; let m;
      while ((m = re.exec(html)) !== null && list.length < 60) list.push(m[0]);
      return list;
    };
    const decode = async (list) => {
      const out = [];
      for (const u of list) {
        out.push(await new Promise(r => {
          const im = new Image();
          im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight });
          im.onerror = () => r({ w: 0, h: 0 });
          im.src = u;
        }));
      }
      return out;
    };
    const fresh = await grab(bust(location.href));
    const asIs = await grab(location.href);
    return { list: await decode(fresh), cached: asIs.length };
  });
  const imgList = imgs.list;
  /* 第四个坑：分档口径要能兜住所有素材，不然新加的图线上坏了也统计不到。
     之前按 h 在 110~130 才算小素材，找不同的 bush(128×79)、cloud(128×83)、
     butterfly(128×105) 三张整张漏验。改成按「比立绘小、比 50px 大」划档，
     并加一条 unclassified 兜底：有任何一张没被归类就直接判失败。 */
  const bigOnes = imgList.filter(d => d.w > 300);                          /* 场景背景 640×560 */
  const chars = imgList.filter(d => d.w >= 150 && d.w <= 300 && d.h >= 150); /* 猫头鹰立绘 */
  const items = imgList.filter(d => d.w > 50 && d.w < 150 && d.h < 150);     /* 道具/动物/景物 */
  const unclassified = imgList.length - bigOnes.length - chars.length - items.length;
  const imgsOk = imgList.every(d => d.w > 0 && d.h > 0) &&
    chars.length >= 2 && items.length >= 23 && bigOnes.length >= 1 && unclassified === 0;
  rec('V2', '全部素材（2 立绘 + 23 小图 + 1 背景）线上完整可解码', imgsOk,
    `共 ${imgList.length} 张（立绘 ${chars.length} / 小图 ${items.length} / 背景 ${bigOnes.length}` +
    `${unclassified ? ' / 未归类 ' + unclassified : ''}）` +
    `${imgs.cached !== imgList.length ? `｜CDN 缓存仍是旧版（${imgs.cached} 张）` : ''}：` +
    imgList.map(d => d.w > 0 ? `${d.w}×${d.h}` : 'DECODE-FAIL').join(' '));

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
     比对逻辑跟本地 ART9 共用一份（tests/lib-spot-match.js）——
     拿位图自己的 alpha 当 mask 去主画布上逐像素验色，不靠「位图 vs 矢量
     变化了多少」这种带临界值的判据（线上就是被它坑过：bush 27%、有个元素
     正好卡在阈值 20 上，时好时坏）。 */
  const decoded = await page.evaluate(() => Object.keys(window.__fsm.SPOT_ART)
    .filter(k => window.__fsm.SPOT_ART[k].img && window.__fsm.SPOT_ART[k].img.naturalWidth > 0).length);
  const propArt = await spotMatch.collect(page, wait);
  rec('V13', '找不同 8 类景物位图线上解码且真画在场景里',
    decoded === 8 && propArt.pass,
    `解码 ${decoded}/8 类 ｜ ` + spotMatch.detail(propArt));

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

  /* V15 打地鼠线上能玩：命中好物加分、好物漏接只断连击不扣分。
     这两条是体检后定的规矩（不扣命；惩罚「判断错」不惩罚「来不及」）。
     本地测过不算数 —— base64 在构建环节被截断、或 SW 把旧版本缓存住，
     线上跑的就是没有这条规矩的老代码，而状态位照样是绿的。 */
  const clickAt = async (lx, ly) => {
    const pt = await page.evaluate(([x, y]) => {
      const r = document.getElementById('game').getBoundingClientRect();
      return { x: r.left + x * (r.width / window.__fsm.W),
               y: r.top + y * (r.height / window.__fsm.H) };
    }, [lx, ly]);
    await page.mouse.click(pt.x, pt.y);
  };

  const wEnter = await page.evaluate(async () => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('whack'); f.selectDiff('normal'); f.startCurrent();
    await new Promise(r => setTimeout(r, 300));
    return { id: f.curGame().id, nHoles: f.Whack.holes.length };
  });
  /* 直接插一个 st=2（完全冒出）、t=12（pop=1，最大可点）的好物，不等随机冒头 */
  const wHitPt = await page.evaluate(() => {
    const f = window.__fsm, h = f.Whack.holes[3];
    h.isBad = false; h.k = 2; h.st = 2; h.t = 12;
    f.Whack.combo = 0; f.Whack.mult = 1; f.Game.score = 0;
    const r = f.whackHoleRect(3);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  });
  await clickAt(wHitPt.x, wHitPt.y);
  await wait(300);
  const afterHit = await page.evaluate(() => ({
    s: window.__fsm.Game.score, c: window.__fsm.Whack.combo }));
  /* 漏接：把好物推到 life 边缘再走一帧 */
  const afterMiss = await page.evaluate(() => {
    const f = window.__fsm, c = f.whackCfg(), h = f.Whack.holes[5];
    h.isBad = false; h.k = 1; h.st = 2; h.t = c.life - 1;
    f.Whack.combo = 3; f.Whack.mult = 2; f.Game.score = 200;
    f.curGame().update(1);
    return { s: f.Game.score, c: f.Whack.combo, miss: f.Whack.miss };
  });
  rec('V15', '打地鼠线上：命中好物加分，好物漏接只断连击不扣分',
    wEnter.id === 'whack' && wEnter.nHoles === 9 &&
    afterHit.s === 10 && afterHit.c === 1 &&
    afterMiss.s === 200 && afterMiss.c === 0 && afterMiss.miss >= 1,
    `开局 ${wEnter.nHoles} 洞 ｜ 命中 0->${afterHit.s} 分 combo=${afterHit.c} ｜ ` +
    `漏接后 ${afterMiss.s} 分不变 combo=0 漏接=${afterMiss.miss}`);

  /* V16 拼图线上能玩：3 张素材解码 + 交换生效 + 完美玩法拿满分 base。
     拼图是这次新加的，最怕两件事：线上 base64 被截断（画面全白却不报错）、
     计分公式跑偏。V2 只验「图能不能解码」，验不到「能不能玩、分对不对」。 */
  const zEnter = await page.evaluate(async () => {
    const f = window.__fsm;
    f.Game.state = 'menu'; f.selectGame('puzzle'); f.selectDiff('p33'); f.startCurrent();
    await new Promise(r => setTimeout(r, 900));
    return {
      id: f.curGame().id, n: f.Puz.n, ready: f.Puz.ready,
      decoded: f.Puz.imgs.filter(function (im) { return im && im.naturalWidth > 0; }).length,
      imgW: f.puzImg() ? f.puzImg().naturalWidth : 0
    };
  });
  /* 构造「一次交换就能解」的局面：identity 但 0/1 互换。
     完美玩法（1 步解）应当恰好拿满分 base —— 计分基线就是这么定的。 */
  const zSwap = await page.evaluate(() => {
    const f = window.__fsm, n = f.Puz.n;
    f.Puz.order = []; for (let k = 0; k < n; k++) f.Puz.order.push(k);
    const t = f.Puz.order[0]; f.Puz.order[0] = f.Puz.order[1]; f.Puz.order[1] = t;
    f.Puz.minSwaps = f.minSwapsOf(f.Puz.order);
    f.Puz.moves = 0; f.Puz.sel = -1; f.Puz.done = false;
    const c0 = f.puzCell(0), c1 = f.puzCell(1);
    return { min: f.Puz.minSwaps, base: f.puzCfg().base,
             x0: c0.x + c0.w / 2, y0: c0.y + c0.h / 2,
             x1: c1.x + c1.w / 2, y1: c1.y + c1.h / 2 };
  });
  await clickAt(zSwap.x0, zSwap.y0); await wait(200);
  await clickAt(zSwap.x1, zSwap.y1); await wait(1500);   /* solvedT 36 帧 + 余量 */
  const zDone = await page.evaluate(() => ({
    s: window.__fsm.Game.state, sc: window.__fsm.Game.score, m: window.__fsm.Puz.moves }));
  rec('V16', '拼图线上：3 张素材解码 + 交换生效 + 完美玩法拿满分 base',
    zEnter.id === 'puzzle' && zEnter.n === 9 && zEnter.decoded === 3 && zEnter.imgW === 512 &&
    zSwap.min === 1 && zDone.s === 'result' && zDone.m === 1 && zDone.sc === zSwap.base,
    `素材 ${zEnter.decoded}/3 张（${zEnter.imgW}px）｜ minSwaps=${zSwap.min} moves=${zDone.m} ` +
    `-> state=${zDone.s} score=${zDone.sc}（base=${zSwap.base}）`);

  /* V17 打地鼠线上：洞数随难度递增 + 单洞物理尺寸严格单调递减。
     PR #21 之前漏了"派生量必须直接断言"，T50 只验 gap 数字递减
     没验洞尺寸 —— 结果横屏 hard 反而比 normal 还好点（一个变量两用的坑）。
     线上复测一次，杜绝类似问题再悄悄回来。 */
  const wh17 = await page.evaluate(async () => {
    const f = window.__fsm;
    const cv = document.getElementById('game');
    const portrait = window.innerHeight > window.innerWidth * 1.15;
    const s = cv.getBoundingClientRect().width / (portrait ? 540 : 960);
    const out = {};
    for (const d of ['easy', 'normal', 'hard']) {
      f.Game.state = 'menu'; f.selectGame('whack'); f.selectDiff(d); f.startCurrent();
      await new Promise(r => setTimeout(r, 60));
      out[d] = {
        n: f.Whack.holes.length,
        hole: f.whackBoard().hole,
        pxHole: +(f.whackBoard().hole * s).toFixed(1),
        pxTap: +(f.whackBoard().hole * 1.14 * s).toFixed(1)
      };
    }
    return { portrait, s: +s.toFixed(3), ...out };
  });
  const w = wh17;
  /* 字段名对上 evaluate 里返回的 n / pxHole，别写成 nHoles（undefined 比较恒 false） */
  const mono = w.easy.n < w.normal.n && w.normal.n < w.hard.n &&
               w.easy.pxHole >= w.normal.pxHole && w.normal.pxHole >= w.hard.pxHole;
  const allTapOK = w.easy.pxTap >= 60 && w.normal.pxTap >= 60 && w.hard.pxTap >= 60;
  rec('V17', '打地鼠线上：洞数 6/9/12 递增 + 单洞物理尺寸单调递减 + 热区均 >= 60px',
    mono && allTapOK,
    `横屏 1440x900 s=${w.s} ｜ 洞数 ${w.easy.n}/${w.normal.n}/${w.hard.n} ｜ ` +
    `热区 ${w.easy.pxTap}/${w.normal.pxTap}/${w.hard.pxTap}px ｜ ` +
    `单洞 ${w.easy.pxHole}->${w.normal.pxHole}->${w.hard.pxHole}px ${mono ? '单调' : '非单调!'}`);

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
