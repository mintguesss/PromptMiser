<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  models,
  plansForProvider,
  planShareForTokens,
  pricingUpdated,
  providerColors,
  providers,
  useCostUnit,
  useSelectedModels,
  useTurns,
  type ModelPricing,
} from '../../composables/usePricing'
import { classifyScenario, conversationTotal, type Scenario } from '../../composables/useScenario'
import { stripProtectionMarkers, useTokenizer } from '../../composables/useTokenizer'
import type { UsageEstimate } from '../../types'

/**
 * 卡片版即時分析。
 *
 * 估算邏輯跟極簡版完全相同（數字必須一致，否則兩版沒得比），差別在呈現：
 *   深色主卡當視覺錨點 → 兩張重點卡 → 攤開的完整比較。
 *
 * 沒輸入時不是空白：同一份表改用「每 1M tokens 單價」呈現，
 * 一進來就看得到各家行情，打完字才換算成這次實際要花多少。
 */
const props = defineProps<{
  currentModelId: string
  llmProfile: Scenario | null
  llmEstimate: UsageEstimate | null
  /** 綜合版：同一套排版，但把現行版才有的完整資訊也放進來 */
  dense?: boolean
}>()
const prompt = defineModel<string>({ required: true })

const { count } = useTokenizer()
const text = computed(() => stripProtectionMarkers(prompt.value))
const tokO = computed(() => count(text.value, 'o200k_base'))
const tokC = computed(() => count(text.value, 'cl100k_base'))
const hasText = computed(() => text.value.trim().length > 0)
const promptTokens = computed(() => Math.max(tokO.value ?? Math.ceil(text.value.length * 0.7), 1))

const cur = computed(() => models.find((m) => m.id === props.currentModelId) ?? models[0])
const turns = useTurns()
const unit = useCostUnit()
const selectedIds = useSelectedModels()

const mappedProfile = computed<Scenario | null>(() =>
  props.llmProfile === 'conversation' ? 'single' : props.llmProfile,
)

const estimate = computed(() => {
  const N = Math.max(turns.value, 1)
  const e = props.llmEstimate
  if (e && mappedProfile.value) {
    const isAgent = mappedProfile.value === 'agent'
    const inLo0 = promptTokens.value + e.context_overhead_min
    const inHi0 = promptTokens.value + e.context_overhead_max
    const [inLo, outLo] =
      !isAgent && N > 1 ? conversationTotal(inLo0, e.expected_output_min, N) : [inLo0, e.expected_output_min]
    const [inHi, outHi] =
      !isAgent && N > 1 ? conversationTotal(inHi0, e.expected_output_max, N) : [inHi0, e.expected_output_max]
    return {
      inputRange: [Math.round(inLo), Math.round(inHi)] as [number, number],
      outputRange: [Math.round(outLo), Math.round(outHi)] as [number, number],
      calls: [e.calls_min, e.calls_max] as [number, number],
      precise: true,
    }
  }
  const h = classifyScenario(text.value, promptTokens.value, undefined, { turns: N })
  return { inputRange: h.inputRange, outputRange: h.outputRange, calls: [1, 1] as [number, number], precise: false }
})

function costOf(m: ModelPricing): [number, number] {
  const e = estimate.value
  const v = m.verbosity ?? 1
  return [
    ((e.inputRange[0] * m.input_per_1m + e.outputRange[0] * v * m.output_per_1m) / 1e6) * e.calls[0],
    ((e.inputRange[1] * m.input_per_1m + e.outputRange[1] * v * m.output_per_1m) / 1e6) * e.calls[1],
  ]
}
function tokOf(m: ModelPricing): number {
  const e = estimate.value
  const base = Math.max(promptTokens.value, 1)
  const enc = (m.encoding === 'cl100k_base' ? tokC.value : tokO.value) ?? base
  return (e.inputRange[1] * (enc / base) + e.outputRange[1] * (m.verbosity ?? 1)) * e.calls[1]
}
/** 沒輸入時用的排序／比較基準：跑 1M input + 1M output 的單價 */
const listPrice = (m: ModelPricing) => m.input_per_1m + m.output_per_1m

