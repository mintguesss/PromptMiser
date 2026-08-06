<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  OUTPUT_RATIO,
  models,
  plansForProvider,
  planShareForTokens,
  pricingUpdated,
  providerColors,
  useCostUnit,
  useSelectedModels,
  useTurns,
  type ModelPricing,
} from '../../composables/usePricing'
import {
  classifyScenario,
  conversationTotal,
  SCENARIOS,
  SELECTABLE_SCENARIOS,
  type Scenario,
} from '../../composables/useScenario'
import { stripProtectionMarkers, useTokenizer } from '../../composables/useTokenizer'
import type { UsageEstimate } from '../../types'

// 極簡版即時分析：計算邏輯與 AnalysisPanel 相同（估算流程見該檔註解），呈現重排為單屏雙欄
const props = defineProps<{
  currentModelId: string
  llmProfile: Scenario | null
  llmEstimate: UsageEstimate | null
}>()
const prompt = defineModel<string>({ required: true })

const { count } = useTokenizer()
const effectiveText = computed(() => stripProtectionMarkers(prompt.value))
const tokensO200k = computed(() => count(effectiveText.value, 'o200k_base'))
const tokensCl100k = computed(() => count(effectiveText.value, 'cl100k_base'))
const hasText = computed(() => effectiveText.value.trim().length > 0)
const charCount = computed(() => effectiveText.value.length)

const currentModelPricing = computed(
  () => models.find((m) => m.id === props.currentModelId) ?? models[0],
)

// ---- 消耗情境（關鍵字判定 → LLM 精算回填 → 可手動切換）----
const override = ref<'auto' | Scenario>('auto')
const llmConfirmed = ref(false)
const turns = useTurns()
const userSetTurns = ref(false)
const mappedLlmProfile = computed<Scenario | null>(() =>
  props.llmProfile === 'conversation' ? 'single' : props.llmProfile,
)
watch(prompt, () => {
  override.value = 'auto'
  llmConfirmed.value = false
  turns.value = 1
  userSetTurns.value = false
})
watch(mappedLlmProfile, (p) => {
  if (p) {
    override.value = p
    llmConfirmed.value = true
  }
})
watch(
  () => props.llmProfile,
  (p) => {
    if (p === 'conversation' && !userSetTurns.value) turns.value = Math.max(turns.value, 8)
  },
)

const promptTokens = computed(() => {
  const tokens = tokensO200k.value ?? Math.ceil(effectiveText.value.length * 0.7)
  return Math.max(tokens, 1)
})

const estimate = computed(() => {
  const N = Math.max(turns.value, 1)
  if (llmConfirmed.value && props.llmEstimate && override.value === mappedLlmProfile.value) {
    const e = props.llmEstimate
    const isAgent = mappedLlmProfile.value === 'agent'
    const perInLo = promptTokens.value + e.context_overhead_min
    const perInHi = promptTokens.value + e.context_overhead_max
    const [inLo, outLo] =
      !isAgent && N > 1 ? conversationTotal(perInLo, e.expected_output_min, N) : [perInLo, e.expected_output_min]
    const [inHi, outHi] =
      !isAgent && N > 1 ? conversationTotal(perInHi, e.expected_output_max, N) : [perInHi, e.expected_output_max]
    return {
      scenario: mappedLlmProfile.value!,
      signals: e.reason ? [e.reason] : [],
      taskLabel: 'LLM 精算',
      inputRange: [Math.round(inLo), Math.round(inHi)] as [number, number],
      outputRange: [Math.round(outLo), Math.round(outHi)] as [number, number],
      reliable: !isAgent,
      suggestedTurns: 1,
      calls: [e.calls_min, e.calls_max] as [number, number],
    }
  }
  const h = classifyScenario(
    effectiveText.value,
    promptTokens.value,
    override.value === 'auto' ? undefined : override.value,
    { turns: N },
  )
  return { ...h, calls: [1, 1] as [number, number] }
})
const scenarioInfo = computed(() => SCENARIOS[estimate.value.scenario])
const isLLMRefined = computed(() => estimate.value.taskLabel === 'LLM 精算')
watch(
  () => estimate.value.suggestedTurns,
  (st) => {
    if (!userSetTurns.value && st > 1 && turns.value === 1) turns.value = st
  },
  { immediate: true },
)

// ---- 成本表（勾選/單位切換與現行畫面共用同一份狀態）----
const selectedModelIds = useSelectedModels()
const unit = useCostUnit()
const pickerOpen = ref(false)
const providerGroups = computed(() => {
  const seen = new Map<string, ModelPricing[]>()
  for (const m of models) {
    if (!seen.has(m.provider)) seen.set(m.provider, [])
    seen.get(m.provider)!.push(m)
  }
  return [...seen.entries()].map(([provider, items]) => ({ provider, items }))
})
function toggleModel(id: string) {
  const list = selectedModelIds.value
  selectedModelIds.value = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
}

