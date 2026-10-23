/**
 * 種子 HR 系統 v2：單一 Cloudflare Worker（網頁 + API + LINE）
 *
 * 部署同一個檔案兩次：
 *   seed-hr       給 Sam 用。前面由 Cloudflare Access 擋住，只放行 Sam 的 Google 信箱。
 *   seed-hr-line  只收 LINE 通知、發每日通知。環境變數 MODE=line；其他路徑一律 404。
 *
 * 環境變數（皆在 Cloudflare 控制台填，不寫進程式）：
 *   ACCESS_TEAM_DOMAIN  例如 xxx.cloudflareaccess.com
 *   ACCESS_AUD          Access 應用程式的 AUD 標籤
 *   ALLOWED_EMAILS      逗號分隔，允許使用網站的 Google 信箱（即使 Access 設錯也會再擋一次）
 *   APPLICANTS          逗號分隔，可代為填單的人名，例如「甲,乙」
 *   HR_TOKEN / CRM_TOKEN   Notion 整合金鑰（CRM 那把只需讀取權限）
 *   DB_LEAVE DB_EXPENSE DB_CHECKIN DB_CRM
 *   LINE_CHANNEL_TOKEN LINE_CHANNEL_SECRET LINE_GROUP_ID
 *   LINE_ALLOWED_USER_IDS（選填，逗號分隔；有填就只接受這些人的指令）
 *
 * Cron（只設在 seed-hr-line）：UTC 01:00 週一到週五，即台灣 09:00 → 每日請假通知
 */

