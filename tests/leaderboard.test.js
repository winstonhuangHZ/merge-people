/* ============================================================
 *  Supabase 完整历史排行榜自检
 *  运行：node tests/leaderboard.test.js
 *
 *  覆盖：
 *    · REST 分页读取全部历史，不截断到最近 20 条
 *    · 所有记录按分数、时间降序排列
 *    · 每次展示 50 条，可继续展开
 *    · 指定昵称、分数、玩家 ID 新增成绩
 *    · 屏蔽昵称不写库，改好后能够重试
 *    · 客户端没有 UPDATE/DELETE 请求
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');

function makeEl(id, tag) {
  const classes = new Set();
  const el = {
    id: id,
    tagName: String(tag || 'div').toUpperCase(),
    hidden: false,
    value: '',
    className: '',
    style: {},
    children: [],
    _text: '',
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener(type, fn) { (el._handlers || (el._handlers = {}))[type] = fn; },
    setAttribute(name, value) { (el._attrs || (el._attrs = {}))[name] = String(value); },
    getAttribute(name) { return (el._attrs && el._attrs[name]) || null; },
    focus() { document.activeElement = el; },
    blur() { if (document.activeElement === el) document.activeElement = null; },
    select() {},
    querySelector(selector) {
      if (selector !== '.is-mine') return null;
      return el.children.find(function (child) {
        return child.classList && child.classList.contains('is-mine');
      }) || null;
    },
    click() {
      if (el._handlers && el._handlers.click) el._handlers.click({ target: el });
    }
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(value) {
      el._text = String(value);
      if (String(value) === '') el.children.length = 0;
    }
  });
  return el;
}

const els = {};
[
  'boardBtn', 'boardBtn2', 'boardModal', 'boardClose', 'boardRefresh',
  'boardList', 'boardMore', 'boardCount', 'nickInput', 'submitBox',
  'submitMsg', 'myNameLabel', 'submitBtn', 'editNameBtn'
].forEach(function (id) { els[id] = makeEl(id); });

const document = {
  readyState: 'complete',
  activeElement: null,
  getElementById(id) { return els[id] || null; },
  createElement(tag) { return makeEl('', tag); },
  addEventListener() {}
};

const windowListeners = {};
const windowObject = {
  crypto: { randomUUID() { return '11111111-1111-4111-8111-111111111111'; } },
  addEventListener(type, fn) { windowListeners[type] = fn; }
};

const records = [];
const calls = [];
const T0 = Date.parse('2026-11-01T00:00:00Z');
let nextId = 1;

function seed(nickname, score, i) {
  records.push({
    id: nextId++,
    player_id: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
    nickname: nickname,
    score: score,
    created_at: new Date(T0 + i * 1000).toISOString()
  });
}

function response(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    text() { return Promise.resolve(body == null ? '' : JSON.stringify(body)); }
  });
}

function fakeFetch(url, options) {
  const target = new URL(String(url));
  const method = (options && options.method) || 'GET';
  calls.push({ method: method, url: target, options: options });

  if (method === 'POST') {
    const body = JSON.parse(options.body);
    const created = body.map(function (item) {
      const row = {
        id: nextId++,
        player_id: item.player_id,
        nickname: item.nickname,
        score: item.score,
        created_at: new Date(T0 + nextId * 1000).toISOString()
      };
      records.push(row);
      return row;
    });
    return response(201, created);
  }

  if (method === 'GET') {
    const offset = Number(target.searchParams.get('offset') || 0);
    const limit = Number(target.searchParams.get('limit') || 1000);
    const sorted = records.slice().sort(function (a, b) {
      return (b.score - a.score) ||
        (Date.parse(b.created_at) - Date.parse(a.created_at)) ||
        (b.id - a.id);
    });
    return response(200, sorted.slice(offset, offset + limit));
  }

  return response(405, { message: 'method not allowed' });
}

for (let i = 0; i < 1235; i++) seed('玩家' + i, i, i);

const memory = {};
const sandbox = {
  window: windowObject,
  document: document,
  localStorage: {
    getItem(key) { return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null; },
    setItem(key, value) { memory[key] = String(value); }
  },
  fetch: fakeFetch,
  URL: URL,
  URLSearchParams: URLSearchParams,
  Intl: Intl,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  console: console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(root, 'leaderboard.js'), 'utf8'),
  sandbox,
  { filename: 'leaderboard.js' }
);

const Board = sandbox.window.DanaiwaBoard;
let pass = 0;
let fail = 0;

function ok(condition, label, extra) {
  if (condition) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + (extra ? '  → ' + extra : ''));
  }
}

(async function main() {
  console.log('Supabase 完整历史排行榜自检\n');

  console.log('[1] 分页读取全部历史');
  const all = await Board.fetchTop();
  ok(all.length === 1235, '读取全部 1235 条，不截断到最近 20 条', '实际 ' + all.length);
  ok(all[0].score === 1234 && all[1234].score === 0, '最高分与最低分都在结果中');
  ok(all.every(function (row, index) {
    return index === 0 || all[index - 1].score >= row.score;
  }), '所有记录按分数从高到低排序');
  const gets = calls.filter(function (call) { return call.method === 'GET'; });
  ok(gets.length === 3, '每页 500 条，1235 条记录分 3 页读取', '实际 ' + gets.length);
  ok(calls.every(function (call) { return call.method === 'GET'; }),
    '读取阶段只有 GET，没有修改或删除');

  console.log('\n[2] 分批展示全部历史');
  calls.length = 0;
  await Board.refresh(null);
  ok(els.boardList.children.length === 50, '首次渲染 50 条');
  ok(els.boardMore.hidden === false, '还有更多时显示展开按钮');
  ok(els.boardCount.textContent.indexOf('1235') >= 0, '显示历史记录总数');

  for (let i = 0; i < 30 && !els.boardMore.hidden; i++) els.boardMore.click();
  ok(els.boardList.children.length === 1235, '继续展开后能看到全部 1235 条');
  ok(els.boardMore.hidden === true, '全部展示后隐藏展开按钮');

  console.log('\n[3] 弹窗开关与游戏暂停状态');
  Board.open();
  ok(Board.isOpen() === true, 'open() 打开排行榜');
  ok(els.boardModal.getAttribute('aria-hidden') === 'false', '更新 aria-hidden');
  Board.close();
  ok(Board.isOpen() === false, 'close() 关闭排行榜');

  console.log('\n[4] 昵称过滤与重试');
  Board.setName('傻逼玩家');
  calls.length = 0;
  Board.onGameOver(4321);
  await new Promise(function (resolve) { setTimeout(resolve, 30); });
  ok(calls.filter(function (call) { return call.method === 'POST'; }).length === 0,
    '屏蔽昵称没有写入 Supabase');
  ok(els.submitBtn.hidden === false, '显示重试提交按钮');

  Board.setName('正常玩家');
  calls.length = 0;
  if (els.submitBtn._handlers && els.submitBtn._handlers.click) {
    els.submitBtn._handlers.click();
  }
  await new Promise(function (resolve) { setTimeout(resolve, 30); });
  const posts = calls.filter(function (call) { return call.method === 'POST'; });
  ok(posts.length === 1, '改好昵称后补提交一次');
  if (posts.length) {
    const body = JSON.parse(posts[0].options.body)[0];
    ok(body.nickname === '正常玩家' && Number(body.score) === 4321,
      '提交保留昵称和本局分数');
    ok(/^[0-9a-f-]{36}$/i.test(body.player_id), '提交包含稳定的匿名玩家 ID');
    ok(Object.keys(body).sort().join(',') === 'nickname,player_id,score',
      '客户端不能伪造服务器时间或记录 ID');
  }
  ok(calls.every(function (call) {
    return call.method === 'GET' || call.method === 'POST';
  }), '没有 UPDATE、PATCH 或 DELETE 请求');

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
