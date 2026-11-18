/* Scan Resi Baby Sona — frontend. Tanpa build tool. */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Penyimpanan lokal (per perangkat)                                  */
  /* ---------------------------------------------------------------- */
  var K = { cfg: 'bs.cfg', queue: 'bs.queue', undo: 'bs.undo', hist: 'bs.hist', stats: 'bs.stats', view: 'bs.view' };
  var storageOk = true;
  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { storageOk = false; return false; }
  }

  var isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var defaultDevice = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'HP' : 'Laptop';

  var cfg = Object.assign({ url: '', token: '', device: defaultDevice, sheetUrl: '' }, lsGet(K.cfg, {}));
  var queue = lsGet(K.queue, []);
  var undoStack = lsGet(K.undo, []);
  var hist = lsGet(K.hist, []);
  var stats = lsGet(K.stats, null);
  var mode = 'in';
  var lastActionId = null;

  function saveQueue() {
    if (!lsSet(K.queue, queue)) showBanner('warn', 'Penyimpanan browser terblokir. Jangan tutup halaman sebelum antrean terkirim.');
  }
  function saveUndo() { lsSet(K.undo, undoStack.slice(-30)); }
  function saveHist() { lsSet(K.hist, hist.slice(0, 12)); }

  /* ---------------------------------------------------------------- */
  /* Pembantu                                                           */
  /* ---------------------------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function ddmmhhmm(ms) { var d = new Date(ms); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + hhmm(ms); }

  /** Sama persis dengan normResi di kode.gs. */
  function normResi(raw) {
    var s = String(raw == null ? '' : raw).toUpperCase().trim();
    var m = s.match(/SPXID[0-9A-Z]+/);
    if (m) return m[0];
    s = s.replace(/^(NO\.?\s*)?RESI\s*[:=#]?\s*/, '');
    return s.replace(/[^0-9A-Z]/g, '');
  }
  var MIN_RESI = 6;

  /* ---------------------------------------------------------------- */
  /* Panggilan ke Apps Script                                           */
  /* POST, body JSON sebagai teks, TANPA header custom -> "simple        */
  /* request", tidak ada preflight CORS. Apps Script membalas 302 ke     */
  /* script.googleusercontent.com; fetch mengikutinya otomatis.          */
  /* ---------------------------------------------------------------- */
  function ApiError(kind, msg) { this.kind = kind; this.message = msg; }

  function api(payload, timeoutMs) {
    if (!cfg.url || !cfg.token) {
      return Promise.reject(new ApiError('config', 'Belum tersambung. Isi URL script dan token di Pengaturan (ikon gigi).'));
    }
    var body = JSON.stringify(Object.assign({}, payload, { token: cfg.token }));
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 15000) : null;
    return fetch(cfg.url, { method: 'POST', body: body, redirect: 'follow', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        return r.text().then(function (txt) { return { status: r.status, txt: txt }; });
      }, function () {
        throw new ApiError('net', navigator.onLine === false
          ? 'Tidak ada sinyal internet.'
          : 'Server tidak terjangkau. Sinyal lemah, atau URL di Pengaturan salah.');
      })
      .then(function (x) {
        clearTimeout(timer);
        var j;
        try { j = JSON.parse(x.txt); } catch (e) {
          if (x.status >= 500 || x.status === 429) throw new ApiError('net', 'Server Google sedang error (' + x.status + '). Dicoba lagi otomatis.');
          throw new ApiError('html', 'Server membalas halaman, bukan data. Cek deploy: "Who has access" harus "Anyone", dan URL harus berakhiran /exec.');
        }
        if (!j || !j.ok) {
          var code = j && j.code;
          var kind = code === 'BAD_TOKEN' || code === 'NO_TOKEN_SET' ? 'auth' : code === 'BUSY' ? 'net' : 'server';
          throw new ApiError(kind, (j && j.error) || 'Server menolak permintaan.');
        }
        if (j.stats) setStats(j.stats);
        return j;
      }, function (e) { clearTimeout(timer); throw e; });
  }

  /* ---------------------------------------------------------------- */
  /* Antrean: semua scan lewat sini, dikirim berurutan, tidak pernah     */
  /* dibuang sebelum server membalas.                                   */
  /* ---------------------------------------------------------------- */
  var flushing = false, retryTimer = null, retryDelay = 3000, lastErr = null;

  function payloadOf(it) {
    return it.type === 'undo'
      ? { action: 'undo', id: it.id, target: it.target, device: it.device }
      : { action: 'scan', id: it.id, resi: it.resi, raw: it.raw, mode: it.mode, device: it.device, ts: it.ts };
  }

  function flush() {
    if (flushing) return;
    if (!queue.length) { renderQueue(); return; }
    flushing = true;
    clearTimeout(retryTimer); retryTimer = null;
    renderQueue();
    var item = queue[0];
    api(payloadOf(item)).then(function (res) {
      if (queue[0] && queue[0].id === item.id) queue.shift();
      saveQueue();
      retryDelay = 3000; lastErr = null;
      hideBanner();
      flushing = false;
      onResult(item, res);
      flush();
    }, function (e) {
      flushing = false;
      lastErr = e;
      onSendFail(e);
      retryTimer = setTimeout(flush, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
      renderQueue();
    });
  }

  function sendNow() { retryDelay = 3000; clearTimeout(retryTimer); retryTimer = null; flush(); }

  function onSendFail(e) {
    if (e.kind === 'auth' || e.kind === 'html' || e.kind === 'config') showBanner('err', e.message, true);
    // Kabari sekali untuk aksi terbaru yang masih tertahan.
    var latest = null;
    queue.forEach(function (q) { if (q.id === lastActionId) latest = q; });
    if (latest && !latest.notified) {
      latest.notified = true;
      saveQueue();
      showCard('warn', 'Belum terkirim — tersimpan di HP',
        e.message + ' Akan dikirim otomatis, jangan scan ulang.', latest.resi || '');
      feedback('warn');
    }
  }

  var ACCEPTED = { OK: 1, EXTRA: 1 };

  /** Nama jasa kirim singkat dari "Opsi Pengiriman" Shopee, atau dari bentuk resinya. */
  function kurirOf(opsi, resi) {
    var s = String(opsi || '').toUpperCase();
    var map = [[/SPX|SHOPEE ?XPRESS/, 'SPX'], [/JNE/, 'JNE'], [/J&T|JNT|J & T/, 'J&T'], [/SICEPAT/, 'SiCepat'],
               [/ANTERAJA/, 'AnterAja'], [/NINJA/, 'Ninja'], [/POS ?INDONESIA|POS/, 'POS'], [/ID ?EXPRESS|IDX/, 'ID Express'],
               [/LION/, 'Lion'], [/GOSEND|GO-SEND|GRAB/, 'Instan']];
    for (var i = 0; i < map.length; i++) if (map[i][0].test(s)) return map[i][1];
    if (/^SPXID/.test(String(resi || ''))) return 'SPX';
    return '';
  }

  function onResult(item, res) {
    var kurir = item.type === 'scan' ? kurirOf(res.kurir, res.resi || item.resi) : '';
    if (item.type === 'scan') {
      if (!ACCEPTED[res.code]) removeUndo(item.id);
      updateHist(item.id, { state: res.code, t: res.t, h: res.h, kurir: kurir });
    } else if (res.code === 'UNDONE') {
      updateHist(item.target, { state: 'UNDONE', t: 'warn', h: 'Dibatalkan' });
    }
    var detail = [res.m, [res.no, res.kurir].filter(Boolean).join(' · '), res.replay ? '(hasil kiriman ulang)' : '']
      .filter(Boolean).join(' ');
    if (item.id === lastActionId) {
      showCard(res.t, res.h, detail, res.resi || item.resi || '', item.type === 'scan' ? (kurir || '?') : '');
      feedback(res.t);
    } else if (res.t !== 'ok') {
      // Hasil scan lama dari antrean yang ternyata bermasalah: jangan diam saja.
      toast(res.t, 'Scan antrean ' + (item.resi || '') + ': ' + res.h);
      feedback(res.t);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Scan                                                               */
  /* ---------------------------------------------------------------- */
  var lastCode = '', lastAt = 0;

  function submitCode(raw, src) {
    raw = String(raw == null ? '' : raw);
    var now = Date.now();
    if (raw === lastCode && now - lastAt < 2500) { lastAt = now; return; } // cooldown kode sama
    lastCode = raw; lastAt = now;

    showRaw(raw, src);
    var resi = normResi(raw);
    if (resi.length < MIN_RESI) {
      showCard('warn', 'Kode tidak terbaca sebagai resi', 'Scan ulang, foto lebih dekat, atau ketik resinya.', '');
      feedback('warn');
      return;
    }
    var item = { id: uid(), type: 'scan', resi: resi, raw: raw.slice(0, 200), mode: mode, device: cfg.device || defaultDevice, ts: now };
    queue.push(item); saveQueue();
    undoStack.push(item.id); saveUndo();
    lastActionId = item.id;
    hist.unshift({ id: item.id, resi: resi, mode: mode, at: now, state: 'PENDING' });
    saveHist(); renderHist();
    showCard('sending', mode === 'in' ? 'Mengirim scan MASUK…' : 'Mengirim scan KELUAR…', '', resi);
    flush();
  }

  function removeUndo(id) {
    var i = undoStack.indexOf(id);
    if (i >= 0) { undoStack.splice(i, 1); saveUndo(); }
  }

  function undoLast() {
    unlockAudio();
    var id = undoStack.pop(); saveUndo();
    if (!id) { showCard('warn', 'Tidak ada scan untuk dibatalkan', '', ''); feedback('warn'); return; }
    var qi = -1;
    queue.forEach(function (q, i) { if (q.id === id) qi = i; });
    if (qi > 0 || (qi === 0 && !flushing)) {
      var it = queue.splice(qi, 1)[0]; saveQueue();
      updateHist(id, { state: 'UNDONE', t: 'warn', h: 'Dibatalkan' });
      lastActionId = null;
      showCard('ok', 'Dibatalkan', 'Scan ini belum sempat terkirim, sudah dihapus dari antrean.', it.resi);
      feedback('ok');
      renderQueue();
      return;
    }
    var h = hist.filter(function (x) { return x.id === id; })[0];
    var u = { id: uid(), type: 'undo', target: id, resi: h ? h.resi : '', device: cfg.device || defaultDevice, ts: Date.now() };
    queue.push(u); saveQueue();
    lastActionId = u.id;
    showCard('sending', 'Membatalkan scan terakhir…', '', u.resi);
    flush();
  }

  function setMode(m) {
    mode = m === 'out' ? 'out' : 'in';
    document.body.setAttribute('data-mode', mode);
    $('segIn').setAttribute('aria-pressed', String(mode === 'in'));
    $('segOut').setAttribute('aria-pressed', String(mode === 'out'));
    $('modeLabel').textContent = mode === 'in' ? 'Mode MASUK — paket selesai packing' : 'Mode KELUAR — paket diserahkan ke kurir';
    lastCode = ''; // ganti mode = boleh scan kode yang sama langsung
    renderScanBtn();
  }

  /* ---------------------------------------------------------------- */
  /* Suara & getar: OK / DOBEL / peringatan dibuat jelas beda           */
  /* ---------------------------------------------------------------- */
  var ac = null;
  function unlockAudio() {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
    } catch (e) { /* tanpa suara */ }
  }
  function tone(freq, at, dur, type, vol, freqEnd) {
    var t0 = ac.currentTime + at;
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.linearRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.setValueAtTime(vol, t0 + dur - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function vib(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* */ } }
  function feedback(t) {
    try {
      unlockAudio();
      if (ac) {
        if (t === 'ok') tone(1400, 0, 0.13, 'sine', 0.6);                        // bip pendek tinggi
        else if (t === 'dup') { tone(180, 0, 0.22, 'square', 0.4); tone(180, 0.32, 0.22, 'square', 0.4); } // buzz-buzz
        else if (t === 'warn') tone(900, 0, 0.5, 'sawtooth', 0.3, 380);           // nada turun panjang
      }
    } catch (e) { /* */ }
    if (t === 'ok') vib(70);
    else if (t === 'dup') vib([160, 90, 160, 90, 160]);
    else if (t === 'warn') vib(450);
    var c = $('card');
    c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
  }

  /* ---------------------------------------------------------------- */
  /* Kamera live & foto (html5-qrcode)                                  */
  /* ---------------------------------------------------------------- */
  var qr = null, camOn = false, camBusy = false;

  function qrConfig() {
    var F = window.Html5QrcodeSupportedFormats;
    return {
      verbose: false,
      formatsToSupport: F ? [F.CODE_128, F.CODE_39, F.QR_CODE] : undefined,
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
  }

  function camErr(e) {
    var n = (e && (e.name || String(e))) || '';
    if (/NotAllowed|Permission/i.test(n)) return 'Izin kamera ditolak. Ketuk ikon gembok di alamat browser, izinkan Kamera, lalu tekan Scan lagi.';
    if (/NotFound|Overconstrained/i.test(n)) return 'Kamera belakang tidak ditemukan. Pakai Foto resi atau ketik manual.';
    if (/NotReadable|TrackStart/i.test(n)) return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi kamera lain, lalu coba lagi.';
    return 'Pakai Foto resi atau ketik manual.';
  }

  function startCam() {
    if (camOn || camBusy) return;
    if (!window.Html5Qrcode) {
      showCard('warn', 'Pustaka kamera belum termuat', 'Cek internet lalu muat ulang halaman. Sementara pakai ketik manual.', '');
      feedback('warn'); return;
    }
    if (!window.isSecureContext) {
      showCard('warn', 'Kamera butuh HTTPS', 'Buka aplikasi lewat alamat https:// (GitHub Pages), bukan file atau http.', '');
      feedback('warn'); return;
    }
    $('reader').hidden = false;
    camBusy = true; renderScanBtn();
    qr = qr || new Html5Qrcode('reader', qrConfig());
    qr.start({ facingMode: 'environment' }, {
      fps: 12,
      aspectRatio: 1.333,
      qrbox: function (w, h) {
        var bw = Math.max(120, Math.floor(w * 0.92));
        return { width: bw, height: Math.max(80, Math.floor(Math.min(h * 0.65, bw * 0.55))) };
      }
    }, function (txt) { submitCode(txt, 'kamera'); }, function () { /* belum ketemu */ })
      .then(function () { camOn = true; camBusy = false; renderScanBtn(); })
      .catch(function (e) {
        camOn = false; camBusy = false; $('reader').hidden = true; renderScanBtn();
        showCard('warn', 'Kamera tidak bisa dibuka', camErr(e), ''); feedback('warn');
      });
  }

  function stopCam() {
    if (qr && camOn) { try { qr.stop().catch(function () {}); } catch (e) { /* */ } }
    camOn = false;
    $('reader').hidden = true;
    renderScanBtn();
  }

  function scanPhoto(file) {
    if (!file) return;
    if (!window.Html5Qrcode) { showCard('warn', 'Pustaka scan belum termuat', 'Cek internet lalu muat ulang halaman.', ''); feedback('warn'); return; }
    showCard('sending', 'Membaca foto…', '', '');
    var h = new Html5Qrcode('photoReader', qrConfig());
    h.scanFile(file, false).then(function (txt) {
      try { h.clear(); } catch (e) { /* */ }
      lastCode = ''; // foto selalu diproses
      submitCode(txt, 'foto');
    }).catch(function () {
      try { h.clear(); } catch (e) { /* */ }
      showCard('warn', 'Barcode di foto tidak terbaca', 'Foto lebih dekat, terang, dan lurus. Atau ketik resinya.', '');
      feedback('warn');
    });
  }

  /* ---------------------------------------------------------------- */
  /* Tampilan layar scan                                                */
  /* ---------------------------------------------------------------- */
  function showCard(t, h, m, resi, kurir) {
    var c = $('card');
    c.className = 'card card-' + t;
    var badge = kurir
      ? '<div class="kurir kurir-' + esc(kurir.replace(/[^A-Za-z]/g, '').toLowerCase() || 'x') + '">' +
        esc(kurir === '?' ? 'Kurir ?' : kurir) + '</div>'
      : '';
    c.innerHTML = '<div class="card-top"><div class="card-h">' + esc(h) + '</div>' + badge + '</div>' +
      (resi ? '<div class="card-resi">' + esc(resi) + '</div>' : '') +
      (m ? '<div class="card-m">' + esc(m) + '</div>' : '');
  }

  function showRaw(raw, src) {
    $('raw').innerHTML = 'Terbaca (' + esc(src) + '): <code>' + esc(raw) + '</code>';
  }

  var toastTimer = null;
  function toast(t, msg) {
    var el = $('toast');
    el.className = 'toast toast-' + t;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 7000);
  }

  function setStats(s) {
    if (!s) return;
    if (stats && stats.session && s.session && stats.session !== s.session) {
      // Sesi di-reset dari laptop: riwayat & batal lokal tidak berlaku lagi.
      undoStack = []; saveUndo();
      hist = []; saveHist(); renderHist();
    }
    stats = s; lsSet(K.stats, s);
    renderCounter();
  }

  function renderCounter() {
    var s = stats || {};
    $('cMasuk').textContent = s.masuk != null ? s.masuk : '–';
    $('cKeluar').textContent = s.keluar != null ? s.keluar : '–';
    $('cTotal').textContent = s.total != null ? s.total : '–';
  }

  function renderQueue() {
    var n = queue.length;
    var pill = $('queuePill');
    pill.hidden = n === 0;
    if (!n) return;
    var scans = queue.filter(function (q) { return q.type === 'scan'; }).length;
    var label = (scans || n) + (scans ? ' scan' : ' aksi') + ' menunggu terkirim';
    $('queueText').textContent = flushing ? label + ' · mengirim…' : label;
    $('queueWhy').textContent = !flushing && lastErr ? lastErr.message : '';
  }

  var STATE_LABEL = {
    PENDING: 'Menunggu', OK: 'OK', EXTRA: 'Kelebihan', DUP_IN: 'DOBEL', DUP_OUT: 'DOBEL',
    NOT_IN: 'Ditolak', UNREADABLE: 'Tak terbaca', UNDONE: 'Dibatalkan'
  };
  function updateHist(id, patch) {
    hist.forEach(function (x) { if (x.id === id) Object.assign(x, patch); });
    saveHist(); renderHist();
  }
  function renderHist() {
    var ul = $('hist');
    if (!hist.length) { ul.innerHTML = '<li class="empty">Belum ada scan di perangkat ini.</li>'; return; }
    ul.innerHTML = hist.slice(0, 8).map(function (x) {
      var cls = x.state === 'PENDING' ? 'pend' : x.state === 'UNDONE' ? 'undone' : (x.t || 'ok');
      return '<li><span class="h-time">' + hhmm(x.at) + '</span>' +
        '<span class="h-mode h-' + x.mode + '">' + (x.mode === 'in' ? 'MASUK' : 'KELUAR') + '</span>' +
        '<span class="h-resi">' + (x.kurir ? '<b class="h-kurir">' + esc(x.kurir) + '</b> ' : '') + esc(x.resi) + '</span>' +
        '<span class="h-st h-' + cls + '">' + esc(STATE_LABEL[x.state] || x.state) + '</span></li>';
    }).join('');
  }

  function renderScanBtn() {
    var b = $('scanBtn');
    var word = mode === 'in' ? 'MASUK' : 'KELUAR';
    $('scanLabel').textContent = camBusy ? 'Membuka kamera…' : camOn ? 'Tutup kamera' : 'Scan ' + word;
    b.classList.toggle('on', camOn);
  }

  /* ---------------------------------------------------------------- */
  /* Banner error (bilang harus apa)                                    */
  /* ---------------------------------------------------------------- */
  function showBanner(kind, msg, withSettings) {
    var b = $('banner');
    b.className = 'banner banner-' + kind;
    $('bannerText').textContent = msg;
    $('bannerBtn').hidden = !withSettings;
    b.hidden = false;
  }
  function hideBanner() { $('banner').hidden = true; }

  /* ---------------------------------------------------------------- */
  /* Impor (laptop)                                                     */
  /* ---------------------------------------------------------------- */
  var XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  var xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = XLSX_URL;
      s.onload = function () { res(); };
      s.onerror = function () { xlsxLoading = null; rej(new Error('Pustaka Excel gagal dimuat. Cek internet, lalu coba lagi.')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  function parseDeadline(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && v > 20000 && v < 80000) { // serial Excel
      var d0 = new Date(Math.round((v - 25569) * 86400000));
      return new Date(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate(), d0.getUTCHours(), d0.getUTCMinutes()).getTime();
    }
    var s = String(v).trim(), m;
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], m[4] != null ? +m[4] : 23, m[5] != null ? +m[5] : 59).getTime();
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], m[4] != null ? +m[4] : 23, m[5] != null ? +m[5] : 59).getTime();
    return null;
  }

  function findCol(cols, exact, re) {
    if (cols.indexOf(exact) >= 0) return exact;
    for (var i = 0; i < cols.length; i++) if (re.test(cols[i])) return cols[i];
    return null;
  }

  // Tidak perlu discan: diambil kurir langsung / bukan pengiriman reguler.
  var INSTAN_RE = /instan|same\s*-?\s*day|sameday|next\s*-?\s*day|ambil\s*di\s*tempat/i;

  /** rows: hasil sheet_to_json. Dedupe per resi, lewati resi kosong & dibatalkan. */
  function parseExport(rows) {
    var cols = rows.length ? Object.keys(rows[0]) : [];
    var c = {
      resi: findCol(cols, 'No. Resi', /^no\.?\s*resi|^nomor\s*resi|^resi$/i),
      no: findCol(cols, 'No. Pesanan', /^no\.?\s*pesanan|^nomor\s*pesanan/i),
      kurir: findCol(cols, 'Opsi Pengiriman', /opsi\s*pengiriman|kurir|ekspedisi/i),
      batal: findCol(cols, 'Status Pembatalan/ Pengembalian', /pembatalan|pengembalian/i),
      tenggat: findCol(cols, 'Pesanan Harus Dikirimkan Sebelum (Menghindari keterlambatan)', /harus\s*dikirim/i)
    };
    if (!c.resi) return { error: 'Kolom "No. Resi" tidak ketemu. Pastikan ini file ekspor "Perlu Dikirim" dari Shopee. Kolom yang ada: ' + cols.slice(0, 8).join(', ') };
    var seen = {}, items = [], kosong = {}, batal = {}, instan = {}, dupRows = 0;
    rows.forEach(function (r, i) {
      var no = c.no ? String(r[c.no] || '').trim() : '';
      var key = no || 'baris' + i;
      var kurir = c.kurir ? String(r[c.kurir] || '').trim() : '';
      if (c.batal && String(r[c.batal] || '').trim()) { batal[key] = 1; return; }
      // Instant & Same Day diambil kurir langsung di tempat: tidak ikut dicek.
      if (INSTAN_RE.test(kurir)) { instan[key] = 1; return; }
      var resi = normResi(r[c.resi]);
      if (resi.length < MIN_RESI) { kosong[key] = 1; return; }
      if (seen[resi]) { dupRows++; return; }
      seen[resi] = 1;
      items.push({ resi: resi, no: no, kurir: kurir, deadline: c.tenggat ? parseDeadline(r[c.tenggat]) : null, src: 'ekspor' });
    });
    return { items: items, rows: rows.length, dupRows: dupRows, skipKosong: Object.keys(kosong).length,
             skipBatal: Object.keys(batal).length, skipInstan: Object.keys(instan).length };
  }

  function parsePaste(text) {
    var seen = {}, items = [], invalid = 0;
    String(text || '').split(/[\r\n,;\t]+/).forEach(function (l) {
      if (!l.trim()) return;
      var r = normResi(l);
      if (r.length < MIN_RESI) { invalid++; return; }
      if (seen[r]) return;
      seen[r] = 1;
      items.push({ resi: r, no: '', kurir: '', deadline: null, src: 'manual' });
    });
    return { items: items, rows: items.length + invalid, dupRows: 0, skipKosong: 0, skipBatal: 0, invalid: invalid };
  }

  function readFile(file) {
    return loadXlsx().then(function () {
      return new Promise(function (res, rej) {
        var rd = new FileReader();
        rd.onload = function () {
          try {
            var wb = XLSX.read(new Uint8Array(rd.result), { type: 'array', raw: true });
            var ws = wb.Sheets[wb.SheetNames[0]];
            res(XLSX.utils.sheet_to_json(ws, { defval: '', raw: false }));
          } catch (e) { rej(new Error('File tidak bisa dibaca. Pakai file .xlsx atau .csv hasil ekspor Shopee.')); }
        };
        rd.onerror = function () { rej(new Error('File tidak bisa dibuka.')); };
        rd.readAsArrayBuffer(file);
      });
    });
  }

  var staged = null; // hasil parse yang menunggu disimpan

  function importFile(file) {
    if (!file) return Promise.resolve();
    impMsg('Membaca ' + file.name + '…');
    return readFile(file).then(function (rows) {
      if (!rows.length) { impMsg('File kosong. Ekspor ulang dari Shopee.', 'err'); return; }
      var p = parseExport(rows);
      if (p.error) { impMsg(p.error, 'err'); return; }
      return stage(p, file.name);
    }).catch(function (e) { impMsg(e.message, 'err'); });
  }

  function stage(p, label) {
    staged = null;
    $('preview').hidden = true;
    if (!p.items.length) {
      impMsg('Tidak ada resi yang bisa diimpor dari ' + label + '. ' + skipText(p), 'err');
      return Promise.resolve();
    }
    impMsg('Memeriksa ke Google Sheet…');
    return api({ action: 'importPreview', rows: p.items }, 30000).then(function (r) {
      var isNew = {};
      r.baru.forEach(function (x) { isNew[x] = 1; });
      staged = { items: p.items.filter(function (x) { return isNew[x.resi]; }), label: label };
      renderPreview(p, r);
      impMsg('');
    }, function (e) { impMsg('Belum bisa dicek ke Sheet: ' + e.message, 'err'); });
  }

  function skipText(p) {
    var a = [];
    if (p.skipKosong) a.push(p.skipKosong + ' pesanan resinya masih kosong (atur pengiriman dulu di Shopee)');
    if (p.skipBatal) a.push(p.skipBatal + ' pesanan dibatalkan/dikembalikan');
    if (p.skipInstan) a.push(p.skipInstan + ' pesanan Instant/Same Day/Next Day/Ambil di Tempat (tidak perlu discan)');
    if (p.invalid) a.push(p.invalid + ' baris bukan resi');
    return a.length ? 'Dilewati: ' + a.join('; ') + '.' : '';
  }

  function renderPreview(p, r) {
    var n = staged.items.length;
    var lines = [
      '<div class="pv-big"><b>' + n + '</b> resi baru akan ditambahkan</div>',
      '<ul class="pv-list">',
      r.sudahAda ? '<li>' + r.sudahAda + ' sudah ada di Daftar — dilewati (aman, tidak dobel)</li>' : '',
      p.skipKosong ? '<li>' + p.skipKosong + ' pesanan dilewati: resi masih kosong. Atur pengiriman di Shopee, lalu ekspor lagi.</li>' : '',
      p.skipBatal ? '<li>' + p.skipBatal + ' pesanan dilewati: dibatalkan/dikembalikan</li>' : '',
      p.skipInstan ? '<li>' + p.skipInstan + ' pesanan dilewati: Instant/Same Day/Next Day/Ambil di Tempat (tidak perlu discan)</li>' : '',
      p.invalid ? '<li>' + p.invalid + ' baris dilewati: bukan resi</li>' : '',
      p.dupRows ? '<li>' + p.dupRows + ' baris produk tambahan digabung (1 resi = 1 paket)</li>' : '',
      '</ul>'
    ];
    $('pvSummary').innerHTML = lines.join('');
    $('pvItems').innerHTML = n ? sortByDeadline(staged.items).slice(0, 200).map(itemRow).join('') : '';
    $('pvSave').disabled = !n;
    $('pvSave').textContent = n ? 'Simpan ' + n + ' resi ke Sheet' : 'Tidak ada yang baru';
    $('preview').hidden = false;
  }

  function saveStaged() {
    if (!staged || !staged.items.length) return;
    var btn = $('pvSave');
    btn.disabled = true; btn.textContent = 'Menyimpan…';
    api({ action: 'import', rows: staged.items }, 60000).then(function (r) {
      $('preview').hidden = true;
      impMsg('Tersimpan: ' + r.added + ' resi baru. ' + (r.sudahAda ? r.sudahAda + ' sudah ada sebelumnya (dilewati). ' : '') +
        'Total daftar sekarang ' + r.stats.total + '.', 'ok');
      staged = null;
      loadPending();
    }, function (e) {
      btn.disabled = false; btn.textContent = 'Coba simpan lagi';
      impMsg('Gagal menyimpan: ' + e.message, 'err');
    });
  }

  function impMsg(msg, kind) {
    var el = $('impMsg');
    el.textContent = msg || '';
    el.className = 'msg' + (kind ? ' msg-' + kind : '');
  }

  function sortByDeadline(arr) {
    return arr.slice().sort(function (a, b) {
      if (a.deadline == null) return b.deadline == null ? 0 : 1;
      if (b.deadline == null) return -1;
      return a.deadline - b.deadline;
    });
  }

  function sisa(ms) {
    var d = ms - Date.now(), neg = d < 0;
    d = Math.abs(d);
    var h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000);
    var t = h >= 48 ? Math.floor(h / 24) + ' hari' : (h ? h + 'j ' : '') + m + 'm';
    return neg ? 'lewat ' + t : t + ' lagi';
  }

  function itemRow(x) {
    var urgent = x.deadline != null && x.deadline - Date.now() < 3 * 3600000;
    return '<li class="it' + (urgent ? ' urgent' : '') + '">' +
      '<span class="it-resi">' + esc(x.resi) + '</span>' +
      '<span class="it-meta">' + esc([x.no, x.kurir].filter(Boolean).join(' · ') || 'manual') + '</span>' +
      '<span class="it-dl">' + (x.deadline != null ? esc(ddmmhhmm(x.deadline)) + ' · ' + esc(sisa(x.deadline)) : 'tanpa tenggat') + '</span></li>';
  }

  function loadPending() {
    var ul = $('pending');
    if (!cfg.url) { ul.innerHTML = '<li class="empty">Sambungkan dulu di Pengaturan (ikon gigi).</li>'; return; }
    $('pendCount').textContent = '…';
    api({ action: 'pending' }, 30000).then(function (r) {
      $('pendCount').textContent = r.items.length;
      ul.innerHTML = r.items.length ? sortByDeadline(r.items).map(itemRow).join('')
        : '<li class="empty">' + (r.stats.total ? 'Semua resi di Daftar sudah scan masuk ✔' : 'Daftar masih kosong. Impor dulu.') + '</li>';
    }, function (e) {
      $('pendCount').textContent = '!';
      ul.innerHTML = '<li class="empty err">' + esc(e.message) + '</li>';
    });
  }

  var resetArmed = null;
  function resetSession() {
    var b = $('resetBtn');
    if (!resetArmed) {
      b.textContent = 'Yakin? Tekan sekali lagi';
      b.classList.add('armed');
      resetArmed = setTimeout(function () { resetArmed = null; b.textContent = 'Reset sesi'; b.classList.remove('armed'); }, 5000);
      return;
    }
    clearTimeout(resetArmed); resetArmed = null;
    b.disabled = true; b.textContent = 'Mengarsipkan…'; b.classList.remove('armed');
    api({ action: 'reset' }, 60000).then(function (r) {
      $('resetMsg').textContent = 'Sesi diarsipkan (' + r.archived.Daftar + ' resi daftar, ' + r.archived.Scan +
        ' scan) ke tab "Arsip …" yang tersembunyi, lalu dikosongkan. Siap untuk hari baru.';
      $('resetMsg').className = 'msg msg-ok';
      loadPending();
    }, function (e) {
      $('resetMsg').textContent = 'Gagal reset: ' + e.message;
      $('resetMsg').className = 'msg msg-err';
    }).then(function () { b.disabled = false; b.textContent = 'Reset sesi'; });
  }

  /* ---------------------------------------------------------------- */
  /* Pengaturan                                                         */
  /* ---------------------------------------------------------------- */
  function openSettings() {
    stopCam();
    $('setUrl').value = cfg.url;
    $('setToken').value = cfg.token;
    $('setDevice').value = cfg.device;
    $('setMsg').textContent = '';
    $('setMsg').className = 'msg';
    var d = $('settings');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function closeSettings() {
    var d = $('settings');
    if (d.close) d.close(); else d.removeAttribute('open');
  }
  function saveSettings(ev) {
    if (ev) ev.preventDefault();
    var url = $('setUrl').value.trim(), token = $('setToken').value.trim();
    var dev = $('setDevice').value.trim().slice(0, 40) || defaultDevice;
    var msg = $('setMsg');
    if (!url || !token) { msg.textContent = 'URL dan token wajib diisi.'; msg.className = 'msg msg-err'; return; }
    var warn = '';
    if (/\/dev$/.test(url)) warn = 'URL berakhiran /dev hanya jalan untukmu. Pakai URL Web app yang berakhiran /exec. ';
    else if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) warn = 'URL biasanya berbentuk https://script.google.com/macros/s/…/exec. ';
    cfg.url = url; cfg.token = token; cfg.device = dev;
    lsSet(K.cfg, cfg);
    msg.textContent = warn + 'Menguji koneksi…'; msg.className = 'msg';
    api({ action: 'ping' }, 20000).then(function (r) {
      cfg.sheetUrl = r.sheetUrl || ''; lsSet(K.cfg, cfg);
      renderSheetLink();
      msg.textContent = 'Tersambung ✔ Daftar: ' + r.stats.total + ' resi, masuk ' + r.stats.masuk + ', keluar ' + r.stats.keluar + '.';
      msg.className = 'msg msg-ok';
      hideBanner();
      sendNow();
      if (currentView === 'impor') loadPending();
    }, function (e) {
      msg.textContent = warn + 'Gagal tersambung: ' + e.message;
      msg.className = 'msg msg-err';
    });
  }
  function renderSheetLink() {
    var a = $('openSheet');
    if (cfg.sheetUrl) { a.href = cfg.sheetUrl; a.removeAttribute('aria-disabled'); }
    else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); }
  }

  /* ---------------------------------------------------------------- */
  /* Navigasi                                                           */
  /* ---------------------------------------------------------------- */
  var currentView = 'scan';
  function showView(v) {
    currentView = v === 'impor' ? 'impor' : 'scan';
    lsSet(K.view, currentView);
    document.body.setAttribute('data-view', currentView);
    $('v-scan').hidden = currentView !== 'scan';
    $('v-impor').hidden = currentView !== 'impor';
    $('dock').hidden = currentView !== 'scan';
    Array.prototype.forEach.call(document.querySelectorAll('[data-view-btn]'), function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-view-btn') === currentView));
    });
    if (currentView === 'impor') { stopCam(); loadXlsx().catch(function () {}); loadPending(); }
    else focusManual();
  }

  function focusManual() {
    // Di laptop (scanner USB) input selalu fokus. Di HP tidak, supaya keyboard tidak menutupi layar.
    if (isTouch || currentView !== 'scan') return;
    var d = $('settings');
    if (d.open) return;
    var a = document.activeElement;
    if (a && a !== document.body && a !== $('manual') && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
    $('manual').focus();
  }

  /* ---------------------------------------------------------------- */
  /* Sambungkan event                                                   */
  /* ---------------------------------------------------------------- */
  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-view-btn]'), function (b) {
      b.addEventListener('click', function () { showView(b.getAttribute('data-view-btn')); });
    });
    $('gear').addEventListener('click', openSettings);
    $('bannerBtn').addEventListener('click', openSettings);
    $('setForm').addEventListener('submit', saveSettings);
    $('setClose').addEventListener('click', closeSettings);
    $('setTokenShow').addEventListener('click', function () {
      var t = $('setToken');
      t.type = t.type === 'password' ? 'text' : 'password';
      this.textContent = t.type === 'password' ? 'Lihat' : 'Sembunyi';
    });

    $('segIn').addEventListener('click', function () { setMode('in'); unlockAudio(); });
    $('segOut').addEventListener('click', function () { setMode('out'); unlockAudio(); });
    $('scanBtn').addEventListener('click', function () { unlockAudio(); if (camOn) stopCam(); else startCam(); });
    $('manualForm').addEventListener('submit', function (e) {
      e.preventDefault(); unlockAudio();
      var v = $('manual').value; $('manual').value = '';
      if (v.trim()) { lastCode = ''; submitCode(v, 'ketik'); }
      focusManual();
    });
    $('manual').addEventListener('blur', function () { setTimeout(focusManual, 250); });
    $('photo').addEventListener('change', function (e) {
      unlockAudio();
      var f = e.target.files && e.target.files[0]; e.target.value = '';
      scanPhoto(f);
    });
    $('undo').addEventListener('click', undoLast);
    $('queueSend').addEventListener('click', sendNow);

    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      importFile(f);
    });
    $('file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; e.target.value = '';
      importFile(f);
    });
    $('pasteBtn').addEventListener('click', function () {
      var p = parsePaste($('paste').value);
      if (!p.items.length) { impMsg('Tempel resi dulu, satu per baris.', 'err'); return; }
      stage(p, 'tempelan').then(function () { if (staged) $('paste').value = ''; });
    });
    $('pvSave').addEventListener('click', saveStaged);
    $('pvCancel').addEventListener('click', function () { staged = null; $('preview').hidden = true; impMsg(''); });
    $('pendRefresh').addEventListener('click', loadPending);
    $('resetBtn').addEventListener('click', resetSession);
    $('openSheet').addEventListener('click', function (e) {
      if (!cfg.sheetUrl) { e.preventDefault(); impMsg('Simpan Pengaturan (ikon gigi) dulu supaya link Sheet diketahui.', 'err'); }
    });

    window.addEventListener('online', sendNow);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopCam(); return; }
      sendNow();
      if (!queue.length && cfg.url) api({ action: 'stats' }).catch(function () {});
    });

    setMode('in');
    renderCounter(); renderHist(); renderQueue(); renderSheetLink();
    var v = lsGet(K.view, null) || (isTouch ? 'scan' : 'impor');
    showView(v);
    if (!cfg.url || !cfg.token) {
      showBanner('err', 'Belum tersambung ke Google Sheet. Buka Pengaturan dan isi URL script + token.', true);
    } else if (queue.length) {
      flush();
    } else {
      api({ action: 'stats' }).catch(function (e) { if (e.kind !== 'net') showBanner('err', e.message, true); });
    }
  }

  // Untuk tes otomatis (tidak dipakai aplikasi).
  window.__bs = {
    normResi: normResi, parseExport: parseExport, parsePaste: parsePaste, parseDeadline: parseDeadline,
    submitCode: submitCode, setMode: setMode, undoLast: undoLast, flush: flush, sendNow: sendNow, importFile: importFile,
    state: function () { return { queue: queue, undoStack: undoStack, hist: hist, stats: stats, cfg: cfg, flushing: flushing }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