interface Row {
  m: ModelPricing
  costLo: number
  costHi: number
  tokLo: number
  tokHi: number
  metric: number
  assumption: string
}
const rows = computed<Row[]>(() => {
  const e = estimate.value
  const baseTok = Math.max(promptTokens.value, 1)
  const assumption = `假設 input ${e.inputRange[0].toLocaleString()}–${e.inputRange[1].toLocaleString()}、output ${e.outputRange[0].toLocaleString()}–${e.outputRange[1].toLocaleString()} tokens × ${e.calls[0]}–${e.calls[1]} 次呼叫（${e.taskLabel}｜${scenarioInfo.value.label}）`
  return models
    .filter((m) => selectedModelIds.value.includes(m.id))
    .map((m) => {
      const encTok = (m.encoding === 'cl100k_base' ? tokensCl100k.value : tokensO200k.value) ?? baseTok
      const ratio = encTok / baseTok
      const verb = m.verbosity ?? 1
      const outLo = e.outputRange[0] * verb
      const outHi = e.outputRange[1] * verb
      const costLo = hasText.value
        ? ((e.inputRange[0] * m.input_per_1m + outLo * m.output_per_1m) / 1_000_000) * e.calls[0]
        : 0
      const costHi = hasText.value
        ? ((e.inputRange[1] * m.input_per_1m + outHi * m.output_per_1m) / 1_000_000) * e.calls[1]
        : 0
      const tokLo = hasText.value ? (e.inputRange[0] * ratio + outLo) * e.calls[0] : 0
      const tokHi = hasText.value ? (e.inputRange[1] * ratio + outHi) * e.calls[1] : 0
      return { m, costLo, costHi, tokLo, tokHi, metric: unit.value === 'tokens' ? tokHi : costHi, assumption }
    })
    .sort((a, b) => a.metric - b.metric)
})
// 手機版：表格改單行、預設只列前幾個（含「你用的」），避免整頁被 20 個模型撐長
const isMobile = ref(false)
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(max-width: 639px)')
  isMobile.value = mq.matches
  mq.addEventListener('change', (e) => (isMobile.value = e.matches))
}
const showAllModels = ref(false)
// 手機：情境切換與輪數拉桿預設收起來。多數人不會動它們，
// 全部攤在上面會讓第一屏擠滿控制項，看不到重點。
const controlsOpen = ref(false)
const hintOpen = ref(false)
const MOBILE_ROWS = 5
const visibleRows = computed(() => {
  if (!isMobile.value || showAllModels.value || rows.value.length <= MOBILE_ROWS + 1) {
    return rows.value
  }
  const top = rows.value.slice(0, MOBILE_ROWS)
  // 「你用的」不管排第幾都要看得到，否則使用者找不到自己的模型
  const current = rows.value.find((r) => r.m.id === props.currentModelId)
  return current && !top.includes(current) ? [...top, current] : top
})
const hiddenCount = computed(() => rows.value.length - visibleRows.value.length)

const maxMetric = computed(() => Math.max(...rows.value.map((r) => r.metric), 1e-12))
const minMetric = computed(() => Math.min(...rows.value.map((r) => r.metric)))
const hasSpread = computed(() => hasText.value && rows.value.length >= 2 && minMetric.value !== maxMetric.value)

function rowMark(r: Row): { label: string; cls: string } | null {
  if (r.m.id === props.currentModelId) return { label: '你用的', cls: 'text-[#c26a54]' }
  if (r.m.free) return { label: '免費', cls: 'text-emerald-600 font-semibold' }
  if (hasSpread.value && r.metric === minMetric.value) return { label: '最省', cls: 'text-emerald-600 font-semibold' }
  if (hasSpread.value && r.metric === maxMetric.value) return { label: '最貴', cls: 'text-[#c26a54]' }
  return null
}
function fmtCost(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return '$' + v.toFixed(4)
  if (v < 1) return '$' + v.toFixed(3)
  return '$' + v.toFixed(2)
}
function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K'
  return Math.round(n).toLocaleString('en-US')
}
function rangeText(r: Row): string {
  if (!hasText.value) return '—'
  if (unit.value === 'tokens') {
    const pre = r.m.provider !== 'OpenAI' ? '≈' : ''
    return Math.round(r.tokLo) === Math.round(r.tokHi)
      ? `${pre}${fmtTok(r.tokHi)}`
      : `${pre}${fmtTok(r.tokLo)}–${fmtTok(r.tokHi)}`
  }
  return r.costLo === r.costHi ? fmtCost(r.costLo) : `${fmtCost(r.costLo)}–${fmtCost(r.costHi)}`
}

