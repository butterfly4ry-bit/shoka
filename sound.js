/* =============================================================
   蓄音機 — 音盤を納めて鳴らす
   音の実体は IndexedDB に置き、目録だけを手元に広げる。
   書架を読み歩いても、鳴っている音は途切れない。
   ============================================================= */
'use strict';

window.Sound = (function () {
  const DB_NAME = 'shoka.sound';
  const PREF_KEY = 'shoka.sound.pref';

  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let db = null;
  let discs = [];          // 目録（音そのものは持たない）
  let queue = [];          // いま鳴らしている並び
  let at = -1;             // queue の中の位置
  let objectUrl = null;
  let pref = { repeat: 'album', shuffle: false, volume: 1 };   // repeat: none / one / album
  let ctx = null, gainNode = null, srcNode = null;

  /* ---------- 覚書 ---------- */
  function loadPref() {
    try { Object.assign(pref, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) {}
  }
  function savePref() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch (e) {}
  }

  /* ---------- 音の大きさ ----------
     iPhone は audio.volume を受け付けないので、絞るときだけ Web Audio に通す。
     100% のままなら経路を作らない（裏での鳴り続けやすさを損なわないため）。 */

  // つまみの目盛りを、耳に合う曲がり方に直す（小さい側を細かく）
  const curve = v => Math.pow(Math.max(0, Math.min(1, v)), 2.2);

  function buildGraph() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      srcNode = ctx.createMediaElementSource(el());
      gainNode = ctx.createGain();
      srcNode.connect(gainNode);
      gainNode.connect(ctx.destination);
      return true;
    } catch (e) {
      console.warn('音量の経路を作れません', e);
      ctx = null;
      return false;
    }
  }

  /* iOS は裏に回ると音声の経路ごと眠らせる。
     耳に聞こえない極小の音を別の口で流し続けて、目を覚まさせておく。 */
  const keepEl = () => q('#keepalive');

  function silentTrack(seconds) {
    const rate = 8000, n = rate * seconds;
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    // 十六ビットの一番下の桁だけを揺らす（およそ -90dB。耳には届かない）
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 400 < 200 ? 1 : -1, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function keepAlive(on) {
    const k = keepEl();
    if (!k) return;
    if (on) {
      if (!k.src) k.src = silentTrack(3);
      if (k.paused) k.play().catch(() => {});
    } else if (!k.paused) k.pause();
  }

  // Web Audio に通しているあいだだけ、下敷きを敷く
  function syncKeepAlive() {
    keepAlive(!!ctx && !el().paused);
  }

  function resumeCtx() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function applyVolume() {
    const v = pref.volume == null ? 1 : pref.volume;
    if (v >= 0.999 && !ctx) { el().volume = 1; keepAlive(false); return; }   // まだ絞っていない＝経路を作らない
    if (buildGraph()) {
      gainNode.gain.value = curve(v);
      resumeCtx();
      syncKeepAlive();
    } else {
      el().volume = v;      // Web Audio が無い端末のための控え
    }
  }

  function setVolume(v) {
    pref.volume = Math.max(0, Math.min(1, v));
    savePref();
    applyVolume();
    const n = q('#snd-vol-n');
    if (n) n.textContent = Math.round(pref.volume * 100) + '%';
    qa('[data-vol]').forEach(b => b.setAttribute('aria-pressed', String(Math.round(pref.volume * 100) === Number(b.dataset.vol))));
  }

  /* ---------- 蔵（IndexedDB） ---------- */
  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio');
      };
      req.onsuccess = () => { db = req.result; res(db); };
      req.onerror = () => rej(req.error);
    });
  }

  function tx(stores, mode) {
    return db.transaction(stores, mode);
  }

  function allMeta() {
    return new Promise((res, rej) => {
      const r = tx(['meta'], 'readonly').objectStore('meta').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  }

  function getAudio(id) {
    return new Promise((res, rej) => {
      const r = tx(['audio'], 'readonly').objectStore('audio').get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  function putDisc(meta, blob) {
    return new Promise((res, rej) => {
      const t = tx(['meta', 'audio'], 'readwrite');
      t.objectStore('meta').put(meta);
      t.objectStore('audio').put(blob, meta.id);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  }

  function removeDiscs(ids) {
    return new Promise((res, rej) => {
      const t = tx(['meta', 'audio'], 'readwrite');
      for (const id of ids) { t.objectStore('meta').delete(id); t.objectStore('audio').delete(id); }
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
  }

  /* ---------- 名前を読む ---------- */
  // 「02 序曲.mp3」→ 二曲目「序曲」。フォルダから選んだときは、その名を音盤の名にする。
  function readName(file) {
    const path = file.webkitRelativePath || '';
    const parts = path.split('/').filter(Boolean);
    const album = parts.length > 1 ? parts[parts.length - 2] : '';
    let base = file.name.replace(/\.[a-z0-9]{1,5}$/i, '');
    // 「01 序曲」「1. 序曲」「03-序曲」など、頭の番号を外して曲順に使う
    const m = base.match(/^\s*(\d{1,3})\s*[.\-_–—．　]+\s*(.+)$/) || base.match(/^\s*(\d{2,3})\s+(.+)$/);
    const track = m ? Number(m[1]) : null;
    if (m) base = m[2];
    return { name: base.trim() || file.name, album: (album || 'その他').trim(), track };
  }

  const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
  const fmtTime = s => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  };

  /* ---------- 納める ---------- */
  async function addFiles(files, albumName) {
    await open();
    const arr = Array.from(files).filter(f => /^audio\//.test(f.type) || /\.(mp3|m4a|aac|wav|flac|ogg|opus|oga)$/i.test(f.name));
    if (!arr.length) { toast('音の入った file が見つかりませんでした'); return 0; }

    if (navigator.storage?.persist) { try { await navigator.storage.persist(); } catch (e) {} }

    let n = 0;
    for (const f of arr) {
      const info = readName(f);
      if (albumName) info.album = albumName;
      const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      await putDisc({
        id, name: info.name, album: info.album, track: info.track,
        type: f.type || '', size: f.size, added: Date.now()
      }, f);
      n++;
    }
    discs = await allMeta();
    return n;
  }

  function renameAlbum(oldName, next) {
    return new Promise((res, rej) => {
      const store = tx(['meta'], 'readwrite').objectStore('meta');
      let left = 0, done = false;
      const finish = () => { if (done && left === 0) res(); };
      for (const d of discs) {
        if (d.album !== oldName) continue;
        left++;
        d.album = next;
        const r = store.put(d);
        r.onsuccess = () => { left--; finish(); };
        r.onerror = () => rej(r.error);
      }
      done = true; finish();
    });
  }

  /* ---------- 並べる ---------- */
  function albums() {
    const map = new Map();
    for (const d of discs) {
      if (!map.has(d.album)) map.set(d.album, []);
      map.get(d.album).push(d);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        if (a.track != null && b.track != null && a.track !== b.track) return a.track - b.track;
        if (a.track != null && b.track == null) return -1;
        if (a.track == null && b.track != null) return 1;
        return a.name.localeCompare(b.name, 'ja');
      });
    }
    return Array.from(map.entries()).map(([name, tracks]) => ({ name, tracks }));
  }

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ---------- 鳴らす ---------- */
  const el = () => q('#player');

  async function playList(tracks, startId) {
    if (!tracks.length) return;
    queue = pref.shuffle ? shuffled(tracks) : tracks.slice();
    if (startId) {
      const i = queue.findIndex(t => t.id === startId);
      if (pref.shuffle && i > 0) { const [t] = queue.splice(i, 1); queue.unshift(t); }
      at = pref.shuffle ? 0 : Math.max(0, i);
    } else at = 0;
    await playAt(at);
  }

  async function playAt(i) {
    const t = queue[i];
    if (!t) return;
    at = i;
    const blob = await getAudio(t.id);
    if (!blob) { toast('音盤が見つかりません'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    const a = el();
    a.src = objectUrl;
    applyVolume();
    resumeCtx();
    try { await a.play(); } catch (e) { console.warn('鳴らせませんでした', e); }
    setSession(t);
    paint();
  }

  function next(auto) {
    if (!queue.length) return;
    if (auto && pref.repeat === 'one') { playAt(at); return; }
    if (at + 1 < queue.length) { playAt(at + 1); return; }
    if (pref.repeat === 'album') { playAt(0); return; }
    if (auto) { el().pause(); paint(); }
  }

  function prev() {
    if (!queue.length) return;
    if (el().currentTime > 3) { el().currentTime = 0; return; }
    playAt(at > 0 ? at - 1 : queue.length - 1);
  }

  function toggle() {
    const a = el();
    if (!a.src) { const al = albums()[0]; if (al) playList(al.tracks); return; }
    if (a.paused) { resumeCtx(); a.play().catch(() => {}); } else a.pause();
  }

  /* ---------- ロック画面の操作盤 ---------- */
  function setSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.name,
        artist: t.album,
        album: '書架 — 蓄音機',
        artwork: [
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
      const set = (k, fn) => { try { navigator.mediaSession.setActionHandler(k, fn); } catch (e) {} };
      set('play', () => el().play());
      set('pause', () => el().pause());
      set('previoustrack', prev);
      set('nexttrack', () => next(false));
      set('seekbackward', d => { el().currentTime = Math.max(0, el().currentTime - (d?.seekOffset || 10)); });
      set('seekforward', d => { el().currentTime = Math.min(el().duration || 0, el().currentTime + (d?.seekOffset || 10)); });
      set('seekto', d => { if (d?.seekTime != null) el().currentTime = d.seekTime; });
    } catch (e) {}
  }

  /* ---------- 下の小さな盤 ---------- */
  function paint() {
    const bar = q('#nowplaying');
    if (!bar) return;
    const t = queue[at];
    const a = el();
    bar.hidden = !t;
    document.body.classList.toggle('has-player', !!t);
    if (!t) return;
    q('#np-name').textContent = t.name;
    q('#np-album').textContent = t.album;
    q('#np-play').textContent = a.paused ? '▶' : '❚❚';
    q('#np-play').setAttribute('aria-label', a.paused ? '鳴らす' : '止める');
    qa('.disc').forEach(d => d.classList.toggle('spin', !a.paused));
    const p = a.duration ? (a.currentTime / a.duration) * 100 : 0;
    q('#np-fill').style.width = p + '%';
    if (location.hash === '#/sound') paintPage();
  }

  function paintPage() {
    const t = queue[at];
    qa('#view .track').forEach(b => b.classList.toggle('now', !!t && b.dataset.id === t.id));
    const a = el();
    const time = q('#snd-time');
    if (time) time.textContent = t ? fmtTime(a.currentTime) + ' / ' + fmtTime(a.duration) : '';
  }

  /* ---------- 蓄音機の間 ---------- */
  function renderPage(view) {
    const list = albums();
    const total = discs.reduce((n, d) => n + (d.size || 0), 0);

    view.innerHTML = `
      <div class="breadcrumb"><button data-go="/">書架</button> ／ 蓄音機</div>
      <div class="plate">
        <div class="stamp">蓄音<br>GRAMOPHONE</div>
        <h1>蓄 音 機</h1>
        <p class="lede">読みながら鳴らしておけます。音盤はこの端末の中に納められ、電波がなくても回ります。</p>
        <p class="meta">${discs.length
          ? `音盤 ${discs.length} 枚 &middot; ${list.length} 揃い &middot; ${fmtSize(total)}`
          : 'まだ一枚も納めていません'}</p>
      </div>

      <div class="panel">
        <h3>音 盤 を 納 め る</h3>
        <p>ドライブから「ファイル」に落とした曲を選んでください。mp3・m4a・wav などが納まります。</p>
        <div class="btnrow">
          <button class="btn primary" id="snd-pick">曲を選んで納める</button>
          <button class="btn" id="snd-pick-dir">フォルダごと納める</button>
        </div>
        <input id="snd-file" type="file" accept="audio/*" multiple hidden>
        <input id="snd-dir" type="file" accept="audio/*" multiple webkitdirectory hidden>
      </div>

      ${discs.length ? `
      <div class="panel">
        <h3>音 の 大 き さ</h3>
        <p>耳もとの機器のいちばん小さい目盛りより、さらに絞れます。小さい側ほど細かく効きます。</p>
        <div class="vol-row">
          <span class="vol-mark">◦</span>
          <input id="snd-vol" type="range" min="0" max="100" step="1" value="${Math.round((pref.volume == null ? 1 : pref.volume) * 100)}"
            aria-label="音の大きさ">
          <span class="vol-mark big">◉</span>
          <span id="snd-vol-n" class="vol-num">${Math.round((pref.volume == null ? 1 : pref.volume) * 100)}%</span>
        </div>
        <div class="btnrow" style="margin-top:10px">
          ${[100, 75, 50, 25, 10].map(v => `<button class="chip" data-vol="${v}" aria-pressed="${Math.round((pref.volume == null ? 1 : pref.volume) * 100) === v}">${v}%</button>`).join('')}
        </div>
        <p class="hint" style="margin-top:12px">
          100% のあいだは、iPhone でいちばん途切れにくい鳴らし方のままです。
          絞ると別の経路に通すため、裏に回したとき止まることがあります。
          そのときは 100% に戻し、いちど閉じて開き直してください。
        </p>
      </div>

      <div class="shelf-modes" style="margin:22px 0 4px">
        <span class="modes-label">鳴らし方</span>
        <button class="chip" data-rep="album" aria-pressed="${pref.repeat === 'album'}">一揃い繰り返し</button>
        <button class="chip" data-rep="one" aria-pressed="${pref.repeat === 'one'}">一曲繰り返し</button>
        <button class="chip" data-rep="none" aria-pressed="${pref.repeat === 'none'}">繰り返さない</button>
        <button class="chip" id="snd-shuffle" aria-pressed="${pref.shuffle}">順不同</button>
      </div>` : ''}

      ${list.map(al => `
        <div class="section-head sub">
          <h2>${esc(al.name)}</h2>
          <span class="count">${al.tracks.length} 曲</span>
        </div>
        <ul class="toc">
          ${al.tracks.map((t, i) => `
            <li><button class="track" data-id="${esc(t.id)}" data-album="${esc(al.name)}">
              <span class="num">${t.track != null ? String(t.track).padStart(2, '0') : String(i + 1).padStart(2, '0')}</span>
              <span class="stack-t">
                <span class="ttl">${esc(t.name)}</span>
                <span class="sub-inline">${fmtSize(t.size || 0)}</span>
              </span>
            </button></li>`).join('')}
        </ul>
        <div class="form-actions" style="margin:10px 0 24px">
          <button class="btn ghost" data-play-album="${esc(al.name)}">この一揃いを鳴らす</button>
          <button class="btn ghost" data-rename-album="${esc(al.name)}">名を改める</button>
          <span class="spacer"></span>
          <button class="btn danger" data-drop-album="${esc(al.name)}">この一揃いを捨てる</button>
        </div>`).join('')}

      ${!discs.length ? `
        <div class="empty">
          <div class="mark">◎</div>
          <h2>音盤はまだ一枚も</h2>
          <p>iPhone なら、ドライブのフォルダを「ファイル」に保存してから<br>
          「曲を選んで納める」で選びます。パソコンなら、フォルダごと納められます。</p>
        </div>` : ''}`;

    qa('[data-go]', view).forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
    q('#snd-pick').addEventListener('click', () => q('#snd-file').click());
    q('#snd-pick-dir').addEventListener('click', () => q('#snd-dir').click());
    ['#snd-file', '#snd-dir'].forEach(sel => q(sel).addEventListener('change', e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      // フォルダごと選んだときは、その名を初めから入れておく
      const folder = (files[0].webkitRelativePath || '').split('/').filter(Boolean).slice(-2, -1)[0] || '';
      promptDialog({
        title: '音盤の名',
        desc: `<strong>${files.length} 曲</strong>を納めます。ひとまとまりの名を付けてください。`,
        label: '一揃いの名',
        value: folder,
        options: list.map(a => a.name),
        hint: 'あとから「名を改める」で変えられます。空欄なら「その他」に入ります。',
        okText: '納める',
        onOk: async name => {
          closeDialog();
          toast(files.length + ' 曲を納めています…');
          const n = await addFiles(files, name || 'その他');
          toast(n + ' 曲を納めました');
          renderPage(view);
        }
      });
    }));

    qa('.track', view).forEach(b => b.addEventListener('click', () => {
      const al = list.find(x => x.name === b.dataset.album);
      playList(al.tracks, b.dataset.id);
    }));
    qa('[data-play-album]', view).forEach(b => b.addEventListener('click', () => {
      const al = list.find(x => x.name === b.dataset.playAlbum);
      playList(al.tracks);
    }));
    qa('[data-drop-album]', view).forEach(b => b.addEventListener('click', () => {
      const name = b.dataset.dropAlbum;
      const al = list.find(x => x.name === name);
      confirmDialog('この一揃いを捨てますか', `「${name}」の ${al.tracks.length} 曲を、この端末から取り除きます。`, async () => {
        await removeDiscs(al.tracks.map(t => t.id));
        discs = await allMeta();
        if (queue.some(t => al.tracks.some(x => x.id === t.id))) { el().pause(); queue = []; at = -1; paint(); }
        toast('捨てました');
        renderPage(view);
      });
    }));
    const vol = q('#snd-vol', view);
    if (vol) {
      vol.addEventListener('input', e => setVolume(Number(e.target.value) / 100));
      qa('[data-vol]', view).forEach(b => b.addEventListener('click', () => {
        vol.value = b.dataset.vol;
        setVolume(Number(b.dataset.vol) / 100);
      }));
    }

    qa('[data-rename-album]', view).forEach(b => b.addEventListener('click', () => {
      const name = b.dataset.renameAlbum;
      promptDialog({
        title: '音盤の名を改める',
        desc: `「${esc(name)}」に入っている曲すべての一揃い名を、いちどに書き替えます。`,
        label: '新しい一揃いの名',
        value: name,
        options: list.map(a => a.name).filter(x => x !== name),
        hint: 'すでにある名前を入れると、そちらと一つにまとまります。',
        onOk: async next => {
          if (!next || next === name) return closeDialog();
          await renameAlbum(name, next);
          discs = await allMeta();
          closeDialog();
          toast('名を改めました');
          renderPage(view);
        }
      });
    }));

    qa('[data-rep]', view).forEach(b => b.addEventListener('click', () => {
      pref.repeat = b.dataset.rep; savePref(); renderPage(view);
    }));
    const sh = q('#snd-shuffle', view);
    if (sh) sh.addEventListener('click', () => { pref.shuffle = !pref.shuffle; savePref(); renderPage(view); });

    paintPage();
  }

  /* ---------- 起動 ---------- */
  async function init() {
    loadPref();
    try { await open(); discs = await allMeta(); } catch (e) { console.warn('蓄音機を開けません', e); }

    const a = el();
    a.addEventListener('play', paint);
    a.addEventListener('pause', paint);
    a.addEventListener('timeupdate', paint);
    a.addEventListener('ended', () => next(true));
    a.addEventListener('error', () => toast('この音盤は鳴らせませんでした'));

    a.addEventListener('play', () => { resumeCtx(); syncKeepAlive(); });
    a.addEventListener('pause', () => keepAlive(false));
    // 下敷きは裏でも時を刻む。その拍に合わせて、眠った経路を起こし直す。
    keepEl().addEventListener('timeupdate', resumeCtx);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeCtx(); });
    applyVolume();

    q('#np-play').addEventListener('click', toggle);
    q('#np-prev').addEventListener('click', prev);
    q('#np-next').addEventListener('click', () => next(false));
    qa('.np-open').forEach(b => b.addEventListener('click', () => { location.hash = '/sound'; }));
    q('#np-seek').addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      if (a.duration) a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
    });

    // パソコンでは、窓に落として納められる
    const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
    document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', async e => {
      if (!hasFiles(e) || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      const n = await addFiles(e.dataTransfer.files);
      if (n) { toast(n + ' 曲を納めました'); if (location.hash === '#/sound') renderPage(document.getElementById('view')); }
    });

    paint();
    // 目録は蔵から読むので、画面が先に出ていたら描き直す
    if (location.hash === '#/sound') renderPage(document.getElementById('view'));
  }

  return {
    init, renderPage, addFiles,
    count: () => discs.length,
    volume: () => (pref.volume == null ? 1 : pref.volume),
    // 実際に効いている音量と、経路の状態（確かめ用）
    gain: () => (gainNode ? gainNode.gain.value : null),
    route: () => (ctx ? ctx.state : 'plain')
  };
})();
