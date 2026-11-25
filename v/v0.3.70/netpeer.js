/* netpeer.js — PeerJS と同じ使い方で、つながらないときは中継役（game-relay）を通す部品
 *
 * 使い方（各アプリ）
 *   1. PeerJS を読み込んだあとで、このファイルを読み込む
 *   2. NetPeer.relay = 'https://game-relay.<サブドメイン>.workers.dev';
 *   3. new Peer(...) を new NetPeer(...) に替える（引数・イベント・connect・send はそのまま）
 *
 * 動き
 *   - PeerJS の直接通信には、中継役から受け取った Cloudflare の TURN を使う（受け取れなければ PeerJS の既定）
 *   - ホスト：PeerJS で待ち受けると同時に、中継役の部屋にもつないでおく
 *   - 参加者：まず PeerJS で直接つなぐ。5秒でつながらない・相手が見つからないときは、中継役を通す
 *   - 中継役が設定されていない・動いていないときは、ふつうの PeerJS と同じに動く
 *   - conn.via が 'direct'（直接）か 'relay'（中継）かを表す
 *   - 途切れても60秒は「切れた」にしない：元の回線が戻るのを待ちながら、つなぎ直す（直接→中継）。続きの番号を付けて送り、抜けた分は送り直す
 *     その間、conn.lost が true になり、conn の 'lost'・'back' が起き、参加者の画面の上に「ホストとつなぎ直しています…」を出す。相手がわざと閉じたときは、すぐ 'close'
 */