// ---- 大字結論（不依賴勾選清單：你用的模型直接算、最省從勾選中挑） ----
function modelCostRange(m: ModelPricing): { lo: number; hi: number } {
  const e = estimate.value
  const verb = m.verbosity ?? 1
  return {
    lo: ((e.inputRange[0] * m.input_per_1m + e.outputRange[0] * verb * m.output_per_1m) / 1_000_000) * e.calls[0],
    hi: ((e.inputRange[1] * m.input_per_1m + e.outputRange[1] * verb * m.output_per_1m) / 1_000_000) * e.calls[1],
  }
}
const yourCost = computed(() => (hasText.value ? modelCostRange(currentModelPricing.value) : null))
const bestRow = computed(() => {
  const cands = rows.value.filter((r) => !r.m.free && r.m.id !== props.currentModelId)
  return cands.length ? [...cands].sort((a, b) => a.costHi - b.costHi)[0] : null
})
/** 這次的錢有多少比例花在你的字上（其餘是 AI 回覆） */
const inShare = computed(() => {
  const m = currentModelPricing.value
  const e = estimate.value
  const i = e.inputRange[1] * m.input_per_1m
  const o = e.outputRange[1] * (m.verbosity ?? 1) * m.output_per_1m
  return (i / (i + o || 1)) * 100
})
const bestSavePct = computed(() =>
  yourCost.value && bestRow.value && yourCost.value.hi > 0
    ? (1 - bestRow.value.costHi / yourCost.value.hi) * 100
    : 0,
)

// 多輪 caching 一行摘要（跟現行畫面同公式：歷史 0.1× 讀取 + 1.25× 寫入溢價）
const convSummary = computed(() => {
  if (!hasText.value || turns.value <= 1) return null
  const U = promptTokens.value
  const N = turns.value
  const grow = U * (1 + OUTPUT_RATIO)
  const totalInput = (grow * N * (N - 1)) / 2 + U * N
  const totalOutput = U * OUTPUT_RATIO * N
  const inR = currentModelPricing.value.input_per_1m / 1_000_000
  const outR = currentModelPricing.value.output_per_1m / 1_000_000
  const noCache = totalInput * inR + totalOutput * outR
  const cache = (1.25 * grow * N + 0.1 * ((grow * N * (N - 1)) / 2)) * inR + totalOutput * outR
  return {
    totalTokens: totalInput + totalOutput,
    noCache,
    cache,
    savePct: noCache > 0 ? (1 - cache / noCache) * 100 : 0,
  }
})

// ---- 訂閱 strip（依你用的模型的提供商）----
const subPlans = computed(() => {
  const e = estimate.value
  const perQueryHi = (e.inputRange[1] + e.outputRange[1] * (currentModelPricing.value.verbosity ?? 1)) * e.calls[1]
  return plansForProvider(currentModelPricing.value.provider)
    .slice(0, 3)
    .map((p) => {
      const share = planShareForTokens(perQueryHi, p)
      return { plan: p, pct: share.pct, q: share.pct > 0 ? Math.floor(100 / share.pct) : 0 }
    })
})
function fmtPct(pct: number): string {
  if (pct < 0.1) return '<0.1'
  if (pct >= 100) return '100'
  return pct.toFixed(1)
}

// ---- 怎麼省（規則版，按壓縮後右邊會有 LLM 版建議）----
const outputCostShare = computed(() => {
  const e = estimate.value
  const m = currentModelPricing.value
  const inC = e.inputRange[1] * m.input_per_1m
  const outC = e.outputRange[1] * (m.verbosity ?? 1) * m.output_per_1m
  const s = inC + outC
  return s > 0 ? (outC / s) * 100 : 0
})
const tips = computed(() => {
  const list: { pct: string; title: string; desc: string }[] = []
  if (bestRow.value && bestSavePct.value > 5) {
    list.push({
      pct: `-${bestSavePct.value.toFixed(0)}%`,
      title: `換到 ${bestRow.value.m.name}`,
      desc: `效能 ${bestRow.value.m.perf_est ? '≈' : ''}${bestRow.value.m.perf}，單價只有 ${currentModelPricing.value.name} 的一小部分。`,
    })
  }
  if (estimate.value.scenario === 'agent') {
    list.push({
      pct: '⚠️',
      title: '這是一整包工作',
      desc: '消耗由 AI 自己呼叫工具的次數決定，同一件事跑兩次可能差 5–10 倍，區間僅為量級參考。',
    })
  } else if (estimate.value.scenario === 'search') {
    list.push({
      pct: '🔍',
      title: '搜尋回填才是大頭',
      desc: '搜尋結果全文會塞回 context，實際 input 遠大於你貼的文字。',
    })
  } else if (turns.value > 1) {
    list.push({
      pct: '-50%+',
      title: '換新主題就開新對話',
      desc: '每輪都重送整段歷史，長對話的消耗以 O(N²) 成長。',
    })
  } else {
    list.push({
      pct: '-25%',
      title: '固定說明開 caching',
      desc: '重複呼叫的固定段落開 prompt caching，之後只收約 10% 費用。',
    })
  }
  list.push({
    pct: `-${Math.min(Math.round(outputCostShare.value / 2), 60)}%`,
    title: '限制回覆長度',
    desc: `這類任務 output 佔成本約 ${outputCostShare.value.toFixed(0)}%，加「請精簡回答」最有感。`,
  })
  return list.slice(0, 3)
})
</script>

