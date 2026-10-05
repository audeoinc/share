// 共有のアプリ(power.config.json の appId)への反映。安全装置つき。
//   npm run deploy
// 反映してよい状態(main で、最新で、変更が残っていない)のときだけ、検証 → ビルド → pa app push を行う。
// 共有のアプリを複数人が上書きしても、他の人の変更を消さないための確認(docs/ONBOARDING.md の「チームの進め方」)。

import { execSync } from 'node:child_process'

const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const fail = (msg) => {
  console.error(`\n反映を中止しました: ${msg}\n`)
  process.exit(1)
}

// 1. main にいること
const branch = sh('git rev-parse --abbrev-ref HEAD')
if (branch !== 'main') fail(`ブランチが ${branch} です。反映は、マージ済みの main から行います(git checkout main)。`)

// 2. 最新であること(リモートより遅れていない・進んでいない)
run('git fetch origin')
const behind = Number(sh('git rev-list --count HEAD..origin/main'))
const ahead = Number(sh('git rev-list --count origin/main..HEAD'))
if (behind > 0) fail(`リモートの main が ${behind} 件先に進んでいます。git pull してから、もう一度実行してください。`)
if (ahead > 0) fail(`まだ push していないコミットが ${ahead} 件あります。チームが同じコードを見られるよう、先に git push してください。`)

// 3. 変更が残っていないこと(追跡しているファイルの未コミットの変更)
const dirty = sh('git status --porcelain --untracked-files=no')
if (dirty) fail(`コミットしていない変更があります:\n${dirty}`)

// 4. 検証 → ビルド → 反映
console.log('\n[1/4] 型チェック')
run('npx tsc -b')
console.log('\n[2/4] lint')
run('npx eslint . --ignore-pattern "src/generated/**"')
console.log('\n[3/4] ビルド')
run('npm run build')
console.log('\n[4/4] 反映(pa app push)')
run('npx pa app push')

const commit = sh('git rev-parse --short HEAD')
console.log(`\n反映しました(コミット ${commit})。画面に「古いバージョン」と出たら、「最新の情報に更新」を押してください。\n`)
