/**
 * 「複製並前往」交棒：把壓縮後的 prompt 送到對應廠商的聊天室。
 *
 * 為什麼是「複製 + 開新分頁」而不是用網址帶 prompt（?q=）：
 * - Claude 只有桌面版 app 的 claude:// scheme 有官方支援（且僅預填不送出、上限約 14000 字元），
 *   沒安裝桌面版的人點了不會有反應；網頁版的 ?q= 已因 prompt injection 疑慮被拿掉。
 * - ChatGPT / Gemini 的 ?q= 都要另外裝瀏覽器擴充功能才會生效，原生無效。
 * - Grok / DeepSeek / Kimi 查不到任何可靠的預填格式。
 * 也就是說「網址預填」對多數使用者是壞的，而且會隨對方改版無聲失效。
 * 改成先寫入剪貼簿再開分頁，使用者到站後 Ctrl+V 即可——不依賴任何一家的網址行為，
 * 沒有長度上限，也沒有把 prompt 塞進網址（會進瀏覽器紀錄／Referer）的隱私問題。
 */

/** 聊天室目的地；key 對應 pricing.json 的 provider 名稱 */
export interface ChatDestination {
  /** 按鈕上的品牌名（非供應商名，例如 Moonshot 的產品叫 Kimi） */
  label: string
  url: string
}

export const CHAT_DESTINATIONS: Record<string, ChatDestination> = {
  OpenAI: { label: 'ChatGPT', url: 'https://chatgpt.com/' },
  Anthropic: { label: 'Claude', url: 'https://claude.ai/new' },
  Google: { label: 'Gemini', url: 'https://gemini.google.com/app' },
  xAI: { label: 'Grok', url: 'https://grok.com/' },
  DeepSeek: { label: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  Moonshot: { label: 'Kimi', url: 'https://www.kimi.com/' },
  // Groq 沒有消費者聊天室，只有開發者 playground
  Groq: { label: 'Groq Playground', url: 'https://console.groq.com/playground' },
}

/** 找不到對應（例如 pricing.json 新增了供應商）就回 null，按鈕不顯示 */
export function destinationFor(provider: string): ChatDestination | null {
  return CHAT_DESTINATIONS[provider] ?? null
}
