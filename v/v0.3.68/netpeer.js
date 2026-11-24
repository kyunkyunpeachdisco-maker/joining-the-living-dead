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
 */
(function () {
  'use strict';
  const DIRECT_TIMEOUT = 5000;   // 直接つながるのを待つ時間
  const HELLO_TIMEOUT = 10000;   // ホストが、新しい参加者の「こちらを使う」の合図を待つ時間
  const PING_MS = 25000;
  const ICE_KEY = 'netpeer-ice';
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  };
  const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); };
  const later = (f) => setTimeout(f, 0);

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
  class NetConn extends Emitter {
    constructor(peerId, metadata, opts) {
      super();
      this.peer = peerId; this.metadata = metadata; this.open = false; this.via = '';
      this.reliable = !!(opts && opts.reliable); this.label = (opts && opts.label) || ''; this.connectionId = 'nc_' + rand(10);
      this.serialization = 'json'; this._closed = false; this._send = null; this._close = null;
    }
    send(d) { if (this._send && !this._closed) this._send(d); }
    close() { if (this._closed) return; if (this._close) this._close(); this._end(); }
    _ready(via, send, close) { this.via = via; this._send = send; this._close = close; this.open = true; later(() => { if (!this._closed) this.emit('open'); }); }
    _end() { if (this._closed) return; this._closed = true; const was = this.open; this.open = false; if (was || this.via) later(() => this.emit('close')); }
  }

  // PeerJS の DataConnection を NetConn の形に包む
  function wrapDirect(nc, dc, skipFirstHello) {
    let skip = skipFirstHello;
    dc.on('data', d => { if (skip && d && d.__np === 'hello') { skip = false; return; } nc.emit('data', d); });
    dc.on('close', () => nc._end());
    dc.on('error', e => nc.emit('error', e));
    nc._ready('direct', d => dc.send(d), () => { try { dc.close(); } catch (e) {} });
  }

  // ---- NetPeer（PeerJS の Peer と同じ形） ----
  class NetPeer extends Emitter {
    constructor(id, opts) {
      super();
      if (id && typeof id === 'object') { opts = id; id = undefined; }
      this._wantId = id || null; this._opts = opts || {};
      this.destroyed = false; this.open = false; this._id = id || null;
      this._p = null; this._pOpen = false; this._pFailed = false; this._pIdTaken = false;
      this._relayOk = false; this._relayRejected = false; this._ws = null; this._wsTry = 0; this._queue = [];
      this._conns = new Map(); // 中継の参加者（ホスト側）: cid → NetConn
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
      // 直接も中継もだめなときだけ、アプリにエラーを渡す
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
        this._pOpen = true; this._pIdTaken = false;
        if (!this._wantId && !this.open) this._id = id;
        this._markOpen();
      });
      p.on('connection', dc => this._onDirectConn(dc));
      p.on('disconnected', () => {
        this._pOpen = false;
        if (this._relayOk || (relayBase() && !this._wantId)) { setTimeout(() => { if (!this.destroyed && p.disconnected && !p.destroyed) try { p.reconnect(); } catch (e) {} }, 3000); return; }
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
      if (this._peerRetry || this.destroyed) return;
      this._peerRetryN = (this._peerRetryN || 0) + 1;
      if (this._peerRetryN > 6) return;
      this._peerRetry = setTimeout(() => {
        this._peerRetry = null;
        if (this.destroyed || this._pOpen) return;
        try { this._p && this._p.destroy(); } catch (e) {}
        this._pFailed = false;
        getIce().then(ice => { if (!this.destroyed) this._startPeer(ice); });
      }, 10000);
    }

    // ホスト：直接の参加者
    _onDirectConn(dc) {
      if (!this._wantId && !this.open) { try { dc.close(); } catch (e) {} return; }
      const raw = dc.metadata;
      const np = raw && typeof raw === 'object' && raw.__np;
      const meta = np ? raw.m : raw;
      const nc = new NetConn(dc.peer, meta, dc);
      if (!np) { // netpeer を使っていない相手（古い版）
        this.emit('connection', nc);
        const go = () => wrapDirect(nc, dc, false);
        if (dc.open) go(); else { dc.on('open', go); dc.on('close', () => nc._end()); }
        return;
      }
      // 相手が「直接を使う」と合図してから渡す（中継に切り替えた相手を、入って出たように見せない）
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; try { dc.close(); } catch (e) {} } }, HELLO_TIMEOUT);
      const onData = d => {
        if (done || !d || d.__np !== 'hello') return;
        done = true; clearTimeout(t); dc.off('data', onData);
        this.emit('connection', nc);
        wrapDirect(nc, dc, false);
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
      let opened = false, ping = null;
      ws.onmessage = ev => {
        const m = String(ev.data);
        if (m === 'pong') return;
        if (m[0] === 'c') {
          let o; try { o = JSON.parse(m.slice(1)); } catch (e) { return; }
          if (o.t === 'open') {
            opened = true; this._relayOk = true; this._relayDown = false; this._wsTry = 0;
            ping = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, PING_MS);
            const q = this._queue; this._queue = []; q.forEach(s => { try { ws.send(s); } catch (e) {} });
            if (this._pIdTaken) this._retryPeerLater();
            this._markOpen();
          } else if (o.t === 'error' && o.type === 'unavailable-id') {
            this._relayRejected = true;
            this._fail({ type: 'unavailable-id', message: 'ID "' + this._wantId + '" is taken' });
          } else if (o.t === 'guests') {
            const live = new Set((o.list || []).map(g => g.c));
            this._conns.forEach((nc, cid) => { if (!live.has(cid)) { this._conns.delete(cid); nc._end(); } });
            (o.list || []).forEach(g => { if (!this._conns.has(g.c)) this._relayGuest(g.c, g.meta); });
          } else if (o.t === 'conn') {
            this._relayGuest(o.c, o.meta);
          } else if (o.t === 'close' && o.c) {
            const nc = this._conns.get(o.c); if (nc) { this._conns.delete(o.c); nc._end(); }
          }
        } else if (m[0] === 'd') {
          const nl = m.indexOf('\n'); if (nl < 2) return;
          const nc = this._conns.get(m.slice(1, nl)); if (!nc) return;
          let d; try { d = JSON.parse(m.slice(nl + 1)); } catch (e) { return; }
          nc.emit('data', d);
        }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (this._ws === ws) this._ws = null;
        this._relayOk = false;
        if (this.destroyed || this._relayRejected) return;
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
      const nc = new NetConn('relay-' + cid, meta, { reliable: true });
      this._conns.set(cid, nc);
      this.emit('connection', nc);
      nc._ready('relay', d => {
        const s = 'd' + cid + '\n' + JSON.stringify(d);
        if (this._ws && this._relayOk) this._ws.send(s); else if (this._queue.length < 500) this._queue.push(s);
      }, () => {
        this._conns.delete(cid);
        if (this._ws && this._relayOk) try { this._ws.send('x' + cid); } catch (e) {}
      });
    }

    // ---- 参加者：ホストへつなぐ ----
    connect(id, opts) {
      opts = opts || {};
      const nc = new NetConn(id, opts.metadata, opts);
      let decided = false, directState = 'trying', relayState = relayBase() ? 'idle' : 'none';
      let dc = null, ws = null, timer = null;
      const finishFail = () => {
        if (decided) return;
        if (directState === 'trying' || relayState === 'trying' || relayState === 'idle') return;
        decided = true; this._pending.delete(nc); clearTimeout(timer);
        nc._closed = true;
        if (!relayBase()) return; // 中継なし：PeerJS 自身のエラーがそのまま届く
        if (directState === 'unavailable' || relayState === 'unavailable') this.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + id });
        else this.emit('error', { type: 'network', message: 'Could not connect to peer ' + id });
      };
      const startRelay = () => {
        if (relayState !== 'idle' || decided) return;
        relayState = 'trying';
        try { ws = new WebSocket(wsUrl('/room/' + encodeURIComponent(id) + '?role=guest' + (opts.metadata !== undefined ? '&meta=' + encodeURIComponent(JSON.stringify(opts.metadata)) : ''))); }
        catch (e) { relayState = 'network'; finishFail(); return; }
        let ping = null;
        ws.onmessage = ev => {
          const m = String(ev.data);
          if (m === 'pong') return;
          if (m[0] === 'c') {
            let o; try { o = JSON.parse(m.slice(1)); } catch (e) { return; }
            if (o.t === 'open') {
              if (decided) { try { ws.close(); } catch (e) {} return; }
              decided = true; this._pending.delete(nc); clearTimeout(timer); relayState = 'open';
              if (dc) { try { dc.close(); } catch (e) {} }
              ping = setInterval(() => { try { ws.send('ping'); } catch (e) {} }, PING_MS);
              nc._ready('relay', d => { if (ws.readyState === 1) ws.send('d' + JSON.stringify(d)); }, () => { try { ws.close(); } catch (e) {} });
            } else if (o.t === 'error') {
              relayState = o.type === 'peer-unavailable' ? 'unavailable' : 'network';
            } else if (o.t === 'close') {
              try { ws.close(); } catch (e) {}
            }
          } else if (m[0] === 'd' && relayState === 'open') {
            let d; try { d = JSON.parse(m.slice(1)); } catch (e) { return; }
            nc.emit('data', d);
          }
        };
        ws.onclose = () => {
          clearInterval(ping);
          if (relayState === 'open') { nc._end(); return; }
          if (relayState === 'trying') relayState = 'network';
          finishFail();
        };
        ws.onerror = () => {};
      };
      nc._directFail = (why) => {
        if (directState !== 'trying') return;
        directState = why;
        if (relayState === 'idle') startRelay(); else finishFail();
      };

      const p = this._p;
      if (p && this._pOpen && !p.disconnected) {
        this._pending.add(nc);
        const md = relayBase() ? { __np: 1, m: opts.metadata } : opts.metadata;
        dc = p.connect(id, Object.assign({}, opts, { metadata: md }));
        dc.on('open', () => {
          if (decided) { try { dc.close(); } catch (e) {} return; }
          decided = true; this._pending.delete(nc); clearTimeout(timer); directState = 'open';
          if (ws) { try { ws.close(); } catch (e) {} }
          if (relayBase()) dc.send({ __np: 'hello' });
          wrapDirect(nc, dc, false);
        });
        dc.on('error', () => nc._directFail('network'));
        dc.on('close', () => { if (directState === 'trying') nc._directFail('network'); });
        if (relayBase()) timer = setTimeout(startRelay, DIRECT_TIMEOUT);
      } else {
        directState = 'network';
        if (relayBase()) later(startRelay);
        else later(() => this.emit('error', { type: 'disconnected', message: 'Cannot connect to new Peer after disconnecting from server.' }));
      }
      return nc;
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
      this._conns.forEach(nc => nc.close()); this._conns.clear();
      if (this._ws) { try { this._ws.close(); } catch (e) {} this._ws = null; }
      if (this._p) { try { this._p.destroy(); } catch (e) {} }
      this.emit('close');
    }
  }

  NetPeer.relay = NetPeer.relay || '';
  window.NetPeer = NetPeer;
})();