const ASSETS = {"/app.js":{"type":"text/javascript; charset=utf-8","body":"(function () {\n  'use strict';\n\n  // ── 小工具 ──────────────────────────────────────────────────\n  function h(tag, attrs) {\n    var el = document.createElement(tag);\n    if (attrs) Object.keys(attrs).forEach(function (k) {\n      var v = attrs[k];\n      if (v == null || v === false) return;\n      if (k === 'class') el.className = v;\n      else if (k === 'text') el.textContent = v;\n      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);\n      else el.setAttribute(k, v === true ? '' : v);\n    });\n    (function add(list) {\n      for (var i = 0; i < list.length; i++) {\n        var c = list[i];\n        if (c == null || c === false) continue;\n        if (Array.isArray(c)) add(c);\n        else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);\n      }\n    })(Array.prototype.slice.call(arguments, 2));\n    return el;\n  }\n  var $ = function (id) { return document.getElementById(id); };\n  var money = function (n) { return 'NT$' + Number(n || 0).toLocaleString('en-US'); };\n  var pad = function (n) { return String(n).padStart(2, '0'); };\n  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }\n  function nowTime() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }\n\n  var toastTimer;\n  function toast(msg, bad) {\n    var t = $('toast');\n    t.textContent = msg;\n    t.className = 'toast show' + (bad ? ' bad' : '');\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3200);\n  }\n\n  function api(method, path, body) {\n    var opts = { method: method, credentials: 'same-origin', headers: {} };\n    if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }\n    return fetch(path, opts).then(function (res) {\n      return res.json().catch(function () { return {}; }).then(function (data) {\n        if (!res.ok) throw new Error(data.error || '操作失敗（' + res.status + '）');\n        return data;\n      });\n    }, function () {\n      throw new Error('連線失敗，登入可能已過期，請重新整理頁面');\n    });\n  }\n\n  // 儲存上次選的申請人（瀏覽器可能禁用儲存，失敗就算了）\n  function remember(key, val) { try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; } }\n\n  // ── 圖示：7×7 點陣，亮點是符號，暗點是底格 ───────────────────\n  var ICONS = {\n    home: ['...#...', '..###..', '.#####.', '.#####.', '.##.##.', '.##.##.', '.#####.'],\n    expense: ['.#####.', '.#...#.', '.#.#.#.', '.#...#.', '.#.#.#.', '.#...#.', '.#.#.#.'],\n    leave: ['.#...#.', '#######', '#.....#', '#.#.#.#', '#.....#', '#.#.#.#', '#######'],\n    checkin: ['.#####.', '#..#..#', '#..#..#', '#..##.#', '#.....#', '#.....#', '.#####.'],\n    clients: ['..###..', '..#.#..', '#######', '#.....#', '#.###.#', '#.....#', '#######']\n  };\n  var SVGNS = 'http://www.w3.org/2000/svg';\n  function icon(name) {\n    var svg = document.createElementNS(SVGNS, 'svg');\n    svg.setAttribute('viewBox', '0 0 28 28');\n    svg.setAttribute('aria-hidden', 'true');\n    ICONS[name].forEach(function (row, y) {\n      for (var x = 0; x < 7; x++) {\n        var c = document.createElementNS(SVGNS, 'circle');\n        c.setAttribute('cx', x * 4 + 2);\n        c.setAttribute('cy', y * 4 + 2);\n        c.setAttribute('r', row[x] === '#' ? 1.5 : 0.9);\n        c.setAttribute('class', row[x] === '#' ? 'dot on' : 'dot');\n        svg.appendChild(c);\n      }\n    });\n    return svg;\n  }\n\n  // ── 全域狀態 ────────────────────────────────────────────────\n  var config = { applicants: [], leaveTypes: [], expenseCats: [] };\n  var PAGES = [\n    { id: 'home', label: '首頁' },\n    { id: 'expense', label: '報帳' },\n    { id: 'leave', label: '請假' },\n    { id: 'checkin', label: '簽到' },\n    { id: 'clients', label: '客戶' }\n  ];\n  var main = $('main');\n\n  function renderNav(current) {\n    var nav = $('nav');\n    nav.textContent = '';\n    nav.appendChild(h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), '種子 內部系統'));\n    PAGES.forEach(function (p) {\n      var a = h('a', { href: '#' + p.id }, icon(p.id), h('span', { text: p.label }));\n      if (p.id === current) a.setAttribute('aria-current', 'page');\n      nav.appendChild(a);\n    });\n  }\n\n  function applicantField(selectedKey) {\n    var sel = h('select', { id: 'f-name', required: true });\n    var saved = remember(selectedKey);\n    config.applicants.forEach(function (n) { sel.appendChild(h('option', { value: n, text: n, selected: n === saved })); });\n    sel.addEventListener('change', function () { remember(selectedKey, sel.value); });\n    return h('div', { class: 'field' }, h('label', { for: 'f-name', text: '申請人' }), sel);\n  }\n\n  function stateText(cls, text) { return h('span', { class: 'state ' + cls, text: text }); }\n\n  function submitWith(btn, fn) {\n    btn.disabled = true;\n    var old = btn.textContent;\n    btn.textContent = '送出中…';\n    return fn().then(function () { btn.disabled = false; btn.textContent = old; }, function (e) {\n      btn.disabled = false; btn.textContent = old; toast(e.message, true);\n    });\n  }\n\n  // ── 首頁 ────────────────────────────────────────────────────\n  function pageHome(month) {\n    var url = '/api/home' + (month ? '?month=' + month : '');\n    main.appendChild(h('h1', { text: '首頁' }));\n    var body = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));\n    main.appendChild(body);\n    api('GET', url).then(function (d) {\n      body.textContent = '';\n      body.appendChild(h('h2', { text: '今天（' + d.today + '）請假' }));\n      body.appendChild(d.todayLeaves.length\n        ? h('div', { class: 'list' }, d.todayLeaves.map(function (x) {\n          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: x.type + (x.days ? ' ' + fmtLeave(x.days) : '') }));\n        }))\n        : h('p', { class: 'empty', text: '今天沒有人請假。' }));\n\n      var parts = d.month.split('-').map(Number);\n      var prev = new Date(parts[0], parts[1] - 2, 1), next = new Date(parts[0], parts[1], 1);\n      var ym = function (dt) { return dt.getFullYear() + '-' + pad(dt.getMonth() + 1); };\n      body.appendChild(h('div', { class: 'month-bar' },\n        h('h2', { text: parts[0] + ' 年 ' + parts[1] + ' 月' }),\n        h('div', {},\n          h('button', { class: 'btn ghost small', type: 'button', text: '上個月', onclick: function () { go('home', ym(prev)); } }), ' ',\n          h('button', { class: 'btn ghost small', type: 'button', text: '下個月', onclick: function () { go('home', ym(next)); } }))));\n\n      body.appendChild(h('h2', { text: '誰請了多少假' }));\n      body.appendChild(d.leaveByPerson.length\n        ? h('div', { class: 'list' }, d.leaveByPerson.map(function (x) {\n          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: fmtLeave(x.days) + '（' + x.count + ' 筆）' }));\n        }))\n        : h('p', { class: 'empty', text: '這個月沒有請假紀錄。' }));\n\n      body.appendChild(h('h2', { text: '誰報了多少帳' }));\n      body.appendChild(d.expenseByPerson.length\n        ? h('div', { class: 'list' }, d.expenseByPerson.map(function (x) {\n          return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name }), h('span', { text: money(x.total) + '（' + x.count + ' 筆）' }));\n        }))\n        : h('p', { class: 'empty', text: '這個月沒有報帳紀錄。' }));\n\n      body.appendChild(h('h2', { text: '最近送出' }));\n      body.appendChild(d.recent.length\n        ? h('div', { class: 'list' }, d.recent.map(function (x) {\n          return h('div', { class: 'item recent' }, h('span', { class: 'title', text: x.name + '　' + x.kind }), h('span', { class: 'muted', text: x.date }), h('span', { class: 'sub', text: x.text }), h('span', { class: 'end-mark ' + (x.kind === '報帳' ? 'expense' : 'leave'), 'aria-hidden': 'true' }));\n        }))\n        : h('p', { class: 'empty', text: '沒有資料。' }));\n    }).catch(function (e) { body.textContent = ''; body.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 報帳 ────────────────────────────────────────────────────\n  function pageExpense() {\n    main.appendChild(h('h1', { text: '報帳' }));\n    main.appendChild(h('p', { class: 'muted', text: '送出後記到 Notion，LINE 群組會收到通知。不需要核准。' }));\n    var lines = h('div', { class: 'lines' });\n    var totalEl = h('p', { class: 'total', text: '合計 NT$0' });\n    function recalc() {\n      var t = 0;\n      lines.querySelectorAll('input[data-amount]').forEach(function (i) { t += Number(i.value) || 0; });\n      totalEl.textContent = '合計 ' + money(t);\n    }\n    function addLine() {\n      var row = h('div', { class: 'line-item' },\n        h('div', { class: 'desc' }, h('label', { text: '說明' }), h('input', { type: 'text', maxlength: '100', 'data-desc': true, required: true })),\n        h('div', {}, h('label', { text: '類別' }), (function () {\n          var s = h('select', { 'data-cat': true });\n          config.expenseCats.forEach(function (c) { s.appendChild(h('option', { value: c, text: c })); });\n          return s;\n        })()),\n        h('div', {}, h('label', { text: '金額' }), h('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', 'data-amount': true, required: true, oninput: recalc })),\n        h('button', { class: 'btn ghost x', type: 'button', 'aria-label': '刪除這一筆', text: '×', onclick: function () { if (lines.children.length > 1) { row.remove(); recalc(); } } }));\n      lines.appendChild(row);\n    }\n    addLine();\n    var project = h('input', { type: 'text', id: 'f-project', maxlength: '200' });\n    var note = h('textarea', { id: 'f-note', maxlength: '500' });\n    var submit = h('button', { class: 'btn', type: 'submit', text: '送出報帳' });\n    var form = h('form', {},\n      applicantField('applicant'),\n      lines,\n      h('p', {}, h('button', { class: 'btn ghost small', type: 'button', text: '＋ 新增一筆', onclick: addLine })),\n      totalEl,\n      h('div', { class: 'field' }, h('label', { for: 'f-project', text: '專案用途（選填）' }), project),\n      h('div', { class: 'field' }, h('label', { for: 'f-note', text: '備註（選填）' }), note),\n      submit);\n    form.addEventListener('submit', function (ev) {\n      ev.preventDefault();\n      var items = Array.prototype.map.call(lines.children, function (r) {\n        return { desc: r.querySelector('[data-desc]').value, cat: r.querySelector('[data-cat]').value, amount: r.querySelector('[data-amount]').value };\n      });\n      submitWith(submit, function () {\n        return api('POST', '/api/expenses', { name: $('f-name').value, items: items, project: project.value, note: note.value }).then(function () {\n          toast('報帳已送出，LINE 已通知');\n          go('expense');\n        });\n      });\n    });\n    main.appendChild(form);\n    recentList('/api/expenses', '最近的報帳', function (x) {\n      return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name + '　' + money(x.total) }), h('span', { class: 'muted', text: x.created }),\n        h('span', { class: 'sub', text: x.detail + (x.project ? '　專案：' + x.project : '') }));\n    });\n  }\n\n  function recentList(path, heading, render) {\n    main.appendChild(h('h2', { text: heading }));\n    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));\n    main.appendChild(box);\n    api('GET', path).then(function (d) {\n      box.textContent = '';\n      box.appendChild(d.items.length ? h('div', { class: 'list' }, d.items.map(render)) : h('p', { class: 'empty', text: '還沒有資料。' }));\n    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 請假（以小時為單位；每天 8 小時）─────────────────────────\n  function fmtLeave(days) {\n    var hours = Math.round(Number(days || 0) * 16) / 2;\n    var d = Math.floor(hours / 8), r = hours - d * 8;\n    return [d ? d + ' 天' : '', r ? r + ' 小時' : ''].filter(Boolean).join(' ') || '0 小時';\n  }\n  function weekdaysBetween(a, b) {\n    if (!a || !b || b < a) return 0;\n    var d = new Date(a + 'T00:00:00'), end = new Date(b + 'T00:00:00'), n = 0;\n    while (d <= end) { var w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }\n    return n;\n  }\n  function pageLeave() {\n    main.appendChild(h('h1', { text: '請假' }));\n    main.appendChild(h('p', { class: 'muted', text: '以小時計，一天 8 小時。送出後記到 Notion，LINE 群組會收到通知，只登記不審核。' }));\n    var typeBox = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': '假別' });\n    config.leaveTypes.forEach(function (t, i) {\n      typeBox.appendChild(h('label', {}, h('input', { type: 'radio', name: 'f-type', value: t, checked: i === 0 }), h('span', { text: t })));\n    });\n    var start = h('input', { type: 'date', id: 'f-start', value: todayStr(), required: true });\n    var end = h('input', { type: 'date', id: 'f-end', value: todayStr(), required: true });\n    var hours = h('input', { type: 'number', id: 'f-hours', min: '0.5', max: '480', step: '0.5', required: true, value: '8' });\n    var summary = h('p', { class: 'muted' });\n    var chipBox = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': '請假時數' });\n    [1, 2, 3, 4, 5, 6, 7, 8].forEach(function (n) {\n      chipBox.appendChild(h('label', {}, h('input', { type: 'radio', name: 'f-chip', value: String(n), checked: n === 8, onchange: function () { hours.value = String(n); sync(); } }), h('span', { text: n === 8 ? '整天 8' : n + ' 小時' })));\n    });\n    function multiDay() { return end.value > start.value; }\n    function sync() {\n      chipBox.hidden = multiDay();\n      var n = Number(hours.value) || 0;\n      summary.textContent = multiDay()\n        ? '跨 ' + weekdaysBetween(start.value, end.value) + ' 個上班日，預設每天 8 小時；週末不算，可直接改合計小時。合計 ' + fmtLeave(n / 8) + '。'\n        : '合計 ' + fmtLeave(n / 8) + '。';\n    }\n    function dates() {\n      if (end.value < start.value) end.value = start.value;\n      if (multiDay()) hours.value = String((weekdaysBetween(start.value, end.value) || 1) * 8);\n      else { var c = chipBox.querySelector('input:checked'); hours.value = c ? c.value : '8'; }\n      sync();\n    }\n    start.addEventListener('change', dates);\n    end.addEventListener('change', dates);\n    hours.addEventListener('input', sync);\n    var reason = h('textarea', { id: 'f-reason', maxlength: '500' });\n    var submit = h('button', { class: 'btn', type: 'submit', text: '送出請假' });\n    var form = h('form', {},\n      applicantField('applicant'),\n      h('div', { class: 'field' }, h('label', { text: '假別' }), typeBox),\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { for: 'f-start', text: '開始日期' }), start),\n        h('div', { class: 'field' }, h('label', { for: 'f-end', text: '結束日期' }), end)),\n      h('div', { class: 'field' }, h('label', { text: '請假時數' }), chipBox),\n      h('div', { class: 'field' }, h('label', { for: 'f-hours', text: '合計小時（最小 0.5）' }), hours, summary),\n      h('div', { class: 'field' }, h('label', { for: 'f-reason', text: '原因（選填）' }), reason),\n      submit);\n    sync();\n    form.addEventListener('submit', function (ev) {\n      ev.preventDefault();\n      submitWith(submit, function () {\n        return api('POST', '/api/leave', {\n          name: $('f-name').value, type: form.querySelector('input[name=\"f-type\"]:checked').value,\n          start: start.value, end: end.value, hours: hours.value, reason: reason.value\n        }).then(function () { toast('請假已送出，LINE 已通知'); go('leave'); });\n      });\n    });\n    main.appendChild(form);\n    recentList('/api/leave', '最近的請假', function (x) {\n      return h('div', { class: 'item' }, h('span', { class: 'title', text: x.name + '　' + x.type + ' ' + fmtLeave(x.days) }), h('span', { class: 'muted', text: x.start }),\n        h('span', { class: 'sub', text: x.start + ' ～ ' + x.end + (x.reason ? '　' + x.reason : '') }));\n    });\n  }\n\n  // ── 簽到 ────────────────────────────────────────────────────\n  function checkinForm(initial, onSubmit, label) {\n    var date = h('input', { type: 'date', value: initial.date || todayStr(), required: true });\n    var cin = h('input', { type: 'time', value: initial.clockIn || '' });\n    var cout = h('input', { type: 'time', value: initial.clockOut || '' });\n    var note = h('input', { type: 'text', maxlength: '300', value: initial.note || '' });\n    var submit = h('button', { class: 'btn', type: 'submit', text: label });\n    var form = h('form', { class: 'checkin-form' },\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { text: '日期' }), date),\n        h('div', { class: 'field' }, h('label', { text: '備註' }), note)),\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { text: '上班' }), cin, h('button', { class: 'btn ghost small', type: 'button', text: '現在', onclick: function () { cin.value = nowTime(); } })),\n        h('div', { class: 'field' }, h('label', { text: '下班' }), cout, h('button', { class: 'btn ghost small', type: 'button', text: '現在', onclick: function () { cout.value = nowTime(); } }))),\n      submit);\n    form.addEventListener('submit', function (ev) {\n      ev.preventDefault();\n      submitWith(submit, function () { return onSubmit({ date: date.value, clockIn: cin.value, clockOut: cout.value, note: note.value }); });\n    });\n    return form;\n  }\n\n  // 全月正常出勤：先預覽要建立哪些天（自動排除週末、國定假日、請假日、已簽到日），確認後一次建立\n  function monthAttendance(nameGetter) {\n    var month = h('input', { type: 'month', value: todayStr().slice(0, 7), required: true });\n    var cin = h('input', { type: 'time', value: remember('monthIn') || '09:00' });\n    var cout = h('input', { type: 'time', value: remember('monthOut') || '18:00' });\n    var out = h('div', {});\n    var previewBtn = h('button', { class: 'btn ghost', type: 'button', text: '預覽這個月' });\n    previewBtn.addEventListener('click', function () {\n      out.textContent = '';\n      out.appendChild(h('p', { class: 'muted', text: '載入中…' }));\n      api('GET', '/api/checkin/plan?name=' + encodeURIComponent(nameGetter()) + '&month=' + month.value).then(function (plan) {\n        out.textContent = '';\n        if (!plan.hasHolidayData) out.appendChild(h('p', { class: 'err', text: '這一年還沒有國定假日資料，請自己取消勾選放假的日子。' }));\n        var boxes = [];\n        var list = h('div', { class: 'list' });\n        plan.days.forEach(function (d) {\n          var cb = h('input', { type: 'checkbox', checked: d.checked, 'aria-label': d.date });\n          boxes.push({ cb: cb, date: d.date });\n          list.appendChild(h('label', { class: 'item day-row' }, cb, h('span', { class: 'title', text: d.date.slice(5) + '（' + d.dow + '）' }), h('span', { class: 'muted', text: d.label })));\n        });\n        var count = h('p', { class: 'muted' });\n        var go2 = h('button', { class: 'btn', type: 'button' });\n        function refresh() {\n          var n = boxes.filter(function (b) { return b.cb.checked; }).length;\n          count.textContent = '將建立 ' + n + ' 筆，上班 ' + cin.value + '，下班 ' + cout.value + '。';\n          go2.textContent = '建立 ' + n + ' 筆簽到';\n          go2.disabled = n === 0;\n        }\n        boxes.forEach(function (b) { b.cb.addEventListener('change', refresh); });\n        refresh();\n        go2.addEventListener('click', function () {\n          var dates = boxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return b.date; });\n          remember('monthIn', cin.value); remember('monthOut', cout.value);\n          submitWith(go2, function () {\n            return api('POST', '/api/checkin/month', { name: nameGetter(), month: month.value, clockIn: cin.value, clockOut: cout.value, dates: dates }).then(function (r) {\n              toast('已建立 ' + r.created + ' 筆' + (r.skipped.length ? '，略過 ' + r.skipped.length + ' 筆已有簽到' : ''));\n              go('checkin');\n            });\n          });\n        });\n        out.appendChild(list); out.appendChild(count); out.appendChild(go2);\n      }).catch(function (e) { out.textContent = ''; out.appendChild(h('p', { class: 'err', text: e.message })); });\n    });\n    return h('div', {},\n      h('h2', { text: '全月正常出勤' }),\n      h('p', { class: 'muted', text: '一次補齊整個月。預覽會排除週末、國定假日、請假日與已有簽到的日子，你可以再手動勾選調整。' }),\n      h('div', { class: 'row2' },\n        h('div', { class: 'field' }, h('label', { text: '月份' }), month),\n        h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: '上班' }), cin), h('div', { class: 'field' }, h('label', { text: '下班' }), cout))),\n      previewBtn, out);\n  }\n\n  function pageCheckin() {\n    main.appendChild(h('h1', { text: '簽到' }));\n    main.appendChild(h('p', { class: 'muted', text: '送出後可以再修改，每筆會顯示最後修改時間，方便核對。' }));\n    var nameField = applicantField('applicant');\n    main.appendChild(nameField);\n    main.appendChild(checkinForm({}, function (v) {\n      v.name = $('f-name').value;\n      return api('POST', '/api/checkin', v).then(function () { toast('已記錄'); go('checkin'); });\n    }, '記錄'));\n    main.appendChild(monthAttendance(function () { return $('f-name').value; }));\n    main.appendChild(h('h2', { text: '最近的簽到' }));\n    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));\n    main.appendChild(box);\n    api('GET', '/api/checkin').then(function (d) {\n      box.textContent = '';\n      if (!d.items.length) { box.appendChild(h('p', { class: 'empty', text: '還沒有資料。' })); return; }\n      var list = h('div', { class: 'list' });\n      d.items.forEach(function (x) {\n        var edited = x.edited ? new Date(x.edited).toLocaleString('zh-TW', { hour12: false }) : '';\n        var row = h('div', { class: 'item' },\n          h('span', { class: 'title', text: x.name + '　' + x.date }),\n          h('span', { text: (x.clockIn || '—') + ' ～ ' + (x.clockOut || '—') }),\n          h('span', { class: 'sub', text: (x.note ? x.note + '　' : '') + '最後修改：' + edited }));\n        var actions = h('div', { class: 'actions' });\n        actions.appendChild(h('button', { class: 'btn ghost small', type: 'button', text: '修改', onclick: function () {\n          actions.textContent = '';\n          actions.appendChild(checkinForm(x, function (v) {\n            return api('PATCH', '/api/checkin/' + x.id, v).then(function () { toast('已修改'); go('checkin'); });\n          }, '儲存修改'));\n        } }));\n        row.appendChild(actions);\n        list.appendChild(row);\n      });\n      box.appendChild(list);\n    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 客戶（只看）────────────────────────────────────────────\n  function pageClients() {\n    main.appendChild(h('h1', { text: '客戶' }));\n    main.appendChild(h('p', { class: 'muted', text: '只能查看。有新動態的客戶排在最上面；新增與修改請到 Notion。' }));\n    var box = h('div', {}, h('p', { class: 'muted', text: '載入中…' }));\n    main.appendChild(box);\n    api('GET', '/api/clients').then(function (d) {\n      box.textContent = '';\n      if (!d.items.length) { box.appendChild(h('p', { class: 'empty', text: '沒有客戶資料。' })); return; }\n      var list = h('div', { class: 'list' });\n      d.items.forEach(function (c) {\n        var logBox = h('div', {});\n        var loaded = false;\n        var det = h('details', { class: 'client' },\n          h('summary', {},\n            h('span', { class: 'title', text: c.name || '（未命名）' }),\n            h('span', { class: 'muted', text: [c.status, c.priority].filter(Boolean).join('　') + '　更新 ' + c.updated })),\n          h('div', { class: 'client-body' },\n            c.action ? h('p', {}, h('strong', { text: '下一步：' }), c.action) : null,\n            c.commitment ? h('p', {}, h('strong', { text: '承諾事項：' }), c.commitment) : null,\n            c.notes ? h('p', {}, h('strong', { text: '現況備註：' }), c.notes) : null,\n            c.amount ? h('p', {}, h('strong', { text: '專案金額：' }), money(c.amount)) : null,\n            logBox));\n        det.addEventListener('toggle', function () {\n          if (!det.open || loaded) return;\n          loaded = true;\n          logBox.appendChild(h('p', { class: 'muted', text: '載入歷史日誌…' }));\n          api('GET', '/api/clients/' + c.id + '/log').then(function (r) {\n            logBox.textContent = '';\n            if (!r.days.length) { logBox.appendChild(h('p', { class: 'empty', text: '這位客戶沒有歷史日誌。' })); return; }\n            r.days.forEach(function (day) {\n              logBox.appendChild(h('h3', { text: day.date }));\n              day.entries.forEach(function (en) {\n                var p = h('div', { class: 'log-entry' }, h('span', { text: en.text }));\n                en.links.forEach(function (l) { p.appendChild(document.createTextNode(' ')); p.appendChild(h('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer', text: l.text })); });\n                logBox.appendChild(p);\n              });\n            });\n          }).catch(function (e) { loaded = false; logBox.textContent = ''; logBox.appendChild(h('p', { class: 'err', text: e.message })); });\n        });\n        list.appendChild(h('div', { class: 'item single' }, det));\n      });\n      box.appendChild(list);\n    }).catch(function (e) { box.textContent = ''; box.appendChild(h('p', { class: 'err', text: e.message })); });\n  }\n\n  // ── 路由 ────────────────────────────────────────────────────\n  var current = { id: 'home', arg: '' };\n  function go(id, arg) {\n    var target = '#' + id + (arg ? '/' + arg : '');\n    if (location.hash === target) render();\n    else location.hash = target;\n  }\n  function render() {\n    var parts = (location.hash || '#home').slice(1).split('/');\n    var id = PAGES.some(function (p) { return p.id === parts[0]; }) ? parts[0] : 'home';\n    current = { id: id, arg: parts[1] || '' };\n    renderNav(id);\n    main.textContent = '';\n    ({ home: function () { pageHome(current.arg); }, expense: pageExpense, leave: pageLeave, checkin: pageCheckin, clients: pageClients })[id]();\n    window.scrollTo(0, 0);\n  }\n\n  window.addEventListener('hashchange', render);\n  api('GET', '/api/config').then(function (c) { config = c; render(); }).catch(function (e) {\n    main.textContent = '';\n    main.appendChild(h('h1', { text: '無法載入' }));\n    main.appendChild(h('p', { class: 'err', text: e.message }));\n  });\n})();\n"},"/favicon.svg":{"type":"image/svg+xml","body":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 28 28\"><rect width=\"28\" height=\"28\" rx=\"5\" fill=\"#1b1a18\"/><g fill=\"#7fbf95\"><circle cx=\"14\" cy=\"4\" r=\"1.6\"/><circle cx=\"10\" cy=\"8\" r=\"1.6\"/><circle cx=\"14\" cy=\"8\" r=\"1.6\"/><circle cx=\"18\" cy=\"8\" r=\"1.6\"/><circle cx=\"6\" cy=\"12\" r=\"1.6\"/><circle cx=\"10\" cy=\"12\" r=\"1.6\"/><circle cx=\"14\" cy=\"12\" r=\"1.6\"/><circle cx=\"18\" cy=\"12\" r=\"1.6\"/><circle cx=\"22\" cy=\"12\" r=\"1.6\"/><circle cx=\"6\" cy=\"16\" r=\"1.6\"/><circle cx=\"10\" cy=\"16\" r=\"1.6\"/><circle cx=\"14\" cy=\"16\" r=\"1.6\"/><circle cx=\"18\" cy=\"16\" r=\"1.6\"/><circle cx=\"22\" cy=\"16\" r=\"1.6\"/><circle cx=\"10\" cy=\"20\" r=\"1.6\"/><circle cx=\"14\" cy=\"20\" r=\"1.6\"/><circle cx=\"18\" cy=\"20\" r=\"1.6\"/><circle cx=\"14\" cy=\"24\" r=\"1.6\"/></g></svg>\n"},"/index.html":{"type":"text/html; charset=utf-8","body":"<!doctype html>\n<html lang=\"zh-Hant\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<title>種子 內部系統</title>\n<link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\">\n<link rel=\"stylesheet\" href=\"/style.css\">\n</head>\n<body>\n<div class=\"shell\">\n  <nav class=\"nav\" id=\"nav\" aria-label=\"主選單\"></nav>\n  <main class=\"main\" id=\"main\" tabindex=\"-1\">\n    <p class=\"muted\">載入中…</p>\n  </main>\n</div>\n<div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n<script src=\"/app.js\"></script>\n</body>\n</html>\n"},"/style.css":{"type":"text/css; charset=utf-8","body":":root {\n  --bg: #1b1a18;\n  --surface: #252421;\n  --surface2: #33312d;\n  --ink: #f1eee7;\n  --ink2: #a7a399;\n  --line: #3a3834;\n  --accent: #7fbf95;\n  --accent-ink: #10150f;\n  --danger: #e0786f;\n  --warn: #d9b36a;\n  --cream: #ece6d8;\n  --cream-ink: #1f1d19;\n  --radius: 6px;\n  font-size: 16px;\n  color-scheme: dark;\n}\n* { box-sizing: border-box; }\nhtml, body { margin: 0; background: var(--bg); color: var(--ink); font-family: system-ui, \"Noto Sans TC\", \"PingFang TC\", \"Microsoft JhengHei\", sans-serif; line-height: 1.6; }\nh1 { font-size: 1.5rem; margin: 0 0 .25rem; font-weight: 700; }\nh2 { font-size: 1.05rem; margin: 2rem 0 .5rem; font-weight: 700; }\np { margin: 0 0 .75rem; }\n.muted { color: var(--ink2); }\n.shell { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }\n.nav { border-right: 1px solid var(--line); padding: 1.25rem .75rem; position: sticky; top: 0; height: 100vh; overflow: auto; background: var(--surface); }\n.brand { display: flex; align-items: center; gap: .6rem; padding: 0 .5rem 1.25rem; font-weight: 700; }\n.brand img { width: 28px; height: 28px; }\n.nav a { display: flex; align-items: center; gap: .7rem; padding: .6rem .75rem; border-radius: var(--radius); color: var(--ink); text-decoration: none; min-height: 44px; }\n.nav a svg { width: 32px; height: 32px; flex: none; }\n.dot { fill: #55524b; }\n.dot.on { fill: currentColor; }\n.nav a:hover { background: var(--surface2); }\n.nav a[aria-current=\"page\"] { background: var(--surface2); color: var(--accent); }\n.nav .who { margin-top: 1.5rem; padding: .75rem .5rem 0; border-top: 1px solid var(--line); font-size: .85rem; color: var(--ink2); overflow-wrap: anywhere; }\n.main { padding: 2rem clamp(1rem, 4vw, 3rem) 4rem; max-width: 860px; outline: none; }\nlabel { display: block; font-size: .9rem; color: var(--ink2); margin: 0 0 .25rem; }\ninput, select, textarea { width: 100%; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: .6rem .7rem; min-height: 44px; }\ntextarea { min-height: 88px; resize: vertical; }\ninput:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, .nav a:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }\n.field { margin-bottom: 1rem; }\n.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }\n.btn { font: inherit; min-height: 44px; padding: .55rem 1.1rem; border-radius: var(--radius); border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); cursor: pointer; }\n.btn:disabled { opacity: .55; cursor: default; }\n.btn.ghost { background: transparent; color: var(--accent); }\n.btn.danger { background: var(--danger); border-color: var(--danger); }\n.btn.small { min-height: 36px; padding: .3rem .8rem; font-size: .9rem; }\n.segment { display: flex; flex-wrap: wrap; gap: .5rem; }\n.segment label { margin: 0; }\n.segment input { position: absolute; opacity: 0; width: 1px; height: 1px; min-height: 0; }\n.segment span { display: inline-block; padding: .5rem 1rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--ink); cursor: pointer; min-height: 44px; line-height: 1.9; }\n.segment input:checked + span { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }\n.segment input:focus-visible + span { outline: 3px solid var(--accent); outline-offset: 1px; }\n.list { border-top: 1px solid var(--line); }\n.item { border-bottom: 1px solid var(--line); padding: .85rem 0; display: grid; grid-template-columns: 1fr auto; gap: .25rem 1rem; }\n.item .title { font-weight: 600; }\n.item .sub { color: var(--ink2); font-size: .9rem; grid-column: 1 / -1; overflow-wrap: anywhere; }\n.item .actions { display: flex; gap: .5rem; flex-wrap: wrap; grid-column: 1 / -1; margin-top: .4rem; }\n.state { font-size: .9rem; font-weight: 600; white-space: nowrap; }\n.state.ok { color: var(--accent); }\n.state.bad { color: var(--danger); }\n.state.wait { color: var(--warn); }\n.big { font-size: 2rem; font-weight: 700; line-height: 1.2; }\n.lines { display: grid; gap: .75rem; }\n.line-item { display: grid; grid-template-columns: 1fr 110px 120px 44px; gap: .5rem; align-items: end; }\n.line-item .x { min-width: 44px; }\n.total { text-align: right; font-weight: 700; margin: .5rem 0 1rem; }\n.empty { color: var(--ink2); padding: 1rem 0; }\n.err { color: var(--danger); }\n.toast { position: fixed; left: 50%; bottom: 5rem; transform: translateX(-50%) translateY(250%); background: var(--cream); color: var(--cream-ink); padding: .7rem 1.1rem; border-radius: var(--radius); max-width: 90vw; transition: transform .2s, opacity .2s; z-index: 30; opacity: 0; visibility: hidden; }\n.toast.show { transform: translateX(-50%) translateY(0); opacity: 1; visibility: visible; }\n.toast.bad { background: var(--danger); color: #1b0f0e; }\n.month-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .5rem; margin-top: 2rem; }\n.month-bar h2 { margin: 0; }\n.item.single { display: block; padding: 0; }\n.client summary { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; flex-wrap: wrap; padding: .85rem 0; cursor: pointer; min-height: 44px; }\n.client .title { font-weight: 600; }\n.client-body { padding: 0 0 1rem; }\n.client-body h3 { font-size: .95rem; margin: 1rem 0 .25rem; color: var(--ink2); }\n.log-entry { padding: .5rem 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }\n.checkin-form .field button { margin-top: .4rem; }\n@media (max-width: 760px) {\n  .shell { grid-template-columns: 1fr; }\n  .nav { position: fixed; bottom: 0; left: 0; right: 0; top: auto; height: auto; z-index: 10; display: flex; padding: 0; border-right: 0; border-top: 1px solid var(--line); overflow-x: auto; }\n  .brand, .nav .who { display: none; }\n  .nav a { flex: 1 0 auto; flex-direction: column; gap: 0; padding: .4rem .6rem; font-size: .72rem; min-width: 64px; justify-content: center; border-radius: 0; }\n  .main { padding-bottom: 6rem; }\n  .row2 { grid-template-columns: 1fr; gap: 0; }\n  .line-item { grid-template-columns: 1fr 1fr 44px; }\n  .line-item .desc { grid-column: 1 / -1; }\n}\n@media (prefers-reduced-motion: reduce) { .toast { transition: none; } }\n\n/* A34：最近送出每列只在最右端帶一小段顏色，區分報帳與請假 */\n.item.recent { position: relative; padding-right: 1.4rem; }\n.end-mark { position: absolute; right: 0; top: .85rem; bottom: .85rem; width: 5px; border-radius: 3px; }\n.end-mark.expense { background: var(--accent); }\n.end-mark.leave { background: var(--warn); }\n/* A213：客戶卡平時深色，展開中的那一張變奶油色 */\n.item.single { margin: .5rem 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 0 1rem; }\n.item.single:has(details[open]) { background: var(--cream); color: var(--cream-ink); border-color: var(--cream); }\n.item.single:has(details[open]) .muted { color: #5b574d; }\n.item.single:has(details[open]) .log-entry { border-top-color: #cfc8b6; }\n.item.single:has(details[open]) .client-body h3 { color: #5b574d; }\n.item.single:has(details[open]) a { color: #2d5a3f; }\n.legend { color: var(--ink2); font-size: .85rem; }\n\n.day-row { grid-template-columns: auto 1fr auto; align-items: center; cursor: pointer; }\n.day-row input { width: 22px; min-height: 22px; accent-color: var(--accent); }\n"}};

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

