// 拡張の点検: node check-ext.mjs [拡張名]
// 設定フォルダの extensions\<名前>\ について、manifest.json、ext.js の構文、collect の実行結果 (JSON か) を調べて、OK / NG を出す。NG があれば、終了コード 1。
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import vm from 'node:vm'; import { spawn } from 'node:child_process';
const CONFIG = process.env.CDOCK_CONFIG_DIR || (process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'crogue') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'crogue'));
const root = path.join(CONFIG, 'extensions'); let bad = 0;
const ok = (m) => console.log('  OK  ' + m); const ng = (m) => { bad++; console.log('  NG  ' + m); };
console.log('拡張の場所: ' + root);
let names = []; try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { ng('extensions フォルダがありません'); }
if (process.argv[2]) names = names.filter((n) => n === process.argv[2]);
if (!names.length && !bad) ng('拡張が見つかりません');
for (const name of names) {
  console.log('\n[' + name + ']'); const dir = path.join(root, name);
  let m; try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, '')); ok('manifest.json'); } catch (e) { ng('manifest.json: ' + e.message); continue; }
  const js = path.join(dir, 'ext.js');
  if (fs.existsSync(js)) { try { new vm.Script(fs.readFileSync(js, 'utf8'), { filename: js }); ok('ext.js の構文'); } catch (e) { ng('ext.js の構文: ' + e.message); } if (!/crogue\.register\(/.test(fs.readFileSync(js, 'utf8'))) ng('ext.js に window.crogue.register(...) がありません'); }
  if (fs.existsSync(path.join(dir, 'ext.css'))) ok('ext.css あり');
  if (!m.collect || !m.collect.command) { if (!fs.existsSync(js)) ng('ext.js も collect もありません'); continue; }
  const r = await new Promise((res) => {
    const c = spawn(m.collect.command, { shell: true, cwd: dir, windowsHide: true, env: { ...process.env, CROGUE_CONFIG_DIR: CONFIG, CROGUE_EXT_DIR: dir } }); let out = '', err = '';
    const t = setTimeout(() => { c.kill(); res({ code: -1, out, err: err + '(時間切れ)' }); }, (m.collect.timeoutSec || 20) * 1000);
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d)); c.on('close', (code) => { clearTimeout(t); res({ code, out, err }); }); c.on('error', (e) => { clearTimeout(t); res({ code: -1, out, err: String(e) }); });
  });
  if (r.code !== 0) { ng('collect が失敗 (終了コード ' + r.code + '): ' + (r.err || r.out).trim().slice(0, 300)); continue; }
  try { const j = JSON.parse(r.out.trim()); ok('collect の出力は JSON: ' + JSON.stringify(j).slice(0, 200)); } catch { ng('collect の出力が JSON ではありません: ' + r.out.trim().slice(0, 200)); }
}
console.log(bad ? `\n結果: NG ${bad} 件` : '\n結果: すべて OK (画面で見える状態かは、ブラウザで開いて確かめてください)'); process.exit(bad ? 1 : 0);
