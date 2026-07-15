<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CONSUMPTION_PROFILES,
  models,
  planShareForTokens,
  plansForProvider,
  providerColors,
  useCostUnit,
  useSelectedModels,
  useTurns,
  type ModelPricing,
  type SubscriptionPlan,
} from '../composables/usePricing'
import { conversationTotal } from '../composables/useScenario'
import { useTokenizer } from '../composables/useTokenizer'
import type { DiffSegment, OptimizeResult } from '../types'
import UnitToggle from './UnitToggle.vue'

const selectedIds = useSelectedModels()

const props = defineProps<{
  result: OptimizeResult
  modelPricing: ModelPricing
}>()

const profile = computed(
  () => CONSUMPTION_PROFILES[props.result.consumption_profile] ?? CONSUMPTION_PROFILES.single,
)

// 精算代表值（區間中位數）；沒有 usage_estimate 時退回粗估
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
// 你用的模型的輸出詳簡係數（估算）：output/思考 token 相對基準的倍率，成本與額度計算都要乘
const curVerb = computed(() => props.modelPricing.verbosity ?? 1)

// 多輪：優化結果的成本/額度改「整段 N 輪累積」（O(N²)），跟即時分析的輪數連動。agent 不套用。
const turns = useTurns()
const isAgent = computed(() => props.result.consumption_profile === 'agent')
const N = computed(() => (isAgent.value ? 1 : Math.max(turns.value, 1)))
/** 給每輪的 input/output，回傳整段 N 輪的 [totalInput, totalOutput] */
function seg(perTurnIn: number, perTurnOut: number): [number, number] {
  return conversationTotal(perTurnIn, perTurnOut, N.value)
}

// 壓縮後成本區間（精算，含整段輪數）
const afterCost = computed(() => {
  const e = props.result.usage_estimate
  const m = props.modelPricing
  const inR = m.input_per_1m / 1_000_000
  const outR = m.output_per_1m / 1_000_000
  const v = curVerb.value
  if (e) {
    const [tiLo, toLo] = seg(props.result.compressed_tokens + e.context_overhead_min, e.expected_output_min * v)
    const [tiHi, toHi] = seg(props.result.compressed_tokens + e.context_overhead_max, e.expected_output_max * v)
    return { lo: (tiLo * inR + toLo * outR) * e.calls_min, hi: (tiHi * inR + toHi * outR) * e.calls_max }
  }
  const [ti, to] = seg(props.result.compressed_tokens, rep.value.out * v)
  const base = ti * inR + to * outR
  return { lo: base * profile.value.mult[0], hi: base * profile.value.mult[1] }
})

// 第 1 點：真實省 %（壓縮前後整段總成本，含 output——比只看 input 誠實）
const realSave = computed(() => {
  const { ctx, calls } = rep.value
  const out = rep.value.out * curVerb.value
  const [tiB, toB] = seg(props.result.original_tokens + ctx, out)
  const [tiA, toA] = seg(props.result.compressed_tokens + ctx, out)
  const before = calls * (tiB * IN_RATE.value + toB * OUT_RATE.value)
  const after = calls * (tiA * IN_RATE.value + toA * OUT_RATE.value)
  return { before, after, pct: before > 0 ? (1 - after / before) * 100 : 0 }
})

// 第 2 點：錢花在哪（壓縮後單次，拆 input / output / context），並翻成白話
const breakdown = computed(() => {
  const { ctx } = rep.value
  const out = rep.value.out * curVerb.value
  const ci = props.result.compressed_tokens * IN_RATE.value
  const cc = ctx * IN_RATE.value
  const co = out * OUT_RATE.value
  const s = ci + cc + co || 1
  const input = (ci / s) * 100
  const output = (co / s) * 100
  const context = (cc / s) * 100
  let hot: 'input' | 'output' | 'context' = 'output'
  if (ci >= co && ci >= cc) hot = 'input'
  else if (cc >= co && cc >= ci) hot = 'context'
  // 白話：哪塊最花錢、對一般人怎麼省
  const plain = {
    output: { where: 'AI 的回覆', pct: output, act: '在指令加一句「請精簡回答」或限制字數，最能降成本' },
    input: { where: '你的 prompt 本身', pct: input, act: '壓縮 prompt、或把固定說明開啟 caching 最有效' },
    context: { where: '額外查到的資料', pct: context, act: '減少要模型檢索或讀取的內容' },
  }[hot]
  return { input, output, context, hasCtx: ctx > 0.5, hot, plain }
})

