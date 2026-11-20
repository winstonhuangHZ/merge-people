/* ============================================================
 *  合成人物 · 完整历史排行榜（Supabase）
 *
 *  Supabase 表公开只读数据，并允许匿名新增成绩；RLS 不允许更新、
 *  删除或读取其他系统表。前端分页读取全表，按分数和时间排序。
 *
 *  安全边界：
 *    · Publishable key 是公开客户端密钥，可以出现在网页中；
 *    · 不要把 sb_secret_* 或旧 service_role key 放进本项目；
 *    · 纯前端无法阻止伪造请求，本榜仅用于娱乐，不作为可信竞技认证。
 * ============================================================ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://zbmwhigxhynjupujipgx.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_XXJFbGVFRvNqUetqy0TkGQ_rAbEL-lB';
  var TABLE_URL = SUPABASE_URL + '/rest/v1/leaderboard_scores';
  var PLAYER_KEY = 'merge-people.player.v1';
  var NAME_KEY = 'merge-people.name.v1';
  var FALLBACK_NAME = '匿名玩家';
  var PAGE_SIZE = 500;       // 小于 Supabase/PostgREST 常用的 1000 行单次上限
  var MAX_PAGES = 200;       // 安全上限：100,000 条历史记录
  var RENDER_STEP = 50;
  var MAX_SCORE = 99999999;
  var SUBMIT_GAP = 3000;

  var els = {};
  var rows = [];
  var rendered = 0;
  var loadedCompletely = true;
  var lastSubmittedId = '';
  var lastSubmittedScore = null;
  var lastSubmitAt = 0;
  var submitting = false;
  var pendingScore = 0;
  var submitAttempted = false;
  var submitted = false;
  var lastFocus = null;

  var ABUSE_WORDS = [
    '傻逼', '煞笔', '傻b', '脑残', '智障', '弱智', '贱人', '贱货', '婊子',
    '畜生', '杂种', '野种', '你妈', '妈的', '他妈', '尼玛', '草泥马',
    '卧槽', '我操', '操你', '去死', '死全家', '狗屎', '加微信', '加qq',
    '刷单', '博彩', '赌博', '洗钱', 'fuck', 'shit', 'bitch', 'asshole',
    'nigger', 'nigga', 'cunt', 'pussy', 'motherfuck'
  ];

  function $(id) { return document.getElementById(id); }

  function normalizeForMatch(raw) {
    return String(raw || '')
      .replace(/[\uff01-\uff5e]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
      })
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  }

  function hasBannedWord(raw) {
    var value = normalizeForMatch(raw);
    if (!value) return false;
    for (var i = 0; i < ABUSE_WORDS.length; i++) {
      var word = normalizeForMatch(ABUSE_WORDS[i]);
      if (word && value.indexOf(word) >= 0) return true;
    }
    return false;
  }

  function cleanName(raw) {
    var value = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return value.length > 12 ? value.slice(0, 12) : value;
  }

  function loadName() {
    try { return cleanName(localStorage.getItem(NAME_KEY) || ''); }
    catch (e) { return ''; }
  }

  function saveName(name) {
    try { localStorage.setItem(NAME_KEY, name); }
    catch (e) { /* 本地存储不可用时只影响下次默认昵称 */ }
  }

  function myName() {
    return loadName();
  }

  function playerId() {
    var id = '';
    try { id = localStorage.getItem(PLAYER_KEY) || ''; }
    catch (e) { /* 使用临时 ID */ }
    if (/^[0-9a-f-]{36}$/i.test(id)) return id;

    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      id = window.crypto.randomUUID();
    } else {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
    try { localStorage.setItem(PLAYER_KEY, id); }
    catch (e) { /* 每次打开使用临时 ID，不影响成绩历史 */ }
    return id;
  }

  function setMsg(text, kind) {
    if (!els.msg) return;
    els.msg.textContent = text || '';
    els.msg.className = 'submit-msg' + (kind ? ' is-' + kind : '');
  }

  function updateSubmitButton() {
    if (!els.submitBtn) return;
    var name = loadName();
    els.submitBtn.disabled = submitting || submitted || pendingScore <= 0 ||
      !name || hasBannedWord(name);
    els.submitBtn.textContent = submitted ? '已提交' :
      (submitAttempted ? '重试提交' : '提交成绩');
  }

  function paintName() {
    var name = loadName();
    if (els.nickInput && document.activeElement !== els.nickInput) {
      els.nickInput.value = name;
    }
    if (els.overNameInput && document.activeElement !== els.overNameInput) {
      els.overNameInput.value = name;
    }
    updateSubmitButton();
  }

  function commitName(raw) {
    var name = cleanName(raw);
    saveName(name);
    if (els.nickInput && document.activeElement !== els.nickInput) {
      els.nickInput.value = name;
    }
    if (els.overNameInput && document.activeElement !== els.overNameInput) {
      els.overNameInput.value = name;
    }
    updateSubmitButton();

    if (!name) {
      if (pendingScore > 0 && !submitted) setMsg('请先输入用户名，再点击提交成绩。', 'bad');
    } else if (hasBannedWord(name)) {
      setMsg('昵称含不适合公开展示的词，本局不会自动上榜。修改昵称后可以重试。', 'bad');
    } else if (pendingScore > 0 && !submitted && !submitting) {
      setMsg('用户名已填写，点击“提交成绩”才会写入排行榜。', '');
    }
    return name;
  }

  function headers(extra) {
    var result = {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY
    };
    Object.keys(extra || {}).forEach(function (key) { result[key] = extra[key]; });
    return result;
  }

  function request(url, options, retry) {
    var opts = options || {};
    opts.headers = headers(opts.headers);
    opts.cache = 'no-store';

    function once() {
      return fetch(url, opts).then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            var detail = '';
            try {
              var parsed = JSON.parse(text);
              detail = parsed.message || parsed.details || parsed.hint || '';
            } catch (e) {
              detail = text.slice(0, 100);
            }
            throw new Error(detail || ('HTTP ' + response.status));
          });
        }
        if (response.status === 204) return null;
        return response.text().then(function (text) {
          if (!text) return null;
          try { return JSON.parse(text); }
          catch (e) { throw new Error('服务器返回了无法解析的数据'); }
        });
      });
    }

    if (!retry) return once();
    return once().catch(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 700); }).then(once);
    });
  }

  function addScore(name, score) {
    var payload = [{
      player_id: playerId(),
      nickname: name,
      score: score
    }];
    return request(TABLE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(payload)
    }, false).then(function (result) {
      var record = Array.isArray(result) ? result[0] : null;
      return {
        id: record && record.id != null ? String(record.id) : '',
        result: result
      };
    });
  }

  function fetchPage(offset) {
    var query = TABLE_URL +
      '?select=id,player_id,nickname,score,created_at' +
      '&order=score.desc,created_at.desc' +
      '&limit=' + PAGE_SIZE +
      '&offset=' + offset;
    return request(query, { method: 'GET' }, true).then(function (result) {
      return Array.isArray(result) ? result : [];
    });
  }

  function searchAll() {
    var all = [];
    var seen = Object.create(null);
    var page = 0;

    function step() {
      if (page >= MAX_PAGES) {
        return { rows: all, complete: false };
      }
      return fetchPage(page * PAGE_SIZE).then(function (result) {
        var added = 0;
        result.forEach(function (record) {
          var key = record && record.id != null ? String(record.id) : '';
          if (key && !seen[key]) {
            seen[key] = true;
            all.push(record);
            added++;
          }
        });
        page++;
        if (result.length < PAGE_SIZE) return { rows: all, complete: true };
        if (!added) return { rows: all, complete: false };
        return step();
      });
    }

    return step();
  }

  function parseRows(records) {
    var result = records.map(function (record) {
      var score = Number(record.score);
      if (!isFinite(score) || score < 0 || score > MAX_SCORE) return null;
      var timestamp = Date.parse(record.created_at || '');
      return {
        tag: String(record.id),
        name: cleanName(record.nickname || '匿名玩家') || '匿名玩家',
        score: Math.floor(score),
        t: isFinite(timestamp) ? timestamp : 0
      };
    }).filter(Boolean);

    result.sort(function (a, b) {
      return (b.score - a.score) || (b.t - a.t) || (b.tag > a.tag ? 1 : -1);
    });
    return result;
  }

  function fetchTop() {
    return searchAll().then(function (found) {
      loadedCompletely = found.complete;
      return parseRows(found.rows);
    });
  }

  function boardMessage(text) {
    if (!els.list) return;
    els.list.textContent = '';
    var p = document.createElement('p');
    p.className = 'board-empty';
    p.textContent = text;
    els.list.appendChild(p);
  }

  function rankClass(index) {
    return index === 0 ? 'r1' : index === 1 ? 'r2' : index === 2 ? 'r3' : '';
  }

  function timeText(timestamp) {
    if (!timestamp) return '早期记录';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (e) {
      return new Date(timestamp).toLocaleString();
    }
  }

  function makeRow(row, index, usedMine) {
    var line = document.createElement('div');
    line.className = 'board-row ' + rankClass(index);

    var rank = document.createElement('span');
    rank.className = 'board-rank';
    rank.textContent = index < 3 ? ['🥇', '🥈', '🥉'][index] : String(index + 1);

    var info = document.createElement('span');
    info.className = 'board-info';

    var name = document.createElement('strong');
    name.className = 'board-name';
    name.textContent = hasBannedWord(row.name) ? FALLBACK_NAME : row.name;

    var time = document.createElement('small');
    time.className = 'board-time';
    time.textContent = timeText(row.t);

    var score = document.createElement('span');
    score.className = 'board-score';
    score.textContent = String(row.score);

    info.appendChild(name);
    info.appendChild(time);
    line.appendChild(rank);
    line.appendChild(info);
    line.appendChild(score);

    var mine = row.tag === lastSubmittedId ||
      (!usedMine && lastSubmittedScore !== null && row.score === lastSubmittedScore);
    if (mine) line.classList.add('is-mine');
    return { element: line, mine: mine };
  }

  function renderMore() {
    if (!els.list || rendered >= rows.length) return;

    if (rendered === 0) els.list.textContent = '';
    var end = Math.min(rows.length, rendered + RENDER_STEP);
    var usedMine = els.list.querySelector && !!els.list.querySelector('.is-mine');

    for (var i = rendered; i < end; i++) {
      var item = makeRow(rows[i], i, usedMine);
      usedMine = usedMine || item.mine;
      els.list.appendChild(item.element);
    }
    rendered = end;

    if (els.more) els.more.hidden = rendered >= rows.length;
    if (els.count) {
      els.count.textContent = '共 ' + rows.length + ' 条历史成绩' +
        (loadedCompletely ? '' : ' · 读取未完整');
    }
  }

  function renderRows(myScore) {
    if (typeof myScore === 'number') lastSubmittedScore = myScore;
    rendered = 0;

    if (!rows.length) {
      boardMessage('还没有历史成绩。玩一局并填写用户名、点击提交后才会上榜。');
      if (els.more) els.more.hidden = true;
      if (els.count) els.count.textContent = '暂无记录';
      return;
    }
    renderMore();
  }

  function refreshBoard(myScore) {
    boardMessage('正在读取全部历史排行榜…');
    if (els.more) els.more.hidden = true;
    if (els.count) els.count.textContent = '读取中…';

    return fetchTop().then(function (result) {
      rows = result;
      renderRows(myScore);
      return result;
    }).catch(function (err) {
      boardMessage('读取失败：' + err.message);
      if (els.count) els.count.textContent = '排行榜暂时不可用';
      throw err;
    });
  }

  function isOpen() {
    return !!(els.modal && els.modal.classList.contains('show'));
  }

  function openBoard() {
    if (!els.modal) return;
    lastFocus = document.activeElement;
    els.modal.classList.add('show');
    els.modal.setAttribute('aria-hidden', 'false');
    refreshBoard(lastSubmittedScore).catch(function () {});
    if (els.close && els.close.focus) els.close.focus();
  }

  function closeBoard() {
    if (!els.modal) return;
    els.modal.classList.remove('show');
    els.modal.setAttribute('aria-hidden', 'true');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function submitScore(name, score, retryMode) {
    name = cleanName(name);
    score = Number(score) || 0;
    if (submitting) return Promise.resolve(false);
    if (!(score > 0) || score > MAX_SCORE) {
      setMsg('分数为 0 或格式异常，不上榜。', 'bad');
      return Promise.resolve(false);
    }
    if (!name) {
      submitAttempted = true;
      setMsg('请先输入用户名，再点击提交成绩。', 'bad');
      updateSubmitButton();
      if (els.overNameInput) els.overNameInput.focus();
      return Promise.resolve(false);
    }
    if (hasBannedWord(name)) {
      submitAttempted = true;
      setMsg('昵称含不适合公开展示的词，本局不会自动上榜。修改昵称后可以重试。', 'bad');
      updateSubmitButton();
      return Promise.resolve(false);
    }

    var now = Date.now();
    if (!retryMode && now - lastSubmitAt < SUBMIT_GAP) {
      setMsg('刚刚提交过，请稍后再试。', 'bad');
      return Promise.resolve(false);
    }

    submitting = true;
    submitAttempted = true;
    setMsg('正在提交历史成绩…', '');
    updateSubmitButton();

    return addScore(name, score).then(function (created) {
      lastSubmittedId = created.id;
      lastSubmittedScore = score;
      lastSubmitAt = Date.now();
      submitted = true;
      pendingScore = 0;
      setMsg('已写入历史排行榜 · ' + name + ' · ' + score + ' 分', 'good');
      if (isOpen()) return refreshBoard(score).then(function () { return true; }, function () { return true; });
      return true;
    }).catch(function (err) {
      setMsg('提交失败：' + err.message, 'bad');
      return false;
    }).then(function (ok) {
      submitting = false;
      updateSubmitButton();
      return ok;
    });
  }

  function retry() {
    if (submitted || pendingScore <= 0) return;
    var name = commitName(els.overNameInput ? els.overNameInput.value : loadName());
    submitScore(name, pendingScore, true);
  }

  function onGameOver(score) {
    pendingScore = Number(score) || 0;
    submitAttempted = false;
    submitted = false;

    if (!(pendingScore > 0)) {
      if (els.submitBox) els.submitBox.hidden = true;
      return;
    }
    if (els.submitBox) els.submitBox.hidden = false;
    paintName();
    if (!loadName()) {
      setMsg('请先输入用户名，再点击提交成绩。本局不会自动写入。', 'bad');
    } else {
      setMsg('确认用户名后，点击“提交成绩”才会写入排行榜。', '');
    }
    updateSubmitButton();
  }

  function bind() {
    els.modal = $('boardModal');
    els.list = $('boardList');
    els.more = $('boardMore');
    els.count = $('boardCount');
    els.close = $('boardClose');
    els.refresh = $('boardRefresh');
    els.msg = $('submitMsg');
    els.submitBox = $('submitBox');
    els.submitBtn = $('submitBtn');
    els.nickInput = $('nickInput');
    els.overNameInput = $('overNameInput');

    ['boardBtn', 'boardBtn2'].forEach(function (id) {
      var button = $(id);
      if (button) button.addEventListener('click', openBoard);
    });
    if (els.close) els.close.addEventListener('click', closeBoard);
    if (els.refresh) els.refresh.addEventListener('click', function () {
      refreshBoard(lastSubmittedScore).catch(function () {});
    });
    if (els.more) els.more.addEventListener('click', renderMore);
    if (els.submitBtn) els.submitBtn.addEventListener('click', retry);
    if (els.modal) {
      els.modal.addEventListener('click', function (e) {
        if (e.target === els.modal) closeBoard();
      });
    }

    if (els.nickInput) {
      els.nickInput.value = loadName();
      var commit = function () { commitName(els.nickInput.value); };
      els.nickInput.addEventListener('input', commit);
      els.nickInput.addEventListener('change', commit);
      els.nickInput.addEventListener('blur', commit);
      els.nickInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          els.nickInput.blur();
        }
      });
    }

    if (els.overNameInput) {
      els.overNameInput.value = loadName();
      els.overNameInput.addEventListener('input', function () {
        commitName(els.overNameInput.value);
      });
      els.overNameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !els.submitBtn.disabled) {
          e.preventDefault();
          retry();
        }
      });
    }

    var editName = $('editNameBtn');
    if (editName) {
      editName.addEventListener('click', function () {
        openBoard();
        if (els.nickInput) {
          setTimeout(function () {
            els.nickInput.focus();
            els.nickInput.select();
          }, 260);
        }
      });
    }

    paintName();
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) closeBoard();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.DanaiwaBoard = {
    open: openBoard,
    close: closeBoard,
    refresh: refreshBoard,
    onGameOver: onGameOver,
    fetchTop: fetchTop,
    submitScore: addScore,
    myName: myName,
    setName: commitName,
    hasName: function () { return !!loadName(); },
    isOpen: isOpen
  };
})();
