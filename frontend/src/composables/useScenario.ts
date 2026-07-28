/**
 * 即時情境判定引擎（純前端、零 API 花費）。
 *
 * 「表面 token × 固定 1.5 倍 output」對多數 prompt 是不準的：
 * - 需要網搜的問題，搜尋結果會回填 context，input 暴增
 * - 多輪對話每輪重送歷史
 * - Agent 型工作的消耗由工具呼叫輪數決定，跟 prompt 長度幾乎無關
 * - output 長度由任務類型決定（摘要 << 翻譯 << 寫程式/寫文章）
 *
 * 這裡用關鍵字規則做即時判定，輸出「誠實的區間」而非假精確的單一數字；
 * 按下壓縮後會再用 LLM 的判定校正。所有規則都是估算，寧粗勿假。
 */

export type Scenario = 'single' | 'search' | 'conversation' | 'agent'

export interface ScenarioInfo {
  id: Scenario
  label: string
  /** 手機版用的短標籤（空間不足時避免換行） */
  short: string
  icon: string
  note: string
  tone: 'ok' | 'warn' | 'info' | 'danger'
}

export const SCENARIOS: Record<Scenario, ScenarioInfo> = {
  single: {
    id: 'single',
    label: '問一次就好',
    short: '問一次',
    icon: '✅',
    note: '不需要外部資訊、一次回答就結束，估算相對可靠。',
    tone: 'ok',
  },
  search: {
    id: 'search',
    label: '要上網查',
    short: '上網查',
    icon: '🔍',
    note: '需要即時網路查詢：搜尋結果全文會塞回 context 當 input（每輪數千 tokens、可能查多輪），實際消耗遠大於你貼的文字。訂閱方案由供應商吸收搜尋成本，仍以訊息數計。',
    tone: 'warn',
  },
  agent: {
    id: 'agent',
    label: '整包工作',
    short: '整包',
    icon: '🤖',
    note: '建置/開發類複雜工作：消耗由工具呼叫與重試輪數決定，跟 prompt 長度幾乎無關，同一任務跑兩次都可能差 5-10 倍。此區間僅為公開實測參考，無法可靠預估。',
    tone: 'danger',
  },
  // conversation 不再是獨立「情境」——多輪是「輪數」維度（下方拉桿），任何情境都能疊加。
  // 保留 type 與資訊供後端 consumption_profile 相容顯示。
  conversation: {
    id: 'conversation',
    label: '來回討論',
    short: '多輪',
    icon: '💬',
    note: '多輪是輪數維度，不是任務型態——用下方輪數拉桿控制。',
    tone: 'info',
  },
}

/** 情境切換只給這三種任務型態；「多輪」是輪數維度，不放這裡 */
export const SELECTABLE_SCENARIOS: Scenario[] = ['single', 'search', 'agent']

/**
 * 整段 N 輪對話的累積消耗（API 無狀態，每輪重送全部歷史 → O(N²)）。
 * 第 i 輪 input = 前 i-1 輪的(user+assistant) + 這輪 user；output = 每輪固定。
 * turns=1 就退回單次。這是「多輪對 Claude 每日額度最可怕」的正確算法。
 */
export function conversationTotal(
  perTurnInput: number,
  perTurnOutput: number,
  turns: number,
): [number, number] {
  const N = Math.max(Math.round(turns), 1)
  const grow = perTurnInput + perTurnOutput
  const totalInput = (grow * N * (N - 1)) / 2 + perTurnInput * N
  const totalOutput = perTurnOutput * N
  return [totalInput, totalOutput]
}

export interface ScenarioEstimate {
  scenario: Scenario
  /** 命中的判定依據（顯示給使用者看，可被打臉、可手動切換） */
  signals: string[]
  /** 推估的任務輸出型態 */
  taskLabel: string
  /** 每次呼叫的實際 input token 區間（含情境 overhead） */
  inputRange: [number, number]
  /** output token 區間（依任務類型推估，含思考 token 加成） */
  outputRange: [number, number]
  /** false = 連區間都只是公開實測參考（agent 型） */
  reliable: boolean
  /** 依 prompt 特徵建議的預設輪數（延續型對話會建議多輪；一般 1） */
  suggestedTurns: number
}

type Rule = [RegExp, string]

