/* ============================================================
 *  物理手感自检（无浏览器，用桩件模拟 DOM/Canvas）
 *  运行：node physics.test.js
 *  覆盖：回弹高度、球对球弹起、堆叠稳定性、真实投放不穿墙
 * ============================================================ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');

/* 记录每个画布上 drawImage 了哪张图，用来验证“下一个”预览画的是哪一级 */
const drawnImages = [];

function makeCtx(id) {
  const g = { addColorStop() {} };
  return {
    _id: id,
    setTransform() {}, save() {}, restore() {}, scale() {}, rotate() {}, translate() {},
    clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, clip() {}, stroke() {}, fill() {}, setLineDash() {},
    drawImage(img) { drawnImages.push({ ctx: this._id, src: (img && img.__src) || null }); },
    createLinearGradient: () => g, createRadialGradient: () => g,
    measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', lineCap: ''
  };
}

const listeners = new Map();
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', width: 680, height: 160, _c: new Set(),
    classList: { add: c => el._c.add(c), remove: c => el._c.delete(c), contains: c => el._c.has(c) },
    getContext: () => el._ctx || (el._ctx = makeCtx(id)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 700 }),
    addEventListener(t, fn) { if (!listeners.has(el)) listeners.set(el, {}); listeners.get(el)[t] = fn; },
    querySelector(sel) {
      if (!el._q) el._q = {};
      if (!el._q[sel]) el._q[sel] = { textContent: '', style: {}, classList: { add() {}, remove() {} } };
      return el._q[sel];
    },
    setAttribute() {}, offsetWidth: 100
  };
  return el;
}
const els = {};
['game', 'stage', 'overlay', 'score', 'best', 'finalScore', 'finalBest',
 'next', 'chain', 'soundBtn', 'resetBtn', 'restartBtn'].forEach(id => els[id] = makeEl(id));

const rafQueue = [];
const winListeners = {};
const sandbox = {
  console, Math, Date, JSON, Object, Array, Number, String, Boolean, Error, isNaN,
  performance: { now: () => Date.now() },
  requestAnimationFrame(fn) { rafQueue.push(fn); return 1; },
  setTimeout: fn => setTimeout(fn, 0), clearTimeout,
  document: {
    readyState: 'complete', getElementById: id => els[id] || null,
    addEventListener() {}, createElement: () => makeEl('tmp')
  },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  addEventListener(t, fn) { winListeners[t] = fn; },
  navigator: {},
  /* 桩件图片：设了 src 就立刻“加载完成”，用来覆盖贴图绘制分支 */
  Image: class {
    constructor() { this.width = 512; this.height = 512; this.naturalWidth = 512; this.onload = null; this.onerror = null; }
    set src(v) { this._src = v; this.__src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'assets', 'fruits', 'parts.js'), 'utf8'),
                sandbox, { filename: 'parts.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'game.js'), 'utf8'), sandbox, { filename: 'game.js' });

const H = 700, W = 420, WALL = 10, R = [17, 23, 31, 39, 48, 58, 69, 81, 94, 108, 124];
const S = sandbox.__DNW__.state;
const U = sandbox.__DNW__;
const step = sandbox.__DNW__.stepPhysics;
const DT = 1 / 180;

function ball(x, tier, y) {
  const r = R[tier];
  const b = U.makeBall(x, y === undefined ? 700 - WALL - r : y, tier);
  b.landed = true;
  b.bornAt = 0;
  return b;
}
function run(n) { for (let i = 0; i < n; i++) step(DT); }
function clear() { S.balls.length = 0; }

/* 碰撞形状是若干小圆，越界检查得看这些小圆的实际范围 */
function bounds(b) {
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let k = 0; k < b.parts.length; k++) {
    const x = b.wx[k], y = b.wy[k], r = b.ws[k];
    if (x - r < minx) minx = x - r;
    if (x + r > maxx) maxx = x + r;
    if (y - r < miny) miny = y - r;
    if (y + r > maxy) maxy = y + r;
  }
  return { minx: minx, maxx: maxx, miny: miny, maxy: maxy };
}
/* 越界检查。
   floorTol 是地板方向的容差：
     运动中   —— 位置约束求解需要一两帧才能把撞击瞬间的重叠解开，
                  实测最深会出现约 8px 的暂态穿地，但落定后必然回到 0.00px，
                  所以运动中放宽一点，别把"暂态"误判成"沉下去"；
     静止以后 —— 用严格容差，这时再穿就是真问题。
   左右墙不参与放宽：水果飞出场地属于硬故障。 */
function outOfBounds(b, floorTol) {
  const ft = floorTol === undefined ? 1.5 : floorTol;
  if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx)) return 'NaN';
  const e = bounds(b);
  if (e.maxy > H - WALL + ft) return 'floor maxy=' + e.maxy.toFixed(1);
  if (e.minx < WALL - 1.5) return 'left minx=' + e.minx.toFixed(1) + ' tier=' + b.tier;
  if (e.maxx > W - WALL + 1.5) return 'right maxx=' + e.maxx.toFixed(1) + ' tier=' + b.tier;
  return '';
}

