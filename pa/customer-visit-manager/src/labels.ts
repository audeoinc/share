import {
  Cr854_productscr854_category,
  Cr854_productscr854_salestrend,
  Cr854_productscr854_season,
  Cr854_productscr854_weather,
  type Cr854_products,
} from './generated/models/Cr854_productsModel'
import { Cr854_heroimagescr854_purpose, Cr854_heroimagescr854_season, type Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'

// Dataverse が選択肢の表示名(○○name の項目)を返さないことがあるので、値(数値)から補う
const pick = (map: Record<number, string>, value?: number, name?: string) => name || (value === undefined ? undefined : map[value])

export function withProductLabels(p: Cr854_products): Cr854_products {
  return {
    ...p,
    cr854_categoryname: pick(Cr854_productscr854_category, p.cr854_category, p.cr854_categoryname),
    cr854_salestrendname: pick(Cr854_productscr854_salestrend, p.cr854_salestrend, p.cr854_salestrendname),
    cr854_seasonname: pick(Cr854_productscr854_season, p.cr854_season, p.cr854_seasonname),
    cr854_weathername: pick(Cr854_productscr854_weather, p.cr854_weather, p.cr854_weathername),
  }
}

export function withHeroLabels(h: Cr854_heroimages): Cr854_heroimages {
  return {
    ...h,
    cr854_purposename: pick(Cr854_heroimagescr854_purpose, h.cr854_purpose, h.cr854_purposename),
    cr854_seasonname: pick(Cr854_heroimagescr854_season, h.cr854_season, h.cr854_seasonname),
  }
}
