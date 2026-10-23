(function () {
  'use strict';

  // ── 小工具 ──────────────────────────────────────────────────
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (function add(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c == null || c === false) continue;
        if (Array.isArray(c)) add(c);
        else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      }
    })(Array.prototype.slice.call(arguments, 2));
    return el;
  }
  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) { return 'NT$' + Number(n || 0).toLocaleString('en-US'); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function nowTime() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  var toastTimer;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || '操作失敗（' + res.status + '）');
        return data;
      });
    }, function () {
      throw new Error('連線失敗，登入可能已過期，請重新整理頁面');
    });
  }

  // 儲存上次選的申請人（瀏覽器可能禁用儲存，失敗就算了）
  function remember(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; } }

  // ── 圖示（線條，自繪，24px）──────────────────────────────────
  var ICONS = {
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/>',
    expense: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
    leave: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="M9 15h6"/>',
    checkin: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    clients: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5h6v3M3 13h18"/>'
  };
  function icon(name) {
    var wrap = document.createElement('span');
    wrap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
    return wrap.firstChild;
  }

  // ── 全域狀態 ────────────────────────────────────────────────
  var config = { applicants: [], leaveTypes: [], expenseCats: [] };
  var PAGES = [
    { id: 'home', label: '首頁' },
    { id: 'expense', label: '報帳' },
    { id: 'leave', label: '請假' },
    { id: 'checkin', label: '簽到' },
    { id: 'clients', label: '客戶' }
  ];
  var main = $('main');

  function renderNav(current) {
    var nav = $('nav');
    nav.textContent = '';
    nav.appendChild(h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), '種子 內部系統'));
    PAGES.forEach(function (p) {
      var a = h('a', { href: '#' + p.id }, icon(p.id), h('span', { text: p.label }));
      if (p.id === current) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    });
  }

  function applicantField(selectedKey) {
    var sel = h('select', { id: 'f-name', required: true });
    var saved = remember(selectedKey);
    config.applicants.forEach(function (n) { sel.appendChild(h('option', { value: n, text: n, selected: n === saved })); });
    sel.addEventListener('change', function () { remember(selectedKey, sel.value); });
    return h('div', { class: 'field' }, h('label', { for: 'f-name', text: '申請人' }), sel);
  }

  function stateText(cls, text) { return h('span', { class: 'state ' + cls, text: text }); }

  function submitWith(btn, fn) {
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = '送出中…';
    return fn().then(function () { btn.disabled = false; btn.textContent = old; }, function (e) {
      btn.disabled = false; btn.textContent = old; toast(e.message, true);
    });
  }

  // ── 首頁 ────────────────────────────────────────────────────
  function pageHome(month) {
    var url = '/api/home' + (month ? '?month=' + month : '');
    main.appendChild(h('h1', { text: '首頁' }));
    var body = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));
    main.appendChild(body);
    api('GET', url).then(function (d) {
      body.textContent = '';
      body.appendChild(h('h2', { text: '今天（' + d.today + '）請假' }));
      body.appendChild(d.todayLeaves.length
        ? h('div', { class: 'list' }, d.todayLeaves.map(function (x) {
          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: x.type + (x.days ? ' ' + x.days + ' 天' : '') }));
        }))
        : h('p', { class: 'empty', text: '今天沒有人請假。' }));

      var parts = d.month.split('-').map(Number);
      var prev = new Date(parts[0], parts[1] - 2, 1), next = new Date(parts[0], parts[1], 1);
      var ym = function (dt) { return dt.getFullYear() + '-' + pad(dt.getMonth() + 1); };
      body.appendChild(h('div', { class: 'month-bar' },
        h('h2', { text: parts[0] + ' 年 ' + parts[1] + ' 月' }),
        h('div', {},
          h('button', { class: 'btn ghost small', type: 'button', text: '上個月', onclick: function () { go('home', ym(prev)); } }), ' ',
          h('button', { class: 'btn ghost small', type: 'button', text: '下個月', onclick: function () { go('home', ym(next)); } }))));

      body.appendChild(h('h2', { text: '誰請了幾天假' }));
      body.appendChild(d.leaveByPerson.length
        ? h('div', { class: 'list' }, d.leaveByPerson.map(function (x) {
          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: x.days + ' 天（' + x.count + ' 筆）' }));
        }))
        : h('p', { class: 'empty', text: '這個月沒有請假紀錄。' }));

      body.appendChild(h('h2', { text: '誰報了多少帳' }));
      body.appendChild(d.expenseByPerson.length
        ? h('div', { class: 'list' }, d.expenseByPerson.map(function (x) {
          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: money(x.total) + '（' + x.count + ' 筆）' }));
        }))
        : h('p', { class: 'empty', text: '這個月沒有報帳紀錄。' }));

      body.appendChild(h('h2', { text: '最近送出' }));
      body.appendChild(d.recent.length
        ? h('div', { class: 'list' }, d.recent.map(function (x) {
          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name + '　' + x.kind }), h('span', { class: 'muted', text: x.date }), h('span', { class: 'sub', text: x.text }));
        }))
        : h('p', { class: 'empty', text: '沒有資料。' }));
    }).catch(function (e) { body.textContent = ''; body.appendChild(h('p', { class: 'err', text: e.message })); });
  }

  // ── 報帳 ────────────────────────────────────────────────────
  function pageExpense() {
    main.appendChild(h('h1', { text: '報帳' }));
    main.appendChild(h('p', { class: 'muted', text: '送出後記到 Notion，LINE 群組會收到通知。不需要核准。' }));
    var lines = h('div', { class: 'lines' });
    var totalEl = h('p', { class: 'total', text: '合計 NT$0' });
    function recalc() {
      var t = 0;
      lines.querySelectorAll('input[data-amount]').forEach(function (i) { t += Number(i.value) || 0; });
      totalEl.textContent = '合計 ' + money(t);
    }
    function addLine() {
      var row = h('div', { class: 'line-item' },
        h('div', { class: 'desc' }, h('label', { text: '說明' }), h('input', { type: 'text', maxlength: '100', 'data-desc': true, required: true })),
        h('div', {}, h('label', { text: '類別' }), (function () {
          var s = h('select', { 'data-cat': true });
          config.expenseCats.forEach(function (c) { s.appendChild(h('option', { value: c, text: c })); });
          return s;
        })()),
        h('div', {}, h('label', { text: '金額' }), h('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', 'data-amount': true, required: true, oninput: recalc })),
        h('button', { class: 'btn ghost x', type: 'button', 'aria-label': '刪除這一筆', text: '×', onclick: function () { if (lines.children.length > 1) { row.remove(); recalc(); } } }));
      lines.appendChild(row);
    }
    addLine();
    var project = h('input', { type: 'text', id: 'f-project', maxlength: '200' });
    var note = h('textarea', { id: 'f-note', maxlength: '500' });
    var submit = h('button', { class: 'btn', type: 'submit', text: '送出報帳' });
    var form = h('form', {},
      applicantField('applicant'),
      lines,
      h('p', {}, h('button', { class: 'btn ghost small', type: 'button', text: '＋ 新增一筆', onclick: addLine })),
      totalEl,
      h('div', { class: 'field' }, h('label', { for: 'f-project', text: '專案用途（選填）' }), project),
      h('div', { class: 'field' }, h('label', { for: 'f-note', text: '備註（選填）' }), note),
      submit);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var items = Array.prototype.map.call(lines.children, function (r) {
        return { desc: r.querySelector('[data-desc]').value, cat: r.querySelector('[data-cat]').value, amount: r.querySelector('[data-amount]').value };
      });
      submitWith(submit, function () {
        return api('POST', '/api/expenses', { name: $('f-name').value, items: items, project: project.value, note: note.value }).then(function () {
          toast('報帳已送出，LINE 已通知');
          go('expense');
        });
      });
    });
    main.appendChild(form);
    recentList('/api/expenses', '最近的報帳', function (x) {
      return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name + '　' + money(x.total) }), h('span', { class: 'muted', text: x.created }),
        h('span', { class: 'sub', text: x.detail + (x.project ? '　專案：' + x.project : '') }));
    });
  }

  function recentList(path, heading, render) {
    main.appendChild(h('h2', { text: heading }));
    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));
    main.appendChild(box);
    api('GET', path).then(function (d) {
      box.textContent = '';
      box.appendChild(d.items.length ? h('div', { class: 'list' }, d.items.map(render)) : h('p', { class: 'empty', text: '還沒有資料。' }));
    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });
  }

  // ── 請假 ────────────────────────────────────────────────────
  function weekdaysBetween(a, b) {
    if (!a || !b || b < a) return 0;
    var d = new Date(a + 'T00:00:00'), end = new Date(b + 'T00:00:00'), n = 0;
    while (d <= end) { var w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }
    return n;
  }
  function pageLeave() {
    main.appendChild(h('h1', { text: '請假' }));
    main.appendChild(h('p', { class: 'muted', text: '送出後記到 Notion，LINE 群組會收到通知。只登記，不審核。' }));
    var typeBox = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': '假別' });
    config.leaveTypes.forEach(function (t, i) {
      typeBox.appendChild(h('label', {}, h('input', { type: 'radio', name: 'f-type', value: t, checked: i === 0 }), h('span', { text: t })));
    });
    var start = h('input', { type: 'date', id: 'f-start', value: todayStr(), required: true });
    var end = h('input', { type: 'date', id: 'f-end', value: todayStr(), required: true });
    var days = h('input', { type: 'number', id: 'f-days', min: '0.5', max: '60', step: '0.5', required: true, value: '1' });
    var half = h('select', { id: 'f-half' }, h('option', { value: '0', text: '整天' }), h('option', { value: '0.5', text: '只請半天' }));
    function calc() {
      var n = weekdaysBetween(start.value, end.value);
      if (half.value === '0.5' && n >= 1) n = n - 0.5;
      days.value = n || 1;
    }
    [start, end, half].forEach(function (el) { el.addEventListener('change', calc); });
    start.addEventListener('change', function () { if (end.value < start.value) end.value = start.value; calc(); });
    var reason = h('textarea', { id: 'f-reason', maxlength: '500' });
    var submit = h('button', { class: 'btn', type: 'submit', text: '送出請假' });
    var form = h('form', {},
      applicantField('applicant'),
      h('div', { class: 'field' }, h('label', { text: '假別' }), typeBox),
      h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('label', { for: 'f-start', text: '開始日期' }), start),
        h('div', { class: 'field' }, h('label', { for: 'f-end', text: '結束日期' }), end)),
      h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('label', { for: 'f-half', text: '半天' }), half),
        h('div', { class: 'field' }, h('label', { for: 'f-days', text: '天數（週末不算，可手動改）' }), days)),
      h('div', { class: 'field' }, h('label', { for: 'f-reason', text: '原因（選填）' }), reason),
      submit);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitWith(submit, function () {
        return api('POST', '/api/leave', {
          name: $('f-name').value, type: form.querySelector('input[name="f-type"]:checked').value,
          start: start.value, end: end.value, days: days.value, reason: reason.value
        }).then(function () { toast('請假已送出，LINE 已通知'); go('leave'); });
      });
    });
    main.appendChild(form);
    recentList('/api/leave', '最近的請假', function (x) {
      return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name + '　' + x.type + ' ' + x.days + ' 天' }), h('span', { class: 'muted', text: x.start }),
        h('span', { class: 'sub', text: x.start + ' ～ ' + x.end + (x.reason ? '　' + x.reason : '') }));
    });
  }

  // ── 簽到 ────────────────────────────────────────────────────
  function checkinForm(initial, onSubmit, label) {
    var date = h('input', { type: 'date', value: initial.date || todayStr(), required: true });
    var cin = h('input', { type: 'time', value: initial.clockIn || '' });
    var cout = h('input', { type: 'time', value: initial.clockOut || '' });
    var note = h('input', { type: 'text', maxlength: '300', value: initial.note || '' });
    var submit = h('button', { class: 'btn', type: 'submit', text: label });
    var form = h('form', { class: 'checkin-form' },
      h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('label', { text: '日期' }), date),
        h('div', { class: 'field' }, h('label', { text: '備註' }), note)),
      h('div', { class: 'row2' },
        h('div', { class: 'field' }, h('label', { text: '上班' }), cin, h('button', { class: 'btn ghost small', type: 'button', text: '現在', onclick: function () { cin.value = nowTime(); } })),
        h('div', { class: 'field' }, h('label', { text: '下班' }), cout, h('button', { class: 'btn ghost small', type: 'button', text: '現在', onclick: function () { cout.value = nowTime(); } }))),
      submit);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submitWith(submit, function () { return onSubmit({ date: date.value, clockIn: cin.value, clockOut: cout.value, note: note.value }); });
    });
    return form;
  }
  function pageCheckin() {
    main.appendChild(h('h1', { text: '簽到' }));
    main.appendChild(h('p', { class: 'muted', text: '送出後可以再修改，每筆會顯示最後修改時間，方便核對。' }));
    var nameField = applicantField('applicant');
    main.appendChild(nameField);
    main.appendChild(checkinForm({}, function (v) {
      v.name = $('f-name').value;
      return api('POST', '/api/checkin', v).then(function () { toast('已記錄'); go('checkin'); });
    }, '記錄'));
    main.appendChild(h('h2', { text: '最近的簽到' }));
    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));
    main.appendChild(box);
    api('GET', '/api/checkin').then(function (d) {
      box.textContent = '';
      if (!d.items.length) { box.appendChild(h('p', { class: 'empty', text: '還沒有資料。' })); return; }
      var list = h('div', { class: 'list' });
      d.items.forEach(function (x) {
        var edited = x.edited ? new Date(x.edited).toLocaleString('zh-TW', { hour12: false }) : '';
        var row = h('div', { class: 'item' },
          h('span', { class: 'title', text: x.name + '　' + x.date }),
          h('span', { text: (x.clockIn || '—') + ' ～ ' + (x.clockOut || '—') }),
          h('span', { class: 'sub', text: (x.note ? x.note + '　' : '') + '最後修改：' + edited }));
        var actions = h('div', { class: 'actions' });
        actions.appendChild(h('button', { class: 'btn ghost small', type: 'button', text: '修改', onclick: function () {
          actions.textContent = '';
          actions.appendChild(checkinForm(x, function (v) {
            return api('PATCH', '/api/checkin/' + x.id, v).then(function () { toast('已修改'); go('checkin'); });
          }, '儲存修改'));
        } }));
        row.appendChild(actions);
        list.appendChild(row);
      });
      box.appendChild(list);
    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });
  }

  // ── 客戶（只看）────────────────────────────────────────────
  function pageClients() {
    main.appendChild(h('h1', { text: '客戶' }));
    main.appendChild(h('p', { class: 'muted', text: '只能查看。有新動態的客戶排在最上面；新增與修改請到 Notion。' }));
    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));
    main.appendChild(box);
    api('GET', '/api/clients').then(function (d) {
      box.textContent = '';
      if (!d.items.length) { box.appendChild(h('p', { class: 'empty', text: '沒有客戶資料。' })); return; }
      var list = h('div', { class: 'list' });
      d.items.forEach(function (c) {
        var logBox = h('div', {});
        var loaded = false;
        var det = h('details', { class: 'client' },
          h('summary', {},
            h('span', { class: 'title', text: c.name || '（未命名）' }),
            h('span', { class: 'muted', text: [c.status, c.priority].filter(Boolean).join('　') + '　更新 ' + c.updated })),
          h('div', { class: 'client-body' },
            c.action ? h('p', {}, h('strong', { text: '下一步：' }), c.action) : null,
            c.commitment ? h('p', {}, h('strong', { text: '承諾事項：' }), c.commitment) : null,
            c.notes ? h('p', {}, h('strong', { text: '現況備註：' }), c.notes) : null,
            c.amount ? h('p', {}, h('strong', { text: '專案金額：' }), money(c.amount)) : null,
            logBox));
        det.addEventListener('toggle', function () {
          if (!det.open || loaded) return;
          loaded = true;
          logBox.appendChild(h('p', { class: 'muted', text: '載入歷史日誌…' }));
          api('GET', '/api/clients/' + c.id + '/log').then(function (r) {
            logBox.textContent = '';
            if (!r.days.length) { logBox.appendChild(h('p', { class: 'empty', text: '這位客戶沒有歷史日誌。' })); return; }
            r.days.forEach(function (day) {
              logBox.appendChild(h('h3', { text: day.date }));
              day.entries.forEach(function (en) {
                var p = h('div', { class: 'log-entry' }, h('span', { text: en.text }));
                en.links.forEach(function (l) { p.appendChild(document.createTextNode(' ')); p.appendChild(h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer', text: l.text })); });
                logBox.appendChild(p);
              });
            });
          }).catch(function (e) { loaded = false; logBox.textContent = ''; logBox.appendChild(h('p', { class: 'err', text: e.message })); });
        });
        list.appendChild(h('div', { class: 'item single' }, det));
      });
      box.appendChild(list);
    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });
  }

  // ── 路由 ────────────────────────────────────────────────────
  var current = { id: 'home', arg: '' };
  function go(id, arg) {
    var target = '#' + id + (arg ? '/' + arg : '');
    if (location.hash === target) render();
    else location.hash = target;
  }
  function render() {
    var parts = (location.hash || '#home').slice(1).split('/');
    var id = PAGES.some(function (p) { return p.id === parts[0]; }) ? parts[0] : 'home';
    current = { id: id, arg: parts[1] || '' };
    renderNav(id);
    main.textContent = '';
    ({ home: function () { pageHome(current.arg); }, expense: pageExpense, leave: pageLeave, checkin: pageCheckin, clients: pageClients })[id]();
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  api('GET', '/api/config').then(function (c) { config = c; render(); }).catch(function (e) {
    main.textContent = '';
    main.appendChild(h('h1', { text: '無法載入' }));
    main.appendChild(h('p', { class: 'err', text: e.message }));
  });
})();
