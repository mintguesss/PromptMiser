<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  models,
  plansForProvider,
  planShareForTokens,
  providerColors,
  useSelectedModels,
  useTurns,
  type ModelPricing,
} from '../../composables/usePricing'
import { conversationTotal } from '../../composables/useScenario'
import type { OptimizeResult } from '../../types'

/**
 * 卡片版優化結果。
 *
 * 跟即時分析用同一套版面語彙：深色主卡當錨點 → 結論 → 佐證 → 細節。
 * 換模型比較與訂閱方案在即時分析頁已經有，這裡不重複。
 */
const props = defineProps<{
  result: OptimizeResult
  modelPricing: ModelPricing
  /** 綜合版：把每個模型的適合度評分與訂閱方案也放回來 */
  dense?: boolean
}>()

const turns = useTurns()
const selectedIds = useSelectedModels()
const isAgent = computed(() => props.result.consumption_profile === 'agent')
const N = computed(() => (isAgent.value ? 1 : Math.max(turns.value, 1)))

const rep = computed(() => {
  const e = props.result.usage_estimate
  return e
    ? {
        out: (e.expected_output_min + e.expected_output_max) / 2,
        ctx: (e.context_overhead_min + e.context_overhead_max) / 2,
        calls: (e.calls_min + e.calls_max) / 2,
      }
    : { out: props.result.original_tokens * 1.5, ctx: 0, calls: 1 }
})

function costFor(m: ModelPricing, tokens: number): number {
  const { out, ctx, calls } = rep.value
  const [ti, to] = conversationTotal(tokens + ctx, out * (m.verbosity ?? 1), N.value)
  return (calls * (ti * m.input_per_1m + to * m.output_per_1m)) / 1e6
}

const before = computed(() => costFor(props.modelPricing, props.result.original_tokens))
const after = computed(() => costFor(props.modelPricing, props.result.compressed_tokens))
const savePct = computed(() => (before.value > 0 ? (1 - after.value / before.value) * 100 : 0))
const tokenCutPct = computed(() =>
  props.result.original_tokens > 0
    ? (1 - props.result.compressed_tokens / props.result.original_tokens) * 100
    : 0,
)

/** 錢花在壓縮後的 prompt 還是 AI 的回覆 */
const split = computed(() => {
  const m = props.modelPricing
  const { out, ctx } = rep.value
  const inC = (props.result.compressed_tokens + ctx) * m.input_per_1m
  const outC = out * (m.verbosity ?? 1) * m.output_per_1m
  const s = inC + outC || 1
  return { input: (inC / s) * 100, output: (outC / s) * 100 }
})

/** LLM 針對這個任務給每個模型的適合度；70 分以上才算做得好 */
const fitMap = computed(() => new Map((props.result.model_fit ?? []).map((f) => [f.model, f.score])))
function canDo(m: ModelPricing): boolean {
  const s = fitMap.value.get(m.name)
  return s === undefined || s >= 70
}

/** 換模型：只從「做得來」的裡面挑最省的 */
const swap = computed(() => {
  const top = models
    .filter((m) => m.id !== props.modelPricing.id && !m.free && canDo(m))
    .map((m) => ({ m, c: costFor(m, props.result.compressed_tokens) }))
    .sort((a, b) => a.c - b.c)[0]
  if (!top || top.c >= after.value) return null
  return { ...top, pct: (1 - top.c / after.value) * 100, fit: fitMap.value.get(top.m.name) ?? null }
})

const compareRows = computed(() =>
  models
    .filter((m) => selectedIds.value.includes(m.id) || m.id === props.modelPricing.id)
    .map((m) => ({ m, c: costFor(m, props.result.compressed_tokens), fit: fitMap.value.get(m.name) ?? null }))
    .sort((a, b) => a.c - b.c),
)
const maxC = computed(() => Math.max(...compareRows.value.map((r) => r.c), 1e-9))

