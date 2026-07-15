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

interface BarRow {
  m: ModelPricing
  c: number
  tok: number
  tokApprox: boolean
  bar: number
  hot?: boolean
  best?: boolean
  label: string
}
const compare = computed(() => {
  const rank = (list: ModelPricing[]) =>
    list
      .filter((m) => !m.free)
      .map((m) => ({ m, c: modelCost(m) }))
      .sort((a, b) => a.c - b.c)[0] ?? null
  const yourCost = modelCost(props.modelPricing)
  const bestSel = rank(models.filter((m) => selectedIds.value.includes(m.id)))
  const bestAll = rank(models)
  const free =
    models.filter((m) => m.free).find((m) => selectedIds.value.includes(m.id)) ??
    models.find((m) => m.free) ??
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

  const metric = (m: ModelPricing, c: number) => (unit.value === 'tokens' ? modelTok(m) : c)
  const yourVal = metric(props.modelPricing, yourCost)
  const base = Math.max(yourVal, ...cands.map((e) => metric(e.m, e.c)), 1e-12)
  const rows: BarRow[] = [
    {
      m: props.modelPricing,
      c: yourCost,
      tok: modelTok(props.modelPricing),
      tokApprox: props.modelPricing.provider !== 'OpenAI',
      bar: (yourVal / base) * 100,
      hot: true,
      label: '你用的',
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
      }),
    ),
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
</script>

<template>
  <main
    class="mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 grid-cols-1 gap-y-6 px-8 py-5 lg:grid-cols-12 lg:overflow-y-auto"
  >
    <!-- ═ 左：壓縮成果 ═ -->
    <section class="flex min-h-0 flex-col lg:col-span-5 lg:pr-8">
      <h1 class="text-xl font-bold leading-snug tracking-tight">
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
      <p class="mt-1.5 text-sm leading-6 text-[#5c626e]">
        {{ turns > 1 && !isAgent ? `這種問題來回 ${turns} 輪，` : '跑一次' }}約
        <b class="font-mono text-[#1d2129]">{{ fmtUSD(realSave.after) }}</b>
        <span v-if="rep.precise" class="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">🤖 AI 精算</span>
        · 錢主要花在<b class="text-[#1d2129]">{{ breakdown.plain.where }}</b
        ><template v-if="realSave.pct < 5">，所以省字幫助不大——省錢重點在右邊 →</template>
      </p>

      <div class="mt-4 flex min-h-0 flex-1 flex-col">
        <p class="flex shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">
          壓縮前 <span class="ml-auto font-mono normal-case tracking-normal">{{ result.original_tokens.toLocaleString('en-US') }} tokens</span>
        </p>
        <div class="mt-1.5 min-h-24 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-[#eae7de] bg-[#fdfcf8] p-3.5 font-mono text-[13px] leading-6 text-[#3c4250]">
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
        <div class="mt-1.5 min-h-24 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-emerald-200/70 bg-[#fdfcf8] p-3.5 font-mono text-[13px] leading-6 text-[#3c4250]">
          <template v-for="(s, i) in afterSegments" :key="i">
            <ins v-if="s.type === 'add'" class="rounded bg-emerald-50 text-emerald-700 no-underline">{{ s.text }}</ins>
            <span v-else>{{ s.text }}</span>
          </template>
        </div>
      </div>

      <p v-if="result.usage_estimate?.reason" class="mt-3 shrink-0 text-[13px] leading-6 text-[#767e8c]">
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
        <span v-if="rep.precise" class="ml-auto font-normal normal-case tracking-normal text-[#8b93a0]">🤖 AI 精算</span>
      </p>
      <template v-if="compare.hasCands">
        <ul class="mt-1">
          <li v-for="r in compare.rows" :key="r.m.id" class="flex items-center gap-3 border-b border-[#eeece6] py-2.5">
            <span class="w-44 truncate text-sm" :class="r.hot ? 'font-semibold' : ''">{{ r.m.name }}</span>
            <div class="h-2 flex-1 rounded-full bg-[#f0eee8]">
              <div
                class="h-full rounded-full"
                :class="r.hot ? 'bg-[#e8927c]' : r.best ? 'bg-emerald-400' : 'bg-[#b9b4a6]'"
                :style="{ width: `max(${r.bar}%, 4px)` }"
              />
            </div>
            <span
              class="w-[104px] shrink-0 text-right font-mono text-sm tabular-nums"
              :class="r.hot ? 'font-bold' : r.best ? 'font-bold text-emerald-600' : ''"
              >{{ unit === 'tokens' ? fmtTokDisp(r.tok, r.tokApprox) : fmtUSD(r.c) }}</span
            >
            <span class="w-16 shrink-0 text-right text-xs" :class="r.best ? 'font-semibold text-emerald-600' : 'text-[#767e8c]'">{{ r.label }}</span>
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
          class="mt-2.5 rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-4 py-2.5 text-sm leading-6 text-[#3c4250]"
        >
          ⭐ 同樣這個任務，改用 <b class="text-[#1d2129]">{{ compare.rec.m.name }}</b> 每次能省
          <b class="font-mono text-base text-emerald-700">{{ compare.recSave.toFixed(0) }}%</b>
          <span v-if="!compare.recInSel" class="text-[#767e8c]">（未在比較清單，可在分析頁勾選）</span>
          <span v-if="compare.free" class="text-[#767e8c]">·「{{ compare.free.name }}」還完全免費</span>
        </p>
      </template>
      <p v-else class="mt-2 text-sm leading-6 text-[#5c626e]">
        ✓ 你用的 <b>{{ modelPricing.name }}</b> 已是最省<span v-if="compare.free" class="text-[#8b93a0]">·「{{ compare.free.name }}」還完全免費</span>
      </p>

      <p class="mt-5 shrink-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">
        省錢建議 · 任務類型：{{ result.task_type }}
        <span class="ml-3 font-normal normal-case tracking-normal text-[#8b93a0]"
          >全部採用預估總共省 <b class="font-mono text-emerald-600">{{ result.total_estimated_saving_pct }}%</b></span
        >
      </p>
      <div class="mt-2 grid shrink-0 gap-3 sm:grid-cols-2">
        <div v-for="c in sugCards" :key="c.title" class="rounded-xl border border-[#e9e6dd] bg-[#f5f3ed] px-4 py-3">
          <div class="flex items-baseline gap-2">
            <p class="min-w-0 text-sm font-semibold leading-6">{{ c.icon }} {{ c.title }}</p>
            <span
              v-if="c.pct > 0"
              class="ml-auto shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-xs font-bold tabular-nums text-emerald-700"
              >省 {{ c.pct.toFixed(0) }}%</span
            >
          </div>
          <p class="mt-0.5 text-[13px] leading-5 text-[#767e8c]">{{ c.desc }}</p>
        </div>
      </div>

      <!-- 錢花在哪（配角：不加框，一行帶過） -->
      <div class="mt-5 shrink-0">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span class="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#767e8c]">錢花在哪</span>
          <div class="flex h-1.5 w-44 gap-0.5 overflow-hidden rounded-full">
            <div
              v-for="it in bdLegend"
              :key="it.key"
              class="h-full first:rounded-l-full last:rounded-r-full"
              :style="{ width: `max(${it.pct}%, 3px)`, background: it.color }"
            />
          </div>
          <span class="text-xs text-[#767e8c]">
            <template v-for="(it, i) in bdLegend" :key="it.key">
              <span :class="it.hot ? 'font-semibold text-[#1d2129]' : ''">{{ it.label }} {{ it.pct.toFixed(0) }}%</span>
              <span v-if="i < bdLegend.length - 1"> · </span>
            </template>
          </span>
          <span class="text-xs text-[#8b93a0]">💡 {{ breakdown.plain.act }}</span>
        </div>

        <!-- 訂閱者視角 -->
        <div v-if="subPlans.length" class="mt-3 divide-y divide-[#e9e6dd] overflow-hidden rounded-xl border border-[#e9e6dd] bg-[#f5f3ed]">
          <div v-for="s in subPlans" :key="s.plan.id" class="flex items-center gap-3 px-4 py-2">
            <b class="w-32 truncate text-sm text-[#1d2129]" :title="s.plan.note">💳 {{ s.plan.name }}</b>
            <span class="w-16 shrink-0 text-xs text-[#8b93a0]">{{ s.plan.price }}</span>
            <div class="h-1.5 max-w-52 flex-1 rounded-full bg-white/80" :title="`一則約佔每日額度 ${fmtPct(s.pct)}%`">
              <div class="h-full rounded-full bg-[#3987e5]" :style="{ width: `max(${Math.min(s.pct, 100)}%, 3px)` }" />
            </div>
            <span class="w-20 shrink-0 text-right font-mono text-sm tabular-nums text-[#1d2129]"
              >{{ fmtPct(s.pct) }}<span class="text-xs text-[#8b93a0]">%/則</span></span
            >
            <span class="w-24 shrink-0 text-right text-sm text-[#5c626e]"
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
