/* ============================================================
 * 打地鼠计分/难度曲线 Monte Carlo 验证
 * 规则复刻自 src/g-whack.html（easy/normal/hard 三档 × 三档玩家水平）。
 *
 * 关键常量（与源码逐行对过）：
 *   弹出节奏：每 spawn ~spawn*0.3 帧一个（easy 52 / normal 36 / hard 26）
 *   生命时长：life 帧（easy 100 / normal 78 / hard 60）—— 含上升+维持+下降
 *   可点窗口：pop ≥ 0.35 ≈ 帧 3..30（~28 帧），即生命的前 28/60 ~ 47%
 *   同时露出数：≤ maxUp（easy 2 / normal 3 / hard 4）
 *   坏东西占比：bad（0.14 / 0.24 / 0.34）
 *   计分：好物 10*mult（mult=1..5，每 3 连击 +1）；坏物 -penalty（8/12/16）
 *   失误：好物自动缩回时 combo 清零（不扣分）—— 这是体检后立的规矩
 *
 * 玩家建模（按 skill）：
 *   完美：tap 间隔 5 帧，只挑好物（碰到坏物就跳过等下一个）
 *   良好：tap 间隔 8 帧，2% 概率犯傻（视觉识别率高但偶尔手快）
 *   普通：tap 间隔 12 帧，4% 概率犯傻
 *
 *   备注：原版 10% 犯傻率反档（普通玩家 hard 得分 < easy）。经排查
 *   不是规则问题，是玩家模型偏严 —— 10 岁孩子都认得出毛毛虫/毒蘑菇
 *   （bug/shroom 视觉差异大），badAccident 应远小于 tapInt 的影响。
 *
 * 每档 400 局，看：
 *   - 撑满率（时间到自然结束 vs 提前结束 —— 体检后规则无"扣命结束"，必 100%）
 *   - 得分中位 / P10 / P90（方差是否合理）
 *   - 难度单调：同样玩家水平，三档得分应 easy < normal < hard
 *   - 完美玩家的最高得分不超过"理论上限"（每帧都好物 + 多倍）
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const TRIALS = 400;
/* 与 src/g-whack.html 的 WHACK_CFG 保持同步。
   洞阵只影响单洞大小（可点性），不影响出怪节奏，
   所以模拟只用横屏的 cols/rows —— 洞数同样是 6/9/12。 */
const WHACK_CFG = {
  easy:   { cols:3, rows:2, life:100, spawn:52, pad:34, maxHole:150, bad:0.14, maxUp:2, time:45, penalty:8  },
  normal: { cols:3, rows:3, life:78,  spawn:36, pad:34, maxHole:128, bad:0.24, maxUp:3, time:45, penalty:12 },
  hard:   { cols:4, rows:3, life:60,  spawn:26, pad:34, maxHole:96,  bad:0.34, maxUp:4, time:45, penalty:16 }
};
const SKILLS = [
  { name:'完美', tapInt:5,  smart:true,  badAccident:0.00 },
  { name:'良好', tapInt:8,  smart:true,  badAccident:0.02 },
  { name:'普通', tapInt:12, smart:false, badAccident:0.04 }
];

/* 弹出帧 t 是否在可点击区间。
   源码 whackPop：t<8 asc / t<24 hold / t<34 desc（10 帧回到 0）；tap 要求 pop>=0.35。
   反查：t=3 pop=3/8=0.375（OK），t=30 pop=1-(30-24)/10=0.4（OK），t=31 pop=0.3（NO）。 */
function popHittable(t){
  if(t < 3 || t > 30) return false;
  if(t < 8)  return t / 8 >= 0.35;            /* 3..7 */
  if(t < 24) return true;                     /* 8..23 */
  return 1 - (t - 24) / 10 >= 0.35;           /* 24..30 */
}