(function () {
  'use strict';
  const DIRECT_TIMEOUT = 5000;   // 直接つながるのを待つ時間
  const HELLO_TIMEOUT = 10000;   // ホストが、新しい参加者の「こちらを使う」の合図を待つ時間
  const PING_MS = 25000;
  const WAIT_MS = 60000;         // 途切れてから、切れたことにするまで（参加者）
  const HOST_WAIT_MS = 75000;    // 同じ（ホスト。参加者がつなぎ直し終わるのを待つので、少し長い）
  const ACK_WAIT = 2500;         // 相手が続きの番号を使えるか、返事を待つ時間（返事がなければ、前の版の相手）
  const BUF_MAX = 2000;          // 届いたと返事のない分を、ためておく数
  const TICK_MS = 5000;          // 見張りの間隔（返事のない分の送り直し・中継の相手がいるかの確かめ）
  const DIAL_MAX = 15000;        // 1回つなぐのにかける時間の上限
  const ICE_KEY = 'netpeer-ice';
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  };
  const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); };
  const later = (f) => setTimeout(f, 0);
  const copy = (d) => { try { return structuredClone(d); } catch (e) { return d; } }; // 送り直すまでに、アプリが中身を書き換えても変わらないように

  class Emitter {
    constructor() { this._h = {}; }
    on(e, f) { (this._h[e] || (this._h[e] = [])).push(f); return this; }
    once(e, f) { const w = (...a) => { this.off(e, w); f(...a); }; return this.on(e, w); }
    off(e, f) { const l = this._h[e]; if (l) { if (f) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } else delete this._h[e]; } return this; }
    removeListener(e, f) { return this.off(e, f); }
    removeAllListeners(e) { if (e) delete this._h[e]; else this._h = {}; return this; }
    emit(e, ...a) { (this._h[e] || []).slice().forEach(f => { try { f(...a); } catch (x) { console.error(x); } }); }
  }

  // 開発用：localStorage の netpeer-relay に URL を入れると、そちらを使う（'none' で中継なし）
  function relayBase() {
    let o = null; try { o = localStorage.getItem('netpeer-relay'); } catch (e) {}
    if (o === 'none') return '';
    return String(o || NetPeer.relay || '').replace(/\/+$/, '');
  }
  function wsUrl(path) { return relayBase().replace(/^http/, 'ws') + path; }

  let icePromise = null;
  function getIce() {
    if (!relayBase()) return Promise.resolve(null);
    try { const c = JSON.parse(ss.get(ICE_KEY) || 'null'); if (c && c.exp > Date.now() && c.iceServers) return Promise.resolve(c.iceServers); } catch (e) {}
    if (icePromise) return icePromise;
    icePromise = new Promise(res => {
      const t = setTimeout(() => res(null), 3000);
      fetch(relayBase() + '/turn').then(r => r.ok ? r.json() : null).then(j => {
        clearTimeout(t);
        const list = j && Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : null;
        if (list) ss.set(ICE_KEY, JSON.stringify({ iceServers: list, exp: Date.now() + Math.max(60, (j.ttl || 3600) - 600) * 1000 }));
        res(list);
      }).catch(() => { clearTimeout(t); res(null); });
    }).finally(() => { icePromise = null; });
    return icePromise;
  }

  // ---- つながり（PeerJS の DataConnection と同じ形） ----
  // 実際の回線（link）：{ via, send(d), close() }。回線からは onMsg・onDown（切れた）・onWeak（失敗と出たが、戻るかもしれない）・onWell（戻った）を呼ぶ
  class NetConn extends Emitter {
    constructor(peerId, metadata, opts) {
      super();
      this.peer = peerId; this.metadata = metadata; this.open = false; this.via = '';
      this.reliable = !!(opts && opts.reliable); this.label = (opts && opts.label) || ''; this.connectionId = 'nc_' + rand(10);
      this.serialization = 'json'; this._closed = false; this._link = null;
      // _mode: plain（続きの番号を使わない）・wait（相手の返事待ち）・seq（番号を付けて送る）
      this._mode = 'plain'; this._buf = []; this._pre = []; this._out = 0; this._in = 0;
      this._lost = false; this._lostT = null; this._ackT = null; this._ackN = 0; this._waitMs = HOST_WAIT_MS; this._redial = null;
      this._askAt = 0; this._askT = null; this._sentAt = 0; this._tickT = null; this._got = false; this._miss = 0; this._f = false; // _f：相手も、見張り（h）に返事をする版
    }
    get lost() { return this._lost; }
    send(d) {
      if (this._closed) return;
      if (this._mode === 'wait') { this._pre.push(d); return; }
      if (this._mode === 'plain') { if (this._link) this._link.send(d); return; }
      const m = { __np: 'd', q: ++this._out, d: copy(d), at: Date.now() };
      this._buf.push(m);
      if (this._buf.length > BUF_MAX) { this._end(); return; }
      if (this._link) this._raw(m);
    }
    _raw(m) { try { this._link.send(m.__np === 'd' ? { __np: 'd', q: m.q, d: m.d } : m); } catch (e) {} }
    // 抜けがあると伝える。続けて何度も言わない（1回ごとに、ためた分が全部送り直されるため）
    _ask() {
      const wait = this._askAt + 800 - Date.now();
      if (wait > 0) { if (!this._askT) this._askT = setTimeout(() => { this._askT = null; if (this._gap && !this._closed) this._ask(); }, wait + 50); return; }
      this._askAt = Date.now(); if (this._link) this._raw({ __np: 'n', r: this._in });
    }
    // ためた分を送り直す。頼まれるたびに送ると膨らむので、間を空ける
    _resend(force) {
      if (!force && Date.now() - this._sentAt < 500) return;
      this._sentAt = Date.now(); this._buf.slice().forEach(m => this._raw(m));
    }
    _seqOn() { this._mode = 'seq'; if (!this._tickT) this._tickT = setInterval(() => this._tick(), TICK_MS); }
    _tick() {
      if (this._closed || !this._link) return;
      const got = this._got; this._got = false;
      if (this._lost) return;
      // 次の通が来ないと気づけない抜け（最後の1通）のため、返事のない分を、時間で送り直す
      const now = Date.now(), old = this._buf[0];
      if (old && now - old.at > TICK_MS - 1000) this._buf.slice(0, 20).forEach(m => { m.at = now; this._raw(m); });
      // 中継は、相手の回線が黙って切れても分からない。20秒なにも来なければ聞き、50秒で切れたとみなす
      if (got) { this._miss = 0; return; }
      if (!this._f || this._link.via !== 'relay') return;
      this._miss++;
      if (this._miss >= 10) { this._miss = 0; const l = this._link; this._link = null; l.onMsg = l.onDown = null; l.close(); this._drop(); }
      else if (this._miss >= 4 && this._miss % 2 === 0) this._raw({ __np: 'h' });
    }
    close() { this._end(); }
    _bye() { if (!this._closed && this._link && this._mode === 'seq') this._raw({ __np: 'bye' }); }
    _attach(link) {
      const old = this._link; this._link = link; this.via = link.via;
      if (old && old !== link) old.close();
      link.onMsg = d => { if (this._link === link) this._msg(d); };
      link.onDown = () => { if (this._link === link) { this._link = null; this._drop(); } };
      link.onWeak = () => { if (this._link === link) this._drop(); };
      link.onWell = () => { if (this._link === link && this._lost) { this._well(); if (this._mode === 'seq') { this._raw({ __np: 'n', r: this._in }); this._resend(); } } };
      if (!this.open && !this._closed) { this.open = true; later(() => { if (!this._closed) this.emit('open'); }); }
    }
    _msg(d) {
      if (this._closed) return;
      this._got = true;
      if (!d || typeof d !== 'object' || !d.__np) { this.emit('data', d); return; }
      if (this._lost && this._link && this._mode === 'seq' && 'dankh'.includes(d.__np)) { this._well(); this._raw({ __np: 'n', r: this._in }); }
      if (d.__np === 'd') {
        if (d.q <= this._in) { this._ackSoon(); return; }
        if (d.q !== this._in + 1) { this._gap = true; this._ask(); return; }
        this._in = d.q; this._gap = false; this._ackSoon();
        this.emit('data', d.d);
      } else if (d.__np === 'a') this._acked(d.r);
      else if (d.__np === 'n') { this._acked(d.r); this._resend(); }
      else if (d.__np === 'h') this._raw({ __np: 'k' });
      else if (d.__np === 'hello?') { if (this._hello) this._hello(); }
      else if (d.__np === 'bye' || d.__np === 'gone') this._end();
      else if (d.__np === 'ack') this._onAck(d);
    }
    _ackSoon() {
      if (++this._ackN >= 20) { this._ackNow(); return; }
      if (!this._ackT) this._ackT = setTimeout(() => this._ackNow(), 1000);
    }
    _ackNow() { clearTimeout(this._ackT); this._ackT = null; this._ackN = 0; if (this._link && !this._closed) this._raw({ __np: 'a', r: this._in }); }
    _acked(q) { while (this._buf.length && this._buf[0].q <= q) this._buf.shift(); }
    _onAck(d) {
      if (d.f) this._f = true;
      if (this._mode === 'plain' && this._late) { this._late = false; this._seqOn(); } // 返事が遅れて届いた
      if (this._mode === 'wait') { this._seqOn(); const p = this._pre; this._pre = []; p.forEach(x => this.send(x)); }
      this._acked(d.r || 0);
      if (this._lost) { this._resend(true); this._well(); }
      if (this._onAckOnce) { const f = this._onAckOnce; this._onAckOnce = null; f(); }
    }
    _toPlain() { if (this._mode !== 'wait') return; this._mode = 'plain'; this._late = true; const p = this._pre; this._pre = []; p.forEach(x => this.send(x)); }
    // 途切れた。前の版の相手とは、つなぎ直しはできないが、元の回線が戻るのは待つ
    _drop() {
      if (this._closed) return;
      if (this._mode !== 'seq' && !this._link) { this._end(); return; }
      if (this._lost) return;
      this._lost = true; this.emit('lost');
      this._lostT = setTimeout(() => this._end(), this._waitMs);
      if (this._mode === 'seq' && this._redial) this._redial();
    }
    _well() { if (!this._lost) return; this._lost = false; clearTimeout(this._lostT); this.emit('back'); }
    _end() {
      if (this._closed) return;
      const was = this.open, l = this._link;
      if (l && this._mode === 'seq') { this._raw({ __np: 'bye' }); setTimeout(() => l.close(), 250); } else if (l) l.close(); // 相手が幽霊とつながったままにならないように、必ず知らせて閉じる
      this._closed = true; clearTimeout(this._lostT); clearTimeout(this._ackT); clearTimeout(this._askT); clearInterval(this._tickT);
      this.open = false;
      if (this._lost) { this._lost = false; this.emit('back'); }
      if (this._onEnd) this._onEnd();
      if (was || this.via) later(() => this.emit('close'));
    }
  }

  // PeerJS の DataConnection を回線にする
  function directLink(dc) {
    // JSON の送り方では、PeerJS は約16KBを超える1通を黙って捨てる（前の版の参加者）。番号が止まらないように、中身を空にして送る
    const big = d => { if (dc.serialization !== 'json') return false; try { return new TextEncoder().encode(JSON.stringify(d)).length >= 16000; } catch (e) { return false; } };
    const l = { via: 'direct', send: d => { if (d && d.__np === 'd' && big(d)) { console.warn('netpeer: too big for json'); d = { __np: 'd', q: d.q, d: null }; } dc.send(d); }, close: () => { try { dc.close(); } catch (e) {} } };
    dc.on('data', d => { if (l.onMsg) l.onMsg(d); });
    dc.on('close', () => { if (l.onDown) l.onDown(); });
    // 相手のページが急に落ちたとき：PeerJS は iceConnectionState だけを見るが、そちらは disconnected のまま failed にならないことがある。
    // connectionState の failed は15秒ほどで出る。ただし、相手の画面ロックなどでは、あとで connected に戻る
    const pc = dc.peerConnection;
    if (pc && pc.addEventListener) pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') { if (l.onWeak) l.onWeak(); } else if (pc.connectionState === 'connected') { if (l.onWell) l.onWell(); }
    });
    return l;
  }

  // 参加者の画面の上に出す知らせ
  let bar = null; const losing = new Set();
  function showBar() {
    if (!document.body) return;
    if (!losing.size) { if (bar) { bar.remove(); bar = null; } return; }
    if (bar) return;
    bar = document.createElement('div');
    bar.textContent = 'ホストとつなぎ直しています…';
    bar.style.cssText = 'position:fixed;left:50%;top:calc(8px + env(safe-area-inset-top));transform:translateX(-50%);z-index:2147483647;background:#222;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 2px 10px #0006;pointer-events:none;white-space:nowrap';
    document.body.appendChild(bar);
  }

  // ページを閉じる・移るとき：すぐ切れたと分かるように、知らせてから閉じる
  const alive = new Set();
  const sayBye = () => alive.forEach(p => p._all.forEach(nc => nc._bye()));
  if (window.addEventListener) { window.addEventListener('pagehide', sayBye); window.addEventListener('pageshow', e => { if (e.persisted) alive.forEach(p => [...p._all].forEach(nc => nc._end())); }); }

  // ---- NetPeer（PeerJS の Peer と同じ形） ----
  class NetPeer extends Emitter {
    constructor(id, opts) {
      super();
      if (id && typeof id === 'object') { opts = id; id = undefined; }
      this._wantId = id || null; this._opts = opts || {};
      this.destroyed = false; this.open = false; this._id = id || null;
      this._p = null; this._pOpen = false; this._pFailed = false; this._pIdTaken = false;
      this._relayOk = false; this._relayRejected = false; this._ws = null; this._wsTry = 0; this._queue = [];
      this._conns = new Map(); // 中継の参加者（ホスト側）: cid → 回線
      this._all = new Set();   // 生きているつながり
      this._sess = new Map();  // ホスト：続きの番号を使う参加者。合言葉 → NetConn
      alive.add(this);
      this._pending = new Set(); // 直接つなぎ中の connect（参加者側）
      this._failedOnce = false;
      if (this._wantId) {
        const k = 'netpeer-key-' + this._wantId;
        this._hostKey = ss.get(k) || rand(24); ss.set(k, this._hostKey);
        this._startRelayHost();
      } else if (relayBase() || !window.Peer) {
        // 仲介サーバーにつながらなくても、中継役で動けるようにする
        this._guestOpenTimer = setTimeout(() => this._markOpen(), window.Peer ? DIRECT_TIMEOUT : 0);
      }
      if (window.Peer) getIce().then(ice => { if (!this.destroyed) this._startPeer(ice); });
      else this._pFailed = true;
    }

    get id() { return this._id; }
    get disconnected() { return this._p ? (this._p.disconnected && !this._relayOk) : !this._relayOk; }
    get connections() { return {}; }

    _markOpen() {
      if (this.open || this.destroyed) return;
      clearTimeout(this._guestOpenTimer);
      if (!this._id) this._id = 'np-' + rand(12);
      this.open = true;
      this.emit('open', this._id);
    }

    _fail(err) {
      // 直接も中継もだめなときだけ、アプリにエラーを渡す。一度つながったあとの不調は、渡さずにつなぎ直す
      if (this.open && !(err && err.type === 'unavailable-id' && this._relayRejected)) { this._retryPeerLater(); return; }
      if (this._failedOnce) return;
      this._failedOnce = true;
      this.emit('error', err);
    }

    _startPeer(ice) {
      const opts = Object.assign({}, this._opts);
      if (ice) opts.config = Object.assign({}, opts.config || {}, { iceServers: ice });
      const p = this._wantId ? new window.Peer(this._wantId, opts) : new window.Peer(opts);
      this._p = p;
      p.on('open', id => {
        this._pOpen = true; this._pIdTaken = false; this._pFailed = false; this._peerRetryN = 0;
        if (!this._wantId && !this.open) this._id = id;
        this._markOpen();
      });
      p.on('connection', dc => this._onDirectConn(dc));
      p.on('disconnected', () => {
        this._pOpen = false;
        if (relayBase()) this._retryPeerLater();
        if (this._relayOk || (relayBase() && !this._wantId)) return;
        this.emit('disconnected', this._id);
      });
      p.on('close', () => { this._pOpen = false; });
      p.on('error', e => this._onPeerError(e));
    }

    _onPeerError(e) {
      const t = e && e.type;
      if (t === 'peer-unavailable') {
        // 直接の相手が見つからない → 中継を試す（中継の結果でアプリに伝える）
        const pend = [...this._pending];
        if (pend.length && relayBase()) { pend.forEach(c => c._directFail('unavailable')); return; }
        if (!relayBase()) this.emit('error', e);
        return;
      }
      if (t === 'unavailable-id') {
        this._pIdTaken = true;
        if (!relayBase()) { this.emit('error', e); return; }
        if (this._relayOk) { this._retryPeerLater(); return; } // 中継で部屋が取れているなら、あとで取り直す
        if (this._relayRejected || this._relayDown) this._fail(e);
        return;
      }
      // 仲介サーバーの不調など
      this._pFailed = true;
      this._pending.forEach(c => c._directFail('network'));
      if (!relayBase()) { this.emit('error', e); return; }
      if (this._wantId) {
        if (this._relayOk) { this._retryPeerLater(); return; }
        if (this._relayDown) this._fail(e);
      }
    }

    _retryPeerLater() {
      if (this._peerRetry || this.destroyed || !window.Peer) return;
      this._peerRetryN = (this._peerRetryN || 0) + 1;
      const wait = this._p && this._p.disconnected && !this._p.destroyed ? Math.min(30000, 3000 * this._peerRetryN) : Math.min(60000, 10000 * this._peerRetryN);
      this._peerRetry = setTimeout(() => {
        this._peerRetry = null;
        if (this.destroyed || this._pOpen) return;
        // 受付だけが切れたときは、直接つながっている人を残したまま、受付に戻る
        if (this._p && this._p.disconnected && !this._p.destroyed) { try { this._p.reconnect(); } catch (e) {} this._retryPeerLater(); return; }
        try { this._p && this._p.destroy(); } catch (e) {}
        this._pFailed = false;
        getIce().then(ice => { if (!this.destroyed) this._startPeer(ice); });
      }, wait);
    }

    _track(nc) { this._all.add(nc); nc._onEnd = () => { this._all.delete(nc); if (nc._sid) this._sess.delete(nc._sid); losing.delete(nc); showBar(); }; return nc; }

    // ホスト：参加者の合図（hello）を受けとる。前からの続きなら、その人の回線を付けかえる
    _hello(link, h, peerId, meta, o) {
      const s = typeof h.s === 'string' && /^[a-z0-9]{24}$/.test(h.s) ? h.s : '';
      if (h.v !== 2 || !s) { // 前の版の参加者
        const nc = this._track(new NetConn(peerId, meta, o)); this.emit('connection', nc); nc._attach(link); return;
      }
      const ex = this._sess.get(s);
      if (ex && !ex._closed) {
        ex._attach(link); ex._acked(h.r || 0);
        if (h.f) ex._f = true;
        link.send({ __np: 'ack', v: 2, r: ex._in, f: 1 });
        ex._resend(true); ex._well(); return;
      }
      if (h.k) { try { link.send({ __np: 'gone' }); } catch (e) {} setTimeout(() => link.close(), 500); return; } // 続きのはずが、こちらは覚えていない（開き直した）
      const nc = this._track(new NetConn(peerId, meta, o)); nc._seqOn(); nc._f = !!h.f; nc._sid = s; this._sess.set(s, nc);
      this.emit('connection', nc);
      link.send({ __np: 'ack', v: 2, r: 0, f: 1 });
      nc._attach(link); nc._resend(true);
    }

    // ホスト：直接の参加者
    _onDirectConn(dc) {
      if (!this._wantId && !this.open) { try { dc.close(); } catch (e) {} return; }
      const raw = dc.metadata;
      const np = raw && typeof raw === 'object' && raw.__np;
      const meta = np ? raw.m : raw;
      if (!np) { // netpeer を使っていない相手
        const nc = this._track(new NetConn(dc.peer, meta, dc));
        this.emit('connection', nc);
        const go = () => nc._attach(directLink(dc));
        if (dc.open) go(); else { dc.on('open', go); dc.on('close', () => nc._end()); }
        return;
      }
      // 相手が「直接を使う」と合図してから渡す（中継に切り替えた相手を、入って出たように見せない）
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; try { dc.close(); } catch (e) {} } }, HELLO_TIMEOUT);
      const onData = d => {
        if (done || !d || d.__np !== 'hello') return;
        done = true; clearTimeout(t); dc.off('data', onData);
        this._hello(directLink(dc), d, dc.peer, meta, dc);
      };
      dc.on('data', onData);
    }

    // ---- 中継（ホスト側） ----
    _startRelayHost() {
      if (!relayBase() || this.destroyed) { this._relayDown = true; return; }
      let ws;
      try { ws = new WebSocket(wsUrl('/room/' + encodeURIComponent(this._wantId) + '?role=host&key=' + this._hostKey)); }
      catch (e) { this._relayDown = true; return; }
      this._ws = ws;
      let opened = false, ping = null, quiet = 0;
      ws.onmessage = ev => {
        const m = String(ev.data);
        quiet = 0;
        if (m === 'pong') return;
        if (m[0] === 'c') {
          let o; try { o = JSON.parse(m.slice(1)); } catch (e) { return; }
          if (o.t === 'open') {
            opened = true; this._relayOk = true; this._relayDown = false; this._wsTry = 0;
            ping = setInterval(() => { if (++quiet > 2) { try { ws.close(); } catch (e) {} if (this._ws === ws) ws.onclose({ code: 0 }); return; } try { ws.send('ping'); } catch (e) {} }, PING_MS);
            const q = this._queue; this._queue = []; q.forEach(s => { try { ws.send(s); } catch (e) {} });
            if (this._pIdTaken) this._retryPeerLater();
            this._markOpen();
          } else if (o.t === 'error' && o.type === 'unavailable-id') {
            this._relayRejected = true;
            this._fail({ type: 'unavailable-id', message: 'ID "' + this._wantId + '" is taken' });
          } else if (o.t === 'guests') {
            const live = new Set((o.list || []).map(g => g.c));
            this._conns.forEach((l, cid) => { if (!live.has(cid)) { this._conns.delete(cid); if (l.onDown) l.onDown(); } });
            (o.list || []).forEach(g => { if (!this._conns.has(g.c)) { this._relayGuest(g.c, g.meta); const l = this._conns.get(g.c); if (l) l.send({ __np: 'hello?' }); } });
            this._all.forEach(nc => { if (nc._mode === 'seq' && nc._link && nc._link.via === 'relay') { nc._raw({ __np: 'n', r: nc._in }); nc._resend(true); } }); // こちらの回線が切れていた間の分
          } else if (o.t === 'conn') {
            this._relayGuest(o.c, o.meta);
          } else if (o.t === 'close' && o.c) {
            const l = this._conns.get(o.c); if (l) { this._conns.delete(o.c); if (l.onDown) l.onDown(); }
          }
        } else if (m[0] === 'd') {
          const nl = m.indexOf('\n'); if (nl < 2) return;
          const l = this._conns.get(m.slice(1, nl)); if (!l) return;
          let d; try { d = JSON.parse(m.slice(nl + 1)); } catch (e) { return; }
          if (l.onMsg) l.onMsg(d);
        }
      };
      let closed = false;
      ws.onclose = ev => {
        if (closed) return; closed = true;
        clearInterval(ping);
        if (this._ws !== ws && this._ws) return;
        this._ws = null;
        this._relayOk = false;
        if (this.destroyed || this._relayRejected) return;
        if (ev && ev.code === 4002) { this._relayRejected = true; this._fail({ type: 'unavailable-id', message: 'replaced' }); return; } // 複製したタブが、ホストになった。取り合いをしない
        if (!opened) {
          this._relayDown = true;
          if (this._pIdTaken || (this._pFailed && !this._pOpen)) this._fail({ type: this._pIdTaken ? 'unavailable-id' : 'network', message: 'relay unavailable' });
        }
        const wait = Math.min(15000, 1000 * Math.pow(2, this._wsTry++));
        this._wsTimer = setTimeout(() => this._startRelayHost(), wait);
      };
      ws.onerror = () => {};
    }

    _relayGuest(cid, meta) {
      const l = { via: 'relay', send: d => {
        const s = 'd' + cid + '\n' + JSON.stringify(d);
        if (this._ws && this._relayOk && this._ws.readyState === 1) this._ws.send(s); else if (this._queue.length < 500) this._queue.push(s);
      }, close: () => {
        this._conns.delete(cid);
        if (this._ws && this._relayOk) try { this._ws.send('x' + cid); } catch (e) {}
      } };
      this._conns.set(cid, l);
      // 最初のひとことが合図（hello）なら、新しい版の参加者。合図でなければ、前の版の参加者
      const plain = first => { clearTimeout(t); this._hello(l, { v: 1 }, 'relay-' + cid, meta, { reliable: true }); if (first !== undefined) { const on = l.onMsg, hold = [first]; l.onMsg = d => hold.push(d); later(() => later(() => { if (l.onMsg) l.onMsg = on; hold.forEach(d => on(d)); })); } };
      const t = setTimeout(() => plain(), 3000);
      l.onDown = () => clearTimeout(t);
      l.onMsg = d => {
        if (d && d.__np === 'hello') { clearTimeout(t); l.onMsg = l.onDown = null; this._hello(l, d, 'relay-' + cid, meta, { reliable: true }); } else plain(d);
      };
    }

    // ---- 参加者：ホストへつなぐ ----
    connect(id, opts) {
      opts = opts || {};
      const nc = this._track(new NetConn(id, opts.metadata, opts)), sid = rand(24), base = relayBase();
      nc._waitMs = WAIT_MS;
      nc.on('lost', () => { losing.add(nc); showBar(); }); nc.on('back', () => { losing.delete(nc); showBar(); });
      this._dial(id, opts, link => {
        if (nc._closed) { link.close(); return; }
        if (!base) { nc._attach(link); return; }
        nc._mode = 'wait'; nc._attach(link);
        nc._hello = () => nc._raw({ __np: 'hello', v: 2, s: sid, r: nc._in, f: 1, ...(nc._mode === 'seq' ? { k: 1 } : {}) });
        nc._hello();
        const t = setTimeout(() => nc._toPlain(), ACK_WAIT);
        nc._onAckOnce = () => clearTimeout(t);
      }, why => {
        nc._closed = true; this._all.delete(nc);
        if (!base) return; // 中継なし：PeerJS 自身のエラーがそのまま届く
        this.emit('error', { type: why === 'unavailable' ? 'peer-unavailable' : 'network', message: 'Could not connect to peer ' + id });
      });
      // つなぎ直し：つながって返事が来るまで、くり返す。元の回線が先に戻ったら、やめる
      let turn = 0;
      nc._redial = () => {
        const my = ++turn, again = ms => setTimeout(go, ms);
        const go = () => {
          if (my !== turn || nc._closed || !nc._lost || this.destroyed) return;
          if (this._p && this._p.disconnected && !this._p.destroyed) { try { this._p.reconnect(); } catch (e) {} }
          this._dial(id, opts, link => {
            if (my !== turn || nc._closed || !nc._lost) { link.close(); return; }
            let over = false;
            const stop = () => { if (!over) { over = true; clearTimeout(t); link.onMsg = link.onDown = null; link.close(); if (nc._lost) again(1000); } };
            const t = setTimeout(stop, 10000);
            link.onDown = stop;
            link.onMsg = d => {
              if (over || !d) return;
              if (d.__np === 'ack') {
                over = true; clearTimeout(t);
                if (nc._closed || !nc._lost) { link.onMsg = link.onDown = null; link.close(); return; }
                nc._attach(link); nc._msg(d);
              } else if (d.__np === 'gone') { over = true; clearTimeout(t); link.onDown = null; link.close(); if (nc._lost) nc._end(); }
            };
            try { link.send({ __np: 'hello', v: 2, s: sid, r: nc._in, k: 1, f: 1 }); } catch (e) { stop(); }
          }, () => again(2000), true);
        };
        again(1500);
      };
      return nc;
    }

    // 1本つなぐ。直接を試し、5秒でつながらない・相手が見つからないときは中継も試して、先につながったほうを渡す
    _dial(id, opts, done, fail, quiet) {
      const at = {}; let decided = false, directState = 'trying', relayState = relayBase() ? 'idle' : 'none';
      let dc = null, ws = null, timer = null;
      // 相手の受付だけが残っていると、誰も答えないまま止まるので、時間を区切る
      const limit = relayBase() ? setTimeout(() => {
        if (decided) return;
        decided = true; this._pending.delete(at); clearTimeout(timer);
        if (dc) { try { dc.close(); } catch (e) {} } if (ws) { try { ws.close(); } catch (e) {} }
        fail(relayState === 'unavailable' ? 'unavailable' : 'network');
      }, quiet ? DIAL_MAX : DIAL_MAX + 10000) : null;
      const finishFail = () => {
        if (decided) return;
        if (directState === 'trying' || relayState === 'trying' || relayState === 'idle') return;
        decided = true; this._pending.delete(at); clearTimeout(timer); clearTimeout(limit);
        fail(directState === 'unavailable' || relayState === 'unavailable' ? 'unavailable' : 'network');
      };
      const startRelay = () => {
        if (relayState !== 'idle' || decided) return;
        relayState = 'trying';
        try { ws = new WebSocket(wsUrl('/room/' + encodeURIComponent(id) + '?role=guest' + (opts.metadata !== undefined ? '&meta=' + encodeURIComponent(JSON.stringify(opts.metadata)) : ''))); }
        catch (e) { relayState = 'network'; finishFail(); return; }
        let ping = null, wait = 0, link = null;
        ws.onmessage = ev => {
          const m = String(ev.data);
          wait = 0;
          if (m === 'pong') return;
          if (m[0] === 'c') {
            let o; try { o = JSON.parse(m.slice(1)); } catch (e) { return; }
            if (o.t === 'open') {
              if (decided) { try { ws.close(); } catch (e) {} return; }
              decided = true; this._pending.delete(at); clearTimeout(timer); clearTimeout(limit); relayState = 'open';
              if (dc) { try { dc.close(); } catch (e) {} }
              ping = setInterval(() => { if (++wait > 2) { try { ws.close(); } catch (e) {} return; } try { ws.send('ping'); } catch (e) {} }, PING_MS);
              link = { via: 'relay', send: d => { if (ws.readyState === 1) ws.send('d' + JSON.stringify(d)); }, close: () => { try { ws.close(); } catch (e) {} } };
              done(link);
            } else if (o.t === 'error') {
              relayState = o.type === 'peer-unavailable' ? 'unavailable' : 'network';
            } else if (o.t === 'close') {
              try { ws.close(); } catch (e) {}
            }
          } else if (m[0] === 'd' && link) {
            let d; try { d = JSON.parse(m.slice(1)); } catch (e) { return; }
            if (link.onMsg) link.onMsg(d);
          }
        };
        ws.onclose = () => {
          clearInterval(ping);
          if (link) { if (link.onDown) link.onDown(); return; }
          if (relayState === 'trying') relayState = 'network';
          finishFail();
        };
        ws.onerror = () => {};
      };
      at._directFail = (why) => {
        if (directState !== 'trying') return;
        directState = why;
        if (relayState === 'idle') startRelay(); else finishFail();
      };

      const p = this._p;
      if (p && this._pOpen && !p.disconnected) {
        this._pending.add(at);
        const md = relayBase() ? { __np: 1, m: opts.metadata } : opts.metadata;
        dc = p.connect(id, Object.assign({}, opts, { metadata: md }, relayBase() && opts.serialization === 'json' ? { serialization: 'binary' } : {})); // json は大きい1通を送れない
        if (!dc) { at._directFail('network'); return; }
        dc.on('open', () => {
          if (decided) { try { dc.close(); } catch (e) {} return; }
          decided = true; this._pending.delete(at); clearTimeout(timer); clearTimeout(limit); directState = 'open';
          if (ws) { try { ws.close(); } catch (e) {} }
          done(directLink(dc));
        });
        dc.on('error', () => at._directFail('network'));
        dc.on('close', () => { if (directState === 'trying') at._directFail('network'); });
        if (relayBase()) timer = setTimeout(startRelay, DIRECT_TIMEOUT);
      } else {
        directState = 'network';
        if (relayBase()) later(startRelay);
        else if (!quiet) later(() => this.emit('error', { type: 'disconnected', message: 'Cannot connect to new Peer after disconnecting from server.' }));
      }
    }

    reconnect() {
      if (this.destroyed) return;
      if (this._p && this._p.disconnected && !this._p.destroyed) { try { this._p.reconnect(); } catch (e) {} }
      if (this._wantId && !this._ws && relayBase()) { clearTimeout(this._wsTimer); this._wsTry = 0; this._startRelayHost(); }
    }

    disconnect() { if (this._p) try { this._p.disconnect(); } catch (e) {} }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.open = false;
      clearTimeout(this._guestOpenTimer); clearTimeout(this._wsTimer); clearTimeout(this._peerRetry);
      alive.delete(this);
      const had = this._all.size > 0, ws = this._ws, p = this._p; this._all.forEach(nc => nc.close()); this._all.clear();
      const shut = () => { if (ws) { try { ws.close(); } catch (e) {} } if (p) { try { p.destroy(); } catch (e) {} } this._ws = null; this._conns.clear(); };
      if (had) setTimeout(shut, 350); else shut(); // 「閉じます」の知らせが届くように、少し待ってから回線を閉じる
      this.emit('close');
    }
  }

  NetPeer.relay = NetPeer.relay || '';
  window.NetPeer = NetPeer;
})();
