import { ref, watch, type Ref } from 'vue'
import pricingData from '../data/pricing.json'
import subscriptionData from '../data/subscriptions.json'
import type { EncodingName } from './useTokenizer'

export interface ModelPricing {
  id: string
  name: string
  provider: string
  encoding: EncodingName
  input_per_1m: number
  output_per_1m: number
  free: boolean
  popular: boolean
  /** Artificial Analysis Intelligence Index（0-100） */
  perf: number
  /** true = 找不到公開分數，為估算值 */
  perf_est: boolean
  /** 輸出詳簡係數：output/思考 token 相對倍率（AA Intelligence Index 輸出量 ÷ 推理模型中位數 62M） */
  verbosity: number
  /** true = AA 無數據，為估算值 */
  verbosity_est: boolean
}

export interface SubscriptionPlan {
  id: string
  name: string
  price: string
  /** 該方案涵蓋哪些模型提供商（用來跟「你選的模型」關聯） */
  providers: string[]
  /** entry / mid / high 階層，方便同生態內對比 */
  tier: 'entry' | 'mid' | 'high'
  daily_messages: number | null
  daily_tokens: number | null
  note: string
  popular: boolean
}

/** 假設 output token 數 = input 的 1.5 倍（規格書的估算基準） */
export const OUTPUT_RATIO = 1.5

export const models = pricingData.models as unknown as ModelPricing[]
export const providers: string[] = pricingData.providers
export const plans = subscriptionData.plans as unknown as SubscriptionPlan[]
export const subscriptionDisclaimer: string = subscriptionData.disclaimer
export const pricingUpdated: string = pricingData.updated
export const perfSource: string = pricingData.perf_source

export const defaultModelIds = models.filter((m) => m.popular).map((m) => m.id)
export const defaultPlanIds = plans.filter((p) => p.popular).map((p) => p.id)

/** 選了某模型 → 該提供商對應的訂閱方案（空陣列 = 該家無主流訂閱，屬 API 計價） */
export function plansForProvider(provider: string): SubscriptionPlan[] {
  return plans.filter((p) => p.providers.includes(provider))
}

/**
 * 提供商識別色（中間暗色底 #2e2e35 驗證過的類別色盤，依 providers 固定順序指派、不循環）。
 * 色點永遠伴隨文字名稱出現——識別不單靠顏色。
 */
// 第 7 色 #0e8f9e（藍綠）經色盲模擬檢核：與既有 6 色的最小 ΔE 32.1（protan/deutan），
// 對淺色底 #faf9f6 對比 3.67:1，皆通過。色點旁一律有模型名稱，識別不單靠顏色。
const PROVIDER_PALETTE = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#0e8f9e', '#e66767']
export const providerColors: Record<string, string> = Object.fromEntries(
  providers.map((p, i) => [p, PROVIDER_PALETTE[i % PROVIDER_PALETTE.length]]),
)

export interface ModelCost {
  input: number
  output: number
  total: number
}

/**
 * 消耗型態 → 實際消耗相對「表面 token 估算」的倍率區間。
 * 搜尋結果回填 context、思考 token、多輪工具呼叫都不會出現在你貼的文字裡，
 * 這些倍率是公開實測的粗略區間，寧可顯示誠實的區間也不顯示精確但錯誤的數字。
 */
export const CONSUMPTION_PROFILES: Record<
  string,
  { label: string; icon: string; mult: [number, number]; note: string; tone: 'ok' | 'warn' | 'danger' | 'info' }
> = {
  single: {
    label: '單輪自足任務',
    icon: '✅',
    mult: [1, 1],
    note: '不需要外部資訊，上面的估算相對可靠。',
    tone: 'ok',
  },
  search: {
    label: '需要網路查詢的任務',
    icon: '🔍',
    mult: [20, 100],
    note: '搜尋結果全文會塞回 context 當 input、可能查好幾輪，實際消耗通常是表面 token 的 20–100 倍。訂閱方案因為供應商吸收搜尋成本，仍以訊息數計。',
    tone: 'warn',
  },
  conversation: {
    label: '多輪對話型任務',
    icon: '💬',
    mult: [5, 30],
    note: '每一輪都會重送全部歷史，整段對話的消耗約以輪數平方成長——用「即時分析」分頁下方的對話成本計算器估整段對話比較準。',
    tone: 'info',
  },
  agent: {
    label: 'Agent 型複雜工作',
    icon: '🤖',
    mult: [100, 1000],
    note: '消耗取決於工具呼叫與重試輪數，同一任務跑兩次都可能差 5-10 倍，無法可靠預估；此區間僅為公開實測參考。',
    tone: 'danger',
  },
}

