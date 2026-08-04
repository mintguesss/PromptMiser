<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CONSUMPTION_PROFILES,
  models,
  plansForProvider,
  planShareForTokens,
  useCostUnit,
  useSelectedModels,
  useTurns,
  type ModelPricing,
} from '../../composables/usePricing'
import { conversationTotal } from '../../composables/useScenario'
import { useTokenizer } from '../../composables/useTokenizer'
import type { DiffSegment, OptimizeResult } from '../../types'

// 極簡版優化結果：計算邏輯與 CompressionResult 相同，呈現重排為單屏雙欄
const props = defineProps<{
  result: OptimizeResult
  modelPricing: ModelPricing
}>()

const selectedIds = useSelectedModels()
const unit = useCostUnit()
const { count } = useTokenizer()

const profile = computed(
  () => CONSUMPTION_PROFILES[props.result.consumption_profile] ?? CONSUMPTION_PROFILES.single,
)
const rep = computed(() => {
  const e = props.result.usage_estimate
  if (e) {
    return {
      out: (e.expected_output_min + e.expected_output_max) / 2,
      ctx: (e.context_overhead_min + e.context_overhead_max) / 2,
      calls: (e.calls_min + e.calls_max) / 2,
      precise: true,
    }
  }
  const [lo, hi] = profile.value.mult
  return { out: props.result.original_tokens * 1.5, ctx: 0, calls: (lo + hi) / 2, precise: false }
})
const IN_RATE = computed(() => props.modelPricing.input_per_1m / 1_000_000)
const OUT_RATE = computed(() => props.modelPricing.output_per_1m / 1_000_000)
const curVerb = computed(() => props.modelPricing.verbosity ?? 1)

const turns = useTurns()
const isAgent = computed(() => props.result.consumption_profile === 'agent')
const N = computed(() => (isAgent.value ? 1 : Math.max(turns.value, 1)))
function seg(perTurnIn: number, perTurnOut: number): [number, number] {
  return conversationTotal(perTurnIn, perTurnOut, N.value)
}

// 真實省 %（含 output 的總成本比例）
const realSave = computed(() => {
  const { out, ctx, calls } = rep.value
  const v = curVerb.value
  const [tiB, toB] = seg(props.result.original_tokens + ctx, out * v)
  const [tiA, toA] = seg(props.result.compressed_tokens + ctx, out * v)
  const before = calls * (tiB * IN_RATE.value + toB * OUT_RATE.value)
  const after = calls * (tiA * IN_RATE.value + toA * OUT_RATE.value)
  return { before, after, pct: before > 0 ? (1 - after / before) * 100 : 0 }
})

// 錢花在哪
const breakdown = computed(() => {
  const { out, ctx } = rep.value
  const ci = props.result.compressed_tokens * IN_RATE.value
  const cc = ctx * IN_RATE.value
  const co = out * curVerb.value * OUT_RATE.value
  const s = ci + cc + co || 1
  const input = (ci / s) * 100
  const output = (co / s) * 100
  const context = (cc / s) * 100
  let hot: 'input' | 'output' | 'context' = 'output'
  if (ci >= co && ci >= cc) hot = 'input'
  else if (cc >= co && cc >= ci) hot = 'context'
  const plain = {
    output: { where: 'AI 的回覆', act: '加「請精簡回答」或限制字數最能降成本' },
    input: { where: '你的 prompt', act: '壓縮 prompt、固定說明開 caching 最有效' },
    context: { where: '額外查到的資料', act: '減少要模型檢索或讀取的內容' },
  }[hot]
  return { input, output, context, hasCtx: ctx > 0.5, hot, plain }
})
const bdLegend = computed(() => {
  const b = breakdown.value
  return [
    { key: 'input', label: '你的 prompt', pct: b.input, color: '#3987e5' },
    { key: 'output', label: 'AI 回覆', pct: b.output, color: '#199e70' },
    ...(b.hasCtx ? [{ key: 'context', label: '額外資料', pct: b.context, color: '#c98500' }] : []),
  ].map((it) => ({ ...it, hot: it.key === b.hot }))
})