// 錢花在哪的三色圖例（顏色 + 文字並行，不單靠顏色辨識；最花錢的那段加粗）
const breakdownLegend = computed(() => {
  const b = breakdown.value
  const items = [
    { key: 'input', label: '你的 prompt', pct: b.input, color: '#3987e5' },
    { key: 'output', label: 'AI 回覆', pct: b.output, color: '#199e70' },
    ...(b.hasCtx ? [{ key: 'context', label: '額外資料', pct: b.context, color: '#c98500' }] : []),
  ]
  return items.map((it) => ({ ...it, hot: it.key === b.hot }))
})

// 用精算數字算某模型的壓縮後成本（整段 N 輪；output 乘該模型的輸出詳簡係數）
function modelCost(m: ModelPricing): number {
  const { out, ctx, calls } = rep.value
  const [ti, to] = seg(props.result.compressed_tokens + ctx, out * (m.verbosity ?? 1))
  return (
    (calls * (ti * m.input_per_1m + to * m.output_per_1m)) /
    1_000_000
  )
}

// ---- 成本欄單位切換（與即時分析的 API 成本對比共用同一份狀態） ----
const unit = useCostUnit()
const { count } = useTokenizer()
const compTokO200k = computed(() => count(props.result.compressed_prompt, 'o200k_base'))
const compTokCl100k = computed(() => count(props.result.compressed_prompt, 'cl100k_base'))

/** 這個任務在某模型的預估 token 消耗（同成本的精算基礎；
 *  input 依該模型 tokenizer 換算、output 乘該模型的輸出詳簡係數） */
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
  barCls: string
  txtCls: string
  label: string
  labelCls: string
}

// 第 4 點：你用的 vs 勾選中最省 vs 全站最省（三條 bar，自動去重）
const compare = computed(() => {
  const rank = (list: ModelPricing[]) =>
    list
      .filter((m) => !m.free)
      .map((m) => ({ m, c: modelCost(m) }))
      .sort((a, b) => a.c - b.c)[0] ?? null
  const yourId = props.modelPricing.id
  const yourCost = modelCost(props.modelPricing)
  const bestSel = rank(models.filter((m) => selectedIds.value.includes(m.id))) // 勾選中最省
  const bestAll = rank(models) // 全站最省（不限勾選）
  const free =
    models.filter((m) => m.free).find((m) => selectedIds.value.includes(m.id)) ??
    models.find((m) => m.free) ??
    null

  // 候選：去重、只留比「你用的」便宜的（勾選最省 → 全站最省）
  const cands: { m: ModelPricing; c: number; scope: 'sel' | 'all' }[] = []
  const seen = new Set([yourId])
  const consider = (e: { m: ModelPricing; c: number } | null, scope: 'sel' | 'all') => {
    if (!e || seen.has(e.m.id) || e.c >= yourCost) return
    seen.add(e.m.id)
    cands.push({ ...e, scope })
  }
  consider(bestSel, 'sel')
  consider(bestAll, 'all')
  const hasBoth = cands.length === 2 // 勾選最省與全站最省是不同模型

  // bar 長度依目前檢視單位（$/次 或 token 數）成比例；候選一律以成本挑選
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
      barCls: 'bg-spend/70',
      txtCls: 'text-txt',
      label: '你用的',
      labelCls: 'text-txt-dim',
    },
    ...cands.map((e): BarRow => {
      const isAll = e.scope === 'all' && hasBoth
      return {
        m: e.m,
        c: e.c,
        tok: modelTok(e.m),
        tokApprox: e.m.provider !== 'OpenAI',
        bar: (metric(e.m, e.c) / base) * 100,
        barCls: isAll ? 'bg-info' : 'bg-save',
        txtCls: isAll ? 'text-info' : 'text-save',
        label: hasBoth ? (e.scope === 'sel' ? '勾選中' : '全站最省') : '最省',
        labelCls: isAll ? 'text-info' : 'text-save',
      }
    }),
  ]

  // 推薦 = 成本最低的候選（bestAll 一定 ≤ bestSel）
  const rec = cands[cands.length - 1] ?? null
  const yourTok = modelTok(props.modelPricing)
  return {
    rows,
    hasCands: cands.length > 0,
    free,
    rec,
    recSave: rec && yourCost > 0 ? (1 - rec.c / yourCost) * 100 : 0,
    // token 檢視用：推薦模型的 token 消耗相對你用的差多少 %（正 = 較省）
    recTokDiff: rec && yourTok > 0 ? (1 - modelTok(rec.m) / yourTok) * 100 : 0,
    recInSel: rec ? selectedIds.value.includes(rec.m.id) : true,
  }
})