const yours = computed(() => costOf(cur.value))
const totalTokens = computed(() => estimate.value.inputRange[1] + estimate.value.outputRange[1])

/** 錢花在你的字還是 AI 的回覆 */
const split = computed(() => {
  const e = estimate.value
  const m = cur.value
  const inC = e.inputRange[1] * m.input_per_1m
  const outC = e.outputRange[1] * (m.verbosity ?? 1) * m.output_per_1m
  const s = inC + outC || 1
  return { input: (inC / s) * 100, output: (outC / s) * 100 }
})

interface Row {
  m: ModelPricing
  cost: [number, number]
  tok: number
  metric: number
}
const rows = computed<Row[]>(() =>
  models
    .filter((m) => selectedIds.value.includes(m.id))
    .map((m) => {
      const cost = costOf(m)
      const tok = tokOf(m)
      const metric = !hasText.value ? listPrice(m) : unit.value === 'tokens' ? tok : cost[1]
      return { m, cost, tok, metric }
    })
    .sort((a, b) => a.metric - b.metric),
)
const maxMetric = computed(() => Math.max(...rows.value.map((r) => r.metric), 1e-9))

/**
 * 最省的替代選擇。排除免費模型——這一頁還沒有 LLM 的適合度評分，
 * 直接推薦免費模型等於叫人去用做不出結果的東西。
 */
const best = computed(() => {
  const cheaper = rows.value.filter(
    (r) => !r.m.free && r.m.id !== cur.value.id && r.cost[1] < yours.value[1],
  )
  return cheaper[0] ?? null
})
const bestSavePct = computed(() =>
  best.value && yours.value[1] > 0 ? (1 - best.value.cost[1] / yours.value[1]) * 100 : 0,
)

const subPlans = computed(() =>
  plansForProvider(cur.value.provider).map((plan) => {
    const share = planShareForTokens(totalTokens.value, plan)
    return { plan, pct: share.pct, q: share.pct > 0 ? Math.floor(100 / share.pct) : 0 }
  }),
)
const topPlan = computed(() => subPlans.value[0] ?? null)

// ── 模型挑選 ──
const pickerOpen = ref(false)
const providerGroups = computed(() =>
  providers
    .map((provider) => ({ provider, items: models.filter((m) => m.provider === provider) }))
    .filter((g) => g.items.length > 0),
)
function toggleModel(id: string) {
  const list = selectedIds.value
  selectedIds.value = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

const money = (v: number) =>
  v === 0 ? '$0' : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 3 : 2)}`
const range = (r: [number, number]) => (r[0] === r[1] ? money(r[1]) : `${money(r[0])}–${money(r[1])}`)
const tokFmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${Math.round(n)}`)
const per1m = (v: number) => (v >= 1 ? `$${v.toFixed(v >= 10 ? 0 : 1)}` : `$${v.toFixed(2)}`)
/** 一列右邊要顯示什麼：沒輸入看單價，有輸入看這次的成本或用量 */
function rowValue(r: Row): string {
  if (!hasText.value) return `${per1m(r.m.input_per_1m)} / ${per1m(r.m.output_per_1m)}`
  return unit.value === 'tokens' ? `${tokFmt(r.tok)}` : range(r.cost)
}

/** 最貴 ÷ 最便宜（不含免費），空狀態的主卡用它講「差幾倍」 */
const spread = computed(() => {
  const paid = models.filter((m) => !m.free).map(listPrice)
  if (paid.length < 2) return null
  const lo = Math.min(...paid)
  const hi = Math.max(...paid)
  return lo > 0 ? Math.round(hi / lo) : null
})

