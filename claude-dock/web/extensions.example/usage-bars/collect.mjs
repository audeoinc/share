// 見本の collect: 標準出力に、JSON を 1 つ出す。実際の環境では、利用状況プラグインの値を取って、同じ形で出すように書き換える。
// 形: { "monthly": { "used": 数, "budget": 数 }, "today": { "used": 数, "budget": 数 }, "unit": "USD", "note": "任意の補足" }
const day = new Date().getDate();
const out = {
  monthly: { used: 12.5 * day, budget: 500 },
  today: { used: 8.4, budget: 20 },
  unit: 'USD',
  note: '見本のデータです (collect.mjs を、実際の値を出すものに置き換えてください)',
};
console.log(JSON.stringify(out));