<template>
  <main class="mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 grid-cols-1 gap-x-12 gap-y-5 px-4 py-3.5 sm:gap-y-6 sm:px-8 sm:py-5 lg:grid-cols-12 lg:content-start lg:overflow-y-auto">
    <!-- 手機：contents 讓下面兩塊變成 main 的直接項目，才能用 order 重排；桌機：一般直欄 -->
    <div class="contents lg:flex lg:min-h-0 lg:flex-col lg:col-span-5">
    <section class="order-1 flex min-h-0 flex-col lg:flex-1">
      <p class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">
        <span class="shrink-0">你的 Prompt</span>
        <!-- 用法說明收在問號裡，不要一直佔著輸入框 -->
        <button
          type="button"
          class="grid h-4 w-4 place-items-center rounded-full border border-[#cfcabb] text-[10px] leading-none text-[#8b93a0] transition hover:border-[#8b93a0] hover:text-[#1d2129]"
          :class="hintOpen ? 'border-[#8b93a0] bg-[#f2f0ea] text-[#1d2129]' : ''"
          aria-label="用法說明"
          @click="hintOpen = !hintOpen"
        >
          ?
        </button>
        <span v-if="hintOpen" class="font-normal normal-case tracking-normal text-[#8b93a0]">
          用 <code class="font-mono text-[#5c626e]">[[ ]]</code> 包住的段落壓縮時不會被改
        </span>
        <span v-else class="ml-1 h-px flex-1 bg-[#e4e1d8]" />
      </p>
      <textarea
        v-model="prompt"
        rows="3"
        placeholder="貼上你要送給 AI 的問題或指令…"
        class="mt-2 max-h-56 min-h-24 w-full resize-y rounded-lg lg:max-h-none lg:min-h-0 lg:flex-1 border border-[#eae7de] bg-[#fdfcf8] p-3 font-mono text-[13px] leading-6 text-[#3c4250] placeholder:text-[#99a0ac] focus:outline-2 focus:outline-emerald-400 sm:min-h-36 sm:p-4"
      />
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-[#767e8c]">
        <span><b class="font-mono text-[#1d2129]">{{ (tokensO200k ?? 0).toLocaleString('en-US') }}</b> tokens · 約 {{ charCount }} 字</span>
        <span class="rounded-full px-2.5 py-1 text-xs" :class="isLLMRefined ? 'bg-emerald-100 text-emerald-700' : 'bg-[#f2f0ea]'"
          >{{ isLLMRefined ? '🤖 AI 精算' : '⚡ 規則估算' }}</span
        >
        <!-- 判定依據（可被打臉，所以秀出來） -->
        <span
          v-for="sig in estimate.signals.slice(0, 1)"
          :key="sig"
          class="hidden max-w-56 truncate rounded-full bg-[#f2f0ea] px-2.5 py-1 text-xs text-[#8b93a0] sm:inline"
          :title="sig"
          >{{ sig }}</span
        >
        <!-- 情境切換：目前判定結果直接標在按鈕上（深色=你手動選的、淺綠=自動判定的），
             不再另外放一顆重複的情境 chip -->
        <!-- 手機：控制項收在「調整」後面，第一屏只留 token 數與判定結果 -->
        <button
          type="button"
          class="ml-auto rounded-full bg-[#f2f0ea] px-2.5 py-1 text-xs text-[#767e8c] transition sm:hidden"
          @click="controlsOpen = !controlsOpen"
        >
          調整 {{ controlsOpen ? '▴' : '▾' }}
        </button>
        <span class="flex gap-1 text-xs max-sm:hidden" :class="controlsOpen ? 'max-sm:!flex max-sm:mt-1 max-sm:w-full' : ''">
          <button
            type="button"
            class="rounded-full px-2 py-1 transition sm:px-2.5"
            :class="override === 'auto' ? 'bg-[#1d2129] text-white' : 'bg-[#f2f0ea] hover:bg-[#e8e6e0]'"
            title="依 prompt 內容自動判定"
            @click="override = 'auto'; llmConfirmed = false"
          >
            自動
          </button>
          <button
            v-for="sid in SELECTABLE_SCENARIOS"
            :key="sid"
            type="button"
            class="rounded-full px-2 py-1 transition sm:px-2.5"
            :class="
              override === sid
                ? 'bg-[#1d2129] text-white'
                : estimate.scenario === sid
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-[#f2f0ea] hover:bg-[#e8e6e0]'
            "
            :title="SCENARIOS[sid].note"
            @click="override = sid; llmConfirmed = false"
          >
            {{ SCENARIOS[sid].icon }}
            <span class="sm:hidden">{{ SCENARIOS[sid].short }}</span>
            <span class="hidden sm:inline">{{ SCENARIOS[sid].label }}</span>
          </button>
        </span>
      </div>

      <!-- 輪數（手機跟情境切換一起收在「調整」後面） -->
      <div
        class="mt-3 items-center gap-3 text-[13px] text-[#767e8c] sm:flex"
        :class="controlsOpen ? 'flex' : 'hidden'"
      >
        <span class="shrink-0">對話輪數</span>
        <input
          :value="turns"
          type="range"
          min="1"
          max="50"
          step="1"
          :disabled="estimate.scenario === 'agent'"
          class="h-1 flex-1 accent-emerald-500"
          :class="estimate.scenario === 'agent' ? 'cursor-not-allowed opacity-30' : 'cursor-pointer'"
          @input="turns = Number(($event.target as HTMLInputElement).value); userSetTurns = true"
        />
        <span class="w-12 text-right font-mono text-sm font-semibold tabular-nums text-[#1d2129]">{{ turns }} 輪</span>
        <span
          v-if="estimate.scenario === 'agent'"
          class="rounded-full bg-[#f2f0ea] px-2 py-0.5 text-[11px] text-[#8b93a0]"
          title="整包工作的消耗由工具呼叫輪數決定，跟對話輪數無關，所以拉桿不影響數據"
          ><span class="sm:hidden">不看輪數</span><span class="hidden sm:inline">整包工作不看輪數</span></span
        >
        <span v-else-if="turns > 1" class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">整段累積</span>
      </div>
      <!-- 多輪時的 caching 摘要 -->
      <p v-if="convSummary && estimate.scenario !== 'agent'" class="mt-1.5 text-xs leading-5 text-[#8b93a0]">
        整段 ≈ <b class="font-mono text-[#5c626e]">{{ fmtTok(convSummary.totalTokens) }}</b> tokens ·
        {{ currentModelPricing.name }} 不開 caching
        <b class="font-mono text-[#c26a54]">{{ fmtCost(convSummary.noCache) }}</b> / 開
        <b class="font-mono text-emerald-600">{{ fmtCost(convSummary.cache) }}</b>（省
        {{ convSummary.savePct.toFixed(0) }}%）
      </p>

      <!-- 大字結論／歡迎語：手機排到輸入框上方（一打開就看到重點），桌機維持在結論位置 -->
      <!-- 結論卡：夢幻漸層深色塊。手機把整頁最重要的三件事集中在這裡——
           花多少、用量多少、換誰能省。刻意壓縮內距，不要卡片版那種大塊頭。 -->
      <div class="order-first mb-3 lg:order-first lg:mb-5 lg:mt-0">
        <template v-if="hasText && yourCost">
          <div
            class="relative overflow-hidden rounded-[18px] px-4 py-3.5 ring-1 ring-inset ring-white/70 shadow-[0_4px_14px_-8px_rgba(80,70,140,0.35)] lg:hidden"
            style="background: linear-gradient(135deg, #e9edff 0%, #f2eaff 46%, #e3f5f0 100%)"
          >
            <!-- 三團柔光疊出漸層的層次，單一線性漸層會顯得平 -->
            <div class="pointer-events-none absolute -left-8 -top-10 h-32 w-32 rounded-full bg-[#a78bfa] opacity-40 blur-2xl" />
            <div class="pointer-events-none absolute -bottom-12 right-6 h-28 w-28 rounded-full bg-[#5eead4] opacity-45 blur-2xl" />
            <div class="pointer-events-none absolute -right-10 top-0 h-24 w-24 rounded-full bg-[#f9a8d4] opacity-35 blur-2xl" />

            <div class="relative flex items-baseline justify-between gap-3">
              <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6f6a92]">這次要花</p>
              <p class="font-mono text-[12px] text-[#8b8aa6]">
                {{ fmtTok(estimate.inputRange[1] + estimate.outputRange[1]) }} tokens
              </p>
            </div>
            <p class="relative mt-1 font-mono text-[25px] font-bold leading-none tracking-tighter text-[#221f35]">
              {{ fmtCost(yourCost.lo)
              }}<template v-if="yourCost.hi !== yourCost.lo">–{{ fmtCost(yourCost.hi) }}</template>
            </p>

            <div class="relative mt-3 flex h-[3px] overflow-hidden rounded-full bg-white/70">
              <div class="h-full bg-[#6d8cf5]" :style="{ width: `${inShare}%` }" />
              <div class="h-full bg-[#16b98a]" :style="{ width: `${100 - inShare}%` }" />
            </div>
            <p class="relative mt-2 text-[12px] leading-[18px] text-[#6f6c8c]">
              這筆錢花在
              <b class="font-mono text-[#3b3757]">你的字 {{ inShare.toFixed(0) }}%</b> ·
              <b class="font-mono text-[#3b3757]">AI 回覆 {{ (100 - inShare).toFixed(0) }}%</b>
            </p>

            <!-- 換模型結論併進同一張卡，不另外開一塊 -->
            <div
              v-if="bestRow && bestSavePct > 5"
              class="relative mt-3 flex items-center justify-between gap-3 border-t border-[#221f35]/10 pt-2.5"
            >
              <span class="min-w-0 text-[13px] text-[#4c4869]">
                ⭐ 換 <b class="font-semibold text-[#221f35]">{{ bestRow.m.name }}</b>
              </span>
              <span class="shrink-0 font-mono text-[18px] font-bold leading-none tracking-tight text-[#0f9d6e]">
                省 {{ bestSavePct.toFixed(0) }}%
              </span>
            </div>
          </div>

          <!-- 桌機維持原本貼在背景上的大字排版 -->
          <div class="hidden lg:block">
            <h1 class="text-[24px] font-bold leading-snug tracking-tight">
              每次約
              <span class="border-b-4 border-emerald-300 font-mono">{{ fmtCost(yourCost.lo)
                }}<template v-if="yourCost.hi !== yourCost.lo">–{{ fmtCost(yourCost.hi) }}</template></span
              ><template v-if="bestRow && bestSavePct > 5"
                >，<br />換 {{ bestRow.m.name }} 省
                <span class="border-b-4 border-emerald-300 font-mono">{{ bestSavePct.toFixed(0) }}%</span></template
              >
            </h1>
            <p
              class="mt-3 text-sm leading-6 text-[#767e8c]"
              :title="`input ${estimate.inputRange[0].toLocaleString()}–${estimate.inputRange[1].toLocaleString()} · output ${estimate.outputRange[0].toLocaleString()}–${estimate.outputRange[1].toLocaleString()} tokens`"
            >
              預估
              <b class="font-mono text-[#1d2129]">{{ fmtTok(estimate.inputRange[1] + estimate.outputRange[1]) }}</b>
              tokens<template v-if="estimate.calls[1] > 1"> · {{ estimate.calls[0] }}–{{ estimate.calls[1] }} 次呼叫</template
              >{{ estimate.reliable ? '' : ' · 僅為量級' }}
            </p>
          </div>
        </template>

        <template v-else>
          <h1 class="text-[17px] font-bold leading-snug tracking-tight text-[#b3ae9f] sm:text-[24px]">
            貼上 prompt，<br class="hidden sm:inline" />馬上知道要花多少。
          </h1>
          <p class="mt-1 hidden text-xs leading-5 text-[#99a0ac] sm:mt-3 sm:block sm:text-sm sm:leading-7">
            即時 token 計算 · 23 個模型成本對比 · 一鍵壓縮省錢
          </p>
        </template>
      </div>

    </section>

    <!-- 怎麼省（直列式，跟訂閱方案交換位置） -->
    <div class="order-3 shrink-0 lg:mt-6">
      <p class="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]"><span class="shrink-0">怎麼省</span><span class="h-px flex-1 bg-[#e4e1d8]" /></p>
      <ul class="mt-2.5 divide-y divide-[#e7e3d9] overflow-hidden rounded-2xl border border-[#e7e3d9] bg-[#f6f4ef]">
        <li v-for="t in tips" :key="t.title" class="flex gap-3 px-3.5 py-3 sm:px-4">
          <!-- 省 % 做成方形徽章當視覺起點，比一條色軌有訊息量 -->
          <span
            class="mt-0.5 grid h-9 w-11 shrink-0 place-items-center rounded-[10px] bg-emerald-50 font-mono text-[12px] font-bold tabular-nums text-emerald-700 ring-1 ring-inset ring-emerald-100"
            >{{ t.pct }}</span
          >
          <div class="min-w-0 flex-1">
            <p class="truncate text-[13.5px] font-bold leading-5 text-[#1d2129] sm:text-sm">{{ t.title }}</p>
            <p class="mt-1 text-[12.5px] leading-5 text-[#8b93a0] sm:text-[13px]">{{ t.desc }}</p>
          </div>
        </li>
      </ul>
    </div>
    </div>
    <!-- 右：成本表 + 訂閱 -->
    <section class="order-2 flex min-h-0 flex-col lg:col-span-7">
      <!-- 這一行只留「選擇模型」。單位切換已經做進下方的欄位標題，
           定價日期移到表格下面的註腳，避免這裡三組東西擠在一起 -->
      <!-- 標題列：跟卡片版同一套——標題 + 延伸線 + segmented 切換，再加選擇模型 -->
      <div class="flex items-center gap-2.5">
        <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">各模型成本</p>
        <span class="h-px flex-1 bg-[#e4e1d8]" />
        <button
          type="button"
          class="shrink-0 rounded-full border border-[#eae7de] bg-white px-2.5 py-1 text-[11px] text-[#767e8c] transition active:scale-95"
          @click="pickerOpen = !pickerOpen"
        >
          選擇模型 {{ selectedModelIds.length }}/{{ models.length }}
        </button>
        <div class="flex shrink-0 overflow-hidden rounded-full bg-[#efece5] p-0.5">
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
      </div>

      <!-- 模型挑選（收合式） -->
      <div v-if="pickerOpen" class="mt-2 rounded-lg border border-[#eae7de] bg-[#fdfcf8] p-3">
        <div v-for="g in providerGroups" :key="g.provider" class="flex flex-wrap items-center gap-1.5 py-1">
          <span class="w-16 text-[10px] font-semibold uppercase text-[#767e8c]">{{ g.provider }}</span>
          <button
            v-for="m in g.items"
            :key="m.id"
            type="button"
            class="rounded-full border px-2.5 py-1 text-xs transition"
            :class="selectedModelIds.includes(m.id) ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-[#e8e6e0] text-[#767e8c] hover:border-[#b3ae9f]'"
            @click="toggleModel(m.id)"
          >
            {{ m.name }}
          </button>
        </div>
      </div>

      <!-- 欄位標題列：手機不需要（單位切換已移到區塊標題），只留桌機用 -->
      <div class="mt-2 hidden items-center gap-3 border-b border-[#e4e1d8] pb-1.5 text-[11px] text-[#8b93a0] sm:flex">
        <span class="w-2 shrink-0" />
        <span class="w-36 shrink-0">模型</span>
        <span class="min-w-16 flex-1 pl-1">相對{{ unit === 'tokens' ? '用量' : '成本' }}</span>
        <span class="w-[150px] shrink-0 text-right">{{ unit === 'tokens' ? '預估用量' : '成本/次' }}</span>
        <span class="w-9 shrink-0 text-right">效能</span>
        <span class="w-12 shrink-0" />
      </div>
      <!-- 桌機：模型多時表格內部捲動，不推開下面的內容；手機：整個展開，跟著頁面捲 -->
      <ul class="lg:max-h-[46vh] lg:overflow-y-auto lg:pr-1 lg:[&>li]:py-[13px]">
        <!-- 手機一列一行（不再雙行），桌機維持完整欄位 -->
        <li
          v-for="r in visibleRows"
          :key="r.m.id"
          class="border-b border-[#eeece6] py-2 sm:flex sm:items-center sm:gap-3 sm:py-[8px]"
        >
          <!-- 第一行：模型 / 效能 / 成本，三欄固定寬度所以會垂直對齊 -->
          <div class="flex items-baseline gap-2 sm:contents">
            <span
              class="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full sm:translate-y-0"
              :style="{ background: providerColors[r.m.provider] }"
              :title="r.m.provider"
            />
            <span class="flex min-w-0 flex-1 items-baseline gap-1.5 sm:w-36 sm:flex-none" :title="r.m.name">
              <span class="min-w-0 truncate text-[13.5px] sm:text-sm" :class="r.m.id === currentModelId ? 'font-semibold' : ''">{{ r.m.name }}</span>
              <span v-if="rowMark(r)" class="shrink-0 text-[10px] sm:hidden" :class="rowMark(r)?.cls">{{ rowMark(r)?.label }}</span>
            </span>
            <span class="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-[#99a0ac] sm:hidden"
              >{{ r.m.perf_est ? '≈' : '' }}{{ r.m.perf }}</span
            >
            <!-- 桌機的相對條 -->
            <div class="hidden h-1.5 rounded-full bg-[#f0eee8] sm:block sm:min-w-16 sm:w-auto sm:flex-1">
              <div
                class="h-full rounded-full"
                :style="{
                  width: hasText ? `max(${(r.metric / maxMetric) * 100}%, 4px)` : '0%',
                  background: r.m.id === currentModelId ? '#e8927c' : providerColors[r.m.provider],
                  opacity: r.m.id === currentModelId ? 1 : 0.45,
                }"
              />
            </div>
            <span
              class="w-[104px] shrink-0 whitespace-nowrap text-right font-mono text-[11.5px] font-semibold tabular-nums text-[#3c4250] sm:w-[150px] sm:text-sm"
              :class="r.m.id === currentModelId ? '!font-bold !text-[#1d2129]' : ''"
              :title="r.assumption"
              >{{ rangeText(r) }}</span
            >
            <span class="hidden w-9 shrink-0 text-right font-mono text-xs tabular-nums text-[#99a0ac] sm:block">{{ r.m.perf_est ? '≈' : '' }}{{ r.m.perf }}</span>
            <span class="hidden w-12 shrink-0 text-right text-xs sm:block" :class="rowMark(r)?.cls">{{ rowMark(r)?.label ?? '' }}</span>
          </div>
          <!-- 第二行（手機）：長條拉滿寬度，比擠在中間的小段清楚得多 -->
          <div class="mt-1.5 ml-4 h-[3px] rounded-full bg-[#f0eee8] sm:hidden">
            <div
              class="h-full rounded-full"
              :style="{
                width: hasText ? `max(${(r.metric / maxMetric) * 100}%, 3px)` : '0%',
                background: r.m.id === currentModelId ? '#e8927c' : providerColors[r.m.provider],
                opacity: r.m.id === currentModelId ? 1 : 0.45,
              }"
            />
          </div>
        </li>
        <li v-if="!rows.length" class="py-6 text-center text-xs text-[#99a0ac]">至少選一個模型才能比較成本</li>
      </ul>
      <!-- 手機收合：預設只列最省的幾個 + 你用的 -->
      <button
        v-if="hiddenCount > 0 || (isMobile && showAllModels && rows.length > MOBILE_ROWS + 1)"
        type="button"
        class="mt-1 w-full rounded-lg border border-[#e9e6dd] py-1.5 text-xs text-[#767e8c] sm:hidden"
        @click="showAllModels = !showAllModels"
      >
        {{ showAllModels ? '收合' : `顯示其餘 ${hiddenCount} 個模型` }}
      </button>
      <!-- 手機沒有滑鼠停留，也不需要整段說明；只留一句 -->
      <p class="mt-2 text-[11px] leading-5 text-[#8b93a0]">
        <span class="sm:hidden">官方定價 {{ pricingUpdated }} · 效能為 Artificial Analysis 指數</span>
        <span class="hidden sm:inline"
          >官方定價 {{ pricingUpdated }} · 效能為 Artificial Analysis 指數（≈ 估算）· 滑鼠停留數字看假設</span
        >
      </p>

      <!-- 訂閱方案（跟怎麼省交換位置；進度條 = 一則佔每日額度）
           手機拉開跟成本表的距離，兩塊才不會黏成一團 -->
      <div class="mt-9 shrink-0 sm:mt-6">
        <p class="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">
          <span class="shrink-0"
            >💳 訂閱方案 ·
            <span class="normal-case tracking-normal">{{ currentModelPricing.provider }}</span></span
          >
          <span class="h-px flex-1 bg-[#e4e1d8]" />
          <span class="shrink-0 font-normal normal-case tracking-normal text-[#b3ae9f]">額度為估算</span>
        </p>
        <div
          v-if="subPlans.length"
          class="mt-2.5 divide-y divide-[#e7e3d9] overflow-hidden rounded-2xl border border-[#e7e3d9] bg-[#f6f4ef]"
        >
          <!-- 手機只留「方案名 + 一天能跑幾次」兩欄，佔比放到名稱下面當註解 -->
          <div v-for="s in subPlans" :key="s.plan.id" class="flex items-center gap-2.5 px-3.5 py-3 sm:gap-3 sm:px-4 lg:py-3.5">
            <div class="min-w-0 flex-1 sm:w-32 sm:flex-none">
              <b class="block truncate text-[14px] text-[#1d2129]" :title="s.plan.note">{{ s.plan.name }}</b>
              <span class="font-mono text-[11px] tabular-nums text-[#a8aebb] sm:hidden"
                >一則佔 {{ hasText ? fmtPct(s.pct) : '—' }}%</span
              >
            </div>
            <span class="hidden shrink-0 text-xs text-[#8b93a0] sm:block sm:w-16">{{ s.plan.price }}</span>
            <div class="hidden h-1.5 max-w-52 flex-1 rounded-full bg-white/80 sm:block" :title="`一則約佔每日額度 ${fmtPct(s.pct)}%`">
              <div
                class="h-full rounded-full bg-[#3987e5]"
                :style="{ width: hasText ? `max(${Math.min(s.pct, 100)}%, 3px)` : '0%' }"
              />
            </div>
            <span class="hidden shrink-0 text-right font-mono tabular-nums text-[#1d2129] sm:block sm:w-20 sm:text-sm"
              >{{ hasText ? fmtPct(s.pct) : '—' }}%<span class="text-xs text-[#8b93a0]">/則</span></span
            >
            <span
              class="shrink-0 whitespace-nowrap rounded-[10px] bg-emerald-50 px-2.5 py-1.5 text-right ring-1 ring-inset ring-emerald-100 sm:w-24 sm:bg-transparent sm:px-0 sm:py-0 sm:ring-0"
              ><b class="font-mono text-[15px] font-bold tabular-nums text-emerald-700 sm:text-sm sm:text-[#1d2129]">{{
                hasText ? s.q.toLocaleString('en-US') : '—'
              }}</b>
              <span class="text-[11px] text-emerald-700/70 sm:text-sm sm:text-[#8b93a0]">次/天</span></span
            >
          </div>
        </div>
        <p v-else class="mt-2 rounded-xl border border-[#e9e6dd] bg-[#f5f3ed] px-4 py-3 text-sm text-[#5c626e]">
          {{ currentModelPricing.provider }} 無主流訂閱方案，屬 API 按量計價——看上方每次成本即可。
        </p>
      </div>
    </section>
  </main>
</template>
