<script setup lang="ts">
import { computed, ref } from 'vue'
import { perfSource, providerColors, useCostUnit, type ModelPricing } from '../composables/usePricing'

export interface CostRow {
  model: ModelPricing
  /** 依情境推估的單次成本區間（USD） */
  costLow: number
  costHigh: number
  /** 這個任務預估消耗的 token 數區間（input+output，含呼叫次數；input 依該模型 tokenizer 換算） */
  tokLow: number
  tokHigh: number
  /** true = 該家沒有公開 tokenizer，input 以近似編碼估算（顯示 ≈） */
  tokApprox: boolean
  /** tooltip 用的假設說明 */
  assumption: string
}

const props = defineProps<{
  rows: CostRow[]
  /** false = agent 型，區間僅為參考 */
  reliable: boolean
  /** true = prompt 還是空白，數字全部顯示 —（避免「還沒打字就有數字」） */
  empty?: boolean
}>()

// 成本欄顯示單位：切換就做在欄位標題上（成本/次 · tokens），全站共用
const unit = useCostUnit()

type SortKey = 'total' | 'perf'
const sortKey = ref<SortKey>('total')
const sortDir = ref<'asc' | 'desc'>('asc')

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    // 效能預設由高到低、成本預設由低到高
    sortDir.value = key === 'perf' ? 'desc' : 'asc'
  }
}

// token 檢視以任務預估消耗排序/取極值（上限）；成本檢視用推估的 $/次
const metricHigh = (r: CostRow) => (unit.value === 'tokens' ? r.tokHigh : r.costHigh)

const sortedRows = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...props.rows].sort((a, b) => {
    const va = sortKey.value === 'total' ? metricHigh(a) : a.model.perf
    const vb = sortKey.value === 'total' ? metricHigh(b) : b.model.perf
    return (va - vb) * dir
  })
})

const maxHigh = computed(() =>
  props.rows.length ? Math.max(...props.rows.map(metricHigh)) : 0,
)
const minHigh = computed(() =>
  props.rows.length ? Math.min(...props.rows.map(metricHigh)) : 0,
)
const maxPerf = computed(() =>
  props.rows.length ? Math.max(...props.rows.map((r) => r.model.perf)) : 0,
)

const hasSpread = computed(
  () => !props.empty && props.rows.length >= 2 && minHigh.value !== maxHigh.value,
)

function costBarWidth(v: number): string {
  if (props.empty || maxHigh.value <= 0) return '0%'
  return `${Math.max((v / maxHigh.value) * 100, v > 0 ? 2 : 0)}%`
}

function perfBarWidth(perf: number): string {
  if (maxPerf.value <= 0) return '0%'
  return `${(perf / maxPerf.value) * 100}%`
}

function fmt(value: number): string {
  if (value === 0) return '0'
  if (value < 0.0001) return value.toFixed(6)
  if (value < 0.01) return value.toFixed(4)
  if (value < 1) return value.toFixed(3)
  return value.toFixed(2)
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K'
  return Math.round(n).toLocaleString('en-US')
}

function rangeText(row: CostRow): string {
  if (props.empty) return '—'
  if (unit.value === 'tokens') {
    const pre = row.tokApprox ? '≈' : ''
    if (Math.round(row.tokLow) === Math.round(row.tokHigh)) return `${pre}${fmtTok(row.tokHigh)}`
    return `${pre}${fmtTok(row.tokLow)}–${fmtTok(row.tokHigh)}`
  }
  if (row.costHigh === 0) return '$0'
  if (row.costLow === row.costHigh) return `$${fmt(row.costLow)}`
  return `$${fmt(row.costLow)}–${fmt(row.costHigh)}`
}

function tokTitle(row: CostRow): string {
  return `這個任務在 ${row.model.name} 預估消耗 ${fmtTok(row.tokLow)}–${fmtTok(
    row.tokHigh,
  )} tokens（= input + 預估 output，含呼叫次數；input 依該模型 tokenizer 換算${
    row.tokApprox ? '，該家沒有公開 tokenizer、為近似值' : ''
  }）——${row.assumption}`
}

