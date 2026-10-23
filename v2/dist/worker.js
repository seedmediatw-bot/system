/**
 * 種子 HR 系統 v2：單一 Cloudflare Worker（網頁 + API + LINE）
 *
 * 同一個檔案部署成兩個 Worker：
 *   seed-house    網站與 API，給 Sam 用。用 Google 登入，只有 ALLOWED_EMAILS 內的信箱進得來。
 *   hr-system123  （沿用舊名）只負責 LINE：收通知並驗簽章、替網站發 LINE 訊息、每日通知。
 *                 環境變數 MODE=line；其他路徑一律 404。LINE 金鑰與群組編號只放在這一個 Worker。
 *
 * seed-house 的環境變數：
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   Google Cloud 的 OAuth 用戶端
 *   SESSION_SECRET      至少 32 字元的隨機字串，用來簽登入 Cookie；換掉它就是全部登出
 *   ALLOWED_EMAILS      逗號分隔，允許使用網站的 Google 信箱；每次請求都會核對
 *   APPLICANTS          逗號分隔，可代填的人名
 *   HR_TOKEN / CRM_TOKEN   Notion 整合金鑰（CRM 那把只需讀取權限）
 *   DB_LEAVE DB_EXPENSE DB_CHECKIN DB_CRM
 *   LINE_NOTIFY_URL     LINE Worker 的 /api/line/notify 完整網址
 *   NOTIFY_KEY          與 LINE Worker 相同的共用密鑰
 *
 * LINE Worker（MODE=line）的環境變數：
 *   MODE=line  LINE_CHANNEL_TOKEN  LINE_CHANNEL_SECRET  LINE_GROUP_ID  NOTIFY_KEY
 *   HR_TOKEN  DB_LEAVE（今日請假查詢用）
 *   LINE_ALLOWED_USER_IDS（選填，逗號分隔；有填就只接受這些人的指令）
 *
 * Cron（只設在 LINE Worker）：UTC 01:00 週一到週五，即台灣 09:00 → 每日請假通知
 */

