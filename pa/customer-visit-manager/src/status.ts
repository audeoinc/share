import {
  Cr854_deliverycardscr854_status as Status,
  Cr854_deliverycardscr854_channel as Channel,
  Cr854_deliverycardscr854_country as Country,
  Cr854_deliverycardscr854_department as Department,
} from './generated/models/Cr854_deliverycardsModel'

type Options = Record<number, string>
const optionsOf = (o: Options) => Object.entries(o).map(([value, label]) => ({ value: Number(value), label }))

export const statusOptions = optionsOf(Status)
export const channelOptions = optionsOf(Channel)
export const countryOptions = optionsOf(Country)
export const departmentOptions = optionsOf(Department)

// 進行順(未起案→検討中→承認済み→確定)の色分け
const statusColors = ['#8a8f98', '#d99a1e', '#3b82f6', '#22a06b']
export const statusColor = (v?: number) => {
  const idx = statusOptions.findIndex((o) => o.value === v)
  return statusColors[idx < 0 ? 0 : idx]
}