// ── 訂閱者視角：依「你用的模型」的提供商，關聯到對應訂閱方案，看額度而非錢 ──
const subPlans = computed(() => plansForProvider(props.modelPricing.provider))
const subView = computed(() => {
  const { ctx, calls } = rep.value
  const out = rep.value.out * curVerb.value
  const [tiB, toB] = seg(props.result.original_tokens + ctx, out)
  const [tiA, toA] = seg(props.result.compressed_tokens + ctx, out)
  const beforeTok = (tiB + toB) * calls
  const afterTok = (tiA + toA) * calls
  return subPlans.value.map((p) => {
    const b = planShareForTokens(beforeTok, p)
    const a = planShareForTokens(afterTok, p)
    return {
      plan: p,
      afterPct: a.pct,
      qBefore: b.pct > 0 ? Math.floor(100 / b.pct) : 0,
      qAfter: a.pct > 0 ? Math.floor(100 / a.pct) : 0,
      limitedBy: a.limitedBy,
      helps: a.pct < b.pct - 0.01,
    }
  })
})
/** 方案的每日總額度（顯示卡住的那種限制；tooltip 看全部） */
function quotaText(row: { plan: SubscriptionPlan; limitedBy: 'messages' | 'tokens' }): string {
  const p = row.plan
  const tokTxt = p.daily_tokens
    ? p.daily_tokens >= 1_000_000
      ? `${(p.daily_tokens / 1_000_000).toFixed(p.daily_tokens % 1_000_000 ? 1 : 0)}M tok/天`
      : `${(p.daily_tokens / 1_000).toFixed(0)}K tok/天`
    : ''
  const msgTxt = p.daily_messages ? `≈${p.daily_messages.toLocaleString('en-US')} 則/天` : ''
  return (row.limitedBy === 'messages' ? msgTxt : tokTxt) || msgTxt || tokTxt
}
// 依主導限制給誠實提示：訊息數限制時壓縮幫助有限，token 限制時壓縮有感；
// Agent 型工作（如寫網站）的實際消耗是「一整個工作階段」而非單則訊息，額外警告
const subLimitHint = computed(() => {
  const any = subView.value[0]
  if (!any) return ''
  if (isAgent.value)
    return '這裡算的是「單則訊息」的額度佔比；但這類工作實際是多輪來回 + 工具呼叫的整個工作階段，公開實測消耗是單則的 100–1000 倍，額度可能做 1–2 個任務就用完。'
  return any.limitedBy === 'messages'
    ? '這些方案以「訊息則數」計額度，壓縮單則幫助有限——額度殺手是長對話累積（每則都重送整段歷史），換新主題就開新對話最省。'
    : '這些方案卡每日 token 額度，壓縮直接讓每天能多問幾次。'
})
function fmtPct(pct: number): string {
  if (pct < 0.1) return '<0.1'
  if (pct >= 100) return '100'
  return pct.toFixed(1)
}