const ASSETS = {"/app.js":{"type":"text/javascript; charset=utf-8","body":"(function () {\n  'use strict';\n\n  // ── 小工具 ──────────────────────────────────────────────────\n  function h(tag, attrs) {\n    var el = document.createElement(tag);\n    if (attrs) Object.keys(attrs).forEach(function (k) {\n      var v = attrs[k];\n      if (v == null || v === false) return;\n      if (k === 'class') el.className = v;\n      else if (k === 'text') el.textContent = v;\n      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);\n      else el.setAttribute(k, v === true ? '' : v);\n    });\n    (function add(list) {\n      for (var i = 0; i < list.length; i++) {\n        var c = list[i];\n        if (c == null || c === false) continue;\n        if (Array.isArray(c)) add(c);\n        else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);\n      }\n    })(Array.prototype.slice.call(arguments, 2));\n    return el;\n  }\n  var $ = function (id) { return document.getElementById(id); };\n  var money = function (n) { return 'NT$' + Number(n || 0).toLocaleString('en-US'); };\n  var pad = function (n) { return String(n).padStart(2, '0'); };\n  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }\n  function nowTime() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }\n\n  var toastTimer;\n  function toast(msg, bad) {\n    var t = $('toast');\n    t.textContent = msg;\n    t.className = 'toast show' + (bad ? ' bad' : '');\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3200);\n  }\n\n  function api(method, path, body) {\n    var opts = { method: method, credentials: 'same-origin', headers: {} };\n    if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }\n    return fetch(path, opts).then(function (res) {\n      return res.json().catch(function () { return {}; }).then(function (data) {\n        if (res.status === 401) { location.href = '/auth/login'; throw new Error('請先登入'); }\n        if (!res.ok) throw new Error(data.error || '操作失敗（' + res.status + '）');\n        return data;\n      });\n    }, function () {\n      throw new Error('連線失敗，登入可能已過期，請重新整理頁面');\n    });\n  }\n\n  // 儲存上次選的申請人（瀏覽器可能禁用儲存，失敗就算了）\n  function remember(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; } }\n\n  // ── 全域狀態 ────────────────────────────────────────────────\n  var config = { applicants: [], leaveTypes: [], expenseCats: [] };\n  var me = null;\n  function logout() {\n    api('POST', '/auth/logout', {}).then(function () { location.href = '/'; }, function (e) { toast(e.message, true); });\n  }\n  var PAGES = [\n    { id: 'home', label: '首頁' },\n    { id: 'expense', label: '報帳' },\n    { id: 'leave', label: '請假' },\n    { id: 'checkin', label: '簽到' },\n    { id: 'clients', label: '客戶' }\n  ];\n  var main = $('main');\n\n  // 選單只建一次，換頁時只更新目前頁面；這樣圖示的形變節奏不會因換頁重來\n  function renderNav(current) {\n    var nav = $('nav');\n    if (!nav.firstChild) {\n      nav.appendChild(h('div', { class: 'brand' }, window.NavIcons.create('brand'), h('span', { text: '種子 內部系統' })));\n      PAGES.forEach(function (p) {\n        nav.appendChild(h('a', { href: '#' + p.id, 'data-page': p.id }, window.NavIcons.create(p.id), h('span', { text: p.label })));\n      });\n    }\n    if (me && !nav.querySelector('.who')) {\n      nav.appendChild(h('div', { class: 'who' }, h('span', { text: me.email }), h('button', { class: 'btn ghost small', type: 'button', text: '登出', onclick: logout })));\n    }\n    nav.querySelectorAll('a').forEach(function (a) {\n      if (a.getAttribute('data-page') === current) a.setAttribute('aria-current', 'page');\n      else a.removeAttribute('aria-current');\n    });\n  }\n\n  function applicantField(selectedKey) {\n    var sel = h('select', { id: 'f-name', required: true });\n    var saved = remember(selectedKey);\n    config.applicants.forEach(function (n) { sel.appendChild(h('option', { value: n, text: n, selected: n === saved })); });\n    sel.addEventListener('change', function () { remember(selectedKey, sel.value); });\n    return h('div', { class: 'field' }, h('label', { for: 'f-name', text: '申請人' }), sel);\n  }\n\n  function stateText(cls, text) { return h('span', { class: 'state ' + cls, text: text }); }\n\n  function submitWith(btn, fn) {\n    btn.disabled = true;\n    var old = btn.textContent;\n    btn.textContent = '送出中…';\n    return fn().then(function () { btn.disabled = false; btn.textContent = old; }, function (e) {\n      btn.disabled = false; btn.textContent = old; toast(e.message, true);\n    });\n  }\n\n  function cols() {\n    var left = h('div', { class: 'col-main' }), right = h('div', { class: 'col-side' });\n    main.appendChild(h('div', { class: 'cols' }, left, right));\n    return { left: left, right: right };\n  }\n\n  // ── 首頁 ────────────────────────────────────────────────────\n  function pageHome(month) {\n    var url = '/api/home' + (month ? '?month=' + month : '');\n    main.appendChild(h('h1', { text: '首頁' }));\n    var body = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));\n    main.appendChild(body);\n    api('GET', url).then(function (d) {\n      body.textContent = '';\n      var L = h('div', { class: 'col-main' }), R = h('div', { class: 'col-side' });\n      body.appendChild(h('div', { class: 'cols' }, L, R));\n      L.appendChild(h('h2', { text: '今天（' + d.today + '）請假' }));\n      L.appendChild(d.todayLeaves.length\n        ? h('div', { class: 'list' }, d.todayLeaves.map(function (x) {\n          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: x.type + (x.days ? ' ' + fmtLeave(x.days) : '') }));\n        }))\n        : h('p', { class: 'empty', text: '今天沒有人請假。' }));\n\n      var parts = d.month.split('-').map(Number);\n      var prev = new Date(parts[0], parts[1] - 2, 1), next = new Date(parts[0], parts[1], 1);\n      var ym = function (dt) { return dt.getFullYear() + '-' + pad(dt.getMonth() + 1); };\n      L.appendChild(h('div', { class: 'month-bar' },\n        h('h2', { text: parts[0] + ' 年 ' + parts[1] + ' 月' }),\n        h('div', {},\n          h('button', { class: 'btn ghost small', type: 'button', text: '上個月', onclick: function () { go('home', ym(prev)); } }), ' ',\n          h('button', { class: 'btn ghost small', type: 'button', text: '下個月', onclick: function () { go('home', ym(next)); } }))));\n\n      L.appendChild(h('h2', { text: '誰請了多少假' }));\n      L.appendChild(d.leaveByPerson.length\n        ? h('div', { class: 'list' }, d.leaveByPerson.map(function (x) {\n          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: fmtLeave(x.days) + '（' + x.count + ' 筆）' }));\n        }))\n        : h('p', { class: 'empty', text: '這個月沒有請假紀錄。' }));\n\n      L.appendChild(h('h2', { text: '誰報了多少帳' }));\n      L.appendChild(d.expenseByPerson.length\n        ? h('div', { class: 'list' }, d.expenseByPerson.map(function (x) {\n          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: money(x.total) + '（' + x.count + ' 筆）' }));\n        }))\n        : h('p', { class: 'empty', text: '這個月沒有報帳紀錄。' }));\n\n      R.appendChild(h('h2', { text: '最近送出' }));\n      R.appendChild(d.recent.length\n        ? h('div', { class: 'list' }, d.recent.map(function (x) {\n          return h('div', { class: 'item recent' }, h('span', { class: 'title', text: x.name + '　' + x.kind }), h('span', { class: 'muted', text: x.date }), h('span', { class: 'sub', text: x.text }), h('span', { class: 'end-mark ' + (x.kind === '報帳' ? 'expense' : 'leave'), 'aria-hidden': 'true' }));\n        }))\n        : h('p', { class: 'empty', text: '沒有資料。' }));\n    }).catch(function (e) { body.textContent = ''; body.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 報帳 ────────────────────────────────────────────────────\n  function pageExpense() {\n    main.appendChild(h('h1', { text: '報帳' }));\n    main.appendChild(h('p', { class: 'muted', text: '送出後記到 Notion，LINE 群組會收到通知。不需要核准。' }));\n    var lines = h('div', { class: 'lines' });\n    var totalEl = h('p', { class: 'total', text: '合計 NT$0' });\n    function recalc() {\n      var t = 0;\n      lines.querySelectorAll('input[data-amount]').forEach(function (i) { t += Number(i.value) || 0; });\n      totalEl.textContent = '合計 ' + money(t);\n    }\n    function addLine() {\n      var row = h('div', { class: 'line-item' },\n        h('div', { class: 'desc' }, h('label', { text: '說明' }), h('input', { type: 'text', maxlength: '100', 'data-desc': true, required: true })),\n        h('div', {}, h('label', { text: '類別' }), (function () {\n          var s = h('select', { 'data-cat': true });\n          config.expenseCats.forEach(function (c) { s.appendChild(h('option', { value: c, text: c })); });\n          return s;\n        })()),\n        h('div', {}, h('label', { text: '金額' }), h('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', 'data-amount': true, required: true, oninput: recalc })),\n        h('button', { class: 'btn ghost x', type: 'button', 'aria-label': '刪除這一筆', text: '×', onclick: function () { if (lines.children.length > 1) { row.remove(); recalc(); } } }));\n      lines.appendChild(row);\n    }\n    addLine();\n    var project = h('input', { type: 'text', id: 'f-project', maxlength: '200' });\n    var note = h('textarea', { id: 'f-note', maxlength: '500' });\n    var submit = h('button', { class: 'btn', type: 'submit', text: '送出報帳' });\n    var form = h('form', {},\n      applicantField('applicant'),\n      lines,\n      h('p', {}, h('button', { class: 'btn ghost small', type: 'button', text: '＋ 新增一筆', onclick: addLine })),\n      totalEl,\n      h('div', { class: 'field' }, h('label', { for: 'f-project', text: '專案用途（選填）' }), project),\n      h('div', { class: 'field' }, h('label', { for: 'f-note', text: '備註（選填）' }), note),\n      submit);\n    form.addEventListener('submit', function (ev) {\n      ev.preventDefault();\n      var items = Array.prototype.map.call(lines.children, function (r) {\n        return { desc: r.querySelector('[data-desc]').value, cat: r.querySelector('[data-cat]').value, amount: r.querySelector('[data-amount]').value };\n      });\n      submitWith(submit, function () {\n        return api('POST', '/api/expenses', { name: $('f-name').value, items: items, project: project.value, note: note.value }).then(function () {\n          toast('報帳已送出，LINE 已通知');\n          go('expense');\n        });\n      });\n    });\n    var c1 = cols();\n    c1.left.appendChild(form);\n    recentList(c1.right, '/api/expenses', '最近的報帳', function (x) {\n      return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name + '　' + money(x.total) }), h('span', { class: 'muted', text: x.created }),\n        h('span', { class: 'sub', text: x.detail + (x.project ? '　專案：' + x.project : '') }));\n    });\n  }\n\n  function recentList(container, path, heading, render) {\n    container.appendChild(h('h2', { text: heading }));\n    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));\n    container.appendChild(box);\n    api('GET', path).then(function (d) {\n      box.textContent = '';\n      box.appendChild(d.items.length ? h('div', { class: 'list' }, d.items.map(render)) : h('p', { class: 'empty', text: '還沒有資料。' }));\n    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 請假（以小時為單位；每天 8 小時）─────────────────────────\n  function fmtLeave(days) {\n    var hours = Math.round(Number(days || 0) * 16) / 2;\n    var d = Math.floor(hours / 8), r = hours - d * 8;\n    return [d ? d + ' 天' : '', r ? r + ' 小時' : ''].filter(Boolean).join(' ') || '0 小時';\n  }\n  function weekdaysBetween(a, b) {\n    if (!a || !b || b < a) return 0;\n    var d = new Date(a + 'T00:00:00'), end = new Date(b + 'T00:00:00'), n = 0;\n    while (d <= end) { var w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }\n    return n;\n  }\n  function pageLeave() {\n    main.appendChild(h('h1', { text: '請假' }));\n    main.appendChild(h('p', { class: 'muted', text: '以小時計，一天 8 小時。送出後記到 Notion，LINE 群組會收到通知，只登記不審核。' }));\n    var typeBox = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': '假別' });\n    config.leaveTypes.forEach(function (t, i) {\n      typeBox.appendChild(h('label', {}, h('input', { type: 'radio', name: 'f-type', value: t, checked: i === 0 }), h('span', { text: t })));\n    });\n    var start = h('input', { type: 'date', id: 'f-start', value: todayStr(), required: true });\n    var end = h('input', { type: 'date', id: 'f-end', value: todayStr(), required: true });\n    var hours = h('input', { type: 'number', id: 'f-hours', min: '0.5', max: '480', step: '0.5', required: true, value: '8' });\n    var summary = h('p', { class: 'muted' });\n    var chipBox = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': '請假時數' });\n    [1, 2, 3, 4, 5, 6, 7, 8].forEach(function (n) {\n      chipBox.appendChild(h('label', {}, h('input', { type: 'radio', name: 'f-chip', value: String(n), checked: n === 8, onchange: function () { hours.value = String(n); sync(); } }), h('span', { text: n === 8 ? '整天 8' : n + ' 小時' })));\n    });\n    function multiDay() { return end.value > start.value; }\n    function sync() {\n      chipBox.hidden = multiDay();\n      var n = Number(hours.value) || 0;\n      summary.textContent = multiDay()\n        ? '跨 ' + weekdaysBetween(start.value, end.value) + ' 個上班日，預設每天 8 小時；週末不算，可直接改合計小時。合計 ' + fmtLeave(n / 8) + '。'\n        : '合計 ' + fmtLeave(n / 8) + '。';\n    }\n    function dates() {\n      if (end.value < start.value) end.value = start.value;\n      if (multiDay()) hours.value = String((weekdaysBetween(start.value, end.value) || 1) * 8);\n      else { var c = chipBox.querySelector('input:checked'); hours.value = c ? c.value : '8'; }\n      sync();\n    }\n    start.addEventListener('change', dates);\n    end.addEventListener('change', dates);\n    hours.addEventListener('input', sync);\n    var reason = h('textarea', { id: 'f-reason', maxlength: '500' });\n    var submit = h('button', { class: 'btn', type: 'submit', text: '送出請假' });\n    var form = h('form', {},\n      applicantField('applicant'),\n      h('div', { class: 'field' }, h('label', { text: '假別' }), typeBox),\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { for: 'f-start', text: '開始日期' }), start),\n        h('div', { class: 'field' }, h('label', { for: 'f-end', text: '結束日期' }), end)),\n      h('div', { class: 'field' }, h('label', { text: '請假時數' }), chipBox),\n      h('div', { class: 'field' }, h('label', { for: 'f-hours', text: '合計小時（最小 0.5）' }), hours, summary),\n      h('div', { class: 'field' }, h('label', { for: 'f-reason', text: '原因（選填）' }), reason),\n      submit);\n    sync();\n    form.addEventListener('submit', function (ev) {\n      ev.preventDefault();\n      submitWith(submit, function () {\n        return api('POST', '/api/leave', {\n          name: $('f-name').value, type: form.querySelector('input[name=\"f-type\"]:checked').value,\n          start: start.value, end: end.value, hours: hours.value, reason: reason.value\n        }).then(function () { toast('請假已送出，LINE 已通知'); go('leave'); });\n      });\n    });\n    var c2 = cols();\n    c2.left.appendChild(form);\n    recentList(c2.right, '/api/leave', '最近的請假', function (x) {\n      return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name + '　' + x.type + ' ' + fmtLeave(x.days) }), h('span', { class: 'muted', text: x.start }),\n        h('span', { class: 'sub', text: x.start + ' ～ ' + x.end + (x.reason ? '　' + x.reason : '') }));\n    });\n  }\n\n  // ── 簽到 ────────────────────────────────────────────────────\n  function checkinForm(initial, onSubmit, label) {\n    var date = h('input', { type: 'date', value: initial.date || todayStr(), required: true });\n    var cin = h('input', { type: 'time', value: initial.clockIn || '' });\n    var cout = h('input', { type: 'time', value: initial.clockOut || '' });\n    var note = h('input', { type: 'text', maxlength: '300', value: initial.note || '' });\n    var submit = h('button', { class: 'btn', type: 'submit', text: label });\n    var form = h('form', { class: 'checkin-form' },\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { text: '日期' }), date),\n        h('div', { class: 'field' }, h('label', { text: '備註' }), note)),\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { text: '上班' }), cin, h('button', { class: 'btn ghost small', type: 'button', text: '現在', onclick: function () { cin.value = nowTime(); } })),\n        h('div', { class: 'field' }, h('label', { text: '下班' }), cout, h('button', { class: 'btn ghost small', type: 'button', text: '現在', onclick: function () { cout.value = nowTime(); } }))),\n      submit);\n    form.addEventListener('submit', function (ev) {\n      ev.preventDefault();\n      submitWith(submit, function () { return onSubmit({ date: date.value, clockIn: cin.value, clockOut: cout.value, note: note.value }); });\n    });\n    return form;\n  }\n\n  // 全月正常出勤：先預覽要建立哪些天（自動排除週末、國定假日、請假日、已簽到日），確認後一次建立\n  function monthAttendance(nameGetter) {\n    var month = h('input', { type: 'month', value: todayStr().slice(0, 7), required: true });\n    var cin = h('input', { type: 'time', value: remember('monthIn') || '09:00' });\n    var cout = h('input', { type: 'time', value: remember('monthOut') || '18:00' });\n    var out = h('div', {});\n    var previewBtn = h('button', { class: 'btn ghost', type: 'button', text: '預覽這個月' });\n    previewBtn.addEventListener('click', function () {\n      out.textContent = '';\n      out.appendChild(h('p', { class: 'muted', text: '載入中…' }));\n      api('GET', '/api/checkin/plan?name=' + encodeURIComponent(nameGetter()) + '&month=' + month.value).then(function (plan) {\n        out.textContent = '';\n        if (!plan.hasHolidayData) out.appendChild(h('p', { class: 'err', text: '這一年還沒有國定假日資料，請自己取消勾選放假的日子。' }));\n        var boxes = [];\n        var list = h('div', { class: 'list' });\n        plan.days.forEach(function (d) {\n          var cb = h('input', { type: 'checkbox', checked: d.checked, 'aria-label': d.date });\n          boxes.push({ cb: cb, date: d.date });\n          list.appendChild(h('label', { class: 'item day-row' }, cb, h('span', { class: 'title', text: d.date.slice(5) + '（' + d.dow + '）' }), h('span', { class: 'muted', text: d.label })));\n        });\n        var count = h('p', { class: 'muted' });\n        var go2 = h('button', { class: 'btn', type: 'button' });\n        function refresh() {\n          var n = boxes.filter(function (b) { return b.cb.checked; }).length;\n          count.textContent = '將建立 ' + n + ' 筆，上班 ' + cin.value + '，下班 ' + cout.value + '。';\n          go2.textContent = '建立 ' + n + ' 筆簽到';\n          go2.disabled = n === 0;\n        }\n        boxes.forEach(function (b) { b.cb.addEventListener('change', refresh); });\n        refresh();\n        go2.addEventListener('click', function () {\n          var dates = boxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return b.date; });\n          remember('monthIn', cin.value); remember('monthOut', cout.value);\n          submitWith(go2, function () {\n            return api('POST', '/api/checkin/month', { name: nameGetter(), month: month.value, clockIn: cin.value, clockOut: cout.value, dates: dates }).then(function (r) {\n              toast('已建立 ' + r.created + ' 筆' + (r.skipped.length ? '，略過 ' + r.skipped.length + ' 筆已有簽到' : ''));\n              go('checkin');\n            });\n          });\n        });\n        out.appendChild(list); out.appendChild(count); out.appendChild(go2);\n      }).catch(function (e) { out.textContent = ''; out.appendChild(h('p', { class: 'err', text: e.message })); });\n    });\n    return h('div', {},\n      h('h2', { text: '全月正常出勤' }),\n      h('p', { class: 'muted', text: '一次補齊整個月。預覽會排除週末、國定假日、請假日與已有簽到的日子，你可以再手動勾選調整。' }),\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { text: '月份' }), month),\n        h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: '上班' }), cin), h('div', { class: 'field' }, h('label', { text: '下班' }), cout))),\n      previewBtn, out);\n  }\n\n  function pageCheckin() {\n    main.appendChild(h('h1', { text: '簽到' }));\n    main.appendChild(h('p', { class: 'muted', text: '送出後可以再修改，每筆會顯示最後修改時間，方便核對。' }));\n    var c3 = cols();\n    var nameField = applicantField('applicant');\n    c3.left.appendChild(nameField);\n    c3.left.appendChild(checkinForm({}, function (v) {\n      v.name = $('f-name').value;\n      return api('POST', '/api/checkin', v).then(function () { toast('已記錄'); go('checkin'); });\n    }, '記錄'));\n    c3.left.appendChild(monthAttendance(function () { return $('f-name').value; }));\n    c3.right.appendChild(h('h2', { text: '最近的簽到' }));\n    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));\n    c3.right.appendChild(box);\n    api('GET', '/api/checkin').then(function (d) {\n      box.textContent = '';\n      if (!d.items.length) { box.appendChild(h('p', { class: 'empty', text: '還沒有資料。' })); return; }\n      var list = h('div', { class: 'list' });\n      d.items.forEach(function (x) {\n        var edited = x.edited ? new Date(x.edited).toLocaleString('zh-TW', { hour12: false }) : '';\n        var row = h('div', { class: 'item' },\n          h('span', { class: 'title', text: x.name + '　' + x.date }),\n          h('span', { text: (x.clockIn || '—') + ' ～ ' + (x.clockOut || '—') }),\n          h('span', { class: 'sub', text: (x.note ? x.note + '　' : '') + '最後修改：' + edited }));\n        var actions = h('div', { class: 'actions' });\n        actions.appendChild(h('button', { class: 'btn ghost small', type: 'button', text: '修改', onclick: function () {\n          actions.textContent = '';\n          actions.appendChild(checkinForm(x, function (v) {\n            return api('PATCH', '/api/checkin/' + x.id, v).then(function () { toast('已修改'); go('checkin'); });\n          }, '儲存修改'));\n        } }));\n        row.appendChild(actions);\n        list.appendChild(row);\n      });\n      box.appendChild(list);\n    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 客戶（只看）────────────────────────────────────────────\n  function pageClients() {\n    main.appendChild(h('h1', { text: '客戶' }));\n    main.appendChild(h('p', { class: 'muted', text: '只能查看。有新動態的客戶排在最上面；新增與修改請到 Notion。' }));\n    var box = h('div', { class: 'client-list' }, h('p', { class: 'muted', text: '載入中…' }));\n    main.appendChild(box);\n    api('GET', '/api/clients').then(function (d) {\n      box.textContent = '';\n      if (!d.items.length) { box.appendChild(h('p', { class: 'empty', text: '沒有客戶資料。' })); return; }\n      var list = h('div', { class: 'list' });\n      d.items.forEach(function (c) {\n        var logBox = h('div', {});\n        var loaded = false;\n        var det = h('details', { class: 'client' },\n          h('summary', {},\n            h('span', { class: 'title', text: c.name || '（未命名）' }),\n            h('span', { class: 'muted', text: [c.status, c.priority].filter(Boolean).join('　') + '　更新 ' + c.updated })),\n          h('div', { class: 'client-body' },\n            c.action ? h('p', {}, h('strong', { text: '下一步：' }), c.action) : null,\n            c.commitment ? h('p', {}, h('strong', { text: '承諾事項：' }), c.commitment) : null,\n            c.notes ? h('p', {}, h('strong', { text: '現況備註：' }), c.notes) : null,\n            c.amount ? h('p', {}, h('strong', { text: '專案金額：' }), money(c.amount)) : null,\n            logBox));\n        det.addEventListener('toggle', function () {\n          if (!det.open || loaded) return;\n          loaded = true;\n          logBox.appendChild(h('p', { class: 'muted', text: '載入歷史日誌…' }));\n          api('GET', '/api/clients/' + c.id + '/log').then(function (r) {\n            logBox.textContent = '';\n            if (!r.days.length) { logBox.appendChild(h('p', { class: 'empty', text: '這位客戶沒有歷史日誌。' })); return; }\n            r.days.forEach(function (day) {\n              logBox.appendChild(h('h3', { text: day.date }));\n              day.entries.forEach(function (en) {\n                var p = h('div', { class: 'log-entry' }, h('span', { text: en.text }));\n                en.links.forEach(function (l) { p.appendChild(document.createTextNode(' ')); p.appendChild(h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer', text: l.text })); });\n                logBox.appendChild(p);\n              });\n            });\n          }).catch(function (e) { loaded = false; logBox.textContent = ''; logBox.appendChild(h('p', { class: 'err', text: e.message })); });\n        });\n        list.appendChild(h('div', { class: 'item single' }, det));\n      });\n      box.appendChild(list);\n    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 路由 ────────────────────────────────────────────────────\n  var current = { id: 'home', arg: '' };\n  function go(id, arg) {\n    var target = '#' + id + (arg ? '/' + arg : '');\n    if (location.hash === target) render();\n    else location.hash = target;\n  }\n  function render() {\n    var parts = (location.hash || '#home').slice(1).split('/');\n    var id = PAGES.some(function (p) { return p.id === parts[0]; }) ? parts[0] : 'home';\n    current = { id: id, arg: parts[1] || '' };\n    renderNav(id);\n    main.textContent = '';\n    ({ home: function () { pageHome(current.arg); }, expense: pageExpense, leave: pageLeave, checkin: pageCheckin, clients: pageClients })[id]();\n    window.scrollTo(0, 0);\n  }\n\n  window.addEventListener('hashchange', render);\n  Promise.all([api('GET', '/api/config'), api('GET', '/api/me')]).then(function (r) { config = r[0]; me = r[1]; render(); }).catch(function (e) {\n    main.textContent = '';\n    main.appendChild(h('h1', { text: '無法載入' }));\n    main.appendChild(h('p', { class: 'err', text: e.message }));\n  });\n})();\n"},"/favicon.svg":{"type":"image/svg+xml","body":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><rect width=\"32\" height=\"32\" rx=\"6\" fill=\"#1b1a18\"/><g transform=\"translate(4 4)\" fill=\"none\" stroke=\"#7fbf95\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3\"/><path d=\"M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4\"/><path d=\"M5 21h14\"/></g></svg>\n"},"/index.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"zh-Hant\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<title>種子 內部系統</title>\n<link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">\n<link rel=\"stylesheet\" href=\"/style.css\">\n</head>\n<body>\n<div class=\"shell\">\n  <nav class=\"nav\" id=\"nav\" aria-label=\"主選單\"></nav>\n  <main class=\"main\" id=\"main\" tabindex=\"-1\">\n    <p class=\"muted\">載入中…</p>\n  </main>\n</div>\n<div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n<script src=\"/morphicons.js\"></script>\n<script src=\"/navicons.js\"></script>\n<script src=\"/app.js\"></script>\n</body>\n</html>\n"},"/morphicons.js":{"type":"text/javascript; charset=utf-8","body":"var Morphicons=(()=>{var nt=Object.defineProperty;var Bt=Object.getOwnPropertyDescriptor;var Dt=Object.getOwnPropertyNames;var Gt=Object.prototype.hasOwnProperty;var Vt=(t,s)=>{for(var o in s)nt(t,o,{get:s[o],enumerable:!0})},zt=(t,s,o,n)=>{if(s&&typeof s==\"object\"||typeof s==\"function\")for(let e of Dt(s))!Gt.call(t,e)&&e!==o&&nt(t,e,{get:()=>s[e],enumerable:!(n=Bt(s,e))||n.enumerable});return t};var Wt=t=>zt(nt({},\"__esModule\",{value:!0}),t);var bn={};Vt(bn,{canonicalD:()=>lt,createMorph:()=>gn});var Yt=\"MmLlHhVvCcSsQqTtAaZz\";function dt(t){let s=[],o=t.length,n=0,e=0,r=0,c=0,f=0,u=null,l=\"\",a=0,i=0,m=\"\",p=!1,d=M=>{throw new Error(`morphicons: ${M} at d[${n}]`)},k=M=>M>=48&&M<=57,y=()=>{for(;n<o;){let M=t.charCodeAt(n);if(M===32||M===9||M===10||M===13||M===12||M===44)n++;else break}},I=()=>{y();let M=n;n<o&&(t[n]===\"+\"||t[n]===\"-\")&&n++;let x=!1;for(;n<o&&k(t.charCodeAt(n));)n++,x=!0;if(n<o&&t[n]===\".\")for(n++;n<o&&k(t.charCodeAt(n));)n++,x=!0;if(x||d(\"expected number\"),n<o&&(t[n]===\"e\"||t[n]===\"E\")){let N=n;n++,n<o&&(t[n]===\"+\"||t[n]===\"-\")&&n++;let P=!1;for(;n<o&&k(t.charCodeAt(n));)n++,P=!0;P||(n=N)}return Number(t.slice(M,n))},w=()=>{y();let M=t[n];return M===\"0\"||M===\"1\"?(n++,M===\"1\"?1:0):d(\"expected arc flag (0|1)\")},h=()=>(p||d(\"path must start with M/m\"),u||(u={x0:e,y0:r,segs:[],closed:!1},s.push(u)),u),g=!1,A=()=>I()+(g?e:0),b=()=>I()+(g?r:0);for(;y(),!(n>=o);){let M=t[n];switch(Yt.includes(M)?(l=M,n++):l===\"\"?d(\"path must start with M/m\"):l===\"M\"?l=\"L\":l===\"m\"?l=\"l\":(l===\"Z\"||l===\"z\")&&d(\"stray data after Z\"),g=l>=\"a\",g?l.toUpperCase():l){case\"M\":{p=!0;let x=A(),N=b();e=x,r=N,c=x,f=N,u={x0:x,y0:N,segs:[],closed:!1},s.push(u),m=\"\";break}case\"L\":{let x=A(),N=b();h().segs.push([\"L\",x,N]),e=x,r=N,m=\"\";break}case\"H\":{let x=A();h().segs.push([\"L\",x,r]),e=x,m=\"\";break}case\"V\":{let x=b();h().segs.push([\"L\",e,x]),r=x,m=\"\";break}case\"C\":case\"S\":{let x,N;l===\"C\"||l===\"c\"?(x=A(),N=b()):(x=m===\"C\"?2*e-a:e,N=m===\"C\"?2*r-i:r);let P=A(),T=b(),C=A(),F=b();h().segs.push([\"C\",x,N,P,T,C,F]),a=P,i=T,e=C,r=F,m=\"C\";break}case\"Q\":case\"T\":{let x,N;l===\"Q\"||l===\"q\"?(x=A(),N=b()):(x=m===\"Q\"?2*e-a:e,N=m===\"Q\"?2*r-i:r);let P=A(),T=b();h().segs.push([\"Q\",x,N,P,T]),a=x,i=N,e=P,r=T,m=\"Q\";break}case\"A\":{let x=I(),N=I(),P=I(),T=w(),C=w(),F=A(),E=b();h().segs.push([\"A\",x,N,P,T,C,F,E]),e=F,r=E,m=\"\";break}case\"Z\":u&&(u.closed=!0,u=null),e=c,r=f,m=\"\";break;default:d(`unsupported command \"${l}\"`)}}return s.filter(M=>M.segs.length>0)}function W(t){return String(Math.round(t*100)/100)}function At(t,s){let o=\"\";for(let n=0;n<t.length;n++){let e=t[n],r=e.length/2;o+=`M${W(e[0])} ${W(e[1])}`;for(let c=1;c<r;c++)o+=`L${W(e[2*c])} ${W(e[2*c+1])}`;s?.[n]&&(o+=\"Z\")}return o}function $(t){return String(Math.round(t*1e4)/1e4)}function Nt(t){let s=\"\";for(let{pts:o,closed:n}of t){s+=`M${$(o[0])} ${$(o[1])}`;for(let e=2;e<o.length;e+=6)s+=`C${$(o[e])} ${$(o[e+1])} ${$(o[e+2])} ${$(o[e+3])} ${$(o[e+4])} ${$(o[e+5])}`;n&&(s+=\"Z\")}return s}var Y=4/3*Math.tan(Math.PI/8),yt=2*Math.PI;function Q(t,s){let o=[t,s],n=t,e=s,r=(a,i,m,p,d,k)=>{o.push(a,i,m,p,d,k),n=d,e=k},c=(a,i)=>{Math.abs(a-n)<1e-12&&Math.abs(i-e)<1e-12||r(n+(a-n)/3,e+(i-e)/3,n+2*(a-n)/3,e+2*(i-e)/3,a,i)};return[r,c,(a,i,m,p)=>{r(n+2/3*(a-n),e+2/3*(i-e),m+2/3*(a-m),p+2/3*(i-p),m,p)},(a,i,m,p,d,k,y)=>{let I=n,w=e;if(Math.abs(k-I)<1e-12&&Math.abs(y-w)<1e-12)return;let h=Math.abs(a),g=Math.abs(i);if(h<1e-12||g<1e-12){c(k,y);return}let A=m*Math.PI/180,b=Math.cos(A),M=Math.sin(A),x=(I-k)/2,N=(w-y)/2,P=b*x+M*N,T=-M*x+b*N,C=P*P/(h*h)+T*T/(g*g);if(C>1){let S=Math.sqrt(C);h*=S,g*=S}let F=h*h,E=g*g,ft=P*P,ut=T*T,X=(F*E-F*ut-E*ft)/(F*ut+E*ft);X<0&&(X=0);let ht=(p===d?-1:1)*Math.sqrt(X),D=ht*h*T/g,G=-ht*g*P/h,_t=b*D-M*G+(I+k)/2,qt=M*D+b*G+(w+y)/2,U=Math.atan2((T-G)/g,(P-D)/h),O=Math.atan2((-T-G)/g,(-P-D)/h)-U;d===0&&O>0?O-=yt:d===1&&O<0&&(O+=yt);let V=Math.max(1,Math.ceil(Math.abs(O)/(Math.PI/2)-1e-9)),mt=O/V,z=4/3*Math.tan(mt/4),Rt=S=>_t+h*Math.cos(S)*b-g*Math.sin(S)*M,Qt=S=>qt+h*Math.cos(S)*M+g*Math.sin(S)*b,pt=S=>-h*Math.sin(S)*b-g*Math.cos(S)*M,gt=S=>-h*Math.sin(S)*M+g*Math.cos(S)*b,J=U,bt=I,Mt=w;for(let S=1;S<=V;S++){let R=U+mt*S,K=S===V?k:Rt(R),tt=S===V?y:Qt(R);r(bt+z*pt(J),Mt+z*gt(J),K-z*pt(R),tt-z*gt(R),K,tt),J=R,bt=K,Mt=tt}},a=>(a&&c(o[0],o[1]),o.length<8?null:{pts:Float64Array.from(o),closed:a})]}function xt(t){let[s,o,n,e,r]=Q(t.x0,t.y0);for(let c of t.segs)switch(c[0]){case\"L\":o(c[1],c[2]);break;case\"C\":s(c[1],c[2],c[3],c[4],c[5],c[6]);break;case\"Q\":n(c[1],c[2],c[3],c[4]);break;case\"A\":e(c[1],c[2],c[3],c[4],c[5],c[6],c[7])}return r(t.closed)}function v(t,s,o=0){let n=t[s];if(n===void 0)return o;let e=typeof n==\"number\"?n:Number(n);return Number.isFinite(e)?e:o}function wt(t){let s=String(t??\"\").trim();if(!s)return[];let o=s.split(/[\\s,]+/).map(Number);if(o.some(n=>!Number.isFinite(n)))throw new Error(`morphicons: invalid points: \"${s}\"`);return o}function et(t,s){if(t.length<4)return null;let[,o,,,n]=Q(t[0],t[1]);for(let e=2;e+1<t.length;e+=2)o(t[e],t[e+1]);return n(s)}function kt(t,s,o,n){if(o<1e-12||n<1e-12)return null;let e=Y*o,r=Y*n,c=t+o,f=t-o,u=s+n,l=s-n,[a,,,,i]=Q(c,s);return a(c,s+r,t+e,u,t,u),a(t-e,u,f,s+r,f,s),a(f,s-r,t-e,l,t,l),a(t+e,l,c,s-r,c,s),i(!0)}function Zt(t){let s=v(t,\"x\"),o=v(t,\"y\"),n=v(t,\"width\"),e=v(t,\"height\");if(n<1e-12||e<1e-12)return null;let r=v(t,\"rx\",NaN),c=v(t,\"ry\",NaN);if(Number.isNaN(r)&&(r=Number.isNaN(c)?0:c),Number.isNaN(c)&&(c=r),r=Math.min(Math.max(r,0),n/2),c=Math.min(Math.max(c,0),e/2),r<1e-12||c<1e-12)return et([s,o,s+n,o,s+n,o+e,s,o+e],!0);let f=s+r,u=s+n-r,l=s+n,a=o+c,i=o+e-c,m=o+e,p=Y*r,d=Y*c,[k,y,,,I]=Q(f,o);return y(u,o),k(u+p,o,l,a-d,l,a),y(l,i),k(l,i+d,u+p,m,u,m),y(f,m),k(f-p,m,s,i+d,s,i),y(s,a),k(s,a-d,f-p,o,f,o),I(!0)}function Z(t){let s=[],o=n=>{n&&s.push(n)};if(typeof t==\"string\"){for(let n of dt(t))o(xt(n));return s}for(let[n,e]of t)switch(n){case\"path\":for(let r of dt(String(e.d??\"\")))o(xt(r));break;case\"line\":{let[,r,,,c]=Q(v(e,\"x1\"),v(e,\"y1\"));r(v(e,\"x2\"),v(e,\"y2\")),o(c(!1));break}case\"circle\":{let r=v(e,\"r\");o(kt(v(e,\"cx\"),v(e,\"cy\"),r,r));break}case\"ellipse\":o(kt(v(e,\"cx\"),v(e,\"cy\"),v(e,\"rx\"),v(e,\"ry\")));break;case\"rect\":o(Zt(e));break;case\"polyline\":o(et(wt(e.points),!1));break;case\"polygon\":o(et(wt(e.points),!0));break;default:throw new Error(`morphicons: unsupported tag <${n}>`)}return s}function vt(t){return t.items.map(()=>new Float64Array(2*t.n))}function Ft(t,s,o){for(let n=0;n<t.items.length;n++){let e=t.items[n],r=o[n],c=t.n,f=Math.exp(e.lnSigma*s),u=e.theta*s,l=Math.cos(u)*f,a=Math.sin(u)*f,i,m;if(e.block){let[p,d]=e.block.off,[k,y]=e.block.drift;i=e.ca[0]+k*s+(p*l-d*a-p),m=e.ca[1]+y*s+(p*a+d*l-d)}else i=e.ca[0]+(e.cb[0]-e.ca[0])*s,m=e.ca[1]+(e.cb[1]-e.ca[1])*s;for(let p=0;p<c;p++){let d=e.aC[2*p]+(e.bT[2*p]-e.aC[2*p])*s,k=e.aC[2*p+1]+(e.bT[2*p+1]-e.aC[2*p+1])*s;r[2*p]=i+d*l-k*a,r[2*p+1]=m+d*a+k*l}}}var Ht=.35,Xt=.05,Ut=.005,Jt=8,Kt=1e5;function j(t){let s=t.length/2,o=0,n=0;for(let e=0;e<s;e++)o+=t[2*e],n+=t[2*e+1];return[o/s,n/s]}function It(t){let s=t.length/2,o=0;for(let n=1;n<s;n++)o+=Math.hypot(t[2*n]-t[2*n-2],t[2*n+1]-t[2*n-1]);return o}function tn(t){let s=t.length/2,o=new Float64Array(2*s);for(let n=0;n<s;n++)o[2*n]=t[2*(s-1-n)],o[2*n+1]=t[2*(s-1-n)+1];return o}function nn(t,s){let o=t.length/2,n=new Float64Array(2*o);for(let e=0;e<o;e++){let r=(e+s)%o;n[2*e]=t[2*r],n[2*e+1]=t[2*r+1]}return n}function ot(t,s,o,n){let e=t.length/2,r=0,c=0,f=0,u=0,l=0,a=0;for(let y=0;y<e;y++){let I=t[2*y]-o[0],w=t[2*y+1]-o[1],h=s[2*y]-n[0],g=s[2*y+1]-n[1];r+=I*h,u+=w*g,c+=I*g,f+=w*h,l+=I*I+w*w,a+=h*h+g*g}let i=Math.atan2(c-f,r+u),m=Math.cos(i)*(r+u)+Math.sin(i)*(c-f),p=l>1e-12?m/l:1;p>1e-6||(p=1e-6);let d=Math.max(0,p*p*l-2*p*m+a),k=a>1e-12?Math.sqrt(d/a):0;return{theta:i,sigma:p,res:k}}function en(t,s,o=!1,n=!1){let e=j(t),r=j(s),c=o&&!n,f=c?t:s,u=o||n?f.length/2:1,l=Number.POSITIVE_INFINITY,a=f,i={theta:0,sigma:1,res:0};for(let m=0;m<2;m++){let p=m?tn(f):f;for(let d=0;d<u;d++){let k=d?nn(p,d):p,y=c?ot(k,s,e,r):ot(t,k,e,r),I=y.res+Xt*Math.abs(y.theta)/Math.PI;I<l&&(l=I,a=k,i=y)}}return c?{ca:e,cb:r,a,b:s,...i}:{ca:e,cb:r,a:t,b:a,...i}}function st(t,s){let o=s.map(j),n=s.map(It);return t.map(e=>{let r=j(e),c=It(e);return o.map((f,u)=>Math.hypot(r[0]-f[0],r[1]-f[1])+Ht*Math.abs(c-n[u]))})}function sn(t){let s=t.length;if(s>Jt){let c=[];for(let l=0;l<s;l++)for(let a=0;a<s;a++)c.push([t[l][a],l,a]);c.sort((l,a)=>l[0]-a[0]);let f=new Array(s).fill(-1),u=new Array(s).fill(!1);for(let[,l,a]of c)f[l]<0&&!u[a]&&(f[l]=a,u[a]=!0);return f}let o=Array.from({length:s},(c,f)=>f),n=o.slice(),e=Number.POSITIVE_INFINITY,r=(c,f,u)=>{if(!(u>=e)){if(f===s){e=u,n=c.slice();return}for(let l=f;l<s;l++)[c[f],c[l]]=[c[l],c[f]],r(c,f+1,u+t[f][c[f]]),[c[f],c[l]]=[c[l],c[f]]}};return r(o,0,0),n}function Pt(t){let s=t.length,o=t[0].length;if(o**s>Kt){let u=t.map(a=>{let i=0;for(let m=1;m<a.length;m++)a[m]<a[i]&&(i=m);return i}),l=new Array(o).fill(0);for(let a of u)l[a]++;for(let a=0;a<o;a++){if(l[a]>0)continue;let i=-1,m=Number.POSITIVE_INFINITY;for(let p=0;p<s;p++){if(l[u[p]]<2)continue;let d=t[p][a]-t[p][u[p]];d<m&&(m=d,i=p)}l[u[i]]--,u[i]=a,l[a]++}return u}let n=null,e=Number.POSITIVE_INFINITY,r=new Array(s),c=new Array(o).fill(0),f=(u,l,a)=>{if(!(l>=e||o-a>s-u)){if(u===s){e=l,n=r.slice();return}for(let i=0;i<o;i++)r[u]=i,c[i]++,f(u+1,l+t[u][i],a+(c[i]===1?1:0)),c[i]--}};if(f(0,0,0),!n)throw new Error(\"morphicons: no valid surjection (B < S)\");return n}function on(t,s){let o=t.length*s,n=new Float64Array(2*o),e=new Float64Array(2*o);t.forEach((i,m)=>{n.set(i.a,2*s*m),e.set(i.bO,2*s*m)});let r=j(n),c=ot(n,e,r,j(e));if(c.res>=Ut)return;let f=Math.cos(-c.theta),u=Math.sin(-c.theta),l=Math.cos(c.theta),a=Math.sin(c.theta);for(let i of t){let m=0,p=0;for(let A=0;A<s;A++){let b=i.bO[2*A]-i.cb[0],M=i.bO[2*A+1]-i.cb[1];i.bT[2*A]=(b*f-M*u)/c.sigma,i.bT[2*A+1]=(b*u+M*f)/c.sigma;let x=c.sigma*(l*i.aC[2*A]-a*i.aC[2*A+1])-b,N=c.sigma*(a*i.aC[2*A]+l*i.aC[2*A+1])-M;m+=x*x+N*N,p+=b*b+M*M}i.theta=c.theta,i.lnSigma=Math.log(c.sigma),i.res=p>1e-12?Math.sqrt(m/p):0;let d=Math.exp(i.lnSigma),k=Math.cos(i.theta)*d,y=Math.sin(i.theta)*d,I=i.ca[0]-r[0],w=i.ca[1]-r[1],h=I*k-w*y-I,g=I*y+w*k-w;i.block={off:[I,w],drift:[i.cb[0]-i.ca[0]-h,i.cb[1]-i.ca[1]-g]}}}function H(t,s){let o=t.length,n=s.length;if(o===0||n===0)throw new Error(\"morphicons: icon has no subpaths\");let e=t.map(l=>l.pts),r=s.map(l=>l.pts),c=[];if(o===n){let l=sn(st(e,r));for(let a=0;a<o;a++)c.push([a,l[a]])}else if(o<n){let l=Pt(st(r,e));for(let a=0;a<n;a++)c.push([l[a],a])}else{let l=Pt(st(e,r));for(let a=0;a<o;a++)c.push([a,l[a]])}let f=e[0].length/2,u=c.map(([l,a])=>{let i=en(e[l],r[a],t[l].closed,s[a].closed),m=i.a,p=new Float64Array(2*f),d=new Float64Array(2*f),k=new Float64Array(2*f),y=Math.cos(-i.theta),I=Math.sin(-i.theta);for(let w=0;w<f;w++){p[2*w]=m[2*w]-i.ca[0],p[2*w+1]=m[2*w+1]-i.ca[1];let h=i.b[2*w]-i.cb[0],g=i.b[2*w+1]-i.cb[1];d[2*w]=(h*y-g*I)/i.sigma,d[2*w+1]=(h*I+g*y)/i.sigma,k[2*w]=i.b[2*w],k[2*w+1]=i.b[2*w+1]}return{a:m,aC:p,bT:d,bO:k,ca:i.ca,cb:i.cb,theta:i.theta,lnSigma:Math.log(i.sigma),res:i.res,closed:t[l].closed&&s[a].closed,block:null}});return u.length>1&&on(u,f),{items:u,n:f}}var Ct=Math.PI/8,St=[.18343464249564978,.525532409916329,.7966664774136267,.9602898564975363],cn=[.362683783378362,.31370664587788727,.22238103445337448,.10122853629037626];function ct(t,s,o){let n=6*s,e=1-o,r=3*e*e,c=6*e*o,f=3*o*o,u=r*(t[n+2]-t[n])+c*(t[n+4]-t[n+2])+f*(t[n+6]-t[n+4]),l=r*(t[n+3]-t[n+1])+c*(t[n+5]-t[n+3])+f*(t[n+7]-t[n+5]);return Math.hypot(u,l)}function rt(t,s,o=1){let n=o/2,e=0;for(let r=0;r<4;r++)e+=cn[r]*(ct(t,s,n+n*St[r])+ct(t,s,n-n*St[r]));return e*n}function rn(t,s,o,n,e){let r=6*s,c=1-o,f=c*c*c,u=3*c*c*o,l=3*c*o*o,a=o*o*o;n[e]=f*t[r]+u*t[r+2]+l*t[r+4]+a*t[r+6],n[e+1]=f*t[r+1]+u*t[r+3]+l*t[r+5]+a*t[r+7]}function Tt(t,s,o){let n=6*s,e=o?n+6:n,r=o?-1:1;for(let c of o?[4,2,0]:[2,4,6]){let f=r*(t[n+c]-t[e]),u=r*(t[n+c+1]-t[e+1]);if(f*f+u*u>1e-18)return[f,u]}return null}function an(t,s=Ct){let o=t.pts,n=(o.length/2-1)/3,e=[];for(let f=0;f<n;f++)rt(o,f)>1e-9&&e.push(f);if(e.length===0)return[];let r=new Set,c=(f,u)=>{let l=Tt(o,f,!0),a=Tt(o,u,!1);!l||!a||Math.abs(Math.atan2(l[0]*a[1]-l[1]*a[0],l[0]*a[0]+l[1]*a[1]))>s&&r.add(u)};for(let f=0;f+1<e.length;f++)c(e[f],e[f+1]);return t.closed&&e.length>1&&c(e[e.length-1],e[0]),[...r].sort((f,u)=>f-u)}function ln(t,s,o,n){if(o<=0)return 0;if(o>=n)return 1;let e=0,r=1,c=o/n;for(let f=0;f<12;f++){let u=rt(t,s,c)-o;if(Math.abs(u)<1e-10*n+1e-14)break;u>0?r=c:e=c;let l=ct(t,s,c),a=l>1e-12?c-u/l:(e+r)/2;a>e&&a<r||(a=(e+r)/2),c=a}return c}function fn(t,s=64,o=Ct){let n=t.pts,e=(n.length/2-1)/3,r=new Float64Array(2*s),c=()=>{for(let h=0;h<s;h++)r[2*h]=n[0],r[2*h+1]=n[1];return r};if(e<1)return c();let f=new Array(e),u=0;for(let h=0;h<e;h++)f[h]=rt(n,h),u+=f[h];if(u<1e-12)return c();let l=an(t,o),a=t.closed?l.length>0?l:[0]:[...new Set([0,...l,e])].sort((h,g)=>h-g),i=[];if(t.closed)for(let h=0;h<a.length;h++){let g=a[h],A=h+1<a.length?a[h+1]:a[0]+e;i.push([g,A])}else for(let h=0;h+1<a.length;h++)i.push([a[h],a[h+1]]);let m=i.map(([h,g])=>{let A=0;for(let b=h;b<g;b++)A+=f[b%e];return A}),p=t.closed?s:s-1;if(i.length>p)throw new Error(`morphicons: N=${s} too small (${i.length} runs)`);let d=m.reduce((h,g)=>h+g,0)||1,k=m.map(h=>p*h/d),y=k.map(h=>Math.max(1,Math.floor(h))),I=p-y.reduce((h,g)=>h+g,0);if(I>0){let h=k.map((g,A)=>[Math.round((g-Math.floor(g))*1e9),A]).sort((g,A)=>A[0]-g[0]||g[1]-A[1]);for(let g=0;g<I;g++)y[h[g%y.length][1]]++}for(;I<0;){let h=0;for(let g=1;g<y.length;g++)y[g]>y[h]&&(h=g);if(y[h]<=1)break;y[h]--,I++}let w=0;for(let h=0;h<i.length;h++){let[g,A]=i[h],b=y[h],M=m[h],x=6*(g%e);r[2*w]=n[x],r[2*w+1]=n[x+1],w++;let N=g,P=0;for(let T=1;T<b;T++){let C=M*T/b;for(;N<A-1&&P+f[N%e]<C;)P+=f[N%e],N++;let F=N%e,E=f[F];rn(n,F,E>1e-12?ln(n,F,C-P,E):0,r,2*w),w++}}if(!t.closed){let h=6*e;r[2*w]=n[h],r[2*w+1]=n[h+1]}return r}function at(t,s=64){return Z(t).map(o=>({pts:fn(o,s),closed:o.closed}))}var Et=class{x=1;v=0;k=250;c=24;config(t,s){this.k=t,this.c=s}start(){this.x=0,this.v>14&&(this.v=14),this.v<-14&&(this.v=-14)}step(t){let s=Math.max(1,Math.min(16,Math.ceil(t/.004166666666666667))),o=t/s;for(let n=0;n<s;n++){let e=this.k*(1-this.x)-this.c*this.v;this.v+=e*o,this.x+=this.v*o}return Math.abs(1-this.x)<.001&&Math.abs(this.v)<.02}},it={smooth:{k:170,c:26},snappy:{k:420,c:30},bouncy:{k:300,c:14}};var B=new Set,L=0,_=-1;function jt(t){let s=_<0?0:Math.min(Math.max((t-_)/1e3,0),.1);_=t;for(let o of[...B])o(s);B.size>0?L=requestAnimationFrame(jt):(L=0,_=-1)}function un(t){B.add(t),L===0&&(_=-1,L=requestAnimationFrame(jt))}function hn(t){B.delete(t),B.size===0&&L!==0&&(cancelAnimationFrame(L),L=0,_=-1)}var $t=new WeakMap,Lt=new WeakMap,Ot=new WeakMap;function q(t){if(typeof t==\"string\")return at(t);let s=$t.get(t);return s||(s=at(t),$t.set(t,s)),s}function lt(t){if(typeof t==\"string\")return t;let s=Lt.get(t);return s||(s=Nt(Z(t)),Lt.set(t,s)),s}function mn(t,s){if(typeof t==\"string\"||typeof s==\"string\")return H(q(t),q(s));let o=Ot.get(t);o||(o=new WeakMap,Ot.set(t,o));let n=o.get(s);return n||(n=H(q(t),q(s)),o.set(s,n)),n}function pn(t){if(typeof t==\"string\")return it[t];let s=it.snappy;return{k:t?.stiffness??s.k,c:t?.damping??s.c}}function gn(t,s,o){let n=new Et,e=o?.reducedMotion??\"never\",r=s,c=!0,f=null,u=null,l=null,a=1,i=!1,m=!1;t.setAttribute(\"d\",lt(s));let p=b=>{let M=f,x=u,N=l;!M||!x||!N||(a=b,Ft(M,b,x),t.setAttribute(\"d\",At(x,N)))},d=()=>{i&&(i=!1,hn(k))},k=b=>{let M=n.step(b);p(n.x),M&&(d(),y())},y=()=>{c=!0,f=null,u=null,l=null,a=1,n.x=1,n.v=0,t.setAttribute(\"d\",lt(r))},I=()=>{let b=f,M=u;return c||!b||!M?q(r):M.map((x,N)=>({pts:Float64Array.from(x),closed:b.items[N].closed}))},w=b=>{f=c?mn(r,b):H(I(),q(b)),u=vt(f),l=f.items.map(M=>M.closed),r=b,c=!1},h=b=>{d(),r=b,y()},g=()=>e===\"always\"?!0:e!==\"user\"||typeof matchMedia>\"u\"?!1:matchMedia?.(\"(prefers-reduced-motion: reduce)\").matches??!1,A=(b,M)=>{if(m)return;let x=!c&&f!==null&&b===r;d(),n.v=0,x||w(b),p(M)};return{morphTo(b,M){if(m||b===r&&(c||i))return;if(g()){h(b);return}let{k:x,c:N}=pn(M);n.config(x,N),w(b),n.start(),i||(i=!0,un(k))},set(b){m||h(b)},seek:A,get progress(){return c?1:a},set progress(b){m||A(r,b)},get reducedMotion(){return e},set reducedMotion(b){e=b},destroy(){d(),m=!0,f=null,u=null,l=null}}}return Wt(bn);})();\n"},"/navicons.js":{"type":"text/javascript; charset=utf-8","body":"// 選單圖示：每個圖示在兩個符號之間循環形變（Morphicons 引擎，Lucide 圖示）。\n// 節奏沿用 Sam 認可的圖鑑：端點停留長、形變短（320–440 毫秒），五組週期與起始時間錯開。\n// 一個計時器推動全部圖示；分頁在背景時停止；系統設定「減少動態」時固定顯示 A 符號。\n(function () {\n  'use strict';\n  var NS = 'http://www.w3.org/2000/svg';\n  var N = {\n    house: [['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }], ['path', { d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],\n    chart: [['path', { d: 'M3 3v16a2 2 0 0 0 2 2h16' }], ['path', { d: 'M18 17V9' }], ['path', { d: 'M13 17V5' }], ['path', { d: 'M8 17v-3' }]],\n    receipt: [['path', { d: 'M12 17V7' }], ['path', { d: 'M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8' }], ['path', { d: 'M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z' }]],\n    coin: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8' }], ['path', { d: 'M12 18V6' }]],\n    calendar: [['path', { d: 'M8 2v3' }], ['path', { d: 'M16 2v3' }], ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M3 9h18' }]],\n    sun: [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2v2' }], ['path', { d: 'M12 20v2' }], ['path', { d: 'm4.93 4.93 1.41 1.41' }], ['path', { d: 'm17.66 17.66 1.41 1.41' }], ['path', { d: 'M2 12h2' }], ['path', { d: 'M20 12h2' }], ['path', { d: 'm6.34 17.66-1.41 1.41' }], ['path', { d: 'm19.07 4.93-1.41 1.41' }]],\n    clock: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 6v6l4 2' }]],\n    check: [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm16 9-5.5 5.5L8 12' }]],\n    briefcase: [['path', { d: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }], ['rect', { width: '20', height: '14', x: '2', y: '6', rx: '2' }]],\n    sprout: [['path', { d: 'M14 9.536V7a4 4 0 0 1 4-4h1.5a.5.5 0 0 1 .5.5V5a4 4 0 0 1-4 4 4 4 0 0 0-4 4c0 2 1 3 1 5a5 5 0 0 1-1 3' }], ['path', { d: 'M4 9a5 5 0 0 1 8 4 5 5 0 0 1-8-4' }], ['path', { d: 'M5 21h14' }]],\n    tree: [['path', { d: 'M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z' }], ['path', { d: 'M12 19v3' }]],\n    users: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['path', { d: 'M16 3.128a4 4 0 0 1 0 7.744' }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['circle', { cx: '9', cy: '7', r: '4' }]]\n  };\n  // 每一條輪廓有 a（起點）與 b（終點）：兩者都有就形變；只有 a 就收回；只有 b 就畫出。\n  // 一組內「主輪廓」永遠連續，多出來的細節各自展開或收回，不硬把線條拉成一團。\n  var CONFIG = {\n    home: [[{ a: N.house[1], b: N.chart[0] }, { a: N.house[0] }, { b: N.chart[1] }, { b: N.chart[2] }, { b: N.chart[3] }], [4400, 320, 1300, 650]],\n    expense: [[{ a: N.receipt[2], b: N.coin[0] }, { a: N.receipt[1], b: N.coin[1] }, { a: N.receipt[0], b: N.coin[2] }], [5300, 360, 1850, 1300]],\n    leave: [[{ a: N.calendar[2], b: N.sun[0] }, { a: N.calendar[0] }, { a: N.calendar[1] }, { a: N.calendar[3] }].concat(N.sun.slice(1).map(function (b) { return { b: b }; })), [6100, 380, 2150, 2050]],\n    checkin: [[{ a: N.clock[0], b: N.check[0] }, { a: N.clock[1], b: N.check[1] }], [4900, 360, 1750, 2800]],\n    brand: [[{ a: N.sprout[1], b: N.tree[0] }, { a: N.sprout[0], b: N.tree[1] }, { a: N.sprout[2] }], [5700, 400, 2000, 900]],\n    clients: [[{ a: N.briefcase[1], b: N.users[3] }, { a: N.briefcase[0], b: N.users[0] }, { b: N.users[1] }, { b: N.users[2] }], [6500, 440, 2300, 3500]]\n  };\n\n  var clamp = function (x) { return Math.max(0, Math.min(1, x)); };\n  var ease = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };\n  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');\n  var pairs = [];\n  var raf = 0, last = 0;\n\n  function makeChannel(svg, c) {\n    var node = document.createElementNS(NS, 'path');\n    node.setAttribute('pathLength', '1');\n    svg.appendChild(node);\n    var a = c.a ? [c.a] : null, b = c.b ? [c.b] : null;\n    var buffer = { d: '', setAttribute: function (k, v) { if (k === 'd') this.d = v; } };\n    var morph = Morphicons.createMorph(buffer, a || b);\n    var ad = a ? Morphicons.canonicalD(a) : null, bd = b ? Morphicons.canonicalD(b) : null;\n    node.setAttribute('d', ad || bd);\n    return { node: node, morph: morph, a: a, b: b, buffer: buffer, ad: ad, bd: bd };\n  }\n  function paint(ch, t) {\n    if (ch.a && ch.b) {\n      if (t === 0) ch.node.setAttribute('d', ch.ad);\n      else if (t === 1) ch.node.setAttribute('d', ch.bd);\n      else { ch.morph.seek(ch.b, t); ch.node.setAttribute('d', ch.buffer.d); }\n      return;\n    }\n    var amount = ch.b ? ease(clamp((t - 0.28) / 0.72)) : 1 - ease(clamp(t / 0.64));\n    ch.node.style.strokeDasharray = '1';\n    ch.node.style.strokeDashoffset = String(1 - amount);\n    ch.node.style.opacity = amount < 0.015 ? '0' : '1';\n  }\n\n  function create(key) {\n    var cfg = CONFIG[key];\n    var svg = document.createElementNS(NS, 'svg');\n    svg.setAttribute('viewBox', '0 0 24 24');\n    svg.setAttribute('aria-hidden', 'true');\n    svg.setAttribute('class', 'navicon');\n    var channels = cfg[0].map(function (c) { return makeChannel(svg, c); });\n    var ch = cfg[1];\n    var pair = { svg: svg, channels: channels, t: 0, to: 0, from: 0, elapsed: 0, active: false, local: 0, cycle: ch[0], dur: ch[1], hold: ch[2], next: ch[3] };\n    pair.render = function (t) { pair.t = t; channels.forEach(function (c) { paint(c, t); }); };\n    pair.render(0);\n    pairs.push(pair);\n    wake();\n    return svg;\n  }\n\n  // 推進 dt 毫秒（計時器與驗收共用）\n  function step(dt) {\n    pairs.forEach(function (p) {\n      p.local += dt;\n      if (p.local >= p.next && !p.active) {\n        p.from = p.t; p.to = 1 - p.to; p.elapsed = 0; p.active = true;\n        // 轉到 B 後停留 hold，再回 A 後停到週期結束，端點停留比形變久\n        p.next = p.local + (p.to ? p.hold : p.cycle - p.hold);\n      }\n      if (p.active) {\n        p.elapsed += dt;\n        var u = clamp(p.elapsed / p.dur);\n        p.render(p.from + (p.to - p.from) * ease(u));\n        if (u === 1) p.active = false;\n      }\n    });\n  }\n  function tick(now) {\n    raf = 0;\n    var dt = last ? Math.min(now - last, 100) : 0;\n    last = now;\n    if (document.hidden || reduced.matches) { last = 0; return; }\n    step(dt);\n    raf = requestAnimationFrame(tick);\n  }\n  function wake() { if (!raf && !document.hidden && !reduced.matches) { last = 0; raf = requestAnimationFrame(tick); } }\n  document.addEventListener('visibilitychange', function () { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; last = 0; } else wake(); });\n  reduced.addEventListener('change', function () {\n    if (reduced.matches) { cancelAnimationFrame(raf); raf = 0; pairs.forEach(function (p) { p.to = 0; p.active = false; p.render(0); }); }\n    else wake();\n  });\n\n  window.NavIcons = { create: create, step: step };\n})();\n"},"/style.css":{"type":"text/css; charset=utf-8","body":":root {\n  --bg: #1b1a18;\n  --surface: #252421;\n  --surface2: #33312d;\n  --ink: #f1eee7;\n  --ink2: #a7a399;\n  --line: #3a3834;\n  --accent: #7fbf95;\n  --accent-ink: #10150f;\n  --danger: #e0786f;\n  --warn: #d9b36a;\n  --cream: #ece6d8;\n  --cream-ink: #1f1d19;\n  --radius: 6px;\n  font-size: 16px;\n  color-scheme: dark;\n}\n* { box-sizing: border-box; }\nhtml, body { margin: 0; background: var(--bg); color: var(--ink); font-family: system-ui, \"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif; line-height: 1.6; }\nh1 { font-size: 1.5rem; margin: 0 0 .25rem; font-weight: 700; }\nh2 { font-size: 1.05rem; margin: 2rem 0 .5rem; font-weight: 700; }\np { margin: 0 0 .75rem; }\n.muted { color: var(--ink2); }\n.shell { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }\n.nav { border-right: 1px solid var(--line); padding: 1.25rem .75rem; position: sticky; top: 0; height: 100vh; overflow: auto; background: var(--surface); }\n.brand { display: flex; align-items: center; gap: .6rem; padding: 0 .5rem 1.25rem; font-weight: 700; }\n.brand { color: var(--accent); }\n.brand span { color: var(--ink); }\n.brand .navicon { width: 30px; height: 30px; }\n.nav a { display: flex; align-items: center; gap: .7rem; padding: .6rem .75rem; border-radius: var(--radius); color: var(--ink); text-decoration: none; min-height: 44px; }\n.navicon { width: 26px; height: 26px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }\n.nav a:hover { background: var(--surface2); }\n.nav a[aria-current=\"page\"] { background: var(--surface2); color: var(--accent); }\n.nav .who { margin-top: 1.5rem; padding: .75rem .5rem 0; border-top: 1px solid var(--line); font-size: .85rem; color: var(--ink2); overflow-wrap: anywhere; }\n.main { padding: 2rem clamp(1rem, 4vw, 3rem) 4rem; max-width: 1280px; width: 100%; margin: 0 auto; outline: none; }\nlabel { display: block; font-size: .9rem; color: var(--ink2); margin: 0 0 .25rem; }\ninput, select, textarea { width: 100%; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: .6rem .7rem; min-height: 44px; }\ntextarea { min-height: 88px; resize: vertical; }\ninput:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, .nav a:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }\n.field { margin-bottom: 1rem; }\n.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }\n.btn { font: inherit; min-height: 44px; padding: .55rem 1.1rem; border-radius: var(--radius); border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; }\n.btn:disabled { opacity: .55; cursor: default; }\n.btn.ghost { background: transparent; color: var(--accent); }\n.btn.danger { background: var(--danger); border-color: var(--danger); }\n.btn.small { min-height: 36px; padding: .3rem .8rem; font-size: .9rem; }\n.segment { display: flex; flex-wrap: wrap; gap: .5rem; }\n.segment label { margin: 0; }\n.segment input { position: absolute; opacity: 0; width: 1px; height: 1px; min-height: 0; }\n.segment span { display: inline-block; padding: .5rem 1rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--ink); cursor: pointer; min-height: 44px; line-height: 1.9; }\n.segment input:checked + span { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }\n.segment input:focus-visible + span { outline: 3px solid var(--accent); outline-offset: 1px; }\n.list { border-top: 1px solid var(--line); }\n.item { border-bottom: 1px solid var(--line); padding: .85rem 0; display: grid; grid-template-columns: 1fr auto; gap: .25rem 1rem; }\n.item .title { font-weight: 600; }\n.item .sub { color: var(--ink2); font-size: .9rem; grid-column: 1 / -1; overflow-wrap: anywhere; }\n.item .actions { display: flex; gap: .5rem; flex-wrap: wrap; grid-column: 1 / -1; margin-top: .4rem; }\n.state { font-size: .9rem; font-weight: 600; white-space: nowrap; }\n.state.ok { color: var(--accent); }\n.state.bad { color: var(--danger); }\n.state.wait { color: var(--warn); }\n.big { font-size: 2rem; font-weight: 700; line-height: 1.2; }\n.lines { display: grid; gap: .75rem; }\n.line-item { display: grid; grid-template-columns: 1fr 110px 120px 44px; gap: .5rem; align-items: end; }\n.line-item .x { min-width: 44px; }\n.total { text-align: right; font-weight: 700; margin: .5rem 0 1rem; }\n.empty { color: var(--ink2); padding: 1rem 0; }\n.err { color: var(--danger); }\n.toast { position: fixed; left: 50%; bottom: 5rem; transform: translateX(-50%) translateY(250%); background: var(--cream); color: var(--cream-ink); padding: .7rem 1.1rem; border-radius: var(--radius); max-width: 90vw; transition: transform .2s, opacity .2s; z-index: 30; opacity: 0; visibility: hidden; }\n.toast.show { transform: translateX(-50%) translateY(0); opacity: 1; visibility: visible; }\n.toast.bad { background: var(--danger); color: #1b0f0e; }\n.month-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .5rem; margin-top: 2rem; }\n.month-bar h2 { margin: 0; }\n.item.single { display: block; padding: 0; }\n.client summary { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; flex-wrap: wrap; padding: .85rem 0; cursor: pointer; min-height: 44px; }\n.client .title { font-weight: 600; }\n.client-body { padding: 0 0 1rem; }\n.client-body h3 { font-size: .95rem; margin: 1rem 0 .25rem; color: var(--ink2); }\n.log-entry { padding: .5rem 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }\n.checkin-form .field button { margin-top: .4rem; }\n@media (max-width: 760px) {\n  .shell { grid-template-columns: 1fr; }\n  .nav { position: fixed; bottom: 0; left: 0; right: 0; top: auto; height: auto; z-index: 10; display: flex; padding: 0; border-right: 0; border-top: 1px solid var(--line); overflow-x: auto; }\n  .brand, .nav .who { display: none; }\n  .nav a { flex: 1 0 auto; flex-direction: column; gap: 0; padding: .4rem .6rem; font-size: .72rem; min-width: 64px; justify-content: center; border-radius: 0; }\n  .main { padding-bottom: 6rem; }\n  .row2 { grid-template-columns: 1fr; gap: 0; }\n  .line-item { grid-template-columns: 1fr 1fr 44px; }\n  .line-item .desc { grid-column: 1 / -1; }\n}\n@media (prefers-reduced-motion: reduce) { .toast { transition: none; } }\n\n/* A34：最近送出每列只在最右端帶一小段顏色，區分報帳與請假 */\n.item.recent { position: relative; padding-right: 1.4rem; }\n.end-mark { position: absolute; right: 0; top: .85rem; bottom: .85rem; width: 5px; border-radius: 3px; }\n.end-mark.expense { background: var(--accent); }\n.end-mark.leave { background: var(--warn); }\n/* A213：客戶卡平時深色，展開中的那一張變奶油色 */\n.item.single { margin: .5rem 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 0 1rem; }\n.item.single:has(details[open]) { background: var(--cream); color: var(--cream-ink); border-color: var(--cream); }\n.item.single:has(details[open]) .muted { color: #5b574d; }\n.item.single:has(details[open]) .log-entry { border-top-color: #cfc8b6; }\n.item.single:has(details[open]) .client-body h3 { color: #5b574d; }\n.item.single:has(details[open]) a { color: #2d5a3f; }\n.legend { color: var(--ink2); font-size: .85rem; }\n\n.day-row { grid-template-columns: auto 1fr auto; align-items: center; cursor: pointer; }\n.day-row input { width: 22px; min-height: 22px; accent-color: var(--accent); }\n\n.client-body p { white-space: pre-wrap; overflow-wrap: anywhere; }\n\n@media (min-width: 761px) { .nav .who { display: grid; gap: .5rem; } }\n\n/* 兩欄版型：左欄操作、右欄紀錄；螢幕不夠寬時自動疊成一欄 */\n.cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 3rem; align-items: start; }\n@media (min-width: 1000px) { .cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }\n.col-side > h2:first-child { margin-top: 2rem; }\n@media (min-width: 1000px) { .col-side > h2:first-child, .col-main > h2:first-child { margin-top: 0; } }\n.client-list { max-width: 960px; }\n"},"/THIRD-PARTY-LICENSES.txt":{"type":"text/plain; charset=utf-8","body":"第三方授權\n\nmorphicons.js：Morphicons 1.7.1（MIT）\nhttps://github.com/guillermolg00/morphicons\n\nCopyright (c) 2026 Guillermo\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n\nnavicons.js 內的圖示向量：Lucide（ISC）\nhttps://lucide.dev\n\nCopyright (c) Lucide Icons and Contributors\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES\nWITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF\nMERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR\nANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES\nWHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN\nACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF\nOR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n\n形變節奏與配對編排的方法來自 Sam 2026-10-10 認可的 Morphicons 動態圖鑑。\n"}};