const AGENT_RULES: Rule[] = [
  [
    /(建置|開發|做出?一個|寫出?一個|撰寫|幫我做|幫我寫|幫我建|打造|實作|建立?|架設?|生成|產出)[^。\n]{0,12}(個人)?(app|應用|網站|網頁|作品集|部落格|blog|系統|平台|遊戲|爬蟲|機器人|bot|專案|服務|後台|前端|後端)/i,
    '要求建置網站/應用/專案',
  ],
  [/(build|create|make|develop|write)\s+(me\s+)?(an?|the|a full|my)\s+(app|website|site|game|system|project|bot|tool|portfolio|blog)/i, '要求建置完整專案'],
  [/(重構|遷移|refactor|migrate)[^。\n]{0,10}(專案|系統|codebase|程式碼庫)/i, '大型程式改動'],
  [/(部署|上線|deploy)/i, '含部署工作'],
  [/(整個|完整的?)[^。\n]{0,6}(專案|系統|網站|流程)/, '範圍是完整系統'],
]

const SEARCH_RULES: Rule[] = [
  [/最新|即時|現況|近期|最近/, '要最新資訊'],
  [/今天|本週|這個月|今年|這屆|本屆|去年|昨天|明天/, '時間敏感詞'],
  [/新聞|股價|匯率|幣價|天氣|賽程|比分|票房|排行榜|排名/, '需要即時資料'],
  [/世足|世界盃|世界杯|奧運|世大運|nba|mlb|季後賽|總冠軍|金馬獎|金曲獎|大選|選舉/i, '賽事/時事，需即時資料'],
  [/(冠軍|奪冠|勝出|得主|當選)[^。\n]{0,4}(是誰|預測|分析|可能|會是|花落)?|誰[^。\n]{0,8}(贏|奪冠|冠軍|當選|勝出|最強)/, '預測賽果/名次'],
  [/(20[2-9]\d)\s*年?/, '提到近期年份'],
  [/(發布|上市|開賣|推出)了嗎/, '查證近期事件'],
  [/(latest|current|today|this (week|year)|news|stock price|who will win)/i, '要最新資訊（英）'],
]

const CONVERSATION_RULES: Rule[] = [
  [/剛剛|上面|前面(提到|說)|你(說過|剛說)|上一(題|輪|個)/, '引用先前對話'],
  [/繼續|接著(說|做|來)|再(給|來)一?(次|個)|換一(個|種)|另外|順便/, '延續型指令'],
  [/(規劃|安排)[^。\n]{0,8}(行程|旅遊|旅行|計畫|課表|菜單)/, '需要來回調整的規劃'],
  [/一步一步|一步步|逐步|陪我|帶我/, '教學/陪伴型互動'],
  [/(as (we|I) (discussed|mentioned)|earlier you said|continue|next step)/i, '延續型指令（英）'],
]

const REASONING_RULES: Rule[] = [
  [/分析|評估|比較|推理|推論|證明|深入|優缺點|利弊|可行性|預測/, '需要深度推理'],
  [/(analyze|compare|evaluate|prove|pros and cons|in depth)/i, '需要深度推理（英）'],
]

interface TaskProfile {
  label: string
  /** 依 input 比例 */
  ratio?: [number, number]
  /** 固定 token 區間 */
  fixed?: [number, number]
  /** 下限（比例型任務用） */
  min?: [number, number]
}

// 區間依 2026-07-12 Groq llama-3.3-70b 實測校準：模型幾乎都會附說明/格式/開場白，
// 「只回答案」的假設全面偏低——所有下限都要含說明成本（實測：翻譯短句 51、摘要 0.87×、
// 知識問答 608、程式 311、分類含理由 54 tokens）
const TASK_RULES: [RegExp, TaskProfile][] = [
  [/翻譯|translate/i, { label: '翻譯', ratio: [1.0, 2.5], min: [40, 90] }],
  [/摘要|總結|重點|概述|summar/i, { label: '摘要', ratio: [0.3, 0.9], min: [60, 200] }],
  [/改寫|潤飾|修飾|校對|rephrase|rewrite|proofread/i, { label: '改寫', ratio: [0.9, 1.8], min: [40, 90] }],
  [/分類|判斷是否|是不是|對不對|classify/i, { label: '分類判斷', fixed: [20, 150] }],
  [
    /(寫|補|改|修|產生?)[^。\n]{0,8}(程式|code|函式|function|script|SQL|regex)|debug|(python|javascript|typescript)/i,
    { label: '程式生成', fixed: [250, 3000] },
  ],
  [
    /(寫|生成|擬|產出)[^。\n]{0,8}(文章|故事|報告|企劃|文案|貼文|講稿|信|email)/i,
    { label: '長文寫作', fixed: [400, 4000] },
  ],
  [/分析|評估|比較|預測/, { label: '分析評估', fixed: [400, 2500] }],
]

/** 使用者有指定字數（「寫一篇 300 字…」）時輸出最可預測：中文 1 字 ≈ 1.3-1.4 token */
const WORD_COUNT_RE = /(\d{2,5})\s*(?:個)?字/

function matchRules(text: string, rules: Rule[]): string[] {
  const hits: string[] = []
  for (const [re, label] of rules) {
    if (re.test(text) && !hits.includes(label)) hits.push(label)
  }
  return hits
}

