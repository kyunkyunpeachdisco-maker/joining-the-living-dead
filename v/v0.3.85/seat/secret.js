// 席にトークンを入れるページ（secret.html）の動き。2つの使い方がある
//   #s=<部屋>&k=<席の鍵>&n=<欄の名前> … ユーザーが開く（スマホでもよい）。貼ったトークンを、席の鍵で暗号にして、中継役を通して席へ送る
//   #r=<部屋>&h=<ホストの鍵>        … 席のブラウザが、裏で開く。使い捨ての鍵を作って待ち、届いたものを元に戻して、席に渡す
// 中継役が見るのは、暗号にしたものだけ。元に戻せるのは、その鍵を作った席だけ
(() => {
  const RELAY = 'wss://game-relay.game-relay-worker.workers.dev';
  const ROOM_RE = /^jtld-seat-[a-f0-9]{24}$/;
  const q = new URLSearchParams(location.hash.slice(1));
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const enc = new TextEncoder(), dec = new TextDecoder();
  const $ = id => document.getElementById(id);
  const ECDH = { name:'ECDH', namedCurve:'P-256' };
  // 鍵の作り方：ECDH で2人だけが持つ値を出し、HKDF（SHA-256。部屋の名前と、使い道の名前を混ぜる）で、AES-GCM の鍵に整える
  const aes = async (priv, pub, use, room) => {
    const bits = await crypto.subtle.deriveBits({ name:'ECDH', public:pub }, priv, 256);
    const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt:enc.encode(room), info:enc.encode('jtld-seat-secret v2') }, ikm, { name:'AES-GCM', length:256 }, false, [use]);
  };

  // ---- 席の側（受け取る） ----
  if(q.get('r')){
    const room = q.get('r'), hk = q.get('h') || '';
    history.replaceState(null, '', location.pathname); // ホストの鍵を、アドレス欄に残さない
    const S = window.__seat = { pub:'', state:'start', v:'' };
    if(!ROOM_RE.test(room) || !/^[A-Za-z0-9]{16,64}$/.test(hk)){ S.state = 'bad'; return; }
    (async () => {
      const kp = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']); // 元に戻す鍵は、取り出せない形で作る
      S.pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
      let tries = 0, done = false;
      const ws = new WebSocket(RELAY + '/room/' + room + '?role=host&key=' + hk);
      ws.onmessage = async ev => {
        const m = String(ev.data);
        if(m === 'pong') return;
        if(m[0] === 'c'){ try { const o = JSON.parse(m.slice(1)); if(o.t === 'open') S.state = 'wait'; else if(o.t === 'error') S.state = 'relay-error'; } catch(e){} return; }
        if(m[0] !== 'd' || done) return;
        const nl = m.indexOf('\n'), cid = m.slice(1, nl), reply = o => { try { ws.send('d' + cid + '\n' + JSON.stringify(o)); } catch(e){} };
        try {
          const o = JSON.parse(m.slice(nl + 1));
          const epk = await crypto.subtle.importKey('raw', unb64u(o.e), ECDH, false, []);
          if(o.v !== 2) throw 0; // 作り方の違う版のページから来たもの
          const key = await aes(kp.privateKey, epk, 'decrypt', room);
          const v = dec.decode(await crypto.subtle.decrypt({ name:'AES-GCM', iv:unb64u(o.i), additionalData:enc.encode(room) }, key, unb64u(o.c)));
          if(!v || v.length > 500) throw 0;
          done = true; S.v = v; S.state = 'got'; reply({ ok:1 });
          setTimeout(() => { try { ws.close(); } catch(e){} }, 1500);
        } catch(e){ reply({ ok:0 }); if(++tries >= 3){ S.state = 'gave-up'; try { ws.close(); } catch(e2){} } }
      };
      ws.onclose = () => { if(S.state === 'wait' || S.state === 'start') S.state = 'closed'; };
      setInterval(() => { try { ws.send('ping'); } catch(e){} }, 25000);
    })().catch(() => { S.state = 'error'; });
    return;
  }

  // ---- ユーザーの側（送る） ----
  const room = q.get('s') || '', k = q.get('k') || '', name = q.get('n') || '';
  const say = (t, bad) => { const e = $('note'); e.textContent = t; e.style.color = bad ? '#b00' : ''; };
  if(!ROOM_RE.test(room) || !/^[A-Za-z0-9_-]{80,100}$/.test(k)){ $('form').hidden = true; say('このページのアドレスが、途中で切れています。AI に、ページのアドレスをもう一度頼んでください。', true); return; }
  $('field').textContent = name.slice(0, 80);
  $('form').onsubmit = async ev => {
    ev.preventDefault();
    const box = $('v'); let v = box.value.trim();
    if(!v){ say('トークンを貼ってから、［入れる］を押してください。', true); return; }
    $('go').disabled = true; say('トークンを送っています…');
    try {
      const seatPub = await crypto.subtle.importKey('raw', unb64u(k), ECDH, false, []);
      const eph = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
      const key = await aes(eph.privateKey, seatPub, 'encrypt', room);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const msg = { v:2, e:b64u(await crypto.subtle.exportKey('raw', eph.publicKey)), i:b64u(iv), c:b64u(await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:enc.encode(room) }, key, enc.encode(v))) };
      v = ''; box.value = '';
      const ws = new WebSocket(RELAY + '/room/' + room + '?role=guest');
      const end = (t, bad) => { say(t, bad); $('go').disabled = !!(!bad); try { ws.close(); } catch(e){} };
      const limit = setTimeout(() => end('席から返事がありません。AI に、ページのアドレスをもう一度頼んでください。', true), 20000);
      ws.onmessage = ev2 => {
        const m = String(ev2.data);
        if(m[0] === 'c'){ try { const o = JSON.parse(m.slice(1)); if(o.t === 'open') ws.send('d' + JSON.stringify(msg)); else if(o.t === 'error'){ clearTimeout(limit); end('席が、トークンを待っていません。15分たったか、トークンがもう入っています。AI に、ページのアドレスをもう一度頼んでください。', true); } } catch(e){} return; }
        if(m[0] === 'd'){ clearTimeout(limit); let o = {}; try { o = JSON.parse(m.slice(1)); } catch(e){} if(o.ok){ $('form').hidden = true; end('トークンを入れました。AI との会話に戻ってください。'); } else end('席が、受け取ったトークンを読めませんでした。AI に、ページのアドレスをもう一度頼んでください。', true); }
      };
      ws.onerror = () => { clearTimeout(limit); end('中継のサーバーにつながりません。つながりやすい所で、トークンを貼り直して、［入れる］を押してください。', true); };
    } catch(e){ $('go').disabled = false; say('トークンを送れませんでした。AI に、ページのアドレスをもう一度頼んでください。', true); }
  };
})();