const NOTION_BASE = 'https://api.notion.com/v1/';
const LEAVE_TYPES = ['特休', '病假', '事假', '公假', '其他'];
const EXPENSE_CATS = ['交通費', '餐費', '住宿費', '材料費', '軟體訂閱', '培訓費', '其他'];
const WRITE_LIMIT_PER_MIN = 20;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' } });
}
const csv = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

// ── 登入：Google 登入（OpenID Connect + PKCE）＋簽章 Cookie 工作階段 ──────
// 流程：/auth/login 導向 Google → /auth/callback 換取並驗證 id_token → 只有 ALLOWED_EMAILS 內的信箱
// 拿得到 8 小時的工作階段 Cookie。每次請求都會重新核對信箱名單，所以從名單移除信箱即刻失效；
// 換掉 SESSION_SECRET 則所有人的登入立刻全部失效。

const SESSION_COOKIE = 'seed_session';
const OAUTH_COOKIE = 'seed_oauth';
const SESSION_TTL_SECONDS = 8 * 3600;
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const b64uToJson = s => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));
const bytesToB64u = bytes => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const strToB64u = s => bytesToB64u(new TextEncoder().encode(s));
const randomB64u = n => bytesToB64u(crypto.getRandomValues(new Uint8Array(n)));
const nowSec = () => Math.floor(Date.now() / 1000);

function authConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && String(env.SESSION_SECRET || '').length >= 32 && csv(env.ALLOWED_EMAILS).length);
}

async function hmacB64u(env, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToB64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
async function signToken(env, obj) {
  const payload = strToB64u(JSON.stringify(obj));
  return payload + '.' + await hmacB64u(env, payload);
}
async function readToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual(await hmacB64u(env, parts[0]), parts[1])) return null;
  try {
    const obj = b64uToJson(parts[0]);
    return obj && obj.exp > nowSec() ? obj : null;
  } catch (_) { return null; }
}

function getCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const setCookie = (name, value, maxAge, path) => `${name}=${value}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
function redirect(location, cookies = []) {
  const headers = new Headers({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Location': location });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}
function messagePage(status, title, text) {
  const body = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><h1>${title}</h1><p>${text}</p><p><a href="/auth/login">用其他 Google 帳號登入</a></p></body></html>`;
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function authenticate(request, env) {
  if (!authConfigured(env)) throw new HttpError(503, '登入尚未設定');
  const session = await readToken(env, getCookie(request, SESSION_COOKIE));
  if (!session || !session.email) throw new HttpError(401, '請先登入');
  const email = String(session.email).toLowerCase();
  if (!csv(env.ALLOWED_EMAILS).map(s => s.toLowerCase()).includes(email)) throw new HttpError(403, '這個帳號沒有使用權限');
  return email;
}