function arrow(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' ↑' : ' ↓'
}
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-left text-sm">
      <thead>
        <tr class="border-b border-line text-[11px] text-txt-dim">
          <th class="whitespace-nowrap py-1.5 pr-3 font-medium">模型</th>
          <th
            class="w-28 cursor-pointer select-none whitespace-nowrap py-1.5 pr-3 font-medium transition-colors hover:text-txt"
            title="Artificial Analysis Intelligence Index，點擊排序"
            @click="setSort('perf')"
          >
            效能{{ arrow('perf') }}
          </th>
          <th class="select-none whitespace-nowrap py-1.5 pr-3 text-right font-medium">
            <!-- 切換做在欄位標題上：點暗的切換顯示、點亮的排序 -->
            <span
              class="cursor-pointer transition-colors"
              :class="unit === 'cost' ? 'text-txt' : 'hover:text-txt'"
              :title="unit === 'cost' ? '依上方情境推估的每次成本區間，點擊排序（以上限排）' : '切回顯示每次成本'"
              @click="unit === 'cost' ? setSort('total') : (unit = 'cost')"
              >成本/次</span
            >
            <span class="px-0.5 text-txt-dim/50">·</span>
            <span
              class="cursor-pointer transition-colors"
              :class="unit === 'tokens' ? 'text-txt' : 'hover:text-txt'"
              :title="unit === 'tokens' ? '這個任務預估消耗的 token 數（input+output，依上方情境推估），點擊排序' : '切換顯示這個任務預估會消耗多少 token'"
              @click="unit === 'tokens' ? setSort('total') : (unit = 'tokens')"
              >tokens</span
            >{{ arrow('total') }}
          </th>
          <th class="hidden w-24 py-1.5 font-medium md:table-cell">
            {{ unit === 'tokens' ? '相對 token 數' : '相對成本' }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in sortedRows"
          :key="row.model.id"
          class="border-b border-line/60 last:border-0"
        >
          <td class="py-1.5 pr-3">
            <span class="flex items-center gap-2">
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                :style="{ backgroundColor: providerColors[row.model.provider] }"
                :title="row.model.provider"
              />
              <span class="whitespace-nowrap text-[13px] text-txt">{{ row.model.name }}</span>
              <span
                v-if="row.model.free"
                class="rounded bg-save/10 px-1 py-0.5 text-[10px] font-semibold text-save"
                >免費</span
              >
              <span
                v-else-if="hasSpread && metricHigh(row) === minHigh"
                class="rounded bg-save/10 px-1 py-0.5 text-[10px] font-semibold text-save"
                >最省</span
              >
              <span
                v-if="hasSpread && metricHigh(row) === maxHigh"
                class="rounded bg-spend/10 px-1 py-0.5 text-[10px] font-semibold text-spend"
                >最貴</span
              >
            </span>
          </td>
          <td class="py-1.5 pr-3">
            <!-- 效能量值條：第二個量值情境用色盤下一個色相（aqua） -->
            <div class="flex items-center gap-1.5">
              <div class="h-1.5 w-14 rounded-r-full bg-[#199e70]/15">
                <div
                  class="h-1.5 rounded-r-full bg-[#199e70]"
                  :style="{ width: perfBarWidth(row.model.perf) }"
                />
              </div>
              <span class="font-mono text-xs tabular-nums text-txt-dim">
                {{ row.model.perf_est ? '≈' : '' }}{{ row.model.perf }}
              </span>
            </div>
          </td>
          <td
            class="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-xs font-semibold tabular-nums text-txt"
            :title="unit === 'tokens' ? tokTitle(row) : row.assumption"
          >
            {{ rangeText(row) }}
          </td>
          <td class="hidden py-1.5 md:table-cell">
            <div class="h-1.5 w-full rounded-r-full bg-[#3987e5]/15">
              <div
                class="h-1.5 rounded-r-full bg-[#3987e5]"
                :style="{ width: costBarWidth(metricHigh(row)) }"
              />
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="4" class="py-4 text-center text-xs text-txt-dim">
            至少勾選一個模型才能比較成本
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length" class="mt-1.5 text-[10px] text-txt-dim/80">
      效能 = {{ perfSource }}，≈ 為估算值。{{
        unit === 'tokens'
          ? 'tokens = 這個任務預估消耗（input + 預估 output，含呼叫次數，依上方情境推估；滑鼠停留看假設）。input 依各模型 tokenizer 換算（≈ 為近似編碼）、output 乘各模型的輸出詳簡係數——話多/思考型模型消耗更多，係數為估算'
          : '成本與 token 的 output 部分都已乘各模型的輸出詳簡係數（話多/思考型較高，估算值）；成本區間依上方情境推估（滑鼠停留看假設）'
      }}{{ reliable ? '' : '；Agent 型工作僅為公開實測參考，無法可靠預估' }}。
    </p>
  </div>
</template>