// 換個模型
function modelCost(m: ModelPricing): number {
  const { out, ctx, calls } = rep.value
  const [ti, to] = seg(props.result.compressed_tokens + ctx, out * (m.verbosity ?? 1))
  return (calls * (ti * m.input_per_1m + to * m.output_per_1m)) / 1_000_000
}
const compTokO200k = computed(() => count(props.result.compressed_prompt, 'o200k_base'))
const compTokCl100k = computed(() => count(props.result.compressed_prompt, 'cl100k_base'))
function modelTok(m: ModelPricing): number {
  const { out, ctx, calls } = rep.value
  const base = Math.max(compTokO200k.value ?? props.result.compressed_tokens, 1)
  const encTok = (m.encoding === 'cl100k_base' ? compTokCl100k.value : compTokO200k.value) ?? base
  const ratio = encTok / base
  const [ti, to] = seg(props.result.compressed_tokens * ratio + ctx, out * (m.verbosity ?? 1))
  return (ti + to) * calls
}

// ---- 適合度：LLM 針對「這個任務」逐一給每個模型打的分數（0-100） ----
/** LLM 直接給分的模型 */
const fitMap = computed(() => {
  const m = new Map<string, number>()
  for (const f of props.result.model_fit ?? []) m.set(f.model, f.score)
  return m
})
/** LLM 給過分的 (效能, 分數) 樣本點，用來補齊它漏掉的模型 */
const fitCurve = computed(() =>
  models
    .filter((m) => fitMap.value.has(m.name))
    .map((m) => ({ perf: m.perf, score: fitMap.value.get(m.name)! }))
    .sort((a, b) => a.perf - b.perf),
)
const hasFit = computed(() => fitMap.value.size > 0)
const ANY_FIT = hasFit

interface Fit {
  score: number
  /** true = LLM 沒給這個模型，用它自己的評分曲線推得 */
  approx: boolean
  cls: string
  label: string
}
/**
 * 取得模型對這個任務的適合度。優先用 LLM 直接給的分數；
 * LLM 漏評時，用「它自己對其他模型的評分」依效能內插補上（不是寫死公式）。
 */
function fit(m: ModelPricing): Fit | null {
  if (!ANY_FIT.value) return null
  const direct = fitMap.value.get(m.name)
  let score: number
  let approx = false
  if (direct !== undefined) {
    score = direct
  } else {
    const c = fitCurve.value
    if (!c.length) return null
    approx = true
    if (m.perf <= c[0].perf) score = c[0].score
    else if (m.perf >= c[c.length - 1].perf) score = c[c.length - 1].score
    else {
      const hi = c.findIndex((p) => p.perf >= m.perf)
      const a = c[hi - 1]
      const b = c[hi]
      const t = b.perf === a.perf ? 0 : (m.perf - a.perf) / (b.perf - a.perf)
      score = Math.round(a.score + (b.score - a.score) * t)
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)))
  // 分數帶依 LLM prompt 裡定義的基準：70+ 能做好、50-69 勉強、50 以下不建議
  const [cls, label] =
    score >= 70
      ? ['text-emerald-600', '能做好']
      : score >= 50
        ? ['text-[#b07d2b]', '勉強']
        : ['text-[#c26a54]', '不建議']
  return { score, approx, cls, label }
}
/** 值得推薦換過去嗎（分數 70 以上才算真的做得好；LLM 沒評分時不擋） */
function canDo(m: ModelPricing): boolean {
  const f = fit(m)
  return !f || f.score >= 70
}