const copied = ref(false)
const beforeSegments = computed<DiffSegment[]>(() => props.result.diff.filter((s) => s.type !== 'add'))
const afterSegments = computed<DiffSegment[]>(() => props.result.diff.filter((s) => s.type !== 'delete'))

async function copyCompressed() {
  await navigator.clipboard.writeText(props.result.compressed_prompt)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

function formatUSD(value: number): string {
  if (value === 0) return '$0'
  if (value < 0.000001) return '<$0.000001'
  return '$' + (value < 0.01 ? value.toFixed(6) : value.toFixed(4))
}

/** 壓縮後 prompt 的 token 數顯示（token 檢視） */
function fmtTok(n: number, approx: boolean): string {
  const s = n >= 10_000 ? (n / 1_000).toFixed(1) + 'K' : Math.round(n).toLocaleString('en-US')
  return `${approx ? '≈' : ''}${s} tok`
}
</script>

<template>
  <section class="card flex flex-col gap-3 p-4">
    <!-- 壓縮成果一行（次要，緊湊）：壓縮率 / 省 tokens / 真實省 / 壓縮後實際成本 -->
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-panel-2/50 px-3.5 py-2 text-[11px] text-txt-dim"
    >
      <span
        >壓縮
        <span class="font-mono font-semibold" :class="result.reduction_pct > 0 ? 'text-save' : 'text-txt'"
          >-{{ result.reduction_pct }}%</span
        ></span
      >
      <span
        >省
        <span class="font-mono text-save"
          >-{{ (result.original_tokens - result.compressed_tokens).toLocaleString('en-US') }}</span
        >
        tokens</span
      >
      <span title="含 output 的總成本省下比例，比只看 input 誠實"
        >真實省(總成本)
        <span class="font-mono text-save">-{{ realSave.pct < 0.1 ? '<0.1' : realSave.pct.toFixed(1) }}%</span></span
      >
      <span class="ml-auto flex items-center gap-1"
        >{{ profile.icon }} {{ turns > 1 && !isAgent ? `${turns} 輪整段` : '單次' }}實際
        <span class="font-mono font-semibold text-txt"
          >{{ formatUSD(afterCost.lo) }}–{{ formatUSD(afterCost.hi) }}</span
        >
        <span v-if="rep.precise" class="rounded bg-save/15 px-1 py-px font-semibold text-save">AI 精算</span></span
      >
    </div>

    <!-- 換模型能省多少（視覺化 bar 對比，主角）-->
    <div class="rounded-xl bg-panel-2/50 px-3.5 py-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="section-label">換個模型能省多少</span>
          <UnitToggle />
        </div>
        <span v-if="rep.precise" class="rounded bg-save/15 px-1.5 py-0.5 text-[10px] font-medium text-save"
          >🤖 AI 精算</span
        >
      </div>

      <template v-if="compare.hasCands">
        <div class="flex flex-col gap-2">
          <div v-for="(r, i) in compare.rows" :key="r.m.id" class="flex items-center gap-2.5">
            <div class="flex w-32 shrink-0 items-center gap-1.5">
              <span
                class="h-2 w-2 shrink-0 rounded-full"
                :style="{ backgroundColor: providerColors[r.m.provider] }"
              />
              <span class="truncate text-xs" :class="i > 0 ? 'font-medium text-txt' : 'text-txt'">{{
                r.m.name
              }}</span>
            </div>
            <div class="h-3.5 flex-1 overflow-hidden rounded-md bg-panel">
              <div class="h-3.5 rounded-md" :class="r.barCls" :style="{ width: `max(${r.bar}%, 6px)` }" />
            </div>
            <span
              class="w-20 shrink-0 text-right font-mono text-[11px] tabular-nums"
              :class="[r.txtCls, i > 0 ? 'font-semibold' : '']"
              >{{ unit === 'tokens' ? fmtTok(r.tok, r.tokApprox) : formatUSD(r.c) }}</span
            >
            <span
              class="w-14 shrink-0 text-right text-[10px]"
              :class="[r.labelCls, i > 0 ? 'font-semibold' : '']"
              >{{ r.label }}</span
            >
          </div>
        </div>
        <p v-if="compare.rec && unit === 'tokens'" class="mt-2 text-xs text-txt-dim">
          換模型 token 消耗差不多（<span class="font-medium text-txt">{{ compare.rec.m.name }}</span>
          {{ compare.recTokDiff >= 0 ? '只少' : '反而多' }}
          <span class="font-mono tabular-nums">{{ Math.abs(compare.recTokDiff).toFixed(0) }}%</span
          >）——「省 {{ compare.recSave.toFixed(0) }}%」省在<span class="text-txt">單價</span>，切回「成本/次」看金額。
        </p>
        <p v-else-if="compare.rec" class="mt-2 text-xs text-txt-dim">
          同樣這個任務，改用
          <span class="font-medium text-txt">{{ compare.rec.m.name }}</span> 每次能省
          <span class="font-semibold text-save">{{ compare.recSave.toFixed(0) }}%</span>
          <span v-if="!compare.recInSel" class="text-info/80">（未在你的比較清單，勾選它可加入對比）</span>
          <span v-if="compare.free" class="text-txt-dim/70"> ·「{{ compare.free.name }}」還完全免費</span>
        </p>
      </template>
      <p v-else class="text-sm text-txt">
        ✓ 你用的
        <span class="font-medium">{{ modelPricing.name }}</span> 已是最省（{{
          formatUSD(compare.rows[0].c)
        }}/次）<span v-if="compare.free" class="text-txt-dim/70"> ·「{{ compare.free.name }}」還完全免費</span>
      </p>
    </div>

    <!-- 訂閱者視角（次要資訊，每方案一行 + 小量值條）：月費固定、看的是額度不是錢 -->
    <div class="flex flex-col gap-1 rounded-xl bg-panel-2/50 px-3.5 py-2">
      <div class="flex items-center gap-2">
        <span class="section-label">💳 訂閱者省下的額度</span>
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :style="{ backgroundColor: providerColors[modelPricing.provider] }"
        />
        <span class="text-[10px] text-txt-dim/80">{{ modelPricing.provider }} · 估算</span>
      </div>
      <template v-if="subView.length">
        <div v-for="row in subView" :key="row.plan.id" class="flex items-center gap-2 text-[11px]">
          <span class="w-24 shrink-0 truncate text-txt">{{ row.plan.name }}</span>
          <span class="w-12 shrink-0 text-[10px] text-txt-dim/70">{{ row.plan.price }}</span>
          <span
            class="w-24 shrink-0 truncate text-[10px] text-txt-dim/70"
            :title="`每日總額度（估算）：${row.plan.daily_messages ? `約 ${row.plan.daily_messages.toLocaleString()} 則` : ''}${row.plan.daily_messages && row.plan.daily_tokens ? '、' : ''}${row.plan.daily_tokens ? `${(row.plan.daily_tokens / 1_000_000).toFixed(1)}M tokens` : ''}`"
            >上限 {{ quotaText(row) }}</span
          >
          <!-- 比例圖：這則訊息用掉每日額度的比例 -->
          <div
            class="flex h-1.5 max-w-36 flex-1 overflow-hidden rounded-full bg-panel"
            :title="`這則訊息約用掉每日額度的 ${fmtPct(row.afterPct)}%`"
          >
            <div
              class="h-full rounded-full bg-[#3987e5]"
              :style="{ width: `max(${Math.min(row.afterPct, 100)}%, 3px)` }"
            />
          </div>
          <span class="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-txt-dim"
            >{{ fmtPct(row.afterPct) }}%/則</span
          >
          <span class="ml-auto whitespace-nowrap font-mono tabular-nums text-txt-dim"
            >每天約 <span class="font-semibold text-txt">{{ row.qAfter.toLocaleString() }}</span> 次<span
              v-if="row.helps"
              class="text-save"
            >
              (+{{ (row.qAfter - row.qBefore).toLocaleString() }})</span
            ></span
          >
        </div>
        <p class="text-[10px] leading-snug" :class="isAgent ? 'text-[#e5b558]' : 'text-txt-dim/70'">
          {{ isAgent ? '⚠️' : '💡' }} {{ subLimitHint }}
        </p>
      </template>
      <p v-else class="text-[11px] text-txt-dim">
        {{ modelPricing.provider }} 無主流訂閱方案，屬 API 按量計價——看上方每次成本即可。
      </p>
    </div>

    <!-- 壓縮前 / 壓縮後 左右並排 -->
    <div class="grid gap-3 md:grid-cols-2">
      <div class="flex min-w-0 flex-col">
        <div class="flex h-6 items-center justify-between px-1 pb-1">
          <span class="text-[11px] font-semibold text-txt-dim">壓縮前</span>
          <span class="font-mono text-[11px] tabular-nums text-txt-dim"
            >{{ result.original_tokens.toLocaleString('en-US') }} tokens</span
          >
        </div>
        <div
          class="max-h-40 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-base/70 px-3 py-2 font-mono text-[11px] leading-[1.6]"
        >
          <template v-for="(seg, i) in beforeSegments" :key="i">
            <del
              v-if="seg.type === 'delete'"
              class="rounded-sm bg-spend/15 text-spend/90 no-underline line-through"
              >{{ seg.text }}</del
            >
            <span v-else class="text-txt">{{ seg.text }}</span>
          </template>
        </div>
      </div>

      <div class="flex min-w-0 flex-col">
        <div class="flex h-6 items-center justify-between px-1 pb-1">
          <span class="text-[11px] font-semibold text-save">壓縮後</span>
          <div class="flex items-center gap-2">
            <span class="font-mono text-[11px] tabular-nums text-txt-dim"
              >{{ result.compressed_tokens.toLocaleString('en-US') }} tokens</span
            >
            <button
              type="button"
              class="rounded-md border border-line bg-panel-2 px-2 py-0.5 text-[11px] font-medium transition-colors"
              :class="copied ? 'border-save/40 text-save' : 'text-txt-dim hover:text-txt'"
              @click="copyCompressed"
            >
              {{ copied ? '✓ 已複製' : '📋 複製' }}
            </button>
          </div>
        </div>
        <div
          class="max-h-40 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-save/25 bg-base/70 px-3 py-2 font-mono text-[11px] leading-[1.6]"
        >
          <template v-for="(seg, i) in afterSegments" :key="i">
            <ins v-if="seg.type === 'add'" class="rounded-sm bg-save/15 text-save no-underline">{{
              seg.text
            }}</ins>
            <span v-else class="text-txt">{{ seg.text }}</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 錢主要花在哪 → 怎麼省（白話建議性質，放最後靠近省錢建議，不卡在數據中）-->
    <div class="flex flex-col gap-1 rounded-xl bg-panel-2/50 px-3.5 py-2">
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
        <span class="section-label">錢花在哪</span>
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px]">
          <span
            v-for="it in breakdownLegend"
            :key="it.key"
            class="flex items-center gap-1"
            :class="it.hot ? 'font-semibold text-txt' : 'text-txt-dim'"
          >
            <span class="h-1.5 w-1.5 rounded-sm" :style="{ backgroundColor: it.color }" />
            {{ it.label }}
            <span class="font-mono tabular-nums">{{ it.pct.toFixed(0) }}%</span>
          </span>
        </div>
      </div>
      <div class="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full">
        <div
          v-for="it in breakdownLegend"
          :key="it.key"
          class="h-full rounded-sm first:rounded-l-full last:rounded-r-full"
          :style="{ width: `max(${it.pct}%, 4px)`, backgroundColor: it.color }"
          :title="`${it.label} ${it.pct.toFixed(0)}%`"
        />
      </div>
      <p class="text-[11px] leading-snug text-txt-dim">
        💡 主要花在<span class="font-medium text-txt">{{ breakdown.plain.where }}</span
        >——{{ breakdown.plain.act }}。
      </p>
    </div>
  </section>
</template>