function estimateOutput(text: string, inputTokens: number): { label: string; range: [number, number] } {
  // 有明確字數要求時輸出最可預測：中文 1 字 ≈ 1.35 token，模型通常略超標
  const wc = text.match(WORD_COUNT_RE)
  if (wc) {
    const words = parseInt(wc[1], 10)
    const tk = words * 1.35
    return { label: `指定約 ${words} 字`, range: [Math.round(tk * 0.9), Math.round(tk * 1.4)] }
  }
  for (const [re, profile] of TASK_RULES) {
    if (re.test(text)) {
      if (profile.fixed) return { label: profile.label, range: profile.fixed }
      const lo = Math.max(inputTokens * profile.ratio![0], profile.min?.[0] ?? 40)
      const hi = Math.max(inputTokens * profile.ratio![1], profile.min?.[1] ?? 90)
      return { label: profile.label, range: [lo, hi] }
    }
  }
  // 一般問答/知識問答：實測「什麼是量子糾纏」→ 608 tokens，模型答得又長又完整，
  // 短問題的回答量跟 input 幾乎無關，用固定寬區間才誠實
  return { label: '一般問答', range: [120, 900] }
}

export function classifyScenario(
  text: string,
  inputTokens: number,
  force?: Scenario,
  opts?: { turns?: number },
): ScenarioEstimate {
  const agentHits = matchRules(text, AGENT_RULES)
  const searchHits = matchRules(text, SEARCH_RULES)
  const convHits = matchRules(text, CONVERSATION_RULES)
  const reasoningHits = matchRules(text, REASONING_RULES)

  // 情境只判 single / search / agent（多輪不是情境，見下方 suggestedTurns）
  let scenario: Scenario = 'single'
  let signals: string[] = []
  if (agentHits.length) {
    scenario = 'agent'
    signals = agentHits
  } else if (searchHits.length) {
    scenario = 'search'
    signals = searchHits
  }

  // 轉換型任務（翻譯/摘要/改寫/分類）的關鍵字常出現在「要處理的內容」裡，
  // 內容自帶、不需要查詢——把 search 誤判壓回 single
  const isTransformTask =
    /翻譯|translate|摘要|總結|summar|改寫|潤飾|校對|rephrase|rewrite|proofread|分類|classify/i.test(
      text,
    )
  if (scenario === 'search' && isTransformTask) {
    scenario = 'single'
    signals = ['轉換型任務：內容自帶，不需查詢']
  }
  if (force) {
    scenario = force
  }

  // 「延續型對話」特徵不改情境，而是建議把預設輪數拉高（多輪 = 輪數維度）
  let suggestedTurns = 1
  if (scenario !== 'agent' && convHits.length) {
    suggestedTurns = 8
    signals = [...signals, `${convHits[0]} → 預設多輪`]
  }

  const task = estimateOutput(text, inputTokens)
  let inputRange: [number, number] = [inputTokens, inputTokens]
  let outputRange = task.range
  let reliable = true

  switch (scenario) {
    case 'search':
      // 搜尋結果回填：每輪約 1.5K-5K tokens、常見 1-3 輪
      inputRange = [inputTokens + 1500, inputTokens + 10000]
      outputRange = [Math.max(outputRange[0], 250), Math.max(outputRange[1], 1500)]
      break
    case 'agent':
      // 消耗由工具迴圈決定，prompt 長度幾乎無關——公開實測的粗略區間
      inputRange = [50_000, 800_000]
      outputRange = [10_000, 150_000]
      reliable = false
      break
  }

  if (reasoningHits.length && scenario !== 'agent') {
    outputRange = [outputRange[0] * 1.3, outputRange[1] * 2.5]
    signals = [...signals, ...reasoningHits.map((h) => `${h}（思考 token 以 output 計費）`)]
  }

  // 輪數 > 1：改成「整段 N 輪對話的累積消耗」（O(N²)），而非單次第 N 輪。
  // agent 不套用（工具迴圈不是對話輪）。
  const turns = Math.max(opts?.turns ?? 1, 1)
  if (scenario !== 'agent' && turns > 1) {
    const [tiLo, toLo] = conversationTotal(inputRange[0], outputRange[0], turns)
    const [tiHi, toHi] = conversationTotal(inputRange[1], outputRange[1], turns)
    inputRange = [tiLo, tiHi]
    outputRange = [toLo, toHi]
  }

  return {
    scenario,
    signals,
    taskLabel: task.label,
    inputRange: [Math.round(inputRange[0]), Math.round(inputRange[1])],
    outputRange: [Math.round(outputRange[0]), Math.round(outputRange[1])],
    reliable,
    suggestedTurns,
  }
}