let googleKeys = { at: 0, keys: null };
async function loadGoogleKeys() {
  if (googleKeys.keys && Date.now() - googleKeys.at < 3600e3) return googleKeys.keys;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new HttpError(503, 'Google 登入服務暫時無法驗證');
  googleKeys = { at: Date.now(), keys: (await res.json()).keys || [] };
  return googleKeys.keys;
}

async function verifyGoogleIdToken(idToken, env, nonce) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('format');
  const header = b64uToJson(parts[0]);
  const payload = b64uToJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('alg');
  const jwk = (await loadGoogleKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  const now = nowSec();
  if (!ok || !GOOGLE_ISSUERS.includes(payload.iss) || payload.aud !== env.GOOGLE_CLIENT_ID || !(payload.exp > now)
    || payload.nonce !== nonce || payload.email_verified !== true || !payload.email) throw new Error('claims');
  return String(payload.email).toLowerCase();
}

async function handleAuthLogin(request, env, url) {
  if (!authConfigured(env)) throw new HttpError(503, '登入尚未設定');
  throttle('login:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), 20);
  const state = randomB64u(16), nonce = randomB64u(16), verifier = randomB64u(32);
  const challenge = bytesToB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const oauth = await signToken(env, { state, nonce, verifier, exp: nowSec() + 600 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/auth/callback', response_type: 'code',
    scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params, [setCookie(OAUTH_COOKIE, oauth, 600, '/auth')]);
}

async function handleAuthCallback(request, env, url) {
  if (!authConfigured(env)) throw new HttpError(503, '登入尚未設定');
  throttle('login:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), 20);
  const clearOauth = setCookie(OAUTH_COOKIE, '', 0, '/auth');
  const saved = await readToken(env, getCookie(request, OAUTH_COOKIE));
  const code = url.searchParams.get('code') || '', state = url.searchParams.get('state') || '';
  if (!saved || !code || !safeEqual(saved.state, state)) return messagePage(400, '登入失敗', '登入逾時或來源不正確，請重新登入。');
  let email;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/auth/callback', grant_type: 'authorization_code', code_verifier: saved.verifier }),
    });
    if (!res.ok) throw new Error('token');
    email = await verifyGoogleIdToken((await res.json()).id_token, env, saved.nonce);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return messagePage(400, '登入失敗', 'Google 驗證沒有通過，請重新登入。');
  }
  if (!csv(env.ALLOWED_EMAILS).map(s => s.toLowerCase()).includes(email)) {
    const page = messagePage(403, '沒有使用權限', '這個 Google 帳號不在允許名單內。');
    page.headers.append('Set-Cookie', clearOauth);
    return page;
  }
  const session = await signToken(env, { email, exp: nowSec() + SESSION_TTL_SECONDS });
  return redirect('/', [setCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS, '/'), clearOauth]);
}