const totalTokens = computed(() => props.result.compressed_tokens + rep.value.ctx + rep.value.out)
const subPlans = computed(() =>
  plansForProvider(props.modelPricing.provider).map((plan) => {
    const share = planShareForTokens(totalTokens.value, plan)
    return { plan, pct: share.pct, q: share.pct > 0 ? Math.floor(100 / share.pct) : 0 }
  }),
)

const money = (v: number) =>
  v === 0 ? '$0' : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 3 : 2)}`

const copied = ref(false)
async function copy() {
  await navigator.clipboard.writeText(props.result.compressed_prompt)
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}
const showFull = ref(false)
</script>

<template>
  <main class="mx-auto w-full max-w-xl px-4 pb-20 pt-4">
    <!-- 主卡：整頁唯一的深色塊 -->
    <section
      class="relative overflow-hidden rounded-[20px] bg-gradient-to-br from-[#3d4553] to-[#515a69] p-5 shadow-[0_8px_20px_-10px_rgba(61,69,83,0.45)]"
    >
      <div class="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full bg-[#2fc38c] opacity-20 blur-3xl" />
      <p class="relative text-[11px] font-semibold uppercase tracking-[0.22em] text-white/60">壓縮後每次</p>
      <p
        class="relative mt-1.5 font-mono text-[30px] font-bold leading-none tracking-tighter text-white [font-variant-numeric:tabular-nums]"
      >
        {{ money(after) }}
      </p>

      <!-- 錢花在哪 -->
      <div class="relative mt-4 flex h-1 overflow-hidden rounded-full bg-white/20">
        <div class="h-full bg-[#5b9cf5]" :style="{ width: `${split.input}%` }" />
        <div class="h-full bg-[#2fc38c]" :style="{ width: `${split.output}%` }" />
      </div>
      <div class="relative mt-2.5 flex items-center justify-between text-[11px] text-white/65">
        <span><b class="font-mono text-white/80">{{ split.input.toFixed(0) }}%</b> 你的字</span>
        <span><b class="font-mono text-white/80">{{ split.output.toFixed(0) }}%</b> AI 回覆</span>
      </div>

      <div class="relative mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-[12px]">
        <span class="flex items-center gap-2 text-white/80">
          <span class="h-1.5 w-1.5 rounded-full" :style="{ background: providerColors[modelPricing.provider] }" />
          {{ modelPricing.name }}
        </span>
        <span class="font-mono text-white/60">
          {{ result.original_tokens }} → {{ result.compressed_tokens }} tokens
        </span>
      </div>
    </section>

    <!-- 真正該做的：整頁的行動點，用綠底反白突顯 -->
    <section
      v-if="swap"
      class="mt-3.5 overflow-hidden rounded-[22px] bg-gradient-to-br from-[#12a978] to-[#0b8a63] p-5 shadow-[0_10px_24px_-14px_rgba(15,157,110,0.8)]"
    >
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/60">真正該做的</p>
          <p class="mt-1.5 truncate text-[18px] font-bold tracking-tight text-white">
            改用 {{ swap.m.name }}
          </p>
          <p class="mt-1 font-mono text-[12px] text-white/65">
            {{ money(swap.c) }}<template v-if="swap.fit !== null"> · 適合度 {{ swap.fit }} 分</template>
          </p>
        </div>
        <div class="shrink-0 text-right">
          <p class="font-mono text-[32px] font-bold leading-none tracking-tighter text-white">
            {{ swap.pct.toFixed(0) }}<span class="text-[17px]">%</span>
          </p>
          <p class="mt-1 text-[11px] text-white/60">能省</p>
        </div>
      </div>
    </section>

    <!-- 兩格重點：字數 vs 錢，矛盾自己說話 -->
    <div class="mt-3.5 grid grid-cols-2 gap-3">
      <div class="rounded-2xl border border-[#d8ece1] bg-[#f4fbf7] px-4 py-3.5">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#0f9d6e]">字數少了</p>
        <p class="mt-1.5 font-mono text-[26px] font-bold leading-none tracking-tighter text-[#0f9d6e]">
          {{ tokenCutPct.toFixed(0) }}<span class="text-[15px]">%</span>
        </p>
        <p class="mt-1.5 text-[12px] text-[#8b93a0]">少 {{ result.original_tokens - result.compressed_tokens }} tokens</p>
      </div>
      <div
        class="rounded-2xl px-4 py-3.5"
        :class="savePct >= 5 ? 'border border-[#d8ece1] bg-[#f4fbf7]' : 'border border-[#f2ddd4] bg-[#fdf6f2]'"
      >
        <p
          class="text-[10px] font-semibold uppercase tracking-[0.16em]"
          :class="savePct >= 5 ? 'text-[#0f9d6e]' : 'text-[#c26a54]'"
        >
          {{ savePct >= 5 ? '錢省了' : '但錢只省' }}
        </p>
        <p
          class="mt-1.5 font-mono text-[26px] font-bold leading-none tracking-tighter"
          :class="savePct >= 5 ? 'text-[#0f9d6e]' : 'text-[#c26a54]'"
        >
          {{ savePct.toFixed(savePct >= 5 ? 0 : 1) }}<span class="text-[15px]">%</span>
        </p>
        <p class="mt-1.5 text-[12px] text-[#8b93a0]">
          {{ savePct >= 5 ? `省 ${money(before - after)}` : '錢在 AI 的回覆' }}
        </p>
      </div>
    </div>

    <!-- 壓縮後的 prompt -->
    <section class="mt-7">
      <div class="flex items-baseline gap-3">
        <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b93a0]">壓縮後的 prompt</p>
        <span class="h-px flex-1 bg-[#eae7de]" />
        <button
          type="button"
          class="shrink-0 rounded-full bg-[#1d2129] px-3 py-1 text-[11px] font-semibold text-white transition active:scale-95"
          @click="copy"
        >
          {{ copied ? '已複製' : '複製' }}
        </button>
      </div>
      <div class="mt-3 rounded-2xl border border-[#eae7de] bg-white p-4">
        <p
          class="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-[#3c4250]"
          :class="showFull ? '' : 'line-clamp-6'"
        >
          {{ result.compressed_prompt }}
        </p>
        <button
          type="button"
          class="mt-3 text-[12px] text-[#8b93a0] underline decoration-dotted underline-offset-4"
          @click="showFull = !showFull"
        >
          {{ showFull ? '收起' : '看全文' }}
        </button>
      </div>
    </section>

    <!-- 省錢建議：攤開，這是這一頁的重點內容 -->
    <section v-if="result.suggestions.length" class="mt-7">
      <div class="flex items-baseline gap-3">
        <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b93a0]">省錢建議</p>
        <span class="h-px flex-1 bg-[#eae7de]" />
        <span class="shrink-0 text-[11px] text-[#b6bcc7]">{{ result.task_type }}</span>
      </div>
      <ul class="mt-3 space-y-2.5">
        <li
          v-for="s in result.suggestions"
          :key="s.title"
          class="rounded-2xl border border-[#eae7de] bg-white p-4"
        >
          <div class="flex items-baseline justify-between gap-3">
            <span class="min-w-0 text-[14px] font-bold text-[#1d2129]">{{ s.icon }} {{ s.title }}</span>
            <span
              class="shrink-0 rounded-full bg-[#e7f6ef] px-2 py-0.5 font-mono text-[11px] font-bold text-[#0f9d6e]"
              >-{{ s.estimated_saving_pct }}%</span
            >
          </div>
          <p class="mt-1.5 text-[12.5px] leading-6 text-[#767e8c]">{{ s.description }}</p>
        </li>
      </ul>
    </section>

    <!-- 卡片版：換模型比較與訂閱方案都在「即時分析」頁，這裡不重複。
         綜合版才列出來——因為「適合度分數」是 LLM 針對這個任務給的，分析頁沒有這份資料。 -->
    <template v-if="dense">
      <section class="mt-7">
        <div class="flex items-baseline gap-3">
          <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b93a0]">
            各模型適合度
          </p>
          <span class="h-px flex-1 bg-[#eae7de]" />
          <span class="shrink-0 text-[11px] text-[#b6bcc7]">70 分以上做得好</span>
        </div>
        <ul class="mt-3 space-y-3">
          <li v-for="r in compareRows" :key="r.m.id">
            <div class="flex items-baseline justify-between gap-3">
              <span class="flex min-w-0 items-center gap-2">
                <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: providerColors[r.m.provider] }" />
                <span
                  class="truncate text-[14px]"
                  :class="r.m.id === modelPricing.id ? 'font-bold text-[#1d2129]' : 'text-[#3c4250]'"
                  >{{ r.m.name }}</span
                >
                <span v-if="r.m.id === modelPricing.id" class="shrink-0 text-[10px] text-[#c26a54]">你用的</span>
              </span>
              <span
                class="shrink-0 font-mono text-[12.5px] font-semibold tabular-nums"
                :class="r.m.id === modelPricing.id ? 'font-bold text-[#1d2129]' : 'text-[#3c4250]'"
                >{{ money(r.c) }}</span
              >
            </div>
            <div class="mt-1.5 flex items-center gap-2.5">
              <div class="h-[3px] flex-1 rounded-full bg-[#efece5]">
                <div
                  class="h-full rounded-full"
                  :style="{
                    width: `max(${(r.c / maxC) * 100}%, 3px)`,
                    background: r.m.id === modelPricing.id ? '#e8927c' : providerColors[r.m.provider],
                    opacity: r.m.id === modelPricing.id ? 1 : 0.4,
                  }"
                />
              </div>
              <span
                v-if="r.fit !== null"
                class="shrink-0 whitespace-nowrap text-[10px]"
                :class="r.fit >= 70 ? 'text-[#0f9d6e]' : r.fit >= 50 ? 'text-[#b07d2b]' : 'text-[#c26a54]'"
                >適合度 <b class="font-mono tabular-nums">{{ r.fit }}</b></span
              >
              <span v-else class="shrink-0 text-[10px] text-[#cfd3da]">未評分</span>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="subPlans.length" class="mt-7">
        <div class="flex items-baseline gap-3">
          <p class="shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8b93a0]">
            {{ modelPricing.provider }} 訂閱方案
          </p>
          <span class="h-px flex-1 bg-[#eae7de]" />
          <span class="shrink-0 text-[11px] text-[#b6bcc7]">壓縮後能跑幾次</span>
        </div>
        <ul class="mt-3 divide-y divide-[#f2efe8] overflow-hidden rounded-2xl border border-[#eae7de] bg-white">
          <li v-for="s in subPlans" :key="s.plan.id" class="flex items-center justify-between gap-3 px-4 py-3">
            <div class="min-w-0">
              <p class="truncate text-[14px] font-semibold text-[#1d2129]">{{ s.plan.name }}</p>
              <p class="text-[11px] text-[#a8aebb]">{{ s.plan.price }}</p>
            </div>
            <span class="flex shrink-0 items-baseline gap-3">
              <span class="font-mono text-[12px] tabular-nums text-[#8b93a0]"
                >{{ s.pct < 0.1 ? '<0.1' : s.pct.toFixed(1) }}%<span class="text-[10px]">/則</span></span
              >
              <span>
                <b class="font-mono text-[17px] tabular-nums text-[#1d2129]">{{ s.q.toLocaleString('en-US') }}</b>
                <span class="ml-1 text-[11px] text-[#8b93a0]">次/天</span>
              </span>
            </span>
          </li>
        </ul>
      </section>
    </template>

    <p class="mt-6 px-1 text-[11px] leading-5 text-[#b6bcc7]">
      成本為估算值，實際以各家帳單為準
    </p>
  </main>
</template>