interface BarRow {
  m: ModelPricing
  c: number
  tok: number
  tokApprox: boolean
  bar: number
  hot?: boolean
  best?: boolean
  /** true = 更便宜但分數不夠，列出來當對照組 */
  tooWeak?: boolean
  label: string
  cap: Fit | null
}
const compare = computed(() => {
  // 只推薦「做得來」的模型——便宜但效能不足的不該出現在建議裡
  const rank = (list: ModelPricing[]) =>
    list
      .filter((m) => !m.free && canDo(m))
      .map((m) => ({ m, c: modelCost(m) }))
      .sort((a, b) => a.c - b.c)[0] ?? null
  const yourCost = modelCost(props.modelPricing)
  const bestSel = rank(models.filter((m) => selectedIds.value.includes(m.id)))
  const bestAll = rank(models)
  // 免費模型同樣要能勝任才提，否則等於叫使用者去用做不出結果的模型
  const free =
    models.filter((m) => m.free && canDo(m)).find((m) => selectedIds.value.includes(m.id)) ??
    models.find((m) => m.free && canDo(m)) ??
    null

  const cands: { m: ModelPricing; c: number; scope: 'sel' | 'all' }[] = []
  const seen = new Set([props.modelPricing.id])
  const consider = (e: { m: ModelPricing; c: number } | null, scope: 'sel' | 'all') => {
    if (!e || seen.has(e.m.id) || e.c >= yourCost) return
    seen.add(e.m.id)
    cands.push({ ...e, scope })
  }
  consider(bestSel, 'sel')
  consider(bestAll, 'all')
  const hasBoth = cands.length === 2

  // 對照組：全站最便宜、但分數不足做不好這個任務的模型。
  // 用意是讓「為什麼不推薦更便宜的」看得見；如果所有模型都做得好就不顯示。
  const cheapestWeak = models
    .filter((m) => !seen.has(m.id) && !canDo(m))
    .map((m) => ({ m, c: modelCost(m) }))
    .sort((a, b) => a.c - b.c)[0]
  const weakRow = cheapestWeak && cheapestWeak.c < yourCost ? cheapestWeak : null

  const metric = (m: ModelPricing, c: number) => (unit.value === 'tokens' ? modelTok(m) : c)
  const yourVal = metric(props.modelPricing, yourCost)
  const base = Math.max(
    yourVal,
    ...cands.map((e) => metric(e.m, e.c)),
    weakRow ? metric(weakRow.m, weakRow.c) : 0,
    1e-12,
  )
  const rows: BarRow[] = [
    {
      m: props.modelPricing,
      c: yourCost,
      tok: modelTok(props.modelPricing),
      tokApprox: props.modelPricing.provider !== 'OpenAI',
      bar: (yourVal / base) * 100,
      hot: true,
      label: '你用的',
      cap: fit(props.modelPricing),
    },
    ...cands.map(
      (e): BarRow => ({
        m: e.m,
        c: e.c,
        tok: modelTok(e.m),
        tokApprox: e.m.provider !== 'OpenAI',
        bar: (metric(e.m, e.c) / base) * 100,
        best: e === cands[cands.length - 1],
        label: hasBoth ? (e.scope === 'sel' ? '勾選中' : '全站最省') : '最省',
        cap: fit(e.m),
      }),
    ),
    ...(weakRow
      ? [
          {
            m: weakRow.m,
            c: weakRow.c,
            tok: modelTok(weakRow.m),
            tokApprox: weakRow.m.provider !== 'OpenAI',
            bar: (metric(weakRow.m, weakRow.c) / base) * 100,
            tooWeak: true,
            label: '省但不夠',
            cap: fit(weakRow.m),
          } as BarRow,
        ]
      : []),
  ]
  const rec = cands[cands.length - 1] ?? null
  const yourTok = modelTok(props.modelPricing)
  return {
    rows,
    hasCands: cands.length > 0,
    free,
    rec,
    recSave: rec && yourCost > 0 ? (1 - rec.c / yourCost) * 100 : 0,
    recTokDiff: rec && yourTok > 0 ? (1 - modelTok(rec.m) / yourTok) * 100 : 0,
    recInSel: rec ? selectedIds.value.includes(rec.m.id) : true,
  }
})

// 訂閱（依你用的模型的提供商，前兩個方案）
const subPlans = computed(() => {
  const { out, ctx, calls } = rep.value
  const [tiA, toA] = seg(props.result.compressed_tokens + ctx, out * curVerb.value)
  const afterTok = (tiA + toA) * calls
  return plansForProvider(props.modelPricing.provider)
    .slice(0, 3)
    .map((p) => {
      const a = planShareForTokens(afterTok, p)
      return { plan: p, pct: a.pct, q: a.pct > 0 ? Math.floor(100 / a.pct) : 0 }
    })
})

