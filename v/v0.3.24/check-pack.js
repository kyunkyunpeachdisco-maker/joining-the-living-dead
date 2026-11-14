// 追加分（book/overlay.json）の点検。ブラウザなしで、node だけで動く
// 使い方：node check-pack.js <overlay.json の場所>
//   原本（公開のリポジトリの index.html と book-*.js）を読んで、追加分の中の名前・番号・もとの文が、原本に見つかるかを調べる
//   もとの文の調べ方は、原本のファイルの中を文字で探すだけなので、「見つからない」は、目安（状況で変わる文は、見つからないことがある）
const fs = require('fs'), path = require('path');
const SRC = process.env.JTLD_SOURCE || 'https://raw.githubusercontent.com/kyunkyunpeachdisco-maker/joining-the-living-dead/HEAD/';
const file = process.argv[2];
if(!file || !fs.existsSync(file)){ console.log('使い方：node check-pack.js <overlay.json の場所>'); process.exit(2); }
const BOOK_FILES = { voter:'book-voter.js', governor:'book-governor.js', chief:'book-chief.js', director:'book-director.js' };
const get = async name => { if(!/^https?:/.test(SRC)) return fs.readFileSync(path.join(SRC, name), 'utf8').split(String.fromCharCode(13)).join(''); const r = await fetch(SRC + name); if(!r.ok) throw new Error(name + ' を読めません（' + r.status + '）'); return (await r.text()).split(String.fromCharCode(13)).join(''); };
const errs = [], warns = [], err = (where, t) => errs.push(where + '：' + t), warn = (where, t) => warns.push(where + '：' + t);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v), arr = v => (Array.isArray(v) ? v : []);
(async () => {
  let o; try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e){ console.log('× JSON として読めません：' + e.message); process.exit(1); }
  const src = {}, spots = {}, paras = {};
  const main = await get('index.html');
  let cat = null; try { cat = JSON.parse(await get('catalog.json')); } catch(e){} // 部品の一覧表（あれば、見取り図と突き合わせる）
  for(const [book, f] of Object.entries(BOOK_FILES)){
    src[book] = await get(f);
    spots[book] = {}; for(const m of src[book].matchAll(/^\s{2}([A-Za-z_][\w]*):\{ no:(\d+), name:'([^']*)'/gm)) spots[book][m[1]] = { no:+m[2], name:m[3] };
    paras[book] = new Set([...src[book].matchAll(/^\s{4}(\d+):\{/gm)].map(m => +m[1]).concat(Object.values(spots[book]).map(s => s.no)));
  }
  const plans = new Set([...main.matchAll(/^\s{2}([a-z]+):\{\n\s+name:'[^']*', floors:/gm), ...main.matchAll(/^PLANS[.]([a-z]+) = [{]/gm)].map(m => m[1]));
  const baseBooks = Object.keys(BOOK_FILES), books = { ...(isObj(o.books) ? o.books : {}) };
  const allBooks = new Set([...baseBooks, ...Object.keys(books)]);
  const likeOf = b => (baseBooks.includes(b) ? b : books[b] && books[b].like);
  const esc = t => String(t).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  // もとの文が、原本のファイルの中に見つかるか（初めの12字と、終わりの12字で探す）
  const found = (book, text) => { const s = src[likeOf(book)] || '', t = esc(text); return t.length < 4 || s.includes(t) || (s.includes(t.slice(0, 12)) && s.includes(t.slice(-12))); };

  // ===== 足した本 =====
  const bases = new Set();
  for(const [id, x] of Object.entries(books)){
    const w = 'books.' + id;
    if(!/^[a-z]{3,12}$/.test(id)) err(w, '名前は、小文字の英字 3〜12 文字');
    if(baseBooks.includes(id)) err(w, 'もとの本と同じ名前');
    if(!isObj(x)){ err(w, '中身がない'); continue; }
    if(!baseBooks.includes(x.like)) err(w, 'like は、' + baseBooks.join('・') + ' のどれか');
    else if(!spots[x.like][x.start]) err(w, 'start「' + x.start + '」が、' + x.like + ' の場所にない');
    if(!(x.base >= 7000 && x.base < 9000 && x.base % 200 === 0)) err(w, 'base は、7000 から 8800 までの、200 きざみ');
    else if(bases.has(x.base)) err(w, 'base ' + x.base + ' が、ほかの本と重なっている'); else bases.add(x.base);
    if(!x.name) err(w, 'name がない');
  }
  // ===== 足した場所・部屋 =====
  const dynSpots = {};
  for(const [book, list] of Object.entries(isObj(o.spots) ? o.spots : {})){
    if(!allBooks.has(book)){ err('spots.' + book, 'そういう本は、ない'); continue; }
    for(const [id, x] of Object.entries(isObj(list) ? list : {})){
      const w = 'spots.' + book + '.' + id, L = likeOf(book);
      (dynSpots[book] = dynSpots[book] || {})[id] = true;
      if(!/^[a-z0-9]{2,24}$/.test(id)) err(w, '名前は、小文字の英数字 2〜24 文字');
      if(!isObj(x) || !x.name){ err(w, 'name がない'); continue; }
      if(!L || (!spots[L][x.from] && !(x.room && isObj(list[x.from]) && list[x.from].room))) err(w, 'from「' + x.from + '」が、' + (L || book) + ' の場所にない');
      if(x.room){
        const r = x.room;
        if(!plans.has(r.plan)) err(w, 'room.plan「' + r.plan + '」という建物は、ない');
        if(!/^u[a-z0-9]{2,20}$/.test(String(r.id))) err(w, 'room.id は、u で始まる小文字の英数字');
        if(!Array.isArray(r.rect) || r.rect.length !== 4 || !r.rect.every(Number.isFinite) || r.rect[2] - r.rect[0] < 2 || r.rect[3] - r.rect[1] < 2 || r.rect[2] - r.rect[0] > 20 || r.rect[3] - r.rect[1] > 20) err(w, 'room.rect は [x0, z0, x1, z1]。1辺は 2〜20 m');
        if(r.stairs){ if(!/^([0-9]{1,2}F|B[0-9])$/.test(String(r.floor))) err(w, 'room.floor（足す階）は、2F・3F・B1 のような名前'); else { const pi = Math.max(main.indexOf('PLANS.' + r.plan + ' = {'), main.indexOf(String.fromCharCode(10) + '  ' + r.plan + ':{' + String.fromCharCode(10) + '    name:')), fi = pi < 0 ? -1 : main.indexOf('floors:[', pi); if(fi >= 0 && main.slice(fi, main.indexOf(']', fi)).includes("'" + r.floor + "'")) err(w, 'room.floor「' + r.floor + '」は、その建物に、もうある（ある階には、stairs で足せない。その階の部屋を fromRoom にして、ふつうの部屋として足す）'); } }
        else if(!Array.isArray(r.door) || r.door.length !== 2 || !r.door.every(Number.isFinite)) err(w, 'room.door は [x, z]');
        if(r.props != null && (!Array.isArray(r.props) || r.props.length > 16 || !r.props.every(q => Array.isArray(q) && typeof q[0] === 'string' && Number.isFinite(q[1]) && Number.isFinite(q[2])))) err(w, 'room.props は [[名前, x, z, 向き], …]（16個まで）');
        else for(const q of r.props || []){ if(!main.includes('\n  ' + q[0] + '(T, g')) err(w, 'room.props の「' + q[0] + '」という家具は、ない'); else if(Array.isArray(r.rect) && (q[1] < r.rect[0] || q[1] > r.rect[2] || q[2] < r.rect[1] || q[2] > r.rect[3])) err(w, 'room.props の「' + q[0] + '」が、部屋の四角の外'); }
        if(!cat && r.fromRoom && !Object.values(list).some(y => y && y.room && y.room.id === r.fromRoom) && !new RegExp('\\b' + r.fromRoom + ':\\{ floor:').test(main)) warn(w, 'room.fromRoom「' + r.fromRoom + '」が、見取り図に見つからない');
      } else if(!Array.isArray(x.at) || x.at.length !== 2 || !x.at.every(Number.isFinite)) err(w, 'at は [x, y]（地図の上の位置）');
      if(x.img && !fs.existsSync(path.join(path.dirname(file), 'assets', x.img + '.jpg'))) err(w, '絵 assets/' + x.img + '.jpg が、ない');
      if(x.z != null && !(x.z >= 0 && x.z <= 6)) err(w, 'z（ゾンビの数）は、0〜6');
    }
  }
  // ===== 見取り図との突き合わせ（一覧表 catalog.json があるとき）：部屋の重なり、戸の位置、つながる部屋 =====
  const addedFloors = new Set();
  for(const list of Object.values(isObj(o.spots) ? o.spots : {})) for(const x of Object.values(isObj(list) ? list : {})) if(isObj(x) && isObj(x.room) && x.room.stairs) addedFloors.add(x.room.plan + ':' + x.room.floor);
  if(cat){
    const norm = r => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    const added = [];
    for(const [book, list] of Object.entries(isObj(o.spots) ? o.spots : {})) for(const [id, x] of Object.entries(isObj(list) ? list : {}))
      if(isObj(x) && isObj(x.room) && Array.isArray(x.room.rect) && x.room.rect.length === 4 && x.room.rect.every(Number.isFinite)) added.push({ w:'spots.' + book + '.' + id, book, x, r:x.room });
    const roomOf = (plan, id) => { const c = ((cat.plans[plan] || {}).rooms || {})[id]; if(c) return { floor:c.floor, rect:norm(c.rect), name:c.name }; const a = added.find(q => q.r.plan === plan && q.r.id === id); return a ? { floor:a.r.floor, rect:norm(a.r.rect), name:a.x.name } : null; };
    // 点 p が、四角 q の壁の上にあるか
    const onEdge = (p, q) => ((Math.abs(p[0] - q[0]) < .15 || Math.abs(p[0] - q[2]) < .15) && p[1] > q[1] - .15 && p[1] < q[3] + .15) || ((Math.abs(p[1] - q[1]) < .15 || Math.abs(p[1] - q[3]) < .15) && p[0] > q[0] - .15 && p[0] < q[2] + .15);
    for(const { w, book, x, r } of added){
      const P = cat.plans[r.plan]; if(!P) continue;
      const from = roomOf(r.plan, r.fromRoom), me = norm(r.rect);
      if(!from){ err(w, 'room.fromRoom「' + r.fromRoom + '」という部屋は、その建物にない（ある部屋：' + Object.keys(P.rooms).join('・') + '）'); continue; }
      if(!r.stairs){
        if(from.floor !== r.floor) err(w, 'room.floor「' + r.floor + '」が、fromRoom「' + from.name + '」の階（' + from.floor + '）と違う（同じ階にしか、戸でつなげない）');
        if(Array.isArray(r.door) && r.door.length === 2 && r.door.every(Number.isFinite)){
          if(!onEdge(r.door, me)) err(w, 'room.door が、足す部屋の壁の上にない');
          else if(!onEdge(r.door, from.rect)) err(w, 'room.door が、fromRoom「' + from.name + '」の壁の上にない（2つの部屋が、戸の位置で接していない）');
        }
      }
      const same = [...Object.entries(P.rooms).map(([id, c]) => ({ id, floor:c.floor, rect:norm(c.rect), name:c.name })), ...added.filter(q => q.r !== r && q.r.plan === r.plan).map(q => ({ id:q.r.id, floor:q.r.floor, rect:norm(q.r.rect), name:q.x.name }))].filter(q => q.floor === r.floor);
      for(const q of same) if(me[0] < q.rect[2] - .05 && me[2] > q.rect[0] + .05 && me[1] < q.rect[3] - .05 && me[3] > q.rect[1] + .05) err(w, '部屋の四角が、「' + q.name + '」（' + q.id + '）と重なっている');
      const base = ((cat.books[likeOf(book)] || {}).spots || {})[x.from], near = ((o.spots[book] || {})[x.from] || {}).room;
      if(base && base.place !== r.plan) warn(w, 'from「' + x.from + '」は、建物「' + r.plan + '」の中の場所ではない');
      else { const at = base ? base.room : near && near.id; if(at && at !== r.fromRoom) warn(w, 'from「' + x.from + '」のある部屋（' + at + '）と、fromRoom（' + r.fromRoom + '）が違う（歩いて行ける先と、戸のつながる先が、食い違う）'); }
    }
  }
  const spotOk = (book, id) => !!((spots[likeOf(book)] || {})[id] || (dynSpots[book] || {})[id]);
  // ===== しぐさ・カメラ =====
  const POSE_BASE = ['none', 'hide', 'crouch', 'kneel', 'sit', 'lie', 'bend', 'aim', 'fend', 'handsup', 'wave', 'point', 'phone', 'knock', 'cross', 'down', 'cover'];
  for(const [id, p] of Object.entries(isObj(o.poses) ? o.poses : {})){
    const w = 'poses.' + id;
    if(!/^[a-z0-9_]{1,20}$/.test(id)) err(w, '名前は、小文字の英数字と _');
    if(POSE_BASE.includes(id)) err(w, 'もとからあるしぐさと同じ名前（使えない）');
    for(const k of ['hip', 'leg', 'knee', 'body', 'head', 'lie', 'y']) if(p[k] != null && !(Math.abs(p[k]) <= 4)) err(w, k + ' は、-4〜4 の数');
    for(const k of ['armL', 'armR']) if(p[k] != null && !(Array.isArray(p[k]) && p[k].length === 2 && p[k].every(n => Math.abs(n) <= 4))) err(w, k + ' は、[肩, ひじ]（-4〜4）');
  }
  const poses = new Set([...POSE_BASE, ...Object.keys(isObj(o.poses) ? o.poses : {})]), camIds = new Set();
  for(const [scene, list] of Object.entries(isObj(o.cams) ? o.cams : {})) for(const [id, c] of Object.entries(isObj(list) ? list : {})){
    const w = 'cams.' + scene + '.' + id; camIds.add(id);
    if(!/^c[a-z0-9]{2,20}$/.test(id)) err(w, '名前は、c で始まる小文字の英数字');
    if(!isObj(c) || !Array.isArray(c.pos) || c.pos.length !== 3 || !c.pos.every(Number.isFinite)) err(w, 'pos は [x, y, z]');
    if(scene.startsWith('plan:')){ const pl = scene.split(':')[1], fl = scene.split(':')[2]; if(!plans.has(pl)) err(w, '場面「' + scene + '」の建物「' + pl + '」は、ない'); else if(cat && cat.plans[pl] && !cat.plans[pl].floors.includes(fl) && !addedFloors.has(pl + ':' + fl)) err(w, '場面「' + scene + '」の階「' + fl + '」は、その建物にない（ある階：' + cat.plans[pl].floors.join('・') + '）'); }
    if(!scene.startsWith('plan:') && !main.includes("cam:'" + scene + "'") && !Object.values(src).some(s => s.includes("cam:'" + scene + "'"))) warn(w, '場面「' + scene + '」が、原本に見つからない');
  }
  // ===== 場面ごとの直し =====
  // 持ち物の名前：追加分のどこかで手に入るか、原本に出てくる名前か（打ち間違いを見つける）
  const gotten = new Set();
  for(const d of Object.values(isObj(o.keys) ? o.keys : {})) for(const a of arr(d && d.add)) if(isObj(a.fx)) for(const n of [...arr(a.fx.get), ...arr(a.fx.once)]) gotten.add(n);
  const itemOk = n => gotten.has(n) || main.includes(n) || Object.values(src).some(s => s.includes(n));
  const checkFx = (w, book, fx) => {
    if(!isObj(fx)) return;
    for(const n of [...arr(fx.lose), ...arr(fx.need), ...[fx.cond, ...arr(fx.cor)].filter(isObj).flatMap(g => [...arr(g.have), ...arr(g.lack)])]) if(typeof n === 'string' && !itemOk(n)) warn(w, '持ち物「' + n + '」は、追加分のどこでも手に入らず、原本にも出てこない（名前の打ち間違いかもしれない）');
    for(const k of ['get', 'lose', 'once', 'flag']) if(fx[k] != null && !Array.isArray(fx[k]) && !(k === 'once' && fx[k] === true)) err(w, 'fx.' + k + ' は、名前の並び');
    if(fx.hp != null && !(Math.abs(fx.hp) <= 3)) err(w, 'fx.hp は、-3〜3');
    if(fx.inf && !['on', 'off'].includes(fx.inf)) err(w, 'fx.inf は、on か off');
    if(fx.hide != null && !/^\d{1,4}$/.test(String(fx.hide))) err(w, 'fx.hide（隠し番号）は、数字 1〜4 けた');
    if(fx.img){ if(!isObj(fx.img) || !/^[A-Za-z0-9_-]{1,60}$/.test(String(fx.img.id))) err(w, 'fx.img は { id, as }'); else if(!fs.existsSync(path.join(path.dirname(file), 'assets', fx.img.id + '.jpg'))) err(w, '絵 assets/' + fx.img.id + '.jpg が、ない'); }
    const st = fx.st || {};
    if(st.gait && !['walk', 'run', 'sneak'].includes(st.gait)) err(w, 'fx.st.gait は、walk・run・sneak');
    if(st.pose && !poses.has(st.pose)) err(w, 'fx.st.pose「' + st.pose + '」という、しぐさは、ない');
    if(st.pos && !['you', 'hide', 'door'].includes(st.pos)) err(w, 'fx.st.pos は、you・hide・door');
    if(st.cam && st.cam !== 'main' && !camIds.has(st.cam)) err(w, 'fx.st.cam「' + st.cam + '」という、足したカメラは、ない');
    for(const g of [fx.cond, ...arr(fx.cor)]) if(isObj(g)){
      for(const id of arr(g.at)) if(!spotOk(book, id)) err(w, '条件の場所「' + id + '」が、その本にない');
      if(g.inf && !['yes', 'no'].includes(g.inf)) err(w, '条件の inf は、yes か no');
      if(g.hp && !['le1', 'le2', 'ge2', 'ge3'].includes(g.hp)) err(w, '条件の hp は、le1・le2・ge2・ge3');
      for(const k of ['from', 'to']) if(g[k] && !/^\d\d:\d\d$/.test(g[k])) err(w, '条件の ' + k + ' は、07:30 の形');
      for(const n of [...arr(g.flag), ...arr(g.noflag)]) if(/^[a-z][a-z0-9_]*$/.test(n) && !Object.values(src).some(s => s.includes("'" + n + "'"))) warn(w, 'もとの本の印「' + n + '」が、原本に見つからない');
    }
  };
  for(const [key, d] of Object.entries(isObj(o.keys) ? o.keys : {})){
    const m = key.match(/^([a-z]+):(\*|\d+|@[a-z0-9_]+)((?:>\d+)*)$/);
    if(!m){ err('keys.' + key, '場面の名前は、「本:段落の番号」「本:@場所の名前」「本:*」「本:番号>足した選択肢の番号」の形'); continue; }
    const book = m[1], L = likeOf(book);
    if(!allBooks.has(book)){ err('keys.' + key, '「' + book + '」という本は、ない'); continue; }
    const at = m[2][0] === '@' ? m[2].slice(1) : null, no = m[2] === '*' || at ? null : +m[2];
    if(at && !spotOk(book, at)) err('keys.' + key, '場所「' + at + '」が、その本にない');
    if(no >= 9000 && no < 9900) warn('keys.' + key, '足した場所の場面は、番号ではなく「' + book + ':@場所の名前」で書く（番号は、外からは決まらない）');
    if(no != null && baseBooks.includes(book) && !paras[book].has(no) && !(no >= 9000 && no < 9900)) err('keys.' + key, '段落 ' + no + ' が、原本にない（原本が変わったか、番号の間違い）');
    if(!isObj(d)) continue;
    const top = !m[3] && (no != null || (at && !(dynSpots[book] || {})[at]));
    for(const q of arr(d.paras)){ if(q.kind !== 'text' && q.kind !== 'msg') err('keys.' + key + '.paras', 'kind がない（"text" か "msg"。ないと、直しが当たらない）'); if(typeof q.before !== 'string') err('keys.' + key + '.paras', 'before がない'); else if(top && L && !found(book, q.before)) warn('keys.' + key + '.paras', 'もとの段落が、原本に見つからない：「' + q.before.slice(0, 20) + '…」'); if(q.st) checkFx('keys.' + key + '.paras', book, { st:q.st }); }
    for(const q of arr(d.ins)) if(q.id == null || (q.kind !== 'text' && q.kind !== 'msg')) err('keys.' + key + '.ins', 'id と kind（"text" か "msg"）が要る'); else if(top && q.afterOf && q.afterOf !== '@top' && L && !found(book, q.afterOf)) warn('keys.' + key + '.ins', '置く所の段落が、原本に見つからない：「' + String(q.afterOf).slice(0, 20) + '…」');
    const labels = [...Object.keys(isObj(d.labels) ? d.labels : {}), ...arr(d.del), ...arr(d.off), ...Object.keys(isObj(d.cond) ? d.cond : {})];
    for(const l of labels) if(top && L && !found(book, l)) warn('keys.' + key, 'もとの選択肢が、原本に見つからない：「' + String(l).slice(0, 20) + '」');
    const ids = new Set();
    for(const a of arr(d.add)){
      const w = 'keys.' + key + '.add「' + String(a.label || '').slice(0, 12) + '」';
      if(a.id == null) err(w, 'id がない'); else if(ids.has(a.id)) err(w, 'id が、同じ場面の中で重なっている'); else ids.add(a.id);
      if(!a.label) err(w, 'label（選択肢の文）がない');
      const to = String(a.to || 'stay');
      if(to.startsWith('spot:')){ if(!spotOk(book, to.slice(5))) err(w, '移る先の場所「' + to.slice(5) + '」が、その本にない'); }
      else if(to !== 'stay' && to !== 'off' && top && L && !found(book, to)) warn(w, '合流する先の選択肢が、原本に見つからない：「' + to.slice(0, 20) + '」');
      checkFx(w, book, a.fx);
    }
  }
  // ===== 結果 =====
  console.log('点検した追加分：' + file + '　原本：' + SRC);
  console.log('場面 ' + Object.keys(o.keys || {}).length + '　足した本 ' + Object.keys(books).length + '　足した場所 ' + Object.values(o.spots || {}).reduce((n, l) => n + Object.keys(l || {}).length, 0) + '　足したしぐさ ' + Object.keys(o.poses || {}).length + '　足したカメラ ' + camIds.size);
  for(const e of errs) console.log('× ' + e);
  for(const w of warns) console.log('△ ' + w);
  console.log(errs.length ? '間違いが ' + errs.length + ' 件。直してください。' : '間違いは、見つかりません。' + (warns.length ? '△ は、目安です（原本が変わったか、状況で変わる文かもしれません）。' : ''));
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.log('× 点検できませんでした：' + e.message); process.exit(2); });