export function computeCost(inputTokens: number, model: ModelPricing): ModelCost {
  const input = (inputTokens * model.input_per_1m) / 1_000_000
  const output = (inputTokens * OUTPUT_RATIO * model.output_per_1m) / 1_000_000
  return { input, output, total: input + output }
}

export interface PlanShare {
  /** 一次提問約佔每日額度的百分比（取訊息數/token 兩種限制中較緊者） */
  pct: number
  /** 目前是哪種限制卡住：短 prompt 通常是訊息數，長 prompt 是 token 量 */
  limitedBy: 'messages' | 'tokens'
  /** 訊息數限制的固定佔比（1/每日訊息數） */
  msgShare: number
  /** token 限制的佔比（隨用量變動） */
  tokenShare: number
}

/**
 * 一次提問同時消耗「1 則訊息」和「N 個 token」，實際額度取較緊的那個：
 * 短 prompt 受訊息數上限（% 固定），token 用量大時改受 token 額度（% 隨用量成長）。
 * tokensPerQuery 傳入「情境推估的 input + output」，不是表面 token。
 */
export function planShareForTokens(tokensPerQuery: number, plan: SubscriptionPlan): PlanShare {
  const msgShare = plan.daily_messages ? 100 / plan.daily_messages : 0
  const tokenShare = plan.daily_tokens
    ? (Math.max(tokensPerQuery, 1) / plan.daily_tokens) * 100
    : 0
  const pct = Math.min(Math.max(msgShare, tokenShare), 100)
  return {
    pct,
    limitedBy: tokenShare > msgShare ? 'tokens' : 'messages',
    msgShare,
    tokenShare: Math.min(tokenShare, 100),
  }
}

/** 勾選狀態記在 localStorage，下次打開網頁還原；只保留仍存在於設定檔的 id */
export function usePersistedSelection(
  storageKey: string,
  validIds: string[],
  defaults: string[],
): Ref<string[]> {
  const selected = ref<string[]>([...defaults])
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const kept = parsed.filter((id): id is string => validIds.includes(id))
        if (kept.length > 0) selected.value = kept
      }
    }
  } catch {
    // localStorage 資料壞掉就用預設值
  }
  watch(
    selected,
    (value) => localStorage.setItem(storageKey, JSON.stringify(value)),
    { deep: true },
  )
  return selected
}

/**
 * 全站共用的勾選狀態（module-level singleton）：成本對比表的勾選要能被優化結果
 * 的「最省模型」引用，所以提升到這裡，兩個元件拿到同一個 ref。
 */
let _selectedModels: Ref<string[]> | null = null
export function useSelectedModels(): Ref<string[]> {
  if (!_selectedModels) {
    _selectedModels = usePersistedSelection(
      'promptmiser.models',
      models.map((m) => m.id),
      defaultModelIds,
    )
  }
  return _selectedModels
}

let _selectedPlans: Ref<string[]> | null = null
export function useSelectedPlans(): Ref<string[]> {
  if (!_selectedPlans) {
    _selectedPlans = usePersistedSelection(
      'promptmiser.plans',
      plans.map((p) => p.id),
      defaultPlanIds,
    )
  }
  return _selectedPlans
}

/** 對話輪數（全站共用）：即時分析拉桿與優化結果的整段消耗算同一個值 */
let _turns: Ref<number> | null = null
export function useTurns(): Ref<number> {
  if (!_turns) _turns = ref(1)
  return _turns
}

/** 成本欄顯示單位（全站共用）：'cost' = 依情境推估的 $/次，'tokens' = 這段 prompt 經各模型
 *  tokenizer 編碼後的 token 數。API 成本對比表與「換個模型」共用同一個切換，且只切換成本那一欄。 */
export type CostUnit = 'cost' | 'tokens'
let _costUnit: Ref<CostUnit> | null = null
export function useCostUnit(): Ref<CostUnit> {
  if (!_costUnit) _costUnit = ref<CostUnit>('cost')
  return _costUnit
}
