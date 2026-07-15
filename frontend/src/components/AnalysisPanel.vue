<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { stripProtectionMarkers, useTokenizer } from '../composables/useTokenizer'
import {
  OUTPUT_RATIO,
  models,
  plans,
  planShareForTokens,
  pricingUpdated,
  subscriptionDisclaimer,
  useSelectedModels,
  useSelectedPlans,
  useTurns,
} from '../composables/usePricing'
import {
  classifyScenario,
  conversationTotal,
  SCENARIOS,
  SELECTABLE_SCENARIOS,
  type Scenario,
  type ScenarioEstimate,
} from '../composables/useScenario'
import type { UsageEstimate } from '../types'
import ModelPicker from './ModelPicker.vue'
import ModelSelector from './ModelSelector.vue'
import CostTable, { type CostRow } from './CostTable.vue'

const props = defineProps<{
  prompt: string
  currentModelId: string
  /** 按過壓縮後，LLM 判定的消耗情境（校正關鍵字判定） */
  llmProfile: Scenario | null
  /** LLM 精算的消耗數字（比關鍵字規則準，優先採用） */
  llmEstimate: UsageEstimate | null
}>()

const { count } = useTokenizer()

const effectiveText = computed(() => stripProtectionMarkers(props.prompt))
const tokensO200k = computed(() => count(effectiveText.value, 'o200k_base'))
const tokensCl100k = computed(() => count(effectiveText.value, 'cl100k_base'))

const currentModelPricing = computed(
  () => models.find((m) => m.id === props.currentModelId) ?? models[0],
)

// ---- 消耗情境（關鍵字即時判定 → LLM 精算回填 → 可手動切換） ----
const override = ref<'auto' | Scenario>('auto')
const llmConfirmed = ref(false)
// 輪數（全站共用）：1 = 單次提問，拉高 = 整段 N 輪對話的累積消耗
const turns = useTurns()
const userSetTurns = ref(false) // 使用者是否手動調過輪數

// 後端 consumption_profile 若是 conversation，不當任務型態——映射成 single（多輪是輪數維度）
const mappedLlmProfile = computed<Scenario | null>(() =>
  props.llmProfile === 'conversation' ? 'single' : props.llmProfile,
)

watch(
  () => props.prompt,
  () => {
    override.value = 'auto'
    llmConfirmed.value = false
    turns.value = 1
    userSetTurns.value = false
  },
)
watch(mappedLlmProfile, (p) => {
  if (p) {
    override.value = p
    llmConfirmed.value = true
  }
})
// LLM 判定為多輪對話 → 把預設輪數拉高（輪數維度，不改情境）
watch(
  () => props.llmProfile,
  (p) => {
    if (p === 'conversation' && !userSetTurns.value) turns.value = Math.max(turns.value, 8)
  },
)

const promptTokens = computed(() => {
  // tokenizer 還在載入時用字數粗估（中文 o200k 約 0.7 token/字）
  const tokens = tokensO200k.value ?? Math.ceil(effectiveText.value.length * 0.7)
  return Math.max(tokens, 1)
})

const estimate = computed<ScenarioEstimate & { calls: [number, number] }>(() => {
  const N = Math.max(turns.value, 1)

  // LLM 精算優先（除非使用者手動切到別的情境）
  if (llmConfirmed.value && props.llmEstimate && override.value === mappedLlmProfile.value) {
    const e = props.llmEstimate
    const isAgent = mappedLlmProfile.value === 'agent'
    const perInLo = promptTokens.value + e.context_overhead_min
    const perInHi = promptTokens.value + e.context_overhead_max
    const perOutLo = e.expected_output_min
    const perOutHi = e.expected_output_max
    // 多輪 → 整段累積（agent 除外）
    const [inLo, outLo] = !isAgent && N > 1 ? conversationTotal(perInLo, perOutLo, N) : [perInLo, perOutLo]
    const [inHi, outHi] = !isAgent && N > 1 ? conversationTotal(perInHi, perOutHi, N) : [perInHi, perOutHi]
    return {
      scenario: mappedLlmProfile.value!,
      signals: e.reason ? [e.reason] : [],
      taskLabel: 'LLM 精算',
      inputRange: [Math.round(inLo), Math.round(inHi)],
      outputRange: [Math.round(outLo), Math.round(outHi)],
      reliable: !isAgent,
      suggestedTurns: 1,
      calls: [e.calls_min, e.calls_max],
    }
  }
  const h = classifyScenario(
    effectiveText.value,
    promptTokens.value,
    override.value === 'auto' ? undefined : override.value,
    { turns: N },
  )
  return { ...h, calls: [1, 1] }
})

const scenarioInfo = computed(() => SCENARIOS[estimate.value.scenario])

