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
  let pref = { repeat: 'album', shuffle: false, level: '' };   // repeat: none / one / album、level: '' / '75' / '50'

  /* ---------- 覚書 ---------- */
  function loadPref() {
    try { Object.assign(pref, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) {}
  }
  function savePref() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch (e) {}
  }

  /* ---------- 音の大きさ ----------
     iPhone は audio.volume を受け付けず、Web Audio に通すと裏で眠らされる。
     そこで、あらかじめ静かな写しを焼いておき、再生はいつもの経路のまま行う。 */

  const LEVELS = [
    { key: '',   pct: 100, gain: 1,     label: 'そのまま' },
    { key: '75', pct: 75,  gain: 0.531, label: '小さめ' },
    { key: '50', pct: 50,  gain: 0.217, label: 'とても小さく' }
  ];
  const levelOf = key => LEVELS.find(l => l.key === key) || LEVELS[0];
  const audioKey = (id, key) => key ? id + '@' + key : id;

  let baking = null;   // 焼いている最中の控え（取りやめ用）

  // 音の板を十六ビットの波形に書き出す。ここで音量を焼き込む。
  function encodeWav(buffer, gain) {
    const ch = Math.min(2, buffer.numberOfChannels);
    const rate = buffer.sampleRate;
    const n = buffer.length;
    const bytes = 44 + n * ch * 2;
    const out = new ArrayBuffer(bytes);
    const v = new DataView(out);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true);
    v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * ch * 2, true);

    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        let x = chans[c][i] * gain;
        if (x > 1) x = 1; else if (x < -1) x = -1;
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out], { type: 'audio/wav' });
  }

  // 一曲ぶんの写しを焼く。解くためだけに Web Audio を借り、すぐ返す。
  async function bakeOne(meta, level) {
    const src = await getAudio(meta.id);
    if (!src) return 0;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('この端末では写しを焼けません');
    const ctx = new AC();
    let blob;
    try {
      const buf = await ctx.decodeAudioData(await src.arrayBuffer());
      blob = encodeWav(buf, level.gain);
    } finally {
      try { await ctx.close(); } catch (e) {}
    }
    await new Promise((res, rej) => {
      const t = tx(['meta', 'audio'], 'readwrite');
      t.objectStore('audio').put(blob, audioKey(meta.id, level.key));
      meta.baked = Array.from(new Set([...(meta.baked || []), level.key]));
      meta['size' + level.key] = blob.size;
      t.objectStore('meta').put(meta);
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
    return blob.size;
  }

  async function bakeAll(levelKey, onStep) {
    const level = levelOf(levelKey);
    const todo = discs.filter(d => !(d.baked || []).includes(level.key));
    baking = { stop: false };
    let done = 0, bytes = 0;
    for (const d of todo) {
      if (baking.stop) break;
      onStep(++done, todo.length, d.name);
      try { bytes += await bakeOne(d, level); }
      catch (e) { console.warn('焼けませんでした', d.name, e); }
      await new Promise(r => setTimeout(r, 0));   // 画面を固まらせない
    }
    baking = null;
    discs = await allMeta();
    return { done, bytes };
  }

  async function dropBaked(levelKey) {
    const ids = discs.filter(d => (d.baked || []).includes(levelKey)).map(d => d.id);
    await new Promise((res, rej) => {
      const t = tx(['meta', 'audio'], 'readwrite');
      for (const id of ids) t.objectStore('audio').delete(audioKey(id, levelKey));
      for (const d of discs) {
        if (!(d.baked || []).includes(levelKey)) continue;
        d.baked = d.baked.filter(k => k !== levelKey);
        delete d['size' + levelKey];
        t.objectStore('meta').put(d);
      }
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
    discs = await allMeta();
  }

  function bakedCount(levelKey) {
    return discs.filter(d => (d.baked || []).includes(levelKey)).length;
  }
  function bakedBytes(levelKey) {
    return discs.reduce((n, d) => n + (d['size' + levelKey] || 0), 0);
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

  async function playAt(i, seekTo, autoplay) {
    const t = queue[i];
    if (!t) return;
    at = i;
    // 選んだ大きさの写しがあればそれを、無ければそのままの音を鳴らす
    const key = (t.baked || []).includes(pref.level) ? pref.level : '';
    const blob = await getAudio(audioKey(t.id, key));
    if (!blob) { toast('音盤が見つかりません'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    const a = el();
    a.src = objectUrl;
    if (seekTo) {
      a.addEventListener('loadedmetadata', () => { try { a.currentTime = seekTo; } catch (e) {} }, { once: true });
    }
    if (autoplay !== false) {
      try { await a.play(); } catch (e) { console.warn('鳴らせませんでした', e); }
    }
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
    if (a.paused) a.play().catch(() => {}); else a.pause();
  }

  async function setLevel(key) {
    pref.level = key;
    savePref();
    const t = queue[at];
    if (t) {
      const a = el();
      await playAt(at, a.currentTime, !a.paused);
    }
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
        <p>耳もとの機器のいちばん小さい目盛りより、さらに絞れます。
        小さい音は<strong>あらかじめ静かな写しを焼いて</strong>おき、鳴らすときはいつもの経路を通ります。
        だから裏に回っても止まりません。</p>
        <div class="btnrow">
          ${LEVELS.map(l => `<button class="chip" data-level="${l.key}" aria-pressed="${pref.level === l.key}">${l.label}${l.key ? '（' + l.pct + '%）' : ''}</button>`).join('')}
        </div>
        <p class="hint" style="margin-top:12px">
          ${LEVELS.slice(1).map(l => {
            const done = bakedCount(l.key);
            return `${l.pct}% の写し … ${done} / ${discs.length} 曲${done ? '（' + fmtSize(bakedBytes(l.key)) + '）' : ''}`;
          }).join('<br>')}
        </p>
        ${pref.level && bakedCount(pref.level) < discs.length ? `
          <div class="btnrow" style="margin-top:10px">
            <button class="btn primary" id="snd-bake">${levelOf(pref.level).pct}% の写しを焼く（${discs.length - bakedCount(pref.level)} 曲）</button>
          </div>
          <p class="hint" style="margin-top:8px">写しの無い曲は、そのままの大きさで鳴ります。
          写しは元の 5〜10 倍ほどの場所を取ります（音を解いた素のままの形で持つため）。</p>
        ` : ''}
        ${LEVELS.slice(1).some(l => bakedCount(l.key)) ? `
          <div class="btnrow" style="margin-top:10px">
            ${LEVELS.slice(1).filter(l => bakedCount(l.key)).map(l =>
              `<button class="btn ghost" data-drop-level="${l.key}">${l.pct}% の写しを捨てる</button>`).join('')}
          </div>` : ''}
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
    qa('[data-level]', view).forEach(b => b.addEventListener('click', async () => {
      await setLevel(b.dataset.level);
      renderPage(view);
    }));

    const bake = q('#snd-bake', view);
    if (bake) bake.addEventListener('click', () => {
      const level = levelOf(pref.level);
      const todo = discs.length - bakedCount(level.key);
      const el2 = dialog(`
        <h3>${level.pct}% の写しを焼く</h3>
        <p><strong>${todo} 曲</strong>の静かな写しを作ります。曲の長さによっては数分かかります。
        焼いているあいだ、この画面は開いたままにしてください。</p>
        <p class="mono" id="bake-log">はじめます…</p>
        <div class="form-actions">
          <button class="btn ghost" id="bake-stop">とりやめる</button>
        </div>`);
      const log = q('#bake-log', el2);
      q('#bake-stop', el2).addEventListener('click', () => { if (baking) baking.stop = true; closeDialog(); });
      bakeAll(level.key, (i, n, name) => { log.textContent = `${i} / ${n} 曲目　${name}`; })
        .then(r => {
          closeDialog();
          toast(r.done + ' 曲の写しを焼きました');
          renderPage(view);
        })
        .catch(e => { closeDialog(); console.error(e); toast('写しを焼けませんでした'); });
    });

    qa('[data-drop-level]', view).forEach(b => b.addEventListener('click', () => {
      const key = b.dataset.dropLevel;
      confirmDialog('写しを捨てますか', `${levelOf(key).pct}% の写し ${bakedCount(key)} 曲ぶん（${fmtSize(bakedBytes(key))}）を取り除きます。元の音はそのまま残ります。`, async () => {
        await dropBaked(key);
        if (pref.level === key) await setLevel('');
        toast('写しを捨てました');
        renderPage(view);
      });
    }));

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
    // 確かめ用：いま選んでいる段階と、写しの焼け具合
    level: () => pref.level,
    baked: () => LEVELS.slice(1).map(l => ({ pct: l.pct, done: bakedCount(l.key), bytes: bakedBytes(l.key) })),
    playingSrc: () => (queue[at] ? ((queue[at].baked || []).includes(pref.level) ? pref.level || '原音' : '原音') : null)
  };
})();