const writeLog = new Map();
function throttle(key, limit) {
  const now = Date.now();
  const recent = (writeLog.get(key) || []).filter(t => now - t < 60e3);
  if (recent.length >= limit) throw new HttpError(429, '操作太頻繁，請稍後再試');
  recent.push(now);
  writeLog.set(key, recent);
}
const throttleWrites = key => throttle(key, WRITE_LIMIT_PER_MIN);

// ── Notion ───────────────────────────────────────────────────

async function notion(token, method, path, body) {
  if (!token) throw new HttpError(500, 'Notion 金鑰未設定');
  const res = await fetch(NOTION_BASE + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, 'Notion 回應錯誤（' + res.status + '）');
  return data;
}
const queryDb = (token, dbId, body) => notion(token, 'POST', `databases/${dbId}/query`, body).then(d => d.results || []);
const rt = v => [{ text: { content: String(v == null ? '' : v).slice(0, 1900) } }];
const plain = arr => (arr || []).map(t => t.plain_text || '').join('');
const getText = (pr, k) => plain(pr[k] && (pr[k].rich_text || pr[k].title));
const getSel = (pr, k) => (pr[k] && pr[k].select && pr[k].select.name) || '';
const getNum = (pr, k) => (pr[k] && pr[k].number != null ? pr[k].number : null);
const getDate = (pr, k) => (pr[k] && pr[k].date && pr[k].date.start) || '';
// CRM 的長文字欄位用 <br /> 表示換行，轉成真正的換行再顯示
const brText = t => String(t || '').replace(/<br\s*\/?>/gi, '\n');
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const sameId = (a, b) => String(a || '').replace(/-/g, '') === String(b || '').replace(/-/g, '');

