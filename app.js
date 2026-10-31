(function () {
  // ===== 設定：公開用デプロイ D2 の URL（デプロイ作成後にここだけ書き換える）=====
  var API_URL = 'https://script.google.com/macros/s/AKfycbxaZL4J78ABNFNyrMk4IQmAOumAXy4Y4HDBB9XCggUqO4-40m2N6XVF3xru__t5q_PM/exec';
  // =================================================================================
  var POLL_MS = 60 * 1000;
  var RELOAD_MS = 30 * 60 * 1000;
  var TIMEOUT_MS = 20 * 1000;
  var TOKEN_KEY = 'hb.token';
  var COOKIE_NAME = 'hb_token';

  var lastVersion = '';
  var currentId = '';
  var lastSuccess = Date.now();
  var timer = null;
  var busy = false;
  var loaded = false;
  var token = '';
  var $ = function (id) { return document.getElementById(id); };
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(d) { return d.getHours() + ':' + pad(d.getMinutes()); }

  // ---- トークン保存（localStorage → Cookie）----
  function readCookie() {
    var m = ('; ' + document.cookie).split('; ' + COOKIE_NAME + '=');
    return m.length === 2 ? m[1].split(';')[0] : '';
  }
  function loadToken() {
    var t = '';
    try { t = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { t = ''; }
    if (!t) { try { t = readCookie(); } catch (e2) { t = ''; } }
    return /^[0-9a-f]{64}$/.test(t) ? t : '';
  }
  function saveToken(t) {
    try {
      localStorage.setItem(TOKEN_KEY, t);
      if (localStorage.getItem(TOKEN_KEY) === t) return true;
    } catch (e) { /* Cookie へ */ }
    try {
      document.cookie = COOKIE_NAME + '=' + t + '; Max-Age=34560000; Path=/home-board/; Secure; SameSite=Strict';
      return readCookie() === t;
    } catch (e2) { return false; }
  }

  // ---- API（常に resolve する。{ok, data} か {ok:false, error}）----
  function api(body) {
    return new Promise(function (resolve) {
      var ctl = new AbortController();
      var done = false;
      var to = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
      function fin(r) { if (done) return; done = true; clearTimeout(to); resolve(r); }
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        signal: ctl.signal
      }).then(function (res) {
        return res.text();
      }).then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (e) { j = null; }
        if (j && j.ok === true) fin({ ok: true, data: j.data });
        else if (j && j.ok === false && typeof j.error === 'string') fin({ ok: false, error: j.error, retryAfterSec: typeof j.retryAfterSec === 'number' ? j.retryAfterSec : 0 });
        else fin({ ok: false, error: 'server_error', reason: 'サーバーのこたえが変' });
      }, function (e) {
        fin({ ok: false, error: 'server_error', reason: (e && e.name === 'AbortError') ? '時間切れ' : '通信できません' });
      });
    });
  }

  // ---- 予定の手動更新（サーバー側で5分に1回。残り秒数はサーバーの値を使う）----
  var calUntil = 0;
  function calWaitMin() { return Math.max(0, Math.ceil((calUntil - Date.now()) / 60000)); }
  function drawCalBtn() {
    var min = calWaitMin();
    $('calBtn').disabled = min > 0;
    $('calBtn').textContent = min > 0 ? 'あと' + min + '分' : '更新';
  }
  function setCalWait(sec) { calUntil = sec > 0 ? Date.now() + sec * 1000 : 0; drawCalBtn(); }

  function tickClock() {
    drawCalBtn();
    var d = new Date();
    $('clock').innerHTML = (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')<span>' + hhmm(d) + '</span>';
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show';
    setTimeout(function () { t.className = ''; }, 2500);
  }

  // 長い文は枠に収まるまで文字を小さくし、最小サイズでも収まらなければスクロールにする
  function fitText() {
    var el = $('text');
    var vh = window.innerHeight / 100;
    var size = 5 * vh, min = 2.6 * vh;
    el.className = '';
    el.style.fontSize = size + 'px';
    while (el.scrollHeight > el.clientHeight + 1 && size > min) {
      size = Math.max(min, size - 0.3 * vh);
      el.style.fontSize = size + 'px';
    }
    if (el.scrollHeight > el.clientHeight + 1) el.className = 'scroll';
  }

  function weekRow(day) {
    var row = document.createElement('div');
    row.className = 'wd' + (day.isToday ? ' today' : '') + (day.isPast ? ' past' : '') +
      (day.dow === '土' ? ' sat' : '') + (day.dow === '日' ? ' sun' : '');
    var head = document.createElement('div');
    head.className = 'wd-head';
    var dt = document.createElement('span');
    dt.className = 'wd-date';
    dt.textContent = day.md + '(' + day.dow + ')';
    head.appendChild(dt);
    if (day.holiday) {
      var hol = document.createElement('span');
      hol.className = 'hol';
      hol.textContent = day.holiday;
      head.appendChild(hol);
    }
    var box = document.createElement('div');
    box.className = 'wd-items';
    row.appendChild(head);
    row.appendChild(box);
    row._day = day;
    row._box = box;
    return row;
  }

  function fillWeekItems(row, shown) {
    var items = row._day.items, box = row._box;
    box.innerHTML = '';
    for (var i = 0; i < shown; i++) {
      var it = items[i];
      var line = document.createElement('div');
      line.className = 'wd-item';
      if (it.allDay) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '終日';
        line.appendChild(tag);
      } else {
        var tm = document.createElement('span');
        tm.className = 'tm';
        tm.textContent = it.time;
        line.appendChild(tm);
      }
      var tt = document.createElement('span');
      tt.className = 'tt';
      tt.textContent = it.title;
      line.appendChild(tt);
      if (i === shown - 1 && shown < items.length) {
        var more = document.createElement('span');
        more.className = 'wd-more';
        more.textContent = 'ほか' + (items.length - shown) + '件';
        line.appendChild(more);
      }
      box.appendChild(line);
    }
  }

  // 枠に収まらない分は「ほかN件」にまとめる
  function fitWeek() {
    var rows = $('weekList').children;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (!row._day) continue;
      var shown = row._day.items.length;
      fillWeekItems(row, shown);
      while (shown > 1 && row._box.scrollHeight > row._box.clientHeight + 1) {
        shown--;
        fillWeekItems(row, shown);
      }
    }
  }

  // 予定の拡大表示（一覧をタップ）。全件を省略なしで大きく出す
  var weekEvents = null;
  var weekModalTimer = null;
  var WEEK_MODAL_MS = 60 * 1000;

  function weekModalOpen() { return !$('weekModal').hidden; }
  function closeWeekModal() {
    if (weekModalTimer) { clearTimeout(weekModalTimer); weekModalTimer = null; }
    $('weekModal').hidden = true;
    $('weekBody').textContent = '';
  }
  function armWeekModalTimer() {
    if (weekModalTimer) clearTimeout(weekModalTimer);
    weekModalTimer = setTimeout(closeWeekModal, WEEK_MODAL_MS);
  }
  function drawWeekModal() {
    var body = $('weekBody');
    body.textContent = '';
    var days = weekEvents.days;
    for (var i = 0; i < days.length; i++) {
      var day = days[i];
      var row = document.createElement('div');
      row.className = 'wm-day' + (day.isToday ? ' today' : '') + (day.isPast ? ' past' : '') +
        (day.dow === '土' ? ' sat' : '') + (day.dow === '日' ? ' sun' : '');
      var head = document.createElement('div');
      head.className = 'wm-head-day';
      var dt = document.createElement('div');
      dt.className = 'wm-date';
      dt.textContent = day.md + '(' + day.dow + ')';
      head.appendChild(dt);
      if (day.holiday) {
        var hol = document.createElement('div');
        hol.className = 'hol';
        hol.textContent = day.holiday;
        head.appendChild(hol);
      }
      var box = document.createElement('div');
      box.className = 'wm-items';
      var items = day.items || [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var line = document.createElement('div');
        line.className = 'wm-item';
        var lead = document.createElement('span');
        if (it.allDay) { lead.className = 'tag'; lead.textContent = '終日'; }
        else { lead.className = 'tm'; lead.textContent = it.time; }
        var tt = document.createElement('span');
        tt.className = 'tt';
        tt.textContent = it.title;
        line.appendChild(lead);
        line.appendChild(tt);
        box.appendChild(line);
      }
      if (!items.length) {
        var none = document.createElement('div');
        none.className = 'wm-none';
        none.textContent = 'よていなし';
        box.appendChild(none);
      }
      row.appendChild(head);
      row.appendChild(box);
      body.appendChild(row);
    }
  }
  function openWeekModal() {
    if (!weekEvents) return;
    drawWeekModal();
    $('weekModal').hidden = false;
    $('weekBody').scrollTop = 0;
    armWeekModalTimer();
  }
  $('weekList').addEventListener('click', openWeekModal);
  $('weekClose').addEventListener('click', closeWeekModal);
  $('weekModal').addEventListener('click', function (e) { if (e.target === $('weekModal')) closeWeekModal(); });
  ['pointerdown', 'touchstart', 'click', 'scroll', 'keydown'].forEach(function (ev) {
    $('weekModal').addEventListener(ev, function () { if (weekModalOpen()) armWeekModalTimer(); }, true);
  });

  function renderWeek(events) {
    var list = $('weekList');
    if (!events || !events.days) {
      weekEvents = null;
      closeWeekModal();
      list.innerHTML = '<div class="soon">準備中</div>';
      return;
    }
    weekEvents = events;
    list.innerHTML = '';
    for (var i = 0; i < events.days.length; i++) list.appendChild(weekRow(events.days[i]));
    fitWeek();
    if (weekModalOpen()) drawWeekModal();
  }

  function wxEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function wxDay(d, src) {
    var box = wxEl('div', 'wx-day' + (d.umbrella ? ' umb' : ''));
    var top = wxEl('div', 'wx-top');
    top.appendChild(wxEl('span', 'wx-label', d.label));
    top.appendChild(wxEl('span', 'wx-icon', d.icon || ''));
    var temp = wxEl('span', 'wx-temp');
    temp.appendChild(wxEl('span', 'wx-max', d.max));
    temp.appendChild(document.createTextNode('/'));
    temp.appendChild(wxEl('span', 'wx-min', d.min));
    top.appendChild(temp);
    box.appendChild(top);
    box.appendChild(wxEl('div', 'wx-tel', d.telop));
    var pops = wxEl('div', 'wx-pops');
    if (src === 'jma') {
      for (var i = 0; i < d.pops.length; i++) {
        var c = wxEl('span', '', d.pops[i].slot + ' ');
        c.appendChild(wxEl('b', '', d.pops[i].value + (d.pops[i].value === '−' ? '' : '%')));
        pops.appendChild(c);
      }
    } else {
      var one = wxEl('span', '', '降水確率（最大） ');
      one.appendChild(wxEl('b', '', d.popMax + (d.popMax === '−' ? '' : '%')));
      pops.appendChild(one);
    }
    box.appendChild(pops);
    if (d.umbrella) box.appendChild(wxEl('div', 'wx-umb', '☂ 傘を持っていこう'));
    return box;
  }

  function renderWeather(w) {
    var body = $('wxBody');
    var h2 = $('wx').firstChild;
    h2.innerHTML = '天気';
    if (!w || !w.days || !w.days.length) {
      body.innerHTML = '<div class="soon">準備中</div>';
      return;
    }
    if (w.source === 'jma') {
      h2.appendChild(wxEl('span', 'wx-src', '出典：気象庁'));
    } else {
      h2.appendChild(wxEl('span', 'wx-ref', '予報（参考）'));
      h2.appendChild(wxEl('span', 'wx-src', 'Open-Meteo CC BY 4.0'));
    }
    body.innerHTML = '';
    for (var i = 0; i < w.days.length; i++) body.appendChild(wxDay(w.days[i], w.source));
  }

  function lunchRow(d) {
    var row = wxEl('div', 'ln-day' + (d.isToday ? ' today' : '') + (d.isPast ? ' past' : ''));
    row.appendChild(wxEl('div', 'ln-date', d.md + '(' + d.dow + ')'));
    var txt;
    var cls = 'ln-dishes';
    if (d.missing) {
      txt = '献立未登録';
      cls += ' miss';
    } else if (d.type === 'holiday' || d.type === 'no_lunch') {
      txt = d.note || (d.type === 'holiday' ? '休み' : '給食なし');
      cls += ' off';
    } else {
      txt = (d.dishes || []).join('・');
    }
    row.appendChild(wxEl('div', cls, txt));
    return row;
  }

  function renderLunch(l) {
    var body = $('lnBody');
    if (!l || !l.days || !l.days.length) {
      body.innerHTML = '<div class="soon">準備中</div>';
      return;
    }
    body.innerHTML = '';
    for (var i = 0; i < l.days.length; i++) body.appendChild(lunchRow(l.days[i]));
  }

  // ---- 連絡板の表示（最新 / 前の連絡）----
  var latestMsg = { id: '', sender: '', text: '', time: '', readAt: null };
  var latestImg = null;
  var hasPrev = false;
  var histMode = 0;        // 0=最新, 1=1つ前, 2=2つ前
  var histItems = [];
  var histBusy = false;
  var histTimer = null;
  var HIST_RETURN_MS = 60 * 1000;

  function drawPhoto(url) {
    var img = $('photo');
    if (url) { if (img.getAttribute('src') !== url) img.src = url; img.style.display = 'block'; }
    else { img.removeAttribute('src'); img.style.display = 'none'; }
  }

  function drawBoard() {
    var showHist = histMode > 0 && histItems[histMode - 1];
    var m = showHist ? histItems[histMode - 1] : latestMsg;
    $('sender').textContent = m.sender || '';
    $('time').textContent = m.time || '';
    $('text').textContent = m.text || 'まだ連絡はないよ';
    drawPhoto(showHist ? m.imageUrl : latestImg);
    var unread = !showHist && !!latestMsg.id && !latestMsg.readAt;
    $('board').className = 'card' + (unread ? ' unread' : '') + (showHist ? ' hist' : '');
    $('readBtn').disabled = showHist || !unread;
    $('histBadge').hidden = !showHist;
    $('histBadge').textContent = histMode + 'つ前';
    $('latestBtn').hidden = !showHist;
    $('prevBtn').disabled = histBusy || (showHist ? histMode >= histItems.length : !hasPrev);
    fitText();
  }

  function clearHistTimer() { if (histTimer) { clearTimeout(histTimer); histTimer = null; } }
  function armHistTimer() {
    clearHistTimer();
    if (histMode > 0) histTimer = setTimeout(leaveHistory, HIST_RETURN_MS);
  }
  function leaveHistory() {
    clearHistTimer();
    if (histMode === 0) return;
    histMode = 0;
    histItems = [];
    drawBoard();
  }
  // 何かさわったら「60秒操作なし」を数え直す
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (histMode > 0) armHistTimer(); }, true);
  });

  function showPrev() {
    if (histBusy) return;
    if (histMode > 0) {
      if (histMode < histItems.length) { histMode++; armHistTimer(); drawBoard(); }
      return;
    }
    histBusy = true;
    $('prevBtn').disabled = true;
    api({ api: 'history', token: token }).then(function (r) {
      histBusy = false;
      if (!r.ok) {
        if (r.error === 'unauthorized') { onUnauthorized(); return; }
        drawBoard();
        toast('前の連絡を読めなかったよ');
        return;
      }
      histItems = (r.data && r.data.items) || [];
      if (!histItems.length) { drawBoard(); toast('前の連絡はないよ'); return; }
      histMode = 1;
      armHistTimer();
      drawBoard();
    });
  }

  function render(data) {
    var m = data.message || {};
    var newMsg = m.id !== latestMsg.id;
    if (histMode > 0 && newMsg) { histMode = 0; histItems = []; clearHistTimer(); }
    currentId = m.id || '';
    latestMsg = { id: m.id || '', sender: m.sender || '', text: m.text || '', time: m.time || '', readAt: m.readAt || null };
    if (!m.imageUnchanged) latestImg = m.imageUrl || null;
    hasPrev = !!data.previous;
    if (typeof data.calendarWaitSec === 'number') setCalWait(data.calendarWaitSec);
    lastVersion = m.version || '';
    drawBoard();
    renderWeek(data.events);
    renderWeather(data.weather);
    renderLunch(data.lunch);
  }

  // ---- 登録画面 ----
  var code = '';
  var pairBusy = false;

  var pairTimer = null;

  function showPair(msg) {
    stopPolling();
    startPairRetry();
    $('pair').className = '';
    code = '';
    drawCode();
    $('pairMsg').textContent = msg || '';
  }
  function hidePair() { $('pair').className = 'hidden'; stopPairRetry(); }
  function pairOpen() { return $('pair').className !== 'hidden'; }

  function drawCode() {
    var cells = $('pairCode').children;
    for (var i = 0; i < 6; i++) {
      cells[i].textContent = i < code.length ? code.charAt(i) : '';
      cells[i].className = i === code.length ? 'on' : '';
    }
  }

  function buildPair() {
    var cb = $('pairCode');
    for (var i = 0; i < 6; i++) cb.appendChild(document.createElement('span'));
    var kp = $('keypad');
    function key(label, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      kp.appendChild(b);
    }
    function digit(n) {
      key(String(n), '', function () {
        if (pairBusy || code.length >= 6) return;
        code += n;
        $('pairMsg').textContent = '';
        drawCode();
      });
    }
    for (var n = 1; n <= 9; n++) digit(n);
    key('けす', 'sm', function () {
      if (pairBusy) return;
      code = code.slice(0, -1);
      drawCode();
    });
    digit(0);
    key('とうろく', 'sm go', submitPair);
  }

  function submitPair() {
    if (pairBusy) return;
    if (code.length !== 6) { $('pairMsg').textContent = '6けたいれてね'; return; }
    pairBusy = true;
    $('pairMsg').textContent = '確認中…';
    api({ api: 'pair', code: code, ua: String(navigator.userAgent || '').slice(0, 120) }).then(function (r) {
      pairBusy = false;
      if (r.ok && r.data && /^[0-9a-f]{64}$/.test(r.data.token || '')) {
        token = r.data.token;
        if (!saveToken(token)) { noStore = true; toast('この端末では記憶できないよ'); }
        hidePair();
        setStatus('');
        lastSuccess = Date.now();
        refresh();
        startPolling();
        return;
      }
      code = '';
      drawCode();
      var msgs = {
        pair_failed: '番号がちがうよ',
        rate_limited: 'しばらく待ってね',
        devices_full: 'おうちの人に伝えてね'
      };
      $('pairMsg').textContent = msgs[r.error] || 'つながらなかったよ';
    });
  }

  // 登録画面の間も、保存済みトークンで board を再試行する（一時的な unauthorized から戻るため）
  function startPairRetry() {
    if (pairTimer) return;
    pairTimer = setInterval(retryStoredToken, POLL_MS);
  }
  function stopPairRetry() { if (pairTimer) { clearInterval(pairTimer); pairTimer = null; } }

  function retryStoredToken() {
    if (!token || !pairOpen() || document.hidden || busy || pairBusy) return;
    var t = token;
    busy = true;
    api({ api: 'board', token: t, since: lastVersion }).then(function (r) {
      busy = false;
      if (!r.ok || token !== t || !pairOpen()) return;
      hidePair();
      lastSuccess = Date.now();
      loaded = true;
      setStatus('');
      render(r.data);
      startPolling();
    });
  }

  // 認証エラー：トークンは消さず、登録画面を出す
  function onUnauthorized() {
    showPair('番号をいれてね');
  }

  // トークンを保存できない端末：reload すると登録画面に戻るので、reload を止めて注意を出し続ける
  var noStore = false;
  var NOSTORE_MSG = 'この端末では記憶できません（おうちの人へ）';
  function setStatus(txt) { $('status').textContent = noStore ? NOSTORE_MSG + (txt ? ' / ' + txt : '') : txt; }

  function refresh() {
    if (document.hidden || busy || pairOpen()) return;
    if (!noStore && Date.now() - lastSuccess >= RELOAD_MS) {
      location.reload();
      return;
    }
    busy = true;
    setStatus('更新中');
    api({ api: 'board', token: token, since: lastVersion }).then(function (r) {
      busy = false;
      if (r.ok) {
        lastSuccess = Date.now();
        loaded = true;
        setStatus('');
        render(r.data);
        return;
      }
      if (r.error === 'unauthorized') { setStatus(''); onUnauthorized(); return; }
      var reason = r.reason || (r.error === 'bad_request' ? '送信エラー' : 'サーバーエラー');
      if (loaded) {
        setStatus('最終更新 ' + hhmm(new Date(lastSuccess)) + '（' + reason + '）');
      } else {
        setStatus('読み込めませんでした');
        $('text').textContent = '読み込めませんでした：' + reason;
      }
    });
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(refresh, POLL_MS);
  }
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopPolling(); }
    else if (!pairOpen()) { tickClock(); refresh(); startPolling(); }
    else { retryStoredToken(); }
  });

  var replyBusy = false;
  function sendReply() {
    if (replyBusy) return;
    var input = $('replyText');
    var text = input.value.trim();
    if (!text) return;
    replyBusy = true;
    input.disabled = true;
    $('replyBtn').disabled = true;
    api({ api: 'reply', token: token, text: text }).then(function (r) {
      replyBusy = false;
      input.disabled = false;
      $('replyBtn').disabled = false;
      if (!r.ok && r.error === 'unauthorized') { onUnauthorized(); return; }
      if (r.ok && r.data && r.data.sent) {
        input.value = '';
        toast('送ったよ！');
      } else {
        toast(!r.ok && r.error === 'rate_limited' ? 'しばらく待ってね' : '送れなかったよ');
      }
    });
  }
  $('replyBtn').addEventListener('click', sendReply);
  $('replyText').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendReply(); }
  });
  var calBusy = false;
  $('calBtn').addEventListener('click', function () {
    if (calBusy || calWaitMin() > 0) return;
    calBusy = true;
    $('calBtn').disabled = true;
    api({ api: 'refreshCalendar', token: token }).then(function (r) {
      calBusy = false;
      if (r.ok && r.data) {
        setCalWait(r.data.nextAllowedSec || 300);
        if (r.data.events) renderWeek(r.data.events);
        toast('予定を更新したよ');
      } else if (!r.ok && r.error === 'unauthorized') {
        drawCalBtn(); onUnauthorized();
      } else if (!r.ok && r.error === 'too_soon') {
        setCalWait(r.retryAfterSec || 300);
        toast('あと' + calWaitMin() + '分まってね');
      } else {
        drawCalBtn();
        toast('更新できなかったよ');
      }
    });
  });
  $('prevBtn').addEventListener('click', showPrev);
  $('latestBtn').addEventListener('click', leaveHistory);

  $('readBtn').addEventListener('click', function () {
    var id = currentId;
    if (!id) return;
    $('readBtn').disabled = true;
    $('board').className = 'card';
    latestMsg.readAt = latestMsg.readAt || 'x';
    api({ api: 'read', token: token, id: id }).then(function (r) {
      if (r.ok) {
        toast(r.data && r.data.changed && r.data.notified === false ? '読んだけど、おうちの人に伝わらなかったよ' : '読んだよって伝えたよ');
        return;
      }
      if (r.error === 'unauthorized') { onUnauthorized(); return; }
      toast('伝えられなかったよ');
      refresh();
    });
  });

  $('photo').addEventListener('load', fitText);
  window.addEventListener('resize', fitText);
  window.addEventListener('resize', fitWeek);

  buildPair();
  tickClock();
  setInterval(tickClock, 10 * 1000);
  token = loadToken();
  if (!token) {
    showPair('番号をいれてね');
  } else {
    refresh();
    if (!document.hidden) startPolling();
  }
})();