/** 綜合版才顯示的省錢提示（跟現行版同一套判斷） */
const tips = computed(() => {
  const out: { title: string; desc: string; pct: string }[] = []
  if (best.value && bestSavePct.value > 5) {
    out.push({
      title: `換到 ${best.value.m.name}`,
      desc: `效能 ${best.value.m.perf_est ? '≈' : ''}${best.value.m.perf}，單價只有 ${cur.value.name} 的一小部分。`,
      pct: `-${bestSavePct.value.toFixed(0)}%`,
    })
  }
  if (split.value.output >= 60) {
    out.push({
      title: '限制回覆長度',
      desc: `這類任務 output 佔成本約 ${split.value.output.toFixed(0)}%，加「請精簡回答」最有感。`,
      pct: '-40%',
    })
  } else {
    out.push({
      title: '固定說明開 caching',
      desc: '重複呼叫的固定段落開 prompt caching，之後只收約 10% 費用。',
      pct: '-25%',
    })
  }
  if (estimate.value.calls[1] > 1) {
    out.push({
      title: '減少工具呼叫輪數',
      desc: `這個任務預估要跑 ${estimate.value.calls[0]}–${estimate.value.calls[1]} 次呼叫，每一輪都會重讀前文。`,
      pct: '-30%',
    })
  }
  return out
})

/** 綜合版顯示的估算假設 */
const assumption = computed(() => {
  const e = estimate.value
  return `input ${e.inputRange[0].toLocaleString()}–${e.inputRange[1].toLocaleString()} · output ${e.outputRange[0].toLocaleString()}–${e.outputRange[1].toLocaleString()} tokens${e.calls[1] > 1 ? ` × ${e.calls[0]}–${e.calls[1]} 次呼叫` : ''}`
})

const controlsOpen = ref(false)

watch(prompt, () => {
  turns.value = 1
})
</script>

