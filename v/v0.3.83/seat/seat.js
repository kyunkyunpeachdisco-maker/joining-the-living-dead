// AI（Claude Code など、自分でコマンドを打てる AI）が、人と同じ入口から部屋に入って、1席に座るための道具。
// 要るもの：Node.js、playwright-core（このファイルのあるフォルダで npm i playwright-core）、Edge か Chrome。
// ブラウザを1つ開いたままにして、画面に出ている文と、押せるものだけを AI に見せる。ゲームの中の変数は、のぞかない。
//
// 席を開く　：node seat.js serve [--pw <playwright の場所>] [--port 8791] [--profile <ブラウザの記憶の置き場>] [--browser msedge|chrome|chromium]
// 　　　　　　（裏で動かしたままにする。ブラウザは、何も付けなければ、Edge → Chrome → playwright の Chromium の順に探す）
// 席に頼む　：node seat.js open <URL>      … ページを開く（招待リンクなど）
// 　　　　　　node seat.js look            … いまの画面の文と、押せるものの番号を出す
// 　　　　　　node seat.js pick <番号> [--yes|--no] [--text <文>]   … 押す。確認が出たときの答えは、先に決めて付ける
// 　　　　　　node seat.js type <番号> <文>  … 入力欄に書く
// 　　　　　　node seat.js wait [秒]        … 画面が変わるまで待つ（既定は600秒。ほかの頼みが来たら、そこで待つのをやめる）
// 　　　　　　node seat.js wait [秒] --chat … 通信に新しい書きこみが来るか、止まっていた本が先へ進めるようになるまで待つ（手が空いている間は、こちら）
// 　　　　　　node seat.js shot <ファイル>   … 画面の写真を保存する
// 　　　　　　node seat.js secret <番号>    … パスワードの欄に、人が入れる（トークンなど）。このパソコンで開くページの場所を返すので、人に渡す。AI には中身が見えない
// 　　　　　　node seat.js log             … ブラウザの記録を出す（つながらないときの調べもの用）
// 　　　　　　node seat.js quit            … ブラウザを閉じて、席を畳む
// ブラウザの記憶（端末の鍵・進行）は --profile に残る。次に席を開くと、同じメンバーとして、前に開いていたページへ戻る。
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), crypto = require('crypto');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); if(i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = k => { const i = argv.indexOf('--' + k); if(i < 0) return false; argv.splice(i, 1); return true; };
const PORT = +opt('port', process.env.JTLD_SEAT_PORT || 8791);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 席に頼む側 ----
if(argv[0] !== 'serve'){
  const body = JSON.stringify({ cmd:argv[0] || 'look', yes:flag('yes'), no:flag('no'), chat:flag('chat'), text:opt('text', null), args:argv.slice(1) });
  const q = http.request({ host:'127.0.0.1', port:PORT, path:'/', method:'POST', headers:{ 'Content-Type':'application/json' } }, r => { let t = ''; r.setEncoding('utf8'); r.on('data', d => t += d); r.on('end', () => { process.stdout.write(t + '\n'); }); });
  q.on('error', e => { console.log('席が開いていません（' + (e.code || e.message) + '、ポート ' + PORT + '）。先に、node seat.js serve を、裏で動かします。'); process.exitCode = 1; });
  q.end(body);
  return;
}

// ---- 席（ブラウザを持つ側） ----
const PW = opt('pw', process.env.JTLD_PW || 'playwright');
const PROFILE = path.resolve(opt('profile', process.env.JTLD_SEAT_PROFILE || path.join(os.homedir(), '.jtld-seat')));
const LAST = path.join(PROFILE, 'seat-last-url.txt');
const BROWSER = opt('browser', process.env.JTLD_SEAT_BROWSER || '');
let chromium = null;
for(const m of [PW, 'playwright-core']){ try { chromium = require(m).chromium; if(chromium) break; } catch(e){} }
if(!chromium){ console.log('playwright がありません。このファイルのあるフォルダで、npm i playwright-core を実行します。'); process.exit(1); }

// 画面の文と、押せるものを集める（ページの中で動く）。見えていないもの・ほかのものの下にあるものは、数えない
const SCAN = () => {
  const shown = el => { const r = el.getBoundingClientRect(); if(r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= innerWidth) return false; for(let e = el; e && e.nodeType === 1; e = e.parentElement){ const s = getComputedStyle(e); if(s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05) return false; } return true; };
  // 画面の中にあるものは、いちばん上にあるかを確かめる（上に別の窓が出ていたら、押せない）。画面の外は、スクロールすれば押せるものとして数える
  const onTop = el => { const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2; if(x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true; const t = document.elementFromPoint(x, y); return !t || el.contains(t) || t.contains(el); };
  const say = s => String(s || '').replace(/\s+/g, ' ').trim();
  const cand = new Set(document.querySelectorAll('button, a[href], input, textarea, select, summary, [role=button], [onclick], [contenteditable=true]'));
  // 手の形のカーソルになるもの（押せる行・地図の場所など）。親も手の形なら、親のほうを数える
  for(const el of document.querySelectorAll('body *')){ if(cand.has(el)) continue; if(getComputedStyle(el).cursor !== 'pointer') continue; const p = el.parentElement; if(p && getComputedStyle(p).cursor === 'pointer') continue; if(el.closest('button, a[href], label, summary')) continue; cand.add(el); }
  // 画面いっぱいの窓（部屋の管理・遊び方など）が上に出ているときは、その窓の中だけを見せる。下の画面は、人にも見えないし、押せない
  let root = document.body;
  for(let e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); e && e !== document.body && e.nodeType === 1; e = e.parentElement){ const p = getComputedStyle(e).position; if(p !== 'fixed' && p !== 'absolute') continue; const r = e.getBoundingClientRect(), w = Math.min(r.right, innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0); if(w > 0 && h > 0 && w * h >= innerWidth * innerHeight * 0.85) root = e; }
  const list = [];
  for(const el of document.querySelectorAll('[data-seat]')) el.removeAttribute('data-seat'); // 前に付けた番号を消す
  for(const el of root.querySelectorAll('*')){
    if(!cand.has(el) || !shown(el) || !onTop(el)) continue;
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    let kind = '押す', label = say(el.innerText) || say(el.getAttribute('aria-label')) || say(el.title);
    if(tag === 'input' && (type === 'checkbox' || type === 'radio')){ kind = 'チェック'; const lb = el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]')); label = (el.checked ? '［✔］' : '［　］') + say(lb ? lb.innerText : el.name); }
    else if(tag === 'input' && type === 'range'){ kind = 'つまみ'; label = say(el.getAttribute('aria-label') || el.id) + '（いま：' + el.value + '）'; }
    else if(tag === 'input' && type === 'file'){ kind = 'ファイル'; label = say(el.id); }
    else if(tag === 'input' || tag === 'textarea'){ kind = '入力'; label = say(el.placeholder || el.getAttribute('aria-label') || el.id) + (type === 'password' ? (el.value ? '（入っている）' : '（空）') : '（いま：「' + say(el.value).slice(0, 60) + '」）'); } // パスワードの欄の中身は、AI に見せない
    else if(tag === 'select'){ kind = '選ぶ'; label = say(el.getAttribute('aria-label') || el.id) + '（いま：' + say((el.selectedOptions[0] || {}).text) + '／' + [...el.options].map(o => say(o.text)).join('・') + '）'; }
    else if(el.isContentEditable){ kind = '入力'; label = '（いま：「' + say(el.innerText).slice(0, 60) + '」）'; }
    if(el.disabled || el.getAttribute('aria-disabled') === 'true') kind += '（いまは押せない）';
    if(!label) label = '（文なし：' + tag + (el.id ? '#' + el.id : '') + '）';
    list.push({ kind, label:label.slice(0, 120), el });
    el.setAttribute('data-seat', String(list.length));
  }
  // 同じ文のものが並ぶとき（［ロックする］が4つ、など）は、まわりの文を頭に付けて、見分けられるようにする
  { const n = {}; for(const x of list) n[x.kind + x.label] = (n[x.kind + x.label] || 0) + 1;
    for(const x of list){ if(n[x.kind + x.label] < 2) continue; const own = say(x.el.innerText); for(let e = x.el.parentElement, i = 0; e && e !== root && i < 4; e = e.parentElement, i++){ const t = say(e.innerText); if(t && t !== own && t.length <= 90){ x.ctx = (own ? t.split(own).join(' ') : t).replace(/\s+/g, ' ').trim().slice(0, 50); break; } if(t.length > 90) break; } }
    for(const x of list){ if(x.ctx) x.label = '（' + x.ctx + '）' + x.label; delete x.ctx; delete x.el; } }
  const text = String(root.innerText || '').split('\n').map(x => x.replace(/\s+$/, '')).filter((x, i, a) => x || (a[i - 1] || '')).join('\n').trim();
  return { title:document.title, url:location.href, text, list };
};

(async () => {
  fs.mkdirSync(PROFILE, { recursive:true });
  // クラウドの Claude Code（Linux）：外への通信は、プロキシ（HTTPS_PROXY）を通る。ブラウザにも渡す。中では、ブラウザの囲い（sandbox）が使えない
  const linux = process.platform === 'linux';
  const px = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  const proxy = px ? { server:px, ...(process.env.NO_PROXY || process.env.no_proxy ? { bypass:process.env.NO_PROXY || process.env.no_proxy } : {}) } : undefined;
  const args = ['--disable-gpu', '--mute-audio', ...(linux ? ['--no-sandbox'] : [])];
  // 入っているブラウザの場所（playwright の名前で見つからないとき）
  const files = [];
  for(const d of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean)) try { for(const v of fs.readdirSync(d).filter(x => /^chromium/.test(x))) for(const s of ['chrome-linux64/chrome', 'chrome-linux/chrome']) if(fs.existsSync(path.join(d, v, s))) files.push(path.join(d, v, s)); } catch(e){}
  for(const f of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if(fs.existsSync(f)) files.push(f);
  const tries = BROWSER ? [{ ch:BROWSER }] : [...(linux ? [{ ch:'chromium' }] : [{ ch:'msedge' }, { ch:'chrome' }, { ch:'chromium' }]), ...files.map(f => ({ exe:f }))];
  let ctx = null, why = '';
  for(const t of tries){
    try { ctx = await chromium.launchPersistentContext(PROFILE, { ...(t.exe ? { executablePath:t.exe } : t.ch === 'chromium' ? {} : { channel:t.ch }), headless:true, viewport:{ width:430, height:900 }, args, ...(proxy ? { proxy } : {}) }); break; }
    catch(e){ why = String(e && e.message || e).split('\n')[0]; }
  }
  if(!ctx){ console.log('ブラウザを開けませんでした（' + why + '）。Edge か Chrome を入れるか、npx playwright-core install chromium を実行してから、--browser chromium を付けます。'); process.exit(1); }
  // 映像は切る（メモリを使うため。ゲームの設定で、人も切れるもの）
  await ctx.addInitScript(() => { try { if(localStorage.getItem('jtld-election-video') === null) localStorage.setItem('jtld-election-video', 'false'); } catch(e){} });
  let page = ctx.pages()[0] || await ctx.newPage(), seen = null, sig = '', answer = null, cut = false; // cut：待っている間に、ほかの頼みが来た
  const logs = [];
  const notes = []; // 確認の窓・ページのエラーなど、次の返事で AI に伝えること
  let secretAsk = null; // secret：人が入れるのを待っている欄（{ nonce, sel, label, title, until }）。1回使ったら消す
  const hook = pg => {
    pg.on('dialog', async d => {
      const a = answer; answer = null;
      const kind = d.type() === 'alert' ? 'お知らせ' : d.type() === 'prompt' ? '入力の窓' : '確認';
      try {
        if(d.type() === 'alert'){ notes.push('【お知らせの窓】' + d.message()); await d.accept(); }
        else if(a && a.yes){ notes.push('【' + kind + '】' + d.message() + ' → はい' + (a.text !== null ? '（' + a.text + '）' : '')); await d.accept(a.text === null ? undefined : a.text); }
        else if(a && a.no){ notes.push('【' + kind + '】' + d.message() + ' → いいえ'); await d.dismiss(); }
        else { notes.push('【' + kind + 'が出たので、いいえで閉じた】' + d.message() + '　　はい、と答えるときは、同じ番号に --yes を付けて押し直す' + (d.type() === 'prompt' ? '（入れる文は --text）' : '')); await d.dismiss(); }
      } catch(e){}
    });
    pg.on('pageerror', e => notes.push('【ページのエラー】' + String(e.message).slice(0, 200)));
    // 調べもの用（遊ぶ判断には使わない）：ブラウザの記録と、失敗した通信を、新しい順に60件まで持つ
    const keep = t => { logs.push(new Date().toTimeString().slice(0, 8) + ' ' + t.slice(0, 300)); if(logs.length > 60) logs.shift(); };
    pg.on('console', m => keep('[' + m.type() + '] ' + m.text()));
    pg.on('requestfailed', q => keep('[通信の失敗] ' + q.url().slice(0, 120) + ' ' + ((q.failure() || {}).errorText || '')));
    pg.on('websocket', w => { keep('[ws 開く] ' + w.url().slice(0, 120)); w.on('close', () => keep('[ws 閉じる] ' + w.url().slice(0, 120))); w.on('socketerror', e => keep('[ws エラー] ' + e)); });
  };
  hook(page);
  ctx.on('page', p => { if(p !== page){ notes.push('【別のタブが開こうとしたので、閉じた】' + p.url()); p.close().catch(() => {}); } });
  const scan = async () => { for(let i = 0; i < 3; i++){ try { return await page.evaluate(SCAN); } catch(e){ await sleep(500); } } return { title:'', url:page.url(), text:'（画面を読めませんでした）', list:[] }; };
  const sigOf = v => v.text + '\n' + v.list.map(x => x.kind + x.label).join('\n');
  const show = async () => {
    const v = await scan(); seen = v; sig = sigOf(v);
    const n = notes.splice(0);
    return (n.length ? n.join('\n') + '\n\n' : '') + '＝＝ ' + v.title + '　' + v.url + ' ＝＝\n' + v.text + '\n\n── 押せるもの ──\n' + (v.list.map((x, i) => (i + 1) + ' ［' + x.kind + '］' + x.label).join('\n') || '（なし）');
  };
  // 番号のものを探す。look のあとで画面が描き直されていても、同じ番号に同じものがあれば、それを使う
  const find = async n => {
    if(!seen) return { err:'先に look で画面を見ます。' };
    const was = seen.list[n - 1]; if(!was) return { err:n + ' 番はありません。' };
    const now = await scan(), is = now.list[n - 1];
    if(!is || is.kind !== was.kind || is.label !== was.label) return { err:'画面が変わっていて、' + n + ' 番が前と違います。押していません。' };
    return { el:page.locator('[data-seat="' + n + '"]').first(), was };
  };
  const moving = () => page.evaluate(() => document.getAnimations().some(a => a.playState === 'running' && !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity))).catch(() => false);
  const settle = async () => { let last = ''; for(let i = 0; i < 15; i++){ await sleep(350); if(await moving()) continue; const s = sigOf(await scan()); if(s === last) return; last = s; } };
  const run = async q => {
    const a = q.args || [];
    if(q.cmd === 'open'){ if(!a[0]) return 'URL が要ります。'; fs.writeFileSync(LAST, a[0]); await page.goto(a[0], { waitUntil:'load', timeout:90000 }); await settle(); return show(); }
    if(q.cmd === 'look') return show();
    if(q.cmd === 'pick'){
      const f = await find(+a[0]); if(f.err) return f.err + '\n\n' + await show();
      if(/押せない/.test(f.was.kind)) return a[0] + ' 番は、いまは押せません。\n\n' + await show();
      answer = { yes:!!q.yes, no:!!q.no, text:q.text === undefined ? null : q.text };
      try { await f.el.scrollIntoViewIfNeeded({ timeout:5000 }); await f.el.click({ timeout:8000 }); } catch(e){ answer = null; return a[0] + ' 番（' + f.was.label + '）を押せませんでした：' + String(e.message).split('\n')[0] + '\n\n' + await show(); }
      await settle(); answer = null;
      return '押した：' + f.was.label + '\n\n' + await show();
    }
    if(q.cmd === 'type'){
      const f = await find(+a[0]); if(f.err) return f.err + '\n\n' + await show();
      const t = a.slice(1).join(' ');
      try { if(/選ぶ/.test(f.was.kind)) await f.el.selectOption({ label:t }); else { await f.el.fill(t, { timeout:8000 }); if(/^input$/i.test(await f.el.evaluate(e => e.tagName))) await f.el.evaluate(e => e.blur()); } } /* 1行の入力欄は、書いたあとに欄の外へ出る（呼び名などは、欄を出たときに保存される） */ catch(e){ return a[0] + ' 番に書けませんでした：' + String(e.message).split('\n')[0] + '\n\n' + await show(); }
      await settle();
      return '書いた：' + t + '\n\n' + await show();
    }
    if(q.cmd === 'wait'){
      const until = Date.now() + (+a[0] || 600) * 1000, base = sig; let how = '（変わりなし）'; cut = false;
      // --chat：通信に新しい書きこみが来たとき（と、止まっていた本が先へ進めるようになったとき）だけ起きる。ほかの人の本が進んだだけでは起きない
      const chatOf = v => { const open = v.list.some(x => x.label === '× 閉じる' || x.label === '‹ 一覧') && /^通信/.test(v.text); return { n:+((/^\((\d+)\)/.exec(v.title) || [])[1] || 0), at:v.list.some(x => /^通信 ?@/.test(x.label)), open, text:open ? v.text : '', stop:/先へは進めません/.test(v.text) }; };
      const c0 = q.chat ? chatOf(seen || await scan()) : null;
      while(Date.now() < until){
        await sleep(2000);
        if(cut){ how = '（ほかの頼みが来たので、待つのをやめた）'; break; }
        if(notes.length){ how = '（画面が変わった）'; break; }
        const v = await scan();
        if(c0){
          const c = chatOf(v);
          if(c.n > c0.n || (c.at && !c0.at) || (c.open && c0.open && c.text !== c0.text)){ await settle(); how = '（通信に、新しい書きこみが来た）'; break; }
          if(c0.stop && !c.stop){ await settle(); how = '（止まっていた本が、先へ進めるようになった）'; break; }
          c0.n = Math.min(c0.n, c.n); // 読んで減った分は、数え直す
        } else if(sigOf(v) !== base){ await settle(); how = '（画面が変わった）'; break; }
      }
      return how + '\n\n' + await show();
    }
    if(q.cmd === 'secret'){
      const f = await find(+a[0]); if(f.err) return f.err + '\n\n' + await show();
      const pw = await f.el.evaluate(e => e.tagName === 'INPUT' && e.type === 'password').catch(() => false);
      if(!pw) return a[0] + ' 番は、パスワードの欄ではありません。secret で入れられるのは、パスワードの欄（中身が画面の文に出ない欄）だけです。\n\n' + await show();
      const nonce = crypto.randomBytes(16).toString('hex'), id = await f.el.evaluate(e => e.id || '');
      if(!/^[\w-]+$/.test(id)) await f.el.evaluate((e, n) => e.setAttribute('data-seat-secret', n), nonce);
      secretAsk = { nonce, sel:/^[\w-]+$/.test(id) ? '[id="' + id + '"]' : '[data-seat-secret="' + nonce + '"]', label:f.was.label.replace(/（(空|入っている)）$/, ''), title:seen.title, until:Date.now() + 15 * 60000 };
      return 'ユーザーに、次のページを、このパソコンのブラウザで開いてもらいます。15分たつか、1回使うと、ページは使えなくなります：\n'
        + 'http://127.0.0.1:' + PORT + '/s/' + nonce + '\n'
        + 'ユーザーが入れる中身は、' + a[0] + ' 番の欄（' + secretAsk.label + '）に入り、あなたには見えません。ユーザーに、中身をこの会話に書かないように伝えます。\n'
        + '中身が入ると wait が返るので、欄のボタンを押します。［連携する］などです。';
    }
    if(q.cmd === 'log') return logs.join('\n') || '（記録なし）';
    if(q.cmd === 'shot'){ const f = path.resolve(a[0] || 'seat.png'); await page.screenshot({ path:f }); return '保存した：' + f; }
    if(q.cmd === 'quit'){ setTimeout(async () => { try { await ctx.close(); } catch(e){} process.exit(0); }, 100); return '席を畳みます。'; }
    return '分からない頼みです：' + q.cmd;
  };
  // secret の入口：人が、このパソコンのブラウザで開いて、秘密の文を入れるページ。中身は、ゲームの欄に入れるだけで、AI への返事にも記録にも出さない
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const secretPage = (q, r, nonce) => {
    const page0 = (body, st = 200) => { r.writeHead(st, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY', 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }); r.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>席にトークンを入れる</title><body style="font:16px/1.7 sans-serif;max-width:560px;margin:32px auto;padding:0 16px">' + body + '</body>'); };
    const s = secretAsk;
    if(!s || s.nonce !== nonce || Date.now() > s.until) return page0('<p>このページは、もう使えません。トークンを入れるときは、AI に、ページのアドレスをもう一度頼んでください。</p>', 404);
    if(q.method === 'GET') return page0('<h1 style="font-size:20px">席にトークンを入れる</h1><p>AI の席のゲーム（' + esc(s.title) + '）の、次の欄にトークンを入れます。入れたトークンは、AI には見えません。</p><p><b>' + esc(s.label) + '</b></p>'
      + '<form method="post"><input name="v" type="password" autocomplete="off" autofocus style="font-size:16px;width:100%;padding:8px;box-sizing:border-box"><p><button style="font-size:16px;padding:8px 20px">入れる</button></p></form><p style="color:#666">トークンを、AI との会話に書かないでください。</p>');
    if(q.method !== 'POST') return page0('<p>使えない頼みです。</p>', 405);
    const o = q.headers.origin; if(o && o !== 'http://127.0.0.1:' + PORT && o !== 'http://localhost:' + PORT) return page0('<p>このページからは入れられません。</p>', 403); // ほかのサイトからの送りこみ
    let t = ''; q.setEncoding('utf8'); q.on('data', d => { t += d; if(t.length > 8192) q.destroy(); });
    q.on('end', async () => {
      if(secretAsk !== s) return page0('<p>このページは、もう使えません。トークンを入れるときは、AI に、ページのアドレスをもう一度頼んでください。</p>', 404);
      let v = (new URLSearchParams(t).get('v') || '').trim(); t = '';
      if(!v) return page0('<p>欄が空でした。前のページに戻って、トークンを入れ直してください。</p>', 400);
      secretAsk = null; // 1回だけ
      try { await page.locator(s.sel).first().fill(v, { timeout:8000 }); v = ''; notes.push('【ユーザーが、' + s.label + ' の欄にトークンを入れた。中身は見せない】'); page0('<p>トークンを入れました。AI との会話に戻ってください。</p>'); } // 欄から出さない（ゲームは、欄に入っている間は描き直さないので、入れた文が消えない）
      catch(e){ v = ''; notes.push('【ユーザーがトークンを入れようとしたが、欄が画面から消えていて、入らなかった。もう一度 secret を打つ】'); page0('<p>トークンを入れられませんでした。席のゲームの画面から、欄が消えていました。AI に、ページのアドレスをもう一度頼んでください。</p>', 409); }
    });
  };
  let busy = Promise.resolve();
  http.createServer((q, r) => {
    const sm = /^\/s\/([a-f0-9]{32})$/.exec(String(q.url).split('?')[0]); if(sm) return secretPage(q, r, sm[1]);
    let t = ''; q.setEncoding('utf8'); q.on('data', d => t += d);
    r.on('close', () => { if(!r.writableEnded) cut = true; }); // 頼んだ側が、返事を待たずに切った
    q.on('end', () => { cut = true; busy = busy.then(async () => { let out; try { out = await run(JSON.parse(t || '{}')); } catch(e){ out = '失敗：' + String(e && e.message || e).split('\n')[0]; } r.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8' }); r.end(out); }); });
  }).listen(PORT, '127.0.0.1', async () => {
    console.log('席を開いた（ポート ' + PORT + '、記憶：' + PROFILE + '）');
    if(fs.existsSync(LAST)){ const u = fs.readFileSync(LAST, 'utf8').trim(); if(u){ try { await page.goto(u, { waitUntil:'load', timeout:90000 }); console.log('前のページへ戻った：' + u); } catch(e){ console.log('前のページを開けなかった：' + u); } } }
  });
})();