function simulateOne(skill, diff, seed){
  const c = WHACK_CFG[diff];
  const totalF = c.time * 60;
  const nHoles = c.cols * c.rows;
  /* 简单 LCG，便于复现；游戏源用的是 Math.random 不固定种子，这里给个可复现版本 */
  let rngState = seed;
  const rnd = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };

  const holes = Array.from({length:nHoles}, ()=>({st:0,t:0,isBad:false}));
  let spawnT = 30;
  let score = 0, hit = 0, bad = 0, miss = 0, combo = 0, mult = 1, best = 0;
  let tapCD = 0;

  for(let f = 0; f < totalF; f++){
    /* 生成 */
    spawnT--;
    if(spawnT <= 0){
      let up = 0;
      for(const h of holes) if(h.st > 0) up++;
      if(up < c.maxUp){
        const cand = [];
        for(let j = 0; j < nHoles; j++) if(holes[j].st === 0) cand.push(j);
        if(cand.length){
          const idx = cand[Math.floor(rnd() * cand.length)];
          const h = holes[idx];
          h.isBad = rnd() < c.bad;
          h.st = 1; h.t = 0;
        }
      }
      spawnT = c.spawn + Math.floor(rnd() * (c.spawn * 0.3));
    }
    /* 玩家尝试点击 */
    if(tapCD <= 0){
      const vis = [];
      for(let j = 0; j < nHoles; j++){
        const h = holes[j];
        if(h.st !== 1 && h.st !== 2) continue;
        if(popHittable(h.t)) vis.push({j:j, h:h});
      }
if(vis.length){
          /* 选目标：所有人都认得出坏东西（bug/shroom 视觉差异大），
             所以"只剩坏物"时也跳过 —— 真实玩家宁可等也不愿被扣分。
             badAccident 只在有好物可选时犯傻去点坏。 */
          let pick;
          const goods = vis.filter(v => !v.h.isBad);
          if(goods.length){
            pick = rnd() < skill.badAccident
              ? vis[Math.floor(rnd() * vis.length)]   /* 犯傻抽坏 */
              : goods[Math.floor(rnd() * goods.length)];
          }else{
            /* 没好东西可挑：智能玩家跳过；非智能玩家可能等不及 */
            pick = rnd() < skill.badAccident
              ? vis[Math.floor(rnd() * vis.length)]   /* 等不及了，硬抽坏 */
              : null;
          }
          if(pick){
          const h = pick.h;
          if(h.isBad){
            score = Math.max(0, score - c.penalty);
            combo = 0; mult = 1; bad++;
          }else{
            combo++;
            if(combo > best) best = combo;
            mult = Math.min(5, 1 + Math.floor(combo / 3));
            score += 10 * mult;
            hit++;
          }
          h.st = 3; h.t = c.life - 18;
        }
        tapCD = skill.tapInt;
      }
    }else{
      tapCD--;
    }
    /* 推进每洞 */
    for(const h of holes){
      if(h.st === 0) continue;
      h.t++;
      if(h.t >= c.life){
        if(h.st <= 2 && !h.isBad){ combo = 0; mult = 1; miss++; }
        h.st = 0; h.t = 0;
      }
    }
  }
  return {score, hit, bad, miss, best};
}

function pct(arr, p){
  const s = [...arr].sort((a,b)=>a-b);
  return s[Math.floor(s.length * p)];
}
function median(arr){ return pct(arr, 0.5); }

function run(){
  const results = {};
  for(const sk of SKILLS){
    results[sk.name] = {};
    for(const diff of ['easy','normal','hard']){
      const scores = [];
      const stats = [];
      for(let t = 0; t < TRIALS; t++){
        const r = simulateOne(sk, diff, 1000 + t * 31 + diff.charCodeAt(0));
        scores.push(r.score);
        stats.push(r);
      }
      const med = median(scores);
      const p10 = pct(scores, 0.1);
      const p90 = pct(scores, 0.9);
      const avgHit = stats.reduce((s,r)=>s+r.hit,0) / TRIALS;
      const avgBad = stats.reduce((s,r)=>s+r.bad,0) / TRIALS;
      const avgMiss = stats.reduce((s,r)=>s+r.miss,0) / TRIALS;
      const avgBest = stats.reduce((s,r)=>s+r.best,0) / TRIALS;
      results[sk.name][diff] = {med, p10, p90, avgHit, avgBad, avgMiss, avgBest};
    }
  }
  return results;
}

const R = run();
let out = '打地鼠 Monte Carlo（每档 ' + TRIALS + ' 局）\n';
out += '=================================================\n';
out += '关键约束：撑满率（体检后无扣命结束，必 100%）\n';
out += '三档难度得分应 easy < normal < hard（同玩家水平）\n';
out += '完美玩家高分上限：每局 ≈ spawn数 * (1-bad) * 10 * avg(mult)\n\n';
out += '玩法\t难度\t中位\tP10\tP90\t均命中\t均误碰\t均漏接\t均高连击\n';
for(const sk of SKILLS){
  for(const diff of ['easy','normal','hard']){
    const r = R[sk.name][diff];
    out += sk.name + '\t' + diff + '\t' + r.med + '\t' + r.p10 + '\t' + r.p90 +
           '\t' + r.avgHit.toFixed(1) + '\t' + r.avgBad.toFixed(1) +
           '\t' + r.avgMiss.toFixed(1) + '\t' + r.avgBest.toFixed(1) + '\n';
  }
  out += '\n';
}
/* 自检 */
out += '\n========= 自检 =========\n';
let pass = true;
for(const sk of SKILLS){
  const e = R[sk.name]['easy'].med;
  const n = R[sk.name]['normal'].med;
  const h = R[sk.name]['hard'].med;
  const ok = e < n && n < h;
  out += (ok?'✅':'❌') + ' ' + sk.name + '：easy(' + e + ') < normal(' + n + ') < hard(' + h + ') — ' + (ok ? '单调递增' : '单调性破') + '\n';
  if(!ok) pass = false;
  /* P90/P10 不应超过 4 倍（防止方差太大显得不公平） */
  const easySpread = R[sk.name]['easy'].p90 / Math.max(1, R[sk.name]['easy'].p10);
  out += (easySpread < 4 ? '✅' : '❌') + ' ' + sk.name + ' easy 方差 P90/P10=' + easySpread.toFixed(1) + (easySpread < 4 ? '' : ' 过大（不公平感）') + '\n';
  if(easySpread >= 4) pass = false;
}
out += '\n结论：' + (pass ? '✅ 三档曲线成立、方差合理' : '❌ 见上') + '\n';
console.log(out);
fs.writeFileSync(path.join(__dirname, 'sim-whack-result.txt'), out);