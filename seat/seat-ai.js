// 自分でコマンドを打てない AI・打たせたくない AI（Gemini・Codex・Claude の軽いモデルなど）を、席（seat.js）に座らせるつなぎ役。
// AI にはコマンドを打たせない。この道具が画面を AI に見せ、AI は「次にすること」を1行で答える。道具が、それを席に頼む。
//
// 使い方：node seat-ai.js --ai gemini|codex|claude [--model <モデル>] [--effort <考える深さ>] [--port 8791] [--turns 40] [--goal <やることを書いたファイル>] [--name Gemini] [--log <記録のファイル>]
// 　gemini は Antigravity の agy、codex は Codex CLI、claude は Claude Code（claude -p）を呼ぶ。どれも、その AI の契約の枠の中で動く。
// 　claude は、何も付けなければ、Opus の中（--model opus --effort medium）で動かす（2026-11-28、ユーザーの決定「haikuは安すぎ」「Opus5.5中がいい」）。
// 先に、node seat.js serve --port <同じ番号> を裏で動かしておく。
const http = require('http'), fs = require('fs'), { spawnSync } = require('child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const PORT = +opt('port', 8791), TURNS = +opt('turns', 40), AI = opt('ai', 'gemini'), NAME = opt('name', AI === 'codex' ? 'Codex' : AI === 'claude' ? 'Claude' : 'Gemini'), MODEL = opt('model', AI === 'claude' ? 'opus' : ''), EFFORT = opt('effort', AI === 'claude' ? 'medium' : '');
const GOAL = opt('goal', '') ? fs.readFileSync(opt('goal'), 'utf8') : '';
const LOG = opt('log', '');
const say = t => { console.log(t); if(LOG) fs.appendFileSync(LOG, t + '\n'); };

// AI ごとの呼び方（文を渡して、答えの文を受けとる。AI には道具を使わせない）
const ASK = {
  gemini: p => spawnSync('agy', ['-p', p, '--print-timeout', '180s'], { encoding:'utf8', timeout:240000, windowsHide:true }),
  codex: p => spawnSync('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', ...(MODEL ? ['--model', MODEL] : []), p], { encoding:'utf8', timeout:240000, windowsHide:true }),
  // 道具を全部外して、文だけを答えさせる。画面の文は、標準入力で渡す。作業フォルダは、何もない所（プロジェクトの決まりごとを読ませない）
  claude: p => spawnSync('claude', ['-p', '--model', MODEL, ...(EFFORT ? ['--effort', EFFORT] : []), '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', 'あなたは、ゲームブックを遊ぶプレイヤーです。渡された文の指示のとおりに、決められた形で答えます。'], { input:p, cwd:require('os').tmpdir(), encoding:'utf8', timeout:240000, windowsHide:true }),
};
if(!ASK[AI]) { console.log('--ai は gemini・codex・claude のどれか'); process.exit(1); }

// 毎回、新しい回線で頼む（使い回すと、AI が考えている間に席の側が回線を閉じていて、切られる）
const seat = q => new Promise(res => {
  const r = http.request({ host:'127.0.0.1', port:PORT, path:'/', method:'POST', agent:false, headers:{ 'Content-Type':'application/json' } }, s => { let t = ''; s.setEncoding('utf8'); s.on('data', d => t += d); s.on('end', () => res(t)); });
  r.on('error', e => res('（席につながらない：' + e.code + ' ' + e.message + '）')); r.end(JSON.stringify(q));
});

const RULES = `あなたは「${NAME}」という呼び名で、ゲームブック「Joining the Living Dead」の部屋に、1人のプレイヤーとして入っています。ほかのプレイヤーと、同じ街の同じ一日を、別々の主人公で進めるゲームです。友だちと遊ぶように、楽しんで遊んでください。
あなたが見られるのは、下の「いまの画面」だけです。ゲームの中身をのぞく方法はありません。
画面の右の［通信］に数字が付いていたら、ほかのプレイヤーの新しい書きこみがあります。開いて読み、話しかけられていたら、自分の主人公として返事をしてから、本に戻ってください。
次にすることを、答えの最後の行に、次のどれか1つの形で書いてください（番号は、いまの画面の「押せるもの」の番号）。
  ACTION: pick <番号>            … 押す（確認が出て「はい」と答えるときは、pick <番号> yes）
  ACTION: type <番号> <書く文>     … 入力欄に書く（書いたあとに［送る］などを押すのは、次の番で）
  ACTION: wait <秒>              … 画面が変わるまで待つ（ほかの人を待つとき・許可を待つとき。最大120）
  ACTION: done                   … やることが済んだので、やめる
その上の行に、次の自分への覚え書きを1行、MEMO: で書いてください（いまどこで、何をしようとしているか）。`;

(async () => {
  const memos = [], done = [];
  for(let turn = 1; turn <= TURNS; turn++){
    const screen = await seat({ cmd:'look' });
    if(screen.startsWith('（席につながらない')) { say(screen); return; }
    // 通信のボタンに数字が出ていたら（画面に出ている未読の数）、はっきり知らせる。AI は、画面の端の数字を見落としやすい
    const unread = (/］通信 (\d+)/.exec(screen) || [])[1];
    const prompt = RULES + (GOAL ? '\n\n＝＝ やること ＝＝\n' + GOAL : '')
      + (unread ? '\n\n【通信に、まだ読んでいない書きこみが ' + unread + ' 件あります。本を進める前に、［通信］を開いて読み、話しかけられていたら返事をしてください】' : '')
      + '\n\n＝＝ これまでの覚え書き ＝＝\n' + (memos.slice(-8).join('\n') || '（なし）')
      + '\n\n＝＝ これまでにしたこと（新しい順） ＝＝\n' + (done.slice(-8).reverse().join('\n') || '（なし）')
      + '\n\n＝＝ いまの画面 ＝＝\n' + screen.slice(0, 6000);
    const t0 = Date.now(), r = ASK[AI](prompt), out = String((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')).trim();
    const sec = Math.round((Date.now() - t0) / 1000);
    const memo = (out.match(/MEMO:\s*(.+)/g) || []).pop(), act = (out.match(/ACTION:\s*(.+)/g) || []).pop();
    if(memo) memos.push(memo.replace(/^MEMO:\s*/, ''));
    say(`[${turn}] ${sec}秒　${memo || '（覚え書きなし）'}　→ ${act || '（答えに ACTION がない）'}`);
    if(!act){ done.push('（答えの形が違った。ACTION: の行を書く）'); if(r.error) say('  AI を呼べない：' + r.error.message); say('  答え：' + out.slice(-300).replace(/\n/g, ' ')); continue; }
    const a = act.replace(/^ACTION:\s*/, '').trim(), m = /^(pick|type|wait|done)\b\s*(\d+)?\s*(.*)$/.exec(a);
    if(!m){ done.push(a + ' → 分からない形'); continue; }
    if(m[1] === 'done'){ say('やめた：' + (memo || '')); return; }
    if(process.env.SEAT_AI_DBG) say('  頼み：' + JSON.stringify(a));
    let res;
    if(m[1] === 'pick') res = await seat({ cmd:'pick', args:[m[2]], yes:/^yes$/i.test(m[3]) });
    else if(m[1] === 'type') res = await seat({ cmd:'type', args:[m[2], m[3]] });
    else res = await seat({ cmd:'wait', args:[String(Math.min(120, +m[2] || 60))] });
    const first = res.split('\n')[0];
    done.push(a + ' → ' + first);
    say('  ' + first);
  }
  say('回数の上限まで来た');
})();