// 手機版：建議卡預設只顯示前兩張（模型推薦），其餘收起來，避免整頁太長
const isMobile = ref(false)
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(max-width: 639px)')
  isMobile.value = mq.matches
  mq.addEventListener('change', (e) => (isMobile.value = e.matches))
}
/** 分數說明預設收起，點標題旁的「?」才展開 */
const showFitNote = ref(false)
/** 建議卡預設只顯示標題，點一下展開說明 */
const openTip = ref<string | null>(null)
function toggleTip(title: string) {
  openTip.value = openTip.value === title ? null : title
}

// diff / 複製
const copied = ref(false)
const beforeSegments = computed<DiffSegment[]>(() => props.result.diff.filter((s) => s.type !== 'add'))
const afterSegments = computed<DiffSegment[]>(() => props.result.diff.filter((s) => s.type !== 'delete'))
async function copyCompressed() {
  await navigator.clipboard.writeText(props.result.compressed_prompt)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function fmtUSD(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.000001) return '<$0.000001'
  return '$' + (v < 0.01 ? v.toFixed(6) : v.toFixed(4))
}
function fmtTokDisp(n: number, approx: boolean): string {
  const s = n >= 10_000 ? (n / 1_000).toFixed(1) + 'K' : Math.round(n).toLocaleString('en-US')
  return `${approx ? '≈' : ''}${s} tok`
}
function fmtPct(pct: number): string {
  if (pct < 0.1) return '<0.1'
  if (pct >= 100) return '100'
  return pct.toFixed(1)
}
const realSaveText = computed(() => (realSave.value.pct < 0.1 ? '<0.1' : realSave.value.pct.toFixed(1)))
// 壓縮幅度太小（<3%）時，大標改講人話「沒什麼好壓的」，不show「壓縮掉 0%」這種怪句
const lowCompress = computed(() => props.result.reduction_pct < 3)

// 建議卡（LLM 生成：同/跨系列推薦 + 兩條使用建議）
const sugCards = computed(() => {
  const cards: { icon: string; title: string; desc: string; pct: number }[] = []
  const r = props.result
  if (r.same_provider_pick)
    cards.push({
      icon: '🎯',
      title: `同系列模型：${r.same_provider_pick.model}`,
      desc: r.same_provider_pick.reason,
      pct: r.same_provider_pick.estimated_saving_pct,
    })
  if (r.cross_provider_pick)
    cards.push({
      icon: '🌐',
      title: `跨系列模型：${r.cross_provider_pick.model}`,
      desc: r.cross_provider_pick.reason,
      pct: r.cross_provider_pick.estimated_saving_pct,
    })
  for (const s of r.suggestions) cards.push({ icon: s.icon, title: s.title, desc: s.description, pct: s.estimated_saving_pct })
  return cards.slice(0, 4)
})
// 卡片改成「標題可展開」後就不需要再藏起後兩張，四張全列（桌機本來就全展開）
const visibleTips = computed(() => sugCards.value)
</script>