// 依判定建議的預設輪數自動帶入（使用者沒手動調過才動）
watch(
  () => estimate.value.suggestedTurns,
  (st) => {
    if (!userSetTurns.value && st > 1 && turns.value === 1) turns.value = st
  },
  { immediate: true },
)
const isLLMRefined = computed(() => estimate.value.taskLabel === 'LLM 精算')

// 資料來源標示：定價一律官方查證，用量估算分「即時規則」與「AI 精算」兩級
const usageSource = computed(() =>
  isLLMRefined.value
    ? { label: '🤖 AI 精算', cls: 'bg-save/15 text-save' }
    : { label: '⚡ 規則估算', cls: 'bg-panel-2 text-txt-dim' },
)

const scenarioToneClass = computed(() => {
  switch (scenarioInfo.value.tone) {
    case 'warn':
      return 'border-amber-400/35 bg-amber-400/10 text-amber-200'
    case 'danger':
      return 'border-red-400/35 bg-red-400/10 text-red-300'
    case 'info':
      return 'border-blue-400/35 bg-blue-400/10 text-blue-300'
    default:
      return 'border-green-400/35 bg-green-400/10 text-green-300'
  }
})

// 多輪對話的一行式 caching 摘要（獨立列，隨輪數拉桿即時更新）
const convSummary = computed(() => {
  if (!props.prompt.trim()) return null
  const U = promptTokens.value
  const N = turns.value
  const grow = U * (1 + OUTPUT_RATIO)
  const totalInput = (grow * N * (N - 1)) / 2 + U * N
  const totalOutput = U * OUTPUT_RATIO * N
  const inR = currentModelPricing.value.input_per_1m / 1_000_000
  const outR = currentModelPricing.value.output_per_1m / 1_000_000
  const noCache = totalInput * inR + totalOutput * outR
  const cache = (1.25 * grow * N + 0.1 * (grow * N * (N - 1)) / 2) * inR + totalOutput * outR
  return {
    totalTokens: totalInput + totalOutput,
    noCache,
    cache,
    savePct: noCache > 0 ? (1 - cache / noCache) * 100 : 0,
  }
})

// ---- 勾選狀態（全站共用，優化結果的「最省」會引用同一份勾選） ----
const selectedModelIds = useSelectedModels()
const selectedPlanIds = useSelectedPlans()

// prompt 是否還是空白（空白時成本表顯示 —，不show任何數字）
const hasText = computed(() => effectiveText.value.trim().length > 0)

// ---- 成本區間（單次呼叫）；LLM 精算時乘上呼叫次數 ----
const costRows = computed<CostRow[]>(() => {
  const e = estimate.value
  const assumption = `假設 input ${e.inputRange[0].toLocaleString()}–${e.inputRange[1].toLocaleString()}、output ${e.outputRange[0].toLocaleString()}–${e.outputRange[1].toLocaleString()} tokens × ${e.calls[0]}–${e.calls[1]} 次呼叫（${e.taskLabel}｜${scenarioInfo.value.label}）`
  // token 檢視 = 任務預估消耗（跟成本用同一套情境推估）：
  // input 依各模型 tokenizer 換算、output 乘該模型的輸出詳簡係數（話多/思考型模型消耗更多）
  const baseTok = Math.max(promptTokens.value, 1)
  return models
    .filter((m) => selectedModelIds.value.includes(m.id))
    .map((m) => {
      const encTok =
        (m.encoding === 'cl100k_base' ? tokensCl100k.value : tokensO200k.value) ?? baseTok
      const ratio = encTok / baseTok
      const verb = m.verbosity ?? 1
      const outLo = e.outputRange[0] * verb
      const outHi = e.outputRange[1] * verb
      return {
        model: m,
        costLow: hasText.value
          ? ((e.inputRange[0] * m.input_per_1m + outLo * m.output_per_1m) / 1_000_000) * e.calls[0]
          : 0,
        costHigh: hasText.value
          ? ((e.inputRange[1] * m.input_per_1m + outHi * m.output_per_1m) / 1_000_000) * e.calls[1]
          : 0,
        tokLow: hasText.value ? (e.inputRange[0] * ratio + outLo) * e.calls[0] : 0,
        tokHigh: hasText.value ? (e.inputRange[1] * ratio + outHi) * e.calls[1] : 0,
        tokApprox: m.provider !== 'OpenAI',
        assumption: hasText.value
          ? `${assumption}；output 已乘 ${m.name} 的輸出詳簡係數 ×${verb}（估算）`
          : '貼上 prompt 後開始估算',
      }
    })
})