async function loadPageIn(token, dbId, pageId) {
  if (!UUID.test(pageId)) throw new HttpError(400, '編號不正確');
  const page = await notion(token, 'GET', 'pages/' + pageId);
  if (!page.parent || !sameId(page.parent.database_id, dbId)) throw new HttpError(404, '找不到資料');
  return page;
}

// ── 輸入驗證 ─────────────────────────────────────────────────

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const isTime = s => s === '' || (typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
function str(v, max, required, label) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `請填寫${label}`);
  if (s.length > max) throw new HttpError(400, `${label}太長`);
  return s;
}
function oneOf(v, list, label) {
  if (!list.includes(v)) throw new HttpError(400, `${label}不正確`);
  return v;
}
function num(v, min, max, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label}不正確`);
  return n;
}
const twToday = (offsetDays = 0) => new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const newCode = prefix => prefix + '-' + twToday().replace(/-/g, '').slice(2) + '-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
const applicant = (v, env) => oneOf(typeof v === 'string' ? v.trim() : '', csv(env.APPLICANTS), '申請人');

// ── LINE ─────────────────────────────────────────────────────

// 只有 LINE Worker（MODE=line）持有 LINE 金鑰與群組編號。網站 Worker 要通知時，
// 帶共用密鑰呼叫 LINE Worker 的 /api/line/notify，由它發出；訊息內容由網站 Worker 自己組，瀏覽器無法指定。
async function linePushDirect(env, text) {
  if (!env.LINE_CHANNEL_TOKEN || !env.LINE_GROUP_ID) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.LINE_CHANNEL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: env.LINE_GROUP_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
}
async function linePush(env, text) {
  try {
    if (env.MODE === 'line') return await linePushDirect(env, text);
    if (!env.LINE_NOTIFY_URL || !env.NOTIFY_KEY) return;
    await fetch(env.LINE_NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notify-Key': env.NOTIFY_KEY },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
    });
  } catch (_) { /* 通知失敗不影響記錄 */ }
}
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleLineNotify(request, env) {
  if (!safeEqual(request.headers.get('X-Notify-Key'), env.NOTIFY_KEY)) throw new HttpError(401, '密鑰不正確');
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 4000) throw new HttpError(400, '訊息內容不正確');
  await linePushDirect(env, text);
  return json({ ok: true });
}
async function lineReply(env, replyToken, text) {
  if (!env.LINE_CHANNEL_TOKEN || !replyToken) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.LINE_CHANNEL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
}

async function verifyLineSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  let expected = '';
  for (const b of mac) expected += String.fromCharCode(b);
  expected = btoa(expected);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function leaveOn(env, date) {
  const rows = await queryDb(env.HR_TOKEN, env.DB_LEAVE, {
    filter: { and: [{ property: '開始日期', date: { on_or_before: date } }, { property: '結束日期', date: { on_or_after: date } }] },
    sorts: [{ property: '開始日期', direction: 'ascending' }],
  });
  return rows.map(r => ({ name: getText(r.properties, '姓名') || '未知', type: getSel(r.properties, '假別'), days: getNum(r.properties, '請假天數') }));
}
// 請假以小時為單位；Notion 的「請假天數」欄存「小時 ÷ 8」，顯示時換回「N 天 M 小時」
const fmtLeave = days => {
  const hours = Math.round(Number(days || 0) * 16) / 2;
  const d = Math.floor(hours / 8), r = hours - d * 8;
  return [d ? d + ' 天' : '', r ? r + ' 小時' : ''].filter(Boolean).join(' ') || '0 小時';
};
const leaveLines = list => list.map(x => `• ${x.name}　${x.type}${x.days ? '　' + fmtLeave(x.days) : ''}`).join('\n');

async function dailyNotice(env) {
  const today = twToday();
  const list = await leaveOn(env, today);
  await linePush(env, `📅 今日請假（${today}）\n` + (list.length ? leaveLines(list) + `\n共 ${list.length} 人` : '今日無人請假'));
}

async function handleLineEvent(event, env) {
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;
  if (!event.source || event.source.type !== 'group' || !env.LINE_GROUP_ID || event.source.groupId !== env.LINE_GROUP_ID) return;
  const allowed = csv(env.LINE_ALLOWED_USER_IDS);
  if (allowed.length && !allowed.includes(String(event.source.userId || ''))) return;
  if (!((event.message.mention || {}).mentionees || []).some(m => m.isSelf === true)) return;
  const text = String(event.message.text || '').replace(/@\S+/g, '').trim().slice(0, 100);
  const reply = msg => lineReply(env, event.replyToken, msg);

  if (text === '今日請假') {
    const today = twToday();
    const list = await leaveOn(env, today);
    return reply(`📅 今日請假（${today}）\n` + (list.length ? leaveLines(list) : '今日無人請假'));
  }
  const m = text.match(/^請假查詢\s+(\S{1,30})$/);
  if (m) {
    const rows = await queryDb(env.HR_TOKEN, env.DB_LEAVE, { filter: { property: '姓名', rich_text: { contains: m[1] } }, sorts: [{ property: '開始日期', direction: 'descending' }], page_size: 5 });
    if (!rows.length) return reply(`找不到 ${m[1]} 的請假記錄`);
    return reply(`📋 ${m[1]} 最近請假\n` + rows.map(r => `• ${getDate(r.properties, '開始日期')}～${getDate(r.properties, '結束日期')}　${getSel(r.properties, '假別')}`).join('\n'));
  }
  return reply('📋 可用指令（先 @我）：\n・今日請假\n・請假查詢 姓名');
}

async function handleLineWebhook(request, env, ctx) {
  const raw = await request.text();
  if (!await verifyLineSignature(raw, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) {
    return new Response('Invalid signature', { status: 401, headers: SECURITY_HEADERS });
  }
  let events = [];
  try { events = JSON.parse(raw).events || []; } catch (_) { /* 簽章正確但內容壞掉，當作沒事件 */ }
  const work = Promise.allSettled(events.slice(0, 20).map(e => handleLineEvent(e, env)));
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return new Response('OK', { status: 200, headers: SECURITY_HEADERS });
}

// ── CRM 歷史日誌（客戶頁面內容，依日期分組，每件事單獨一則）─────

const LOG_NOTE = /^(日期說明|說明|注意|須知|備註|提醒|重要)[：:]/;
function parseClientLog(blocks) {
  const days = [];
  let day = null;
  for (const b of blocks) {
    const body = b[b.type];
    if (!body || !Array.isArray(body.rich_text)) continue;
    const text = plain(body.rich_text).replace(/<br\s*\/?>/gi, '\n').trim();
    const links = body.rich_text.filter(t => t.href && t.plain_text.trim()).map(t => ({ text: t.plain_text.trim(), href: t.href }))
      .filter(l => /^https:\/\//.test(l.href));
    if (!text) continue;
    if (/^heading_/.test(b.type)) {
      if (text.includes('歷史日誌')) continue;
      day = { date: text, entries: [] };
      days.push(day);
      continue;
    }
    if (!day || LOG_NOTE.test(text)) continue;
    day.entries.push({ text: text.replace(/^[•・-]\s*/, ''), links });
  }
  return days.filter(d => d.entries.length);
}

// ── API ──────────────────────────────────────────────────────

const monthRange = month => {
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
};


// 國定假日（只列平日放假與補假；週末一律不排班）。資料來源：ruyut/TaiwanCalendar 2026.json，
// 使用前請以行政院人事行政總處公告為準。2026 年沒有週末補班日；其他年份沒有資料時預覽會提醒。
const HOLIDAYS = {
  '2026-01-01': '開國紀念日', '2026-02-16': '農曆除夕', '2026-02-17': '春節', '2026-02-18': '春節', '2026-02-19': '春節',
  '2026-02-20': '補假', '2026-02-27': '補假', '2026-04-03': '補假', '2026-04-06': '補假', '2026-05-01': '勞動節',
  '2026-06-19': '端午節', '2026-09-25': '中秋節', '2026-09-28': '教師節', '2026-10-09': '補假', '2026-10-26': '補假',
  '2026-12-25': '行憲紀念日',
};
const MAKEUP_WORKDAYS = {};
const HOLIDAY_YEARS = ['2026'];
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const validMonth = v => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v || '')) throw new HttpError(400, '月份不正確');
  return v;
};

async function checkinPlan(env, name, month) {
  const { start, end } = monthRange(month);
  const [existing, leaves] = await Promise.all([
    queryDb(env.HR_TOKEN, env.DB_CHECKIN, { filter: { and: [{ property: '姓名', title: { equals: name } }, { property: '日期', date: { on_or_after: start } }, { property: '日期', date: { on_or_before: end } }] }, page_size: 100 }),
    queryDb(env.HR_TOKEN, env.DB_LEAVE, { filter: { and: [{ property: '姓名', rich_text: { equals: name } }, { property: '開始日期', date: { on_or_before: end } }, { property: '結束日期', date: { on_or_after: start } }] }, page_size: 100 }),
  ]);
  const done = new Set(existing.map(r => getDate(r.properties, '日期').slice(0, 10)));
  const leaveDays = new Set();
  for (const r of leaves) {
    const a = getDate(r.properties, '開始日期').slice(0, 10), b = getDate(r.properties, '結束日期').slice(0, 10) || a;
    for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d = new Date(d.getTime() + 86400e3)) leaveDays.add(d.toISOString().slice(0, 10));
  }
  const days = [];
  const last = Number(end.slice(8));
  for (let i = 1; i <= last; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`;
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekend = (dow === 0 || dow === 6) && !MAKEUP_WORKDAYS[date];
    if (weekend) continue;
    let status = 'work', label = '';
    if (HOLIDAYS[date]) { status = 'holiday'; label = HOLIDAYS[date]; }
    else if (leaveDays.has(date)) { status = 'leave'; label = '請假'; }
    else if (done.has(date)) { status = 'done'; label = '已有簽到'; }
    days.push({ date, dow: WEEKDAY_NAMES[dow], status, label, checked: status === 'work' });
  }
  return { month, hasHolidayData: HOLIDAY_YEARS.includes(month.slice(0, 4)), days };
}