// ── Cloudflare Access 憑證驗證 ────────────────────────────────

const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const b64uToJson = s => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));
let jwksCache = { at: 0, keys: null, team: '' };

async function loadJwks(env) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.team === env.ACCESS_TEAM_DOMAIN && now - jwksCache.at < 3600e3) return jwksCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, '登入服務暫時無法驗證');
  const data = await res.json();
  jwksCache = { at: now, keys: data.keys || [], team: env.ACCESS_TEAM_DOMAIN };
  return jwksCache.keys;
}

async function authenticate(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !csv(env.ALLOWED_EMAILS).length) throw new HttpError(503, '登入尚未設定');
  const parts = (request.headers.get('Cf-Access-Jwt-Assertion') || '').split('.');
  if (parts.length !== 3) throw new HttpError(401, '請先登入');
  let email;
  try {
    const header = b64uToJson(parts[0]);
    const payload = b64uToJson(parts[1]);
    if (header.alg !== 'RS256') throw new Error('alg');
    const jwk = (await loadJwks(env)).find(k => k.kid === header.kid);
    if (!jwk) throw new Error('kid');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    const now = Math.floor(Date.now() / 1000);
    if (!ok || ![].concat(payload.aud || []).includes(env.ACCESS_AUD) || payload.iss !== 'https://' + env.ACCESS_TEAM_DOMAIN
      || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60) || !payload.email) throw new Error('claims');
    email = String(payload.email).toLowerCase();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, '登入無效或已過期');
  }
  if (!csv(env.ALLOWED_EMAILS).map(s => s.toLowerCase()).includes(email)) throw new HttpError(403, '這個帳號沒有使用權限');
  return email;
}

const writeLog = new Map();
function throttleWrites(key) {
  const now = Date.now();
  const recent = (writeLog.get(key) || []).filter(t => now - t < 60e3);
  if (recent.length >= WRITE_LIMIT_PER_MIN) throw new HttpError(429, '操作太頻繁，請稍後再試');
  recent.push(now);
  writeLog.set(key, recent);
}

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

async function linePush(env, text) {
  if (!env.LINE_CHANNEL_TOKEN || !env.LINE_GROUP_ID) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.LINE_CHANNEL_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: env.LINE_GROUP_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    });
  } catch (_) { /* 通知失敗不影響記錄 */ }
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
    return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '客戶名稱'), status: getSel(r.properties, '潛在客戶狀態'), priority: getSel(r.properties, '優先級'), action: getText(r.properties, '下一步行動'), commitment: getText(r.properties, '承諾事項'), notes: getText(r.properties, '詳細現況備註'), amount: getNum(r.properties, '專案金額'), updated: (r.last_edited_time || '').slice(0, 10) })) });
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
        return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
      if (request.method === 'GET') {
        await authenticate(request, env);
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
    ctx.waitUntil(dailyNotice(env));
  },
};