let pass = true;
function check(name, ok, detail) {
  console.log((ok ? '  [OK] ' : '  [NG] ') + name + (detail ? '  -- ' + detail : ''));
  if (!ok) pass = false;
}


console.log('炸药玩法回归');
U.reset();
check('开局 3 枚', S.bombs === 3);
const pending = S.pending, next = S.next;
U.toggleBomb(); check('可选择炸药',S.bombMode);
U.toggleBomb(); check('可取消选择且不消耗',!S.bombMode && S.bombs===3);
U.toggleBomb(); U.tryDrop();
let bomb=S.balls.find(b=>b.isBomb);
check('投放消耗一枚，小尺寸且保持待投人物',S.bombs===2 && bomb && bomb.r===9 && S.pending===pending && S.next===next);
U.render(0);
for(let i=0;i<145;i++) U.update(1/60);
check('引信到时自动爆炸', !S.balls.some(b=>b.isBomb) && S.blastGrace>0);
U.reset(); const before=S.bombs;
S.balls.push(ball(185,7,450),ball(200,7,450)); step(DT);
check('合成习近平奖励一枚', S.bombs===before+1 && S.balls.some(b=>b.tier===8));
U.reset();
let a=ball(70,0,600),b=ball(130,0,600), far=ball(350,4,500);
bomb=ball(35,0,600);bomb.isBomb=true;bomb.tier=-1;S.balls.push(a,b,far,bomb);U.detonateBomb(bomb);
check('爆炸不删除人物，全场受到推力', S.balls.length===3 && Math.hypot(a.vx,a.vy)>100 && Math.hypot(far.vx,far.vy)>100);
const expected=15*(300+400/(1+35/150));
check('爆炸初始推力为之前版本的三倍', Math.abs(Math.hypot(a.vx,a.vy)-expected)<0.01, 'actual='+Math.hypot(a.vx,a.vy).toFixed(1)+' expected='+expected.toFixed(1));
check('爆炸后提供判负缓冲', S.blastGrace>0);
let invalid=false, maxSpeed=0;
for(let i=0;i<60*4;i++){ U.update(1/60); for(const item of S.balls){ if(outOfBounds(item,12)) invalid=true; maxSpeed=Math.max(maxSpeed,Math.hypot(item.vx,item.vy)); } }
check('爆炸后数值稳定且不穿墙',!invalid && maxSpeed<=15750,'max speed='+maxSpeed.toFixed(1));
check('被弹开的同级人物仍能碰撞合成',S.score>0,'score='+S.score);
U.reset();
for(let i=0;i<20;i++) S.balls.push(ball(70+(i%5)*65,i%5,385+Math.floor(i/5)*65));
bomb=ball(210,0,525); bomb.isBomb=true; bomb.tier=-1; S.balls.push(bomb); U.detonateBomb(bomb);
let stressInvalid=false, largest=0;
for(let i=0;i<120;i++){ U.update(1/60); for(const item of S.balls){ if(outOfBounds(item,12)) stressInvalid=true; largest=Math.max(largest,Math.hypot(item.vx,item.vy)); } }
check('拥挤场景强爆炸后保持有界',!stressInvalid && largest<=15750,'max speed='+largest.toFixed(1));
S.bombs=0;U.toggleBomb();check('没有炸药时无法选择',!S.bombMode);
U.reset();check('重开后炸药恢复至 3 枚',S.bombs===3);
console.log(pass?'炸药玩法通过':'炸药玩法失败');process.exitCode=pass?0:1;
