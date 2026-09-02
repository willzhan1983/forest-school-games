/* ============================================================
 * 拼图计分曲线 Monte Carlo 验证
 * 规则复刻自 src/g-puzzle.html：
 *   基础分 base（p33=900 / p43=1200 / p44=1500）
 *   罚分 pen（10/12/14）每多一步
 *   最低保底 50 分
 *   shuffleOrder 强制 minSwaps >= 4（最多重洗 20 次）
 *   计分公式：score = max(50, base - (moves - minSwaps) * pen)
 *
 * 体检后规则：
 *   - 完美玩法恰好拿 base（无满分开天窗）
 *   - 没有时间罚（用时只作为结算页 extra 展示）
 *
 * 模拟设计：
 *   用 player 模型的「多走多少倍 minSwaps」衡量水平：
 *     完美 = 1.0x minSwaps（最少步数）
 *     良好 = 1.5x minSwaps
 *     普通 = 2.5x minSwaps
 *   每档 400 局（每局重新洗牌），看：
 *     - 完美玩家三档都得满分 base
 *     - 三档得分同玩家水平也单调递增（base 跨度 900→1500）
 *     - 区分度合理（普通-完美应该拉开明显）
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const TRIALS = 400;
const PUZZLES = [
  { id:'p33', cols:3, rows:3, base:900,  pen:14 },
  { id:'p43', cols:4, rows:3, base:1200, pen:12 },
  { id:'p44', cols:4, rows:4, base:1500, pen:10 }
];
const SKILLS = [
  { name:'完美', mult:1.00 },   /* 恰好 minSwaps 步（理论最优） */
  { name:'良好', mult:1.50 },
  { name:'普通', mult:2.50 }
];

function minSwapsOf(perm){
  const seen = new Array(perm.length);
  let sw = 0;
  for(let i = 0; i < perm.length; i++){
    if(seen[i] || perm[i] === i){ seen[i] = true; continue; }
    let j = i, cyc = 0;
    while(!seen[j]){ seen[j] = true; j = perm[j]; cyc++; }
    sw += cyc - 1;
  }
  return sw;
}
function shuffleOrder(n){
  for(let t = 0; t < 20; t++){
    const a = []; for(let i = 0; i < n; i++) a[i] = i;
    for(let k = n - 1; k > 0; k--){
      const j = Math.floor(Math.random() * (k + 1));
      const tmp = a[k]; a[k] = a[j]; a[j] = tmp;
    }
    let isId = true;
    for(let p = 0; p < n; p++) if(a[p] !== p){ isId = false; break; }
    if(isId) continue;
    const ms = minSwapsOf(a);
    if(ms >= 4) return a;
  }
  return null;
}

function simulateOne(skill, puzCfg, seed){
  let rng = seed;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  /* 洗牌 */
  let order = null, ms = 0;
  for(let t = 0; t < 20 && !order; t++){
    const n = puzCfg.cols * puzCfg.rows;
    const a = []; for(let i = 0; i < n; i++) a[i] = i;
    for(let k = n - 1; k > 0; k--){
      const j = Math.floor(rnd() * (k + 1));
      const tmp = a[k]; a[k] = a[j]; a[j] = tmp;
    }
    let isId = true;
    for(let p = 0; p < n; p++) if(a[p] !== p){ isId = false; break; }
    if(isId) continue;
    ms = minSwapsOf(a);
    if(ms < 4) continue;
    order = a;
  }
  /* 玩家步数 = round(minSwaps * mult) —— 加少量噪声避免整数过齐 */
  const moves = Math.max(ms, Math.round(ms * skill.mult * (0.9 + rnd() * 0.2)));
  const penalty = Math.max(0, moves - ms) * puzCfg.pen;
  const score = Math.max(50, puzCfg.base - penalty);
  return {score, moves, minSwaps:ms};
}

function med(arr){ const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length * 0.5)]; }
function pct(arr, p){ const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length * p)]; }

function run(){
  const R = {};
  for(const sk of SKILLS){
    R[sk.name] = {};
    for(const puz of PUZZLES){
      const scores = [], stats = [];
      for(let t = 0; t < TRIALS; t++){
        const r = simulateOne(sk, puz, 1000 + t * 31 + puz.id.charCodeAt(1));
        scores.push(r.score); stats.push(r);
      }
      R[sk.name][puz.id] = {med:med(scores), p10:pct(scores,0.1), p90:pct(scores,0.9),
        avgMoves:stats.reduce((s,r)=>s+r.moves,0)/TRIALS,
        avgMin:stats.reduce((s,r)=>s+r.minSwaps,0)/TRIALS};
    }
  }
  return R;
}

const R = run();
let out = '拼图 Monte Carlo（每档 ' + TRIALS + ' 局）\n';
out += '=================================================\n';
out += '玩家模型：完美=minSwaps*1.0 / 良好=minSwaps*1.5 / 普通=minSwaps*2.5\n';
out += '关键约束：完美玩家三档都得满分 base（900/1200/1500）\n';
out += '         同水平玩家三档得分应单调递增（base 跨度大）\n\n';
out += '玩法\t尺寸\t基分\t中位\tP10\tP90\t均步数\t均最少\n';
for(const sk of SKILLS){
  for(const puz of PUZZLES){
    const r = R[sk.name][puz.id];
    out += sk.name + '\t' + puz.id + '\t' + puz.base + '\t' + r.med + '\t' + r.p10 + '\t' + r.p90 +
           '\t' + r.avgMoves.toFixed(1) + '\t' + r.avgMin.toFixed(1) + '\n';
  }
  out += '\n';
}
out += '\n========= 自检 =========\n';
let pass = true;
/* 完美玩家三档都得满分 */
for(const puz of PUZZLES){
  const m = R['完美'][puz.id].med;
  const ok = m === puz.base;
  out += (ok?'✅':'❌') + ' 完美玩家 ' + puz.id + ' 中位=' + m + '（应=' + puz.base + ' 满分可达）\n';
  if(!ok) pass = false;
}
/* 三档单调 */
for(const sk of SKILLS){
  const e = R[sk.name]['p33'].med;
  const n = R[sk.name]['p43'].med;
  const h = R[sk.name]['p44'].med;
  const ok = e < n && n < h;
  out += (ok?'✅':'❌') + ' ' + sk.name + ' 单调：p33=' + e + ' p43=' + n + ' p44=' + h + '\n';
  if(!ok) pass = false;
}
/* 区分度：完美玩家 ≥ 普通玩家（计分公式是 base - 罚分，完美 = base，普通 > 0 罚分 → 更低） */
const spreadP33 = R['完美']['p33'].med - R['普通']['p33'].med;
const spreadP44 = R['完美']['p44'].med - R['普通']['p44'].med;
out += '区分度 p33：完美(' + R['完美']['p33'].med + ') - 普通(' + R['普通']['p33'].med + ') = ' + spreadP33 + '\n';
out += '区分度 p44：完美(' + R['完美']['p44'].med + ') - 普通(' + R['普通']['p44'].med + ') = ' + spreadP44 + '（应 ≥ 100）\n';
if(spreadP44 < 100) pass = false;

out += '\n结论：' + (pass ? '✅ 完美玩法能拿满分，三档单调，区分度合理' : '❌ 见上') + '\n';
console.log(out);
fs.writeFileSync(path.join(__dirname, 'sim-puzzle-result.txt'), out);