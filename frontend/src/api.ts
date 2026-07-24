import { models } from './composables/usePricing'
import type { OptimizeResult } from './types'

// 一律用同網域相對路徑：部署在 Vercel 時前後端同一個網域，
// 本機開發則由 vite.config.ts 的 proxy 轉給後端（預設 localhost:8000）。
const API_BASE = ''

// 給 LLM 的模型清單摘要（含提供商，讓「同品牌推薦」挑得出來）
const availableModels = models.map(
  (m) =>
    `${m.provider}｜${m.name}｜$${m.input_per_1m}/$${m.output_per_1m}${m.free ? '（免費）' : ''}｜效能 ${m.perf}`,
)

/** 從 prompt 中解析出 [[ ]] 保護段落的內容 */
export function parseProtectedSections(prompt: string): string[] {
  return [...prompt.matchAll(/\[\[([\s\S]*?)\]\]/g)].map((m) => m[1].trim()).filter(Boolean)
}

export async function optimizePrompt(
  prompt: string,
  currentModel: string,
): Promise<OptimizeResult> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        protected_sections: parseProtectedSections(prompt),
        // 傳顯示名稱而非內部 id，LLM 比較看得懂
        current_model: models.find((m) => m.id === currentModel)?.name ?? currentModel,
        available_models: availableModels,
      }),
    })
  } catch {
    throw new Error('連不上後端——本機開發請確認後端已啟動（見 SETUP.md）')
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      // 非 JSON 錯誤內容就用狀態碼
    }
    throw new Error(detail)
  }

  return res.json() as Promise<OptimizeResult>
}