// ---- 訂閱方案（對應「你選的模型」的方案自動顯示 + 高亮，即使沒勾選） ----
const currentProvider = computed(() => currentModelPricing.value.provider)
const selectedPlans = computed(() => {
  const e = estimate.value
  const verb = currentModelPricing.value.verbosity ?? 1
  const perQueryLo = (e.inputRange[0] + e.outputRange[0] * verb) * e.calls[0]
  const perQueryHi = (e.inputRange[1] + e.outputRange[1] * verb) * e.calls[1]
  const yourIds = plans.filter((p) => p.providers.includes(currentProvider.value)).map((p) => p.id)
  const showIds = new Set([...selectedPlanIds.value, ...yourIds])
  return plans
    .filter((p) => showIds.has(p.id))
    .map((p) => {
      const lo = planShareForTokens(perQueryLo, p)
      const hi = planShareForTokens(perQueryHi, p)
      return {
        plan: p,
        isYours: p.providers.includes(currentProvider.value),
        pctLo: lo.pct,
        pctHi: hi.pct,
        queriesLo: hi.pct > 0 ? Math.floor(100 / hi.pct) : 0,
        queriesHi: lo.pct > 0 ? Math.floor(100 / lo.pct) : 0,
        limitedBy: hi.limitedBy,
        msgShare: hi.msgShare,
        tokenLo: lo.tokenShare,
        tokenHi: hi.tokenShare,
      }
    })
})

function fmtPct(pct: number): string {
  if (pct < 0.1) return '<0.1'
  if (pct >= 100) return '100'
  return pct.toFixed(1)
}

function pctRangeText(lo: number, hi: number): string {
  if (fmtPct(lo) === fmtPct(hi)) return `${fmtPct(lo)}%`
  return `${fmtPct(lo)}–${fmtPct(hi)}%`
}

function queriesRangeText(lo: number, hi: number): string {
  if (lo === hi) return `${lo.toLocaleString('en-US')}`
  return `${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')}`
}