async function api(request, env, ctx, url) {
  const email = await authenticate(request, env);
  const method = request.method;
  const path = url.pathname;
  if (method !== 'GET') {
    if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, '來源不被允許');
    throttleWrites(email);
  }
  const body = (method === 'GET' || method === 'HEAD') ? {} : await request.json().catch(() => { throw new HttpError(400, '資料格式錯誤'); });
  let m;

  if (method === 'GET' && path === '/api/me') return json({ email });

  if (method === 'GET' && path === '/api/config') {
    return json({ applicants: csv(env.APPLICANTS), leaveTypes: LEAVE_TYPES, expenseCats: EXPENSE_CATS });
  }

  if (method === 'GET' && path === '/api/home') {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : twToday().slice(0, 7);
    const { start, end } = monthRange(month);
    const [today, leaves, expenses] = await Promise.all([
      leaveOn(env, twToday()),
      queryDb(env.HR_TOKEN, env.DB_LEAVE, { filter: { and: [{ property: '開始日期', date: { on_or_after: start } }, { property: '開始日期', date: { on_or_before: end } }] }, sorts: [{ property: '開始日期', direction: 'descending' }], page_size: 100 }),
      queryDb(env.HR_TOKEN, env.DB_EXPENSE, { filter: { and: [{ timestamp: 'created_time', created_time: { on_or_after: start } }, { timestamp: 'created_time', created_time: { on_or_before: end + 'T23:59:59+08:00' } }] }, sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 }),
    ]);
    const leaveBy = {}, expBy = {};
    const entries = [];
    for (const r of leaves) {
      const n = getText(r.properties, '姓名') || '未知', d = getNum(r.properties, '請假天數') || 0;
      (leaveBy[n] = leaveBy[n] || { name: n, days: 0, count: 0 }).days += d; leaveBy[n].count++;
      entries.push({ kind: '請假', name: n, text: `${getSel(r.properties, '假別')} ${fmtLeave(d)}`, date: getDate(r.properties, '開始日期'), at: r.created_time });
    }
    for (const r of expenses) {
      const n = getText(r.properties, '姓名') || '未知', t = getNum(r.properties, '合計金額') || 0;
      (expBy[n] = expBy[n] || { name: n, total: 0, count: 0 }).total += t; expBy[n].count++;
      entries.push({ kind: '報帳', name: n, text: `NT$${t.toLocaleString('en-US')}　${getText(r.properties, '專案用途')}`.trim(), date: (r.created_time || '').slice(0, 10), at: r.created_time });
    }
    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return json({ month, today: twToday(), todayLeaves: today, leaveByPerson: Object.values(leaveBy), expenseByPerson: Object.values(expBy), recent: entries.slice(0, 10) });
  }

  if (path === '/api/leave') {
    if (method === 'GET') {
      const rows = await queryDb(env.HR_TOKEN, env.DB_LEAVE, { sorts: [{ property: '開始日期', direction: 'descending' }], page_size: 30 });
      return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '姓名'), type: getSel(r.properties, '假別'), start: getDate(r.properties, '開始日期'), end: getDate(r.properties, '結束日期'), days: getNum(r.properties, '請假天數'), reason: getText(r.properties, '請假原因') })) });
    }
    if (method === 'POST') {
      const name = applicant(body.name, env);
      const type = oneOf(body.type, LEAVE_TYPES, '假別');
      if (!isDate(body.start) || !isDate(body.end) || body.end < body.start) throw new HttpError(400, '日期不正確');
      const hours = num(body.hours, 0.5, 480, '請假時數');
      if (hours * 2 !== Math.round(hours * 2)) throw new HttpError(400, '請假時數最小單位是 0.5 小時');
      const spanDays = Math.round((new Date(body.end + 'T00:00:00Z') - new Date(body.start + 'T00:00:00Z')) / 86400e3) + 1;
      if (hours > spanDays * 8) throw new HttpError(400, '請假時數超過日期範圍（每天最多 8 小時）');
      const days = Math.round(hours / 8 * 1000) / 1000;
      const reason = str(body.reason, 500, false, '原因');
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_LEAVE }, properties: {
        '申請編號': { title: rt(newCode('REQ')) }, '姓名': { rich_text: rt(name) }, '假別': { select: { name: type } },
        '開始日期': { date: { start: body.start } }, '結束日期': { date: { start: body.end } },
        '請假天數': { number: days }, '請假原因': { rich_text: rt(reason) }, '審核狀態': { select: { name: '已登記' } },
      } });
      ctx.waitUntil(linePush(env, `📋 新請假\n${name}　${type}\n${body.start} ～ ${body.end}（${fmtLeave(days)}）${reason ? '\n原因：' + reason : ''}`));
      return json({ ok: true });
    }
  }

  if (path === '/api/expenses') {
    if (method === 'GET') {
      const rows = await queryDb(env.HR_TOKEN, env.DB_EXPENSE, { sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 30 });
      return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '姓名'), total: getNum(r.properties, '合計金額'), detail: getText(r.properties, '費用明細'), project: getText(r.properties, '專案用途'), created: (r.created_time || '').slice(0, 10) })) });
    }
    if (method === 'POST') {
      const name = applicant(body.name, env);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > 20) throw new HttpError(400, '請填寫 1 到 20 筆費用明細');
      const clean = items.map(i => ({ desc: str(i.desc, 100, true, '費用說明'), cat: oneOf(i.cat, EXPENSE_CATS, '費用類別'), amount: num(i.amount, 0, 10000000, '金額') }));
      const total = clean.reduce((s, i) => s + i.amount, 0);
      const project = str(body.project, 200, false, '專案用途');
      const note = str(body.note, 500, false, '備註');
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_EXPENSE }, properties: {
        '申請編號': { title: rt(newCode('EXP')) }, '姓名': { rich_text: rt(name) }, '合計金額': { number: total },
        '費用明細': { rich_text: rt(clean.map(i => `${i.desc}（${i.cat}）NT$${i.amount}`).join('、')) },
        '專案用途': { rich_text: rt(project) }, '備註': { rich_text: rt(note) }, '審核狀態': { select: { name: '已登記' } },
      } });
      ctx.waitUntil(linePush(env, `💰 新報帳\n${name}　NT$${Math.round(total).toLocaleString('en-US')}\n項目：${[...new Set(clean.map(i => i.cat))].join('、')}${project ? '\n專案：' + project : ''}`));
      return json({ ok: true });
    }
  }

  if (path === '/api/checkin') {
    if (method === 'GET') {
      const rows = await queryDb(env.HR_TOKEN, env.DB_CHECKIN, { sorts: [{ property: '日期', direction: 'descending' }], page_size: 40 });
      return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '姓名'), date: getDate(r.properties, '日期'), clockIn: getText(r.properties, '上班時間'), clockOut: getText(r.properties, '下班時間'), note: getText(r.properties, '備註'), edited: r.last_edited_time || '' })) });
    }
    if (method === 'POST') {
      const name = applicant(body.name, env);
      if (!isDate(body.date) || !isTime(body.clockIn || '') || !isTime(body.clockOut || '') || !(body.clockIn || body.clockOut)) throw new HttpError(400, '日期或時間不正確');
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_CHECKIN }, properties: {
        '姓名': { title: rt(name) }, '日期': { date: { start: body.date } }, '上班時間': { rich_text: rt(body.clockIn || '') },
        '下班時間': { rich_text: rt(body.clockOut || '') }, '備註': { rich_text: rt(str(body.note, 300, false, '備註')) },
      } });
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/api\/checkin\/([0-9a-fA-F-]{32,36})$/)) && method === 'PATCH') {
    const page = await loadPageIn(env.HR_TOKEN, env.DB_CHECKIN, m[1]);
    if (!isDate(body.date) || !isTime(body.clockIn || '') || !isTime(body.clockOut || '') || !(body.clockIn || body.clockOut)) throw new HttpError(400, '日期或時間不正確');
    await notion(env.HR_TOKEN, 'PATCH', 'pages/' + page.id, { properties: {
      '日期': { date: { start: body.date } }, '上班時間': { rich_text: rt(body.clockIn || '') },
      '下班時間': { rich_text: rt(body.clockOut || '') }, '備註': { rich_text: rt(str(body.note, 300, false, '備註')) },
    } });
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/checkin/plan') {
    return json(await checkinPlan(env, applicant(url.searchParams.get('name'), env), validMonth(url.searchParams.get('month'))));
  }
  if (method === 'POST' && path === '/api/checkin/month') {
    const name = applicant(body.name, env);
    const month = validMonth(body.month);
    if (!isTime(body.clockIn || '') || !isTime(body.clockOut || '') || !body.clockIn || !body.clockOut) throw new HttpError(400, '請填上班與下班時間');
    const dates = Array.isArray(body.dates) ? [...new Set(body.dates)] : [];
    if (!dates.length || dates.length > 31 || !dates.every(d => isDate(d) && d.startsWith(month + '-'))) throw new HttpError(400, '日期不正確');
    const plan = await checkinPlan(env, name, month);
    const already = new Set(plan.days.filter(d => d.status === 'done').map(d => d.date));
    let created = 0;
    const skipped = [];
    for (const date of dates.sort()) {
      if (already.has(date)) { skipped.push(date); continue; }
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_CHECKIN }, properties: {
        '姓名': { title: rt(name) }, '日期': { date: { start: date } }, '上班時間': { rich_text: rt(body.clockIn) },
        '下班時間': { rich_text: rt(body.clockOut) }, '備註': { rich_text: rt('全月正常出勤') },
      } });
      created++;
    }
    return json({ ok: true, created, skipped });
  }

  if (path === '/api/clients' && method === 'GET') {
    const rows = await queryDb(env.CRM_TOKEN, env.DB_CRM, { sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }], page_size: 100 });
    return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '客戶名稱'), status: getSel(r.properties, '潛在客戶狀態'), priority: getSel(r.properties, '優先級'), action: brText(getText(r.properties, '下一步行動')), commitment: brText(getText(r.properties, '承諾事項')), notes: brText(getText(r.properties, '詳細現況備註')), amount: getNum(r.properties, '專案金額'), updated: (r.last_edited_time || '').slice(0, 10) })) });
  }
  if ((m = path.match(/^\/api\/clients\/([0-9a-fA-F-]{32,36})\/log$/)) && method === 'GET') {
    const page = await loadPageIn(env.CRM_TOKEN, env.DB_CRM, m[1]);
    const blocks = (await notion(env.CRM_TOKEN, 'GET', `blocks/${page.id}/children?page_size=100`)).results || [];
    return json({ days: parseClientLog(blocks) });
  }

  throw new HttpError(404, '找不到這個功能');
}

// ── 靜態頁面與進入點 ─────────────────────────────────────────

function serveAsset(path) {
  const a = ASSETS[path === '/' ? '/index.html' : path];
  if (!a) return null;
  return new Response(a.body, { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': a.type, 'Cache-Control': 'no-cache' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (env.MODE === 'line') {
        if (url.pathname === '/api/line/webhook' && request.method === 'POST') return await handleLineWebhook(request, env, ctx);
        if (url.pathname === '/api/line/notify' && request.method === 'POST') return await handleLineNotify(request, env);
        return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
      }
      if (url.pathname === '/auth/login' && request.method === 'GET') return await handleAuthLogin(request, env, url);
      if (url.pathname === '/auth/callback' && request.method === 'GET') return await handleAuthCallback(request, env, url);
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, '來源不被允許');
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0, '/') } });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
      if (request.method === 'GET') {
        try { await authenticate(request, env); } catch (e) {
          if (e instanceof HttpError && e.status === 401) return redirect('/auth/login');
          throw e;
        }
        const asset = serveAsset(url.pathname);
        if (asset) return asset;
      }
      return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log('[error]', e && e.message);
      return json({ error: '系統忙碌，請稍後再試' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (env.MODE !== 'line') return;
    const dow = new Date(Date.now() + 8 * 3600e3).getUTCDay();
    if (dow === 0 || dow === 6) return;
    ctx.waitUntil(dailyNotice(env));
  },
};
