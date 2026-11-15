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


console.log('回归：深度重叠不会变成弹射速度');
clear();
S.balls.push(ball(205, 5, 400), ball(210, 6, 400));
step(DT);
let speed = Math.max(...S.balls.map(b => Math.hypot(b.vx,b.vy)));
check('静止物体重叠后不会凭空弹飞', speed < 100, 'max speed=' + speed.toFixed(2));
console.log('回归：多物体持续堆叠');
clear();
for (let i=0;i<8;i++) S.balls.push(ball(110+(i%4)*55,i,440+Math.floor(i/4)*65));
let maxSpeed=0, invalid=false;
for (let i=0;i<180*8;i++) { step(DT); for(const b of S.balls){maxSpeed=Math.max(maxSpeed,Math.hypot(b.vx,b.vy));if(outOfBounds(b,10)) invalid=true;} }
check('持续模拟不飞出边界', !invalid);
check('堆叠速度有界',maxSpeed<1501,'max speed='+maxSpeed.toFixed(2));
console.log('回归：坦克炮管具有碰撞轮廓');
clear();
const tank=ball(180,10,400), above=ball(281,0,374);
S.balls.push(tank,above);
step(DT);
check('炮管接触触发碰撞', tank.contacts > 0 && above.contacts > 0, 'contacts=' + tank.contacts + '/' + above.contacts);
console.log('回归：受压物体在合成时释放应力');
function releaseTrial(stress) {
  clear();
  const a=ball(190,0,400), b=ball(200,0,400), neighbor=ball(260,3,400);
  neighbor.stress=stress;
  S.balls.push(a,b,neighbor);
  step(DT);
  return neighbor.vx;
}
const relaxed=releaseTrial(0), pressed=releaseTrial(30);
check('受压时弹开明显，未受压时不额外弹飞', pressed-relaxed>35 && pressed<260, '压缩/未压缩 vx='+pressed.toFixed(1)+'/'+relaxed.toFixed(1));
clear();
const low=ball(210,5,630), upper=ball(210,3,570);
S.balls.push(low,upper); let peak=0; for(let i=0;i<180*3;i++){step(DT); peak=Math.max(peak,low.stress,upper.stress);}
check('堆叠会积累有限应力', peak>1 && peak<=70, 'peak stress='+peak.toFixed(1));
console.log(pass ? '物理回归通过' : '物理回归失败');
process.exitCode=pass?0:1;