function fmtUSD(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.000001) return '<$0.000001'
  return '$' + (v < 0.01 ? v.toFixed(6) : v.toFixed(4))
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 消耗情境列：判定 + 手動切換 + 輪數（多輪時）一列搞定 -->
    <div class="card flex flex-col gap-2 p-3.5">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="section-label">消耗情境</h3>
        <div class="flex rounded-lg border border-line bg-panel-2 p-0.5">
          <button
            type="button"
            class="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
            :class="override === 'auto' ? 'bg-panel text-txt shadow-sm' : 'text-txt-dim hover:text-txt'"
            @click="override = 'auto'; llmConfirmed = false"
          >
            自動
          </button>
          <button
            v-for="sid in SELECTABLE_SCENARIOS"
            :key="sid"
            type="button"
            class="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
            :class="override === sid ? 'bg-panel text-txt shadow-sm' : 'text-txt-dim hover:text-txt'"
            @click="override = sid; llmConfirmed = false"
          >
            {{ SCENARIOS[sid].icon }} {{ SCENARIOS[sid].label }}
          </button>
        </div>
      </div>

      <div class="rounded-lg border px-3 py-2 text-xs leading-relaxed" :class="scenarioToneClass">
        <span class="font-semibold">{{ scenarioInfo.icon }} {{ scenarioInfo.label }}</span>
        <span
          v-if="isLLMRefined"
          class="ml-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold"
          >LLM 精算</span
        >
        <span
          v-for="sig in estimate.signals.slice(0, 3)"
          :key="sig"
          class="ml-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px]"
          >{{ sig }}</span
        >
        <span class="ml-1.5 font-mono text-[11px] tabular-nums opacity-90">
          input {{ estimate.inputRange[0].toLocaleString() }}–{{
            estimate.inputRange[1].toLocaleString()
          }}
          · output {{ estimate.outputRange[0].toLocaleString() }}–{{
            estimate.outputRange[1].toLocaleString()
          }}<template v-if="estimate.calls[1] > 1">
            · {{ estimate.calls[0] }}–{{ estimate.calls[1] }} 次呼叫</template
          >
        </span>
      </div>
    </div>

    <!-- 對話輪數：1=單次；拉高 = 整段 N 輪對話的累積消耗（下方全部連動） -->
    <div class="card flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2">
      <h3 class="section-label">對話輪數</h3>
      <label class="flex items-center gap-2 text-[11px] text-txt-dim">
        <input
          :value="turns"
          type="range"
          min="1"
          max="50"
          step="1"
          class="h-1.5 w-32 cursor-pointer accent-[#3987e5]"
          @input="turns = Number(($event.target as HTMLInputElement).value); userSetTurns = true"
        />
        <span class="w-14 text-right font-mono text-xs font-semibold tabular-nums text-txt"
          >{{ turns }} 輪</span
        >
      </label>
      <span v-if="convSummary && turns > 1" class="font-mono text-[11px] tabular-nums text-txt-dim">
        整段消耗 ≈ <span class="text-txt">{{ fmtTokens(convSummary.totalTokens) }}</span> tokens ·
        {{ currentModelPricing.name }} 不開 caching
        <span class="text-spend">{{ fmtUSD(convSummary.noCache) }}</span> / 開
        <span class="text-save">{{ fmtUSD(convSummary.cache) }}</span
        >（省 {{ convSummary.savePct.toFixed(0) }}%）
      </span>
      <span v-else class="text-[11px] text-txt-dim/70"
        >1 輪 = 單次提問；拉高模擬整段對話（每輪重送歷史，消耗 O(N²) 成長，下方全部連動）</span
      >
      <span
        v-if="turns > 1"
        class="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info"
        >下方成本/額度＝整段 {{ turns }} 輪累積</span
      >
    </div>

    <!-- 成本表 | 訂閱 並排，吃滿寬度不往下長 -->
    <div class="grid gap-3 xl:grid-cols-5">
      <div class="card flex flex-col gap-2.5 p-3.5 xl:col-span-3">
        <div class="flex flex-wrap items-baseline justify-between gap-1">
          <h3 class="section-label">API 成本對比</h3>
          <span class="flex items-center gap-1 text-[10px]">
            <span
              class="rounded bg-panel-2 px-1.5 py-0.5 text-txt-dim/80"
              title="定價來自各家官方，手動查證維護"
              >官方定價 {{ pricingUpdated }}</span
            >
            <span
              class="rounded px-1.5 py-0.5 font-medium"
              :class="usageSource.cls"
              title="成本 = 官方定價 × 用量估算。用量的來源：規則＝即時關鍵字估、AI＝按壓縮後模型精算"
              >用量 {{ usageSource.label }}</span
            >
          </span>
        </div>
        <ModelPicker v-model="selectedModelIds" />
        <CostTable :rows="costRows" :reliable="estimate.reliable" :empty="!hasText" />
      </div>

      <div class="card flex flex-col gap-2.5 p-3.5 xl:col-span-2">
        <div class="flex flex-wrap items-baseline justify-between gap-1">
          <h3 class="section-label">訂閱方案參考</h3>
          <span class="flex items-center gap-1 text-[10px]">
            <span class="rounded px-1.5 py-0.5 font-medium" :class="usageSource.cls"
              >用量 {{ usageSource.label }}</span
            >
            <span class="rounded bg-panel-2 px-1.5 py-0.5 text-txt-dim/80">{{
              subscriptionDisclaimer
            }}</span>
          </span>
        </div>
        <ModelSelector
          v-model="selectedPlanIds"
          :options="plans.map((p) => ({ id: p.id, label: p.name }))"
        />
        <ul class="flex flex-col gap-2">
          <li
            v-for="row in selectedPlans"
            :key="row.plan.id"
            class="rounded-xl px-3.5 py-2.5"
            :class="row.isYours ? 'border border-brand/40 bg-brand/5' : 'bg-panel-2/70'"
          >
            <!-- 第一行：方案身分 -->
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium text-txt">{{ row.plan.name }}</span>
              <span
                v-if="row.isYours"
                class="rounded bg-brand/15 px-1.5 py-px text-[9px] font-semibold text-brand"
                >你的方案</span
              >
              <span class="ml-auto text-[10px] text-txt-dim/80">{{ row.plan.price }}</span>
            </div>
            <!-- 第二行：主數字 + 次數 -->
            <div class="mt-1.5 flex items-baseline gap-1.5">
              <span class="font-mono text-lg font-semibold leading-none tabular-nums text-txt">{{
                pctRangeText(row.pctLo, row.pctHi)
              }}</span>
              <span class="text-[10px] text-txt-dim">/次</span>
              <span class="ml-auto text-[10px] text-txt-dim"
                >約
                <span class="font-mono text-[11px] tabular-nums text-txt">{{
                  queriesRangeText(row.queriesLo, row.queriesHi)
                }}</span>
                次/天</span
              >
            </div>
            <div class="mt-2 h-1 w-full rounded-full bg-[#3987e5]/15">
              <div
                class="h-1 rounded-full bg-[#3987e5]"
                :style="{ width: `${Math.min(row.pctHi, 100)}%` }"
              />
            </div>
            <p class="mt-1.5 text-[10px] leading-snug text-txt-dim/80">
              <template v-if="row.limitedBy === 'messages'">
                訊息上限卡住（{{ fmtPct(row.msgShare) }}%）· token 佔
                <span class="font-mono tabular-nums">{{ pctRangeText(row.tokenLo, row.tokenHi) }}</span>
              </template>
              <template v-else>卡 token 額度，用量越大次數越少</template>
            </p>
          </li>
          <li v-if="!selectedPlans.length" class="py-2 text-center text-xs text-txt-dim">
            勾選訂閱方案顯示估算
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