<template>
  <main class="mx-auto w-full max-w-xl px-4 pb-20 pt-4">
    <!-- 輸入 -->
    <textarea
      v-model="prompt"
      rows="3"
      placeholder="貼上你要送給 AI 的問題或指令…"
      class="w-full resize-y rounded-2xl border border-[#e6e3da] bg-white p-4 text-[15px] leading-7 text-[#3c4250] shadow-[0_1px_2px_rgba(28,25,18,0.04)] transition placeholder:text-[#b6bcc7] focus:border-[#1d2129]/25 focus:outline-none focus:ring-4 focus:ring-[#1d2129]/5"
    />
    <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-[11px] text-[#a8aebb]">
      <span class="font-mono tabular-nums">
        <template v-if="hasText">
          {{ (tokO ?? 0).toLocaleString('en-US') }} tokens
          <template v-if="dense"> · {{ text.length }} 字</template>
        </template>
        <template v-else>[[ ]] 內的段落壓縮時不會被改</template>
      </span>
      <template v-if="dense && hasText">
        <span class="rounded-full bg-[#efece5] px-2 py-0.5 text-[10px] text-[#8b93a0]">
          {{ estimate.precise ? '🤖 AI 精算' : '⚡ 規則估算' }}
        </span>
        <button
          type="button"
          class="ml-auto rounded-full bg-[#efece5] px-2.5 py-0.5 text-[10px] text-[#767e8c]"
          @click="controlsOpen = !controlsOpen"
        >
          調整 {{ controlsOpen ? '▴' : '▾' }}
        </button>
      </template>
    </div>

    <!-- 綜合版：對話輪數。多數人不會動，所以預設收起 -->
    <div v-if="dense && controlsOpen" class="mt-2 flex items-center gap-3 rounded-xl bg-white px-4 py-3 text-[12px] text-[#767e8c] ring-1 ring-[#eae7de]">
      <span class="shrink-0">對話輪數</span>
      <input
        :value="turns"
        type="range"
        min="1"
        max="50"
        step="1"
        class="h-1 flex-1 cursor-pointer accent-emerald-500"
        @input="turns = Number(($event.target as HTMLInputElement).value)"
      />
      <span class="w-10 shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums text-[#1d2129]">{{ turns }}</span>
    </div>

    <!-- 主卡：整頁唯一的深色塊，視線一定先落在這裡 -->
    <section
      class="relative mt-4 overflow-hidden rounded-[20px] bg-gradient-to-br from-[#3d4553] to-[#515a69] p-5 shadow-[0_8px_20px_-10px_rgba(61,69,83,0.45)]"
    >
      <div
        class="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full opacity-20 blur-3xl"
        :style="{ background: providerColors[cur.provider] }"
      />

      <template v-if="hasText">
        <p class="relative text-[11px] font-semibold uppercase tracking-[0.22em] text-white/60">這次要花</p>
        <p
          class="relative mt-1.5 font-mono text-[30px] font-bold leading-none tracking-tighter text-white [font-variant-numeric:tabular-nums]"
        >
          {{ range(yours) }}
        </p>
        <div class="relative mt-4 flex h-1 overflow-hidden rounded-full bg-white/20">
          <div class="h-full bg-[#5b9cf5]" :style="{ width: `${split.input}%` }" />
          <div class="h-full bg-[#2fc38c]" :style="{ width: `${split.output}%` }" />
        </div>
        <div class="relative mt-2.5 flex items-center justify-between text-[11px] text-white/65">
          <span><b class="font-mono text-white/80">{{ split.input.toFixed(0) }}%</b> 你的字</span>
          <span><b class="font-mono text-white/80">{{ split.output.toFixed(0) }}%</b> AI 回覆</span>
        </div>
      </template>

      <!-- 空狀態也要有內容：講這個模型的單價與行情落差 -->
      <template v-else>
        <p class="relative text-[11px] font-semibold uppercase tracking-[0.22em] text-white/60">目前選擇</p>
        <p class="relative mt-1.5 text-[24px] font-bold leading-tight tracking-tight text-white">{{ cur.name }}</p>
        <div class="relative mt-3.5 grid grid-cols-2 gap-2.5">
          <div class="rounded-xl bg-white/[0.06] px-3 py-2.5">
            <p class="text-[10px] uppercase tracking-[0.14em] text-white/40">input</p>
            <p class="mt-0.5 font-mono text-[17px] font-bold text-white">{{ per1m(cur.input_per_1m) }}</p>
          </div>
          <div class="rounded-xl bg-white/[0.06] px-3 py-2.5">
            <p class="text-[10px] uppercase tracking-[0.14em] text-white/40">output</p>
            <p class="mt-0.5 font-mono text-[17px] font-bold text-white">{{ per1m(cur.output_per_1m) }}</p>
          </div>
        </div>
        <p class="relative mt-3 text-[11px] text-white/40">每 1M tokens · 貼上 prompt 後換算成實際花費</p>
      </template>

      <div class="relative mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-[12px]">
        <span class="flex items-center gap-2 text-white/80">
          <span class="h-1.5 w-1.5 rounded-full" :style="{ background: providerColors[cur.provider] }" />
          {{ hasText ? cur.name : `效能 ${cur.perf_est ? '≈' : ''}${cur.perf}` }}
        </span>
        <span class="font-mono text-white/60">
          {{ hasText ? `${tokFmt(totalTokens)} tokens` : spread ? `全站最貴是最便宜的 ${spread}×` : '' }}
        </span>
      </div>
    </section>

    <!-- 兩格重點：做成並排小塊，跟主卡裡的 input/output 方塊同一套語彙。
         原本兩張大卡各佔一整列，空太多也太重 -->
    <div v-if="hasText" class="mt-3.5 grid grid-cols-2 gap-3">
      <div
        v-if="best && bestSavePct > 5"
        class="rounded-2xl border border-[#d8ece1] bg-[#f4fbf7] px-4 py-3.5"
      >
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#0f9d6e]">換模型最省</p>
        <p class="mt-1.5 font-mono text-[26px] font-bold leading-none tracking-tighter text-[#0f9d6e]">
          {{ bestSavePct.toFixed(0) }}<span class="text-[15px]">%</span>
        </p>
        <p class="mt-1.5 truncate text-[12px] font-semibold text-[#1d2129]">{{ best.m.name }}</p>
      </div>

      <div v-if="topPlan" class="rounded-2xl border border-[#dbe6f6] bg-[#f5f8fd] px-4 py-3.5">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#3b7fe0]">
          {{ topPlan.plan.name }}
        </p>
        <p class="mt-1.5 font-mono text-[26px] font-bold leading-none tracking-tighter text-[#3b7fe0]">
          {{ topPlan.q.toLocaleString('en-US') }}
        </p>
        <p class="mt-1.5 text-[12px] font-semibold text-[#1d2129]">
          次/天<span class="ml-1 font-normal text-[#8b93a0]"
            >一則 {{ topPlan.pct < 0.1 ? '<0.1' : topPlan.pct.toFixed(1) }}%</span
          >
        </p>
      </div>
    </div>

    <!-- 完整比較：一律攤開，這是這一頁的主體 -->
    <section class="mt-7">
      <div class="flex items-baseline gap-3">
        <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b93a0]">
          {{ hasText ? '各模型成本' : '各模型單價' }}
        </p>
        <span class="h-px flex-1 bg-[#eae7de]" />
        <div v-if="hasText" class="flex shrink-0 overflow-hidden rounded-full bg-[#efece5] p-0.5">
          <button
            v-for="opt in [
              { id: 'cost' as const, label: '成本' },
              { id: 'tokens' as const, label: 'tokens' },
            ]"
            :key="opt.id"
            type="button"
            class="rounded-full px-2.5 py-0.5 text-[11px] transition"
            :class="unit === opt.id ? 'bg-white font-semibold text-[#1d2129] shadow-sm' : 'text-[#8b93a0]'"
            @click="unit = opt.id"
          >
            {{ opt.label }}
          </button>
        </div>
        <span v-else class="shrink-0 font-mono text-[11px] text-[#b6bcc7]">in / out · 1M</span>
      </div>

      <ul class="mt-3 space-y-3">
        <li v-for="r in rows" :key="r.m.id">
          <div class="flex items-baseline justify-between gap-3">
            <span class="flex min-w-0 items-center gap-2">
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                :style="{ background: providerColors[r.m.provider] }"
              />
              <span
                class="truncate text-[14px]"
                :class="r.m.id === cur.id ? 'font-bold text-[#1d2129]' : 'text-[#3c4250]'"
                >{{ r.m.name }}</span
              >
              <span v-if="r.m.free" class="shrink-0 text-[10px] font-semibold text-[#0f9d6e]">免費</span>
              <span v-else-if="r.m.id === cur.id" class="shrink-0 text-[10px] text-[#c26a54]">你用的</span>
            </span>
            <span
              class="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums"
              :class="r.m.id === cur.id ? 'font-bold text-[#1d2129]' : 'text-[#3c4250]'"
              >{{ rowValue(r) }}</span
            >
          </div>
          <div class="mt-1.5 flex items-center gap-2.5">
            <div class="h-[3px] flex-1 rounded-full bg-[#efece5]">
              <div
                class="h-full rounded-full transition-[width] duration-300"
                :style="{
                  width: `max(${(r.metric / maxMetric) * 100}%, 3px)`,
                  background: r.m.id === cur.id ? '#e8927c' : providerColors[r.m.provider],
                  opacity: r.m.id === cur.id ? 1 : 0.4,
                }"
              />
            </div>
            <span class="shrink-0 whitespace-nowrap text-[10px] text-[#b6bcc7]"
              >效能 <b class="font-mono tabular-nums">{{ r.m.perf_est ? '≈' : '' }}{{ r.m.perf }}</b></span
            >
          </div>
        </li>
      </ul>

      <button
        type="button"
        class="mt-4 w-full rounded-xl border border-[#eae7de] bg-white py-2.5 text-[13px] text-[#767e8c] transition active:scale-[0.99]"
        @click="pickerOpen = !pickerOpen"
      >
        選擇模型（{{ selectedIds.length }}/{{ models.length }}）{{ pickerOpen ? '收起' : '' }}
      </button>
      <div v-if="pickerOpen" class="mt-2 rounded-xl border border-[#eae7de] bg-white p-3">
        <div v-for="g in providerGroups" :key="g.provider" class="py-1">
          <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#b6bcc7]">
            {{ g.provider }}
          </p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="m in g.items"
              :key="m.id"
              type="button"
              class="rounded-full border px-2.5 py-1 text-[12px] transition"
              :class="
                selectedIds.includes(m.id)
                  ? 'border-[#0f9d6e]/40 bg-[#e7f6ef] text-[#0f9d6e]'
                  : 'border-[#eae7de] text-[#8b93a0]'
              "
              @click="toggleModel(m.id)"
            >
              {{ m.name }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 訂閱方案：也一律攤開 -->
    <section v-if="subPlans.length" class="mt-7">
      <div class="flex items-baseline gap-3">
        <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b93a0]">
          {{ cur.provider }} 訂閱方案
        </p>
        <span class="h-px flex-1 bg-[#eae7de]" />
        <span class="shrink-0 text-[11px] text-[#b6bcc7]">{{ hasText ? '能跑幾次/天' : '額度' }}</span>
      </div>
      <ul class="mt-3 divide-y divide-[#f2efe8] overflow-hidden rounded-2xl border border-[#eae7de] bg-white">
        <li
          v-for="s in subPlans"
          :key="s.plan.id"
          class="flex items-center justify-between gap-3 px-4 py-3"
        >
          <div class="min-w-0">
            <p class="truncate text-[14px] font-semibold text-[#1d2129]">{{ s.plan.name }}</p>
            <p class="text-[11px] text-[#a8aebb]">{{ s.plan.price }}</p>
          </div>
          <span v-if="hasText" class="flex shrink-0 items-baseline gap-3 text-right">
            <span v-if="dense" class="font-mono text-[12px] tabular-nums text-[#8b93a0]"
              >{{ s.pct < 0.1 ? '<0.1' : s.pct.toFixed(1) }}%<span class="text-[10px]">/則</span></span
            >
            <span>
              <b class="font-mono text-[17px] tabular-nums text-[#1d2129]">{{ s.q.toLocaleString('en-US') }}</b>
              <span class="ml-1 text-[11px] text-[#8b93a0]">次/天</span>
            </span>
          </span>
          <!-- 空狀態顯示方案本身的額度上限。note 是一整段說明文字，塞在這裡會溢出 -->
          <span v-else class="shrink-0 text-right">
            <template v-if="s.plan.daily_messages">
              <b class="font-mono text-[17px] tabular-nums text-[#1d2129]">{{ s.plan.daily_messages }}</b>
              <span class="ml-1 text-[11px] text-[#8b93a0]">則/天</span>
            </template>
            <span v-else class="text-[12px] text-[#a8aebb]">依 token 計</span>
          </span>
        </li>
      </ul>
    </section>

    <!-- 綜合版：怎麼省 -->
    <section v-if="dense && hasText && tips.length" class="mt-7">
      <div class="flex items-baseline gap-3">
        <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b93a0]">怎麼省</p>
        <span class="h-px flex-1 bg-[#eae7de]" />
      </div>
      <ul class="mt-3 space-y-2.5">
        <li v-for="t in tips" :key="t.title" class="rounded-2xl border border-[#eae7de] bg-white p-4">
          <div class="flex items-baseline justify-between gap-3">
            <span class="min-w-0 text-[14px] font-bold text-[#1d2129]">{{ t.title }}</span>
            <span class="shrink-0 rounded-full bg-[#e7f6ef] px-2 py-0.5 font-mono text-[11px] font-bold text-[#0f9d6e]"
              >{{ t.pct }}</span
            >
          </div>
          <p class="mt-1.5 text-[12.5px] leading-6 text-[#767e8c]">{{ t.desc }}</p>
        </li>
      </ul>
    </section>

    <p class="mt-6 px-1 text-[11px] leading-5 text-[#b6bcc7]">
      官方定價 {{ pricingUpdated }} · 效能為 Artificial Analysis 指數 · 成本為估算值
      <template v-if="dense && hasText"><br />假設 {{ assumption }}</template>
    </p>
  </main>
</template>
