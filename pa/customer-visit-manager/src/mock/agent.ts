// 撮影・デモ用の、AI エージェントの身代わり。実際の AI ではなく、依頼の内容(task、商品の一覧、チャットの指示)から、
// それらしい返答(JSON の文字列)を、決まった形で作る。AI の画面の撮影のためだけに使う。

type Obj = Record<string, unknown>
type ProductIn = { code: string; name: string; category?: string; price?: number; stock?: number; salesTrend?: string; rating?: number }
type HeroIn = { code: string; name: string; season?: string; purpose?: string }

const TREND_EN: Record<string, string> = { 上昇: 'rising', 横ばい: 'flat', 下降: 'falling' }
const hasJa = (s: string) => /[぀-ヿ㐀-鿿]/.test(s)

/** 依頼の文から、末尾の入力(JSON)を取り出す */
function payloadOf(message: string): Obj {
  const i = message.lastIndexOf('{"task":')
  if (i < 0) return {}
  try {
    return JSON.parse(message.slice(i)) as Obj
  } catch {
    return {}
  }
}

const J = (o: unknown) => JSON.stringify(o)

export function mockAgent(message: string): string {
  const p = payloadOf(message)
  const task = String(p.task ?? '')
  const en = message.includes('自然な英語で書くこと') // 画面が English のときの注意書き
  const card = (p.card ?? {}) as Obj
  const theme = String(card.theme ?? '')
  const chat = (p.chat as { role: string; text: string }[] | undefined) ?? []
  const last = chat.length > 0 ? chat[chat.length - 1].text : ''

  // チャットで、質問・相談のときは、案を変えずに、答えだけを返す
  if (chat.length > 0 && /[?？]|どう思|なぜ|why|what do you think|how about/i.test(last)) {
    return J({
      mode: 'answer',
      reply: hasJa(last)
        ? '全体として季節感と統一感がありますが、見出しの内容がやや重複しています。トップス中心に、軽めのニットやカーディガンを軸に再構成すると、より自然に秋の立ち上がりに合います。'
        : 'The lineup feels seasonal and cohesive, though two items overlap. Building around knits and a light cardigan would fit the early-fall mood more naturally.',
    })
  }
  const reply = (jaDefault: string, enDefault: string) => {
    if (chat.length === 0) return {}
    return { mode: 'update', reply: hasJa(last) ? jaDefault : enDefault }
  }

  if (task === 'suggest_themes') {
    return en
      ? J({ themes: [
          { theme: 'Layered Comfort for Crisp Days', reason: 'Early October brings cooler mornings; light jackets and knits are well stocked and trending up.' },
          { theme: 'Rain-Ready Chic for Autumn Streets', reason: 'Rain parkas, boots and totes have solid inventory and growing demand this season.' },
          { theme: 'Warm Textures to Welcome Fall', reason: 'Knits, blankets and loungewear are selling well and give a strong seasonal feel.' },
        ] })
      : J({ themes: [
          { theme: '季節の変わり目スタイル', reason: '10月初旬の寒暖差が大きく、在庫豊富な軽アウターとニットが好調なため。' },
          { theme: '雨の日も楽しむ秋支度', reason: 'レインパーカーやレインブーツの在庫が多く、雨具の需要が高まる時期。' },
          { theme: 'あたたか素材で、秋じたく', reason: 'ニットやブランケットの売れ行きが伸びており、季節感を出しやすい。' },
        ] })
  }

  if (task === 'suggest_copies') {
    const t = en ? theme || 'the season' : theme || '季節'
    void t
    return en
      ? J({ copies: [
          { headline: 'Embrace the Autumn Layers', lead: 'Discover cozy blends and structured essentials that redefine effortless warmth.', angle: 'Seasonal feel' },
          { headline: 'Style That Moves With Fall', lead: 'Transition seamlessly from chilly mornings to golden afternoons with soft, tailored comfort.', angle: 'Product appeal' },
          { headline: 'Find Your Perfect Fall Layer', lead: 'From trench to wool, explore new arrivals made to make every outing effortlessly stylish.', angle: 'Call to action' },
        ] })
      : J({ copies: [
          { headline: 'ぬくもりを纏う、秋', lead: '重ねるほどに表情が変わる、やさしい手ざわりの新作が届きました。', angle: '季節感' },
          { headline: '秋の主役は、ニット', lead: '上質な素材とこなれたシルエットで、いつもの装いを一歩先へ。', angle: '商品の魅力' },
          { headline: 'あなたの秋の一枚を', lead: '今季の新作から、お気に入りのレイヤーを見つけてください。', angle: '行動の呼びかけ' },
        ] })
  }

  if (task === 'suggest_instructions') {
    return en
      ? J({ instructions: [
          { text: 'Lead with a full-width autumn outfit visual in warm brown and terracotta tones. Present the four products in a calm two-by-two grid with generous white space, short product notes, and quiet dark call-to-action buttons.', angle: 'Classic layout' },
          { text: 'Make the products the heroes: use slightly larger product images with natural crops that show texture. Keep text minimal and let the materials speak, with a soft beige background.', angle: 'Product first' },
          { text: 'Build a mood-driven story: a golden-hour street scene as the hero, layered outfits below, and gold accents for the call-to-action. Keep typography refined and spacious.', angle: 'Mood-driven' },
        ] })
      : J({ instructions: [
          { text: 'メインビジュアルは秋のコーディネートを全幅で配置し、温かみのあるブラウン〜テラコッタ系で季節感を演出。商品は4点を2×2のグリッドで表示し、各商品の特徴を短く添える。余白を多めに取り、ボタンは落ち着いた濃色に統一する。', angle: '王道構成' },
          { text: '商品を主役にする。商品画像をやや大きめに配置し、質感が伝わるクロップにする。文字は控えめにして、素材の魅力を前面に出す。背景は淡いベージュで統一する。', angle: '商品を主役に' },
          { text: '世界観を重視する。夕暮れの街角をヒーローにして、下に重ね着のコーディネートを並べる。ボタンはゴールド系のアクセントにし、タイポグラフィは上品で余白のあるものにする。', angle: '世界観重視' },
        ] })
  }

  if (task === 'suggest_template') {
    return en
      ? J({ template: 'cat2', reason: 'The theme calls for two angles (outerwear and knits) shown side by side.' })
      : J({ template: 'cat2', reason: '複数の切り口(アウターとニット)を並べて見せたいテーマのため。' })
  }

  if (task === 'select_hero') {
    const heroes = (p.heroes as HeroIn[] | undefined) ?? []
    const fall = heroes.filter((h) => /秋|fall|autumn/i.test(String(h.season ?? '')) || /new|新作/i.test(String(h.purpose ?? '')))
    const list = [...fall, ...heroes.filter((h) => !fall.includes(h))]
    const pick = list[0]
    if (!pick) return J({ hero: null, candidates: [] })
    return J({
      hero: { code: pick.code, reason: en ? `Fits the theme and the fall season: ${pick.name}.` : `テーマと秋の季節感に合う画像です(${pick.name})。` },
      candidates: list.slice(1, 4).map((h) => ({ code: h.code, reason: en ? `Alternative with a similar mood: ${h.name}.` : `近い雰囲気の候補です(${h.name})。` })),
    })
  }

  if (task.startsWith('select_section')) {
    const pool = ((p.products as ProductIn[] | undefined) ?? []).filter((x) => (x.stock ?? 0) >= 50)
    const section = (p.section ?? {}) as Obj
    const slots = Number(section.slots) || 4
    const others = (p.otherSections as Obj[] | undefined) ?? []
    const idx = others.filter((o) => Array.isArray(o.productNames) && (o.productNames as unknown[]).length > 0).length
    const wantTitle = Boolean(section.wantTitle)

    // 指示(チャット)に、商品名が入っていれば、先頭にする。「安い・affordable」なら、価格の安い順
    let ranked = [...pool].sort((a, b) => (a.salesTrend === '上昇' ? 0 : 1) - (b.salesTrend === '上昇' ? 0 : 1) || (b.rating ?? 0) - (a.rating ?? 0))
    if (/安|手頃|affordable|cheap/i.test(last)) ranked = [...pool].sort((a, b) => (a.price ?? 0) - (b.price ?? 0))
    if (wantTitle && !last) {
      const cats = ['アウター', 'トップス', 'ボトムス', 'シューズ']
      const cat = cats[idx % cats.length]
      ranked = [...ranked.filter((x) => x.category === cat), ...ranked.filter((x) => x.category !== cat)]
    }
    const named = pool.find((x) => last && (last.toLowerCase().includes(x.name.toLowerCase()) || last.toLowerCase().includes(x.code.toLowerCase())))
    if (named) ranked = [named, ...ranked.filter((x) => x !== named)]

    const why = (x: ProductIn) =>
      en
        ? `Stock ${x.stock}, sales ${TREND_EN[x.salesTrend ?? ''] ?? 'flat'}, rating ★${x.rating}; fits "${theme || 'this story'}".`
        : `在庫${x.stock}、売上トレンド${x.salesTrend ?? '横ばい'}、評価★${x.rating}。「${theme || 'このテーマ'}」に合う${x.category ?? '商品'}です。`
    const products = ranked.slice(0, slots + 3).map((x) => ({ code: x.code, reason: why(x) }))

    const titlesJa = [
      { title: '重ねて楽しむ、秋のアウター', reason: 'アウターを軸にした切り口。' },
      { title: 'ニットで作る、秋の定番', reason: 'ニットを軸にした切り口。' },
      { title: '雨の日の、秋支度', reason: '雨具を軸にした切り口。' },
    ]
    const titlesEn = [
      { title: 'Outer Layers for Crisp Days', reason: 'An outerwear-led angle.' },
      { title: 'Knits That Layer Well', reason: 'A knit-led angle.' },
      { title: 'Rain-Ready Fall Picks', reason: 'A rainwear-led angle.' },
    ]
    const rot = <T,>(a: T[]) => [...a.slice(idx % a.length), ...a.slice(0, idx % a.length)]
    const used = new Set(others.map((o) => String(o.title ?? '')))
    const all = rot(en ? titlesEn : titlesJa)
    const titles = wantTitle ? [...all.filter((x) => !used.has(x.title)), ...all.filter((x) => used.has(x.title))] : []
    const copies = en
      ? [
          { copy: 'Find comfort and polish in layers that welcome the crisp fall breeze.', angle: 'Refined seasonal layering' },
          { copy: 'Warm up gently with soft textures and subtle tones for early autumn days.', angle: 'Cozy transitional style' },
          { copy: 'Easy pieces that carry you from chilly mornings to golden afternoons.', angle: 'Classy fall versatility' },
        ]
      : [
          { copy: '涼やかな秋風にぴったりの、上品な重ね着を。', angle: '上品な季節の重ね着' },
          { copy: 'やわらかな素材と穏やかな色で、秋のはじめをあたたかく。', angle: 'ほっとする移行期の装い' },
          { copy: '朝の肌寒さから午後のやわらかな日ざしまで、ずっと心地よく。', angle: '一日中使える万能さ' },
        ]

    const r = reply(
      named ? `ご指定の「${named.name}」を先頭に含めて、選び直しました。` : '指示を反映して、選び直しました。',
      named ? `Included "${named.name}" first and re-selected this section.` : 'Re-selected this section with your instruction applied.',
    )
    if (task === 'select_section_titles') return J({ titles, ...r })
    if (task === 'select_section_copies') return J({ copies, ...r })
    if (task === 'select_section_products') return J({ products, ...r })
    return J({ titles, copies, products, ...r })
  }

  return J({ error: 'mock agent: unknown task' })
}
