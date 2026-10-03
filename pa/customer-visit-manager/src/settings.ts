const AUTO_KEY = 'cardDetail.autoDraft'

/** カードを開いたときの自動下書きの設定(既定はオン)。アプリ全体の設定で、ブラウザごとに保存する */
export function loadAutoDraft(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off'
  } catch {
    return true
  }
}

export function saveAutoDraft(on: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, on ? 'on' : 'off')
  } catch {
    // 保存できなくても動作には影響しない
  }
}