<template>
  <main
    class="mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 grid-cols-1 gap-y-10 px-4 py-3.5 sm:gap-y-6 sm:px-8 sm:py-5 lg:grid-cols-12 lg:overflow-y-auto"
  >
    <!-- ═ 左：壓縮成果 ═ -->
    <section class="flex min-h-0 flex-col lg:col-span-5 lg:pr-8">
      <h1 class="text-[17px] font-bold leading-snug tracking-tight sm:text-xl">
        <template v-if="lowCompress">這段 prompt 已經夠精簡，沒什麼好壓的。</template>
        <template v-else-if="realSave.pct < 5"
          >字省了 <span class="font-mono text-emerald-600">{{ result.reduction_pct }}%</span>，錢只省
          <span class="font-mono text-[#c26a54]">{{ realSaveText }}%</span>。</template
        >
        <template v-else
          >壓縮完成，每次能省
          <span class="font-mono text-emerald-600">{{ realSaveText }}%</span>。</template
        >
      </h1>
      <p class="mt-1.5 text-[13px] leading-6 text-[#5c626e] sm:text-sm">
        {{ turns > 1 && !isAgent ? `這種問題來回 ${turns} 輪，` : '跑一次' }}約
        <b class="font-mono text-[#1d2129]">{{ fmtUSD(realSave.after) }}</b>
        <span v-if="rep.precise" class="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">🤖 AI 精算</span>
      </p>
      <!-- 錢花在哪：跟上面那句講的是同一件事，直接併在這裡一次講完，
           不必在頁尾再開一個區塊重複一遍 -->
      <div class="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#767e8c]">
        <div class="flex h-1.5 w-28 gap-0.5 overflow-hidden rounded-full">
          <div
            v-for="it in bdLegend"
            :key="it.key"
            class="h-full first:rounded-l-full last:rounded-r-full"
            :style="{ width: `max(${it.pct}%, 3px)`, background: it.color }"
          />
        </div>
        <span>
          <template v-for="(it, i) in bdLegend" :key="it.key">
            <span :class="it.hot ? 'font-semibold text-[#1d2129]' : ''">{{ it.label }} {{ it.pct.toFixed(0) }}%</span>
            <span v-if="i < bdLegend.length - 1"> · </span>
          </template>
        </span>
        <span class="text-[#8b93a0]">💡 {{ breakdown.plain.act }}</span>
      </div>

      <div class="mt-10 flex min-h-0 flex-1 flex-col sm:mt-4">
        <p class="flex shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">
          壓縮前 <span class="ml-auto font-mono normal-case tracking-normal">{{ result.original_tokens.toLocaleString('en-US') }} tokens</span>
        </p>
        <div class="mt-1.5 max-h-32 min-h-16 flex-1 overflow-y-auto sm:max-h-none sm:min-h-24 whitespace-pre-wrap break-words rounded-lg border border-[#eae7de] bg-[#fdfcf8] p-3.5 font-mono text-[13px] leading-6 text-[#3c4250]">
          <template v-for="(s, i) in beforeSegments" :key="i">
            <del v-if="s.type === 'delete'" class="rounded bg-[#fbe9e4] text-[#c26a54] no-underline">{{ s.text }}</del>
            <span v-else>{{ s.text }}</span>
          </template>
        </div>
        <p class="mt-3 flex shrink-0 items-center text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-600">
          壓縮後 <span class="ml-auto font-mono normal-case tracking-normal">{{ result.compressed_tokens.toLocaleString('en-US') }} tokens</span>
          <button
            type="button"
            class="ml-3 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold normal-case tracking-normal transition"
            :class="copied ? 'border-emerald-400 text-emerald-600' : 'border-[#e0ddd4] text-[#5c626e] hover:border-emerald-400 hover:text-emerald-600'"
            @click="copyCompressed"
          >
            {{ copied ? '✓ 已複製' : '📋 複製' }}
          </button>
        </p>
        <div class="mt-1.5 max-h-32 min-h-16 flex-1 overflow-y-auto sm:max-h-none sm:min-h-24 whitespace-pre-wrap break-words rounded-lg border border-emerald-200/70 bg-[#fdfcf8] p-3.5 font-mono text-[13px] leading-6 text-[#3c4250]">
          <template v-for="(s, i) in afterSegments" :key="i">
            <ins v-if="s.type === 'add'" class="rounded bg-emerald-50 text-emerald-700 no-underline">{{ s.text }}</ins>
            <span v-else>{{ s.text }}</span>
          </template>
        </div>
      </div>

      <p v-if="result.usage_estimate?.reason" class="mt-8 shrink-0 text-[13px] leading-6 text-[#767e8c] sm:mt-3">
        🤖 AI 估算依據：{{ result.usage_estimate.reason }}
      </p>
    </section>

    <!-- ═ 右：怎麼行動（中線分隔） ═ -->
    <section class="flex min-h-0 flex-col lg:col-span-7 lg:border-l lg:border-[#e4e1d8] lg:pl-8">
      <p class="flex flex-wrap items-baseline gap-x-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">
        <span>
          <button
            type="button"
            class="normal-case tracking-normal"
            :class="unit === 'cost' ? 'font-bold text-[#1d2129]' : 'border-b border-dotted border-[#b3ae9f] text-[#9a9378] hover:text-[#1d2129]'"
            @click="unit = 'cost'"
          >
            換個模型能省多少
          </button>
          <span class="px-1 text-[#b3ae9f]">·</span>
          <button
            type="button"
            class="normal-case tracking-normal"
            :class="unit === 'tokens' ? 'font-bold text-[#1d2129]' : 'border-b border-dotted border-[#b3ae9f] text-[#9a9378] hover:text-[#1d2129]'"
            @click="unit = 'tokens'"
          >
            tokens
          </button>
        </span>
        <!-- 分數說明收在標題旁，預設不佔版面 -->
        <button
          v-if="hasFit"
          type="button"
          class="shrink-0 rounded-full border border-[#e0ddd4] px-1.5 text-[10px] font-normal normal-case tracking-normal text-[#8b93a0] transition hover:border-[#b3ae9f] hover:text-[#1d2129]"
          :class="showFitNote ? 'border-[#b3ae9f] text-[#1d2129]' : ''"
          title="適合度分數怎麼來的"
          @click="showFitNote = !showFitNote"
        >
          適合度 ?
        </button>
        <span v-if="rep.precise" class="ml-auto font-normal normal-case tracking-normal text-[#8b93a0]">🤖 AI 精算</span>
      </p>
      <p v-if="hasFit && showFitNote" class="mt-1.5 rounded-lg bg-[#f5f3ed] px-3 py-2 text-xs leading-5 text-[#767e8c] sm:text-[13px]">
        分數 = AI 評估各模型做好<b class="text-[#1d2129]">這個任務</b>的程度（70 以上算能做好）<template
          v-if="result.required_perf_reason"
        >。{{ result.required_perf_reason }}</template
        >
      </p>
      <template v-if="compare.hasCands">
        <!-- 欄位標題（桌機）：不然「78 分」會被誤讀成價格的一部分 -->
        <div class="mt-2 flex items-center gap-2 border-b border-[#e4e1d8] pb-1 text-[11px] text-[#8b93a0] sm:gap-3">
          <span class="min-w-0 flex-1 sm:w-44 sm:flex-none">模型</span>
          <span class="min-w-8 flex-1 text-center sm:text-left">相對</span>
          <span class="w-[104px] shrink-0 text-right">{{ unit === 'tokens' ? '預估用量' : '成本/次' }}</span>
          <span v-if="hasFit" class="hidden w-20 shrink-0 cursor-help text-right sm:block" title="AI 評估各模型做好這個任務的程度，滿分 100">適合度</span>
          <span class="hidden w-16 shrink-0 sm:block" />
        </div>
        <ul class="mt-2.5 sm:mt-0">
          <!-- 手機：只有 3-4 列，改雙行換取可讀性（4 欄擠在 361px 會黏成一團） -->
          <li v-for="r in compare.rows" :key="r.m.id" class="border-b border-[#eeece6] py-2 sm:py-2.5">
            <div class="flex items-center gap-2 sm:gap-3">
              <span
                class="min-w-0 flex-1 truncate text-sm sm:w-44 sm:flex-none"
                :class="[r.hot ? 'font-semibold' : '', r.tooWeak ? 'text-[#8b93a0]' : '']"
                >{{ r.m.name }}</span
              >
              <!-- 長條緊貼成本（它表示的是成本），跟適合度分開避免誤讀 -->
              <div class="h-2 min-w-8 flex-1 rounded-full bg-[#f0eee8]">
                <div
                  class="h-full rounded-full"
                  :class="r.hot ? 'bg-[#e8927c]' : r.best ? 'bg-emerald-400' : 'bg-[#b9b4a6]'"
                  :style="{ width: `max(${r.bar}%, 4px)` }"
                />
              </div>
              <span
                class="w-[104px] shrink-0 whitespace-nowrap text-right font-mono text-[13px] tabular-nums sm:text-sm"
                :class="[
                  r.hot ? 'font-bold' : r.best ? 'font-bold text-emerald-600' : '',
                  r.tooWeak ? 'text-[#8b93a0]' : '',
                ]"
                >{{ unit === 'tokens' ? fmtTokDisp(r.tok, r.tokApprox) : fmtUSD(r.c) }}</span
              >
              <!-- 適合度分數：LLM 針對這個任務逐一評分（桌機同一行、手機移到第二行） -->
              <span
                v-if="r.cap"
                class="hidden w-20 shrink-0 text-right font-mono text-xs tabular-nums sm:block"
                :class="r.cap.cls"
                :title="`${r.cap.approx ? '（由 AI 對其他模型的評分推得）' : 'AI 評分：'}這個任務 ${r.cap.label}`"
                >{{ r.cap.approx ? '≈' : '' }}{{ r.cap.score }} 分</span
              >
              <span
                class="hidden w-16 shrink-0 whitespace-nowrap text-right text-xs sm:block"
                :class="r.best ? 'font-semibold text-emerald-600' : r.tooWeak ? 'text-[#c26a54]' : 'text-[#767e8c]'"
                >{{ r.label }}</span
              >
            </div>
            <!-- 手機第二行：只放適合度與標記（長條在上一行貼著成本，不放這裡避免被當成適合度） -->
            <div class="mt-1.5 flex items-center text-[11px] sm:hidden">
              <span v-if="r.cap" :class="r.cap.cls"
                >適合度 <b class="font-mono tabular-nums">{{ r.cap.approx ? '≈' : '' }}{{ r.cap.score }}</b> 分</span
              >
              <span
                class="ml-auto"
                :class="r.best ? 'font-semibold text-emerald-600' : r.tooWeak ? 'text-[#c26a54]' : 'text-[#767e8c]'"
                >{{ r.label }}</span
              >
            </div>
          </li>
        </ul>
        <p v-if="compare.rec && unit === 'tokens'" class="mt-2 text-sm leading-6 text-[#5c626e]">
          換模型 token 消耗差不多（{{ compare.rec.m.name }} {{ compare.recTokDiff >= 0 ? '只少' : '反而多' }}
          <span class="font-mono tabular-nums">{{ Math.abs(compare.recTokDiff).toFixed(0) }}%</span>）——「省
          {{ compare.recSave.toFixed(0) }}%」省在<b class="text-[#1d2129]">單價</b>，切回「換個模型能省多少」看金額。
        </p>
        <!-- 最重要的一句：做成重點框，整頁的視覺焦點 -->
        <p
          v-else-if="compare.rec"
          class="mt-8 rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-3.5 py-3 text-[13px] leading-6 text-[#3c4250] sm:mt-2.5 sm:px-4 sm:py-2.5 sm:text-sm"
        >
          ⭐ 同樣這個任務，改用 <b class="text-[#1d2129]">{{ compare.rec.m.name }}</b> 每次能省
          <b class="font-mono text-base text-emerald-700">{{ compare.recSave.toFixed(0) }}%</b>
          <span v-if="fit(compare.rec.m)" class="text-[#767e8c]">（適合度 {{ fit(compare.rec.m)!.score }} 分）</span>
          <span v-if="!compare.recInSel" class="text-[#767e8c]">，未在比較清單，可在分析頁勾選</span>
          <span v-if="compare.free" class="text-[#767e8c]">·「{{ compare.free.name }}」免費且做得來</span>
        </p>
      </template>
      <p v-else class="mt-2 text-sm leading-6 text-[#5c626e]">
        ✓ 你用的 <b>{{ modelPricing.name }}</b>
        {{ hasFit ? '已是做得好這個任務的模型裡最省的' : '已是最省' }}——更便宜的模型分數不夠，換過去可能做不好。<span
          v-if="compare.free"
          class="text-[#8b93a0]"
          >「{{ compare.free.name }}」是唯一免費又做得好的選擇。</span
        >
      </p>

      <p class="mt-14 shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c] sm:mt-5">
        省錢建議 · 任務類型：{{ result.task_type }}
        <span class="ml-3 font-normal normal-case tracking-normal text-[#8b93a0]"
          >全部採用預估總共省 <b class="font-mono text-emerald-600">{{ result.total_estimated_saving_pct }}%</b></span
        >
      </p>
      <!-- 建議卡：手機只留標題、點一下展開說明；桌機空間夠，一律完整顯示 -->
      <div class="mt-2.5 grid shrink-0 gap-2 sm:mt-2 sm:grid-cols-2 sm:gap-3">
        <div
          v-for="c in visibleTips"
          :key="c.title"
          class="rounded-xl border border-[#e9e6dd] bg-[#f5f3ed] transition"
          :class="openTip === c.title ? 'border-[#d8d3c6]' : ''"
        >
          <button
            type="button"
            class="flex w-full cursor-pointer items-baseline gap-2 px-3 py-2.5 text-left sm:cursor-default sm:px-4 sm:py-3"
            @click="isMobile && toggleTip(c.title)"
          >
            <span class="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 sm:whitespace-normal sm:text-sm sm:leading-6">{{ c.icon }} {{ c.title }}</span>
            <span
              v-if="c.pct > 0"
              class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-xs font-bold tabular-nums text-emerald-700"
              >省 {{ c.pct.toFixed(0) }}%</span
            >
            <span class="shrink-0 text-[10px] text-[#a8a596] sm:hidden">{{ openTip === c.title ? '▴' : '▾' }}</span>
          </button>
          <p
            v-show="!isMobile || openTip === c.title"
            class="px-3 pb-2.5 text-xs leading-5 text-[#767e8c] sm:-mt-1 sm:px-4 sm:pb-3 sm:text-[13px]"
          >
            {{ c.desc }}
          </p>
        </div>
      </div>

      <!-- 「錢花在哪」已併到頁面上方的結論那一段，這裡只留訂閱者視角。
           原本它是掛在「錢花在哪」的標題下面，拿掉後要補自己的標題才不會變孤兒 -->
      <div class="mt-14 shrink-0 sm:mt-5">
        <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">
          💳 訂閱者視角<span class="normal-case tracking-normal">（額度為估算）</span>
        </p>
        <div v-if="subPlans.length" class="mt-3 divide-y divide-[#e9e6dd] overflow-hidden rounded-xl border border-[#e9e6dd] bg-[#f5f3ed]">
          <div v-for="s in subPlans" :key="s.plan.id" class="flex items-center gap-2.5 px-3 py-2 sm:gap-3 sm:px-4">
            <b class="min-w-0 flex-1 truncate text-sm text-[#1d2129] sm:w-32 sm:flex-none" :title="s.plan.note">{{ s.plan.name }}</b>
            <span class="hidden shrink-0 text-xs text-[#8b93a0] sm:block sm:w-16">{{ s.plan.price }}</span>
            <div class="hidden h-1.5 max-w-52 flex-1 rounded-full bg-white/80 sm:block" :title="`一則約佔每日額度 ${fmtPct(s.pct)}%`">
              <div class="h-full rounded-full bg-[#3987e5]" :style="{ width: `max(${Math.min(s.pct, 100)}%, 3px)` }" />
            </div>
            <span class="shrink-0 text-right font-mono text-[13px] tabular-nums text-[#1d2129] sm:w-20 sm:text-sm"
              >{{ fmtPct(s.pct) }}<span class="text-xs text-[#8b93a0]">%/則</span></span
            >
            <span class="shrink-0 whitespace-nowrap text-right text-[13px] text-[#5c626e] sm:w-24 sm:text-sm"
              >約 <b class="font-mono tabular-nums text-[#1d2129]">{{ s.q.toLocaleString('en-US') }}</b> 次/天</span
            >
          </div>
        </div>
        <p v-else class="mt-3 rounded-xl border border-[#e9e6dd] bg-[#f5f3ed] px-4 py-3 text-sm text-[#5c626e]">
          💳 {{ modelPricing.provider }} 無主流訂閱方案，屬 API 按量計價。
        </p>
      </div>
    </section>
  </main>
</template>
