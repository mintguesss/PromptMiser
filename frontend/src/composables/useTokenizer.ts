import { computed, shallowRef } from 'vue'
import type { Tiktoken } from 'js-tiktoken/lite'

export type EncodingName = 'o200k_base' | 'cl100k_base'

// 編碼器全域共用（rank 檔案很大，只載入一次），用動態 import 避免拖慢首次渲染
const encoders = {
  o200k_base: shallowRef<Tiktoken | null>(null),
  cl100k_base: shallowRef<Tiktoken | null>(null),
}
let loadStarted = false

async function loadEncoders() {
  if (loadStarted) return
  loadStarted = true
  const [{ Tiktoken }, o200k, cl100k] = await Promise.all([
    import('js-tiktoken/lite'),
    import('js-tiktoken/ranks/o200k_base'),
    import('js-tiktoken/ranks/cl100k_base'),
  ])
  encoders.o200k_base.value = new Tiktoken(o200k.default)
  encoders.cl100k_base.value = new Tiktoken(cl100k.default)
}

/** 移除 [[ ]] 保護標記本身（保留內容）——計算 token 時用實際會送出的文字 */
export function stripProtectionMarkers(text: string): string {
  return text.replace(/\[\[([\s\S]*?)\]\]/g, '$1')
}

export function useTokenizer() {
  loadEncoders()

  const ready = computed(
    () => encoders.o200k_base.value !== null && encoders.cl100k_base.value !== null,
  )

  /** 回傳 token 數；編碼器還沒載入完成時回傳 null */
  function count(text: string, encoding: EncodingName): number | null {
    if (!text) return 0
    const enc = encoders[encoding].value
    if (!enc) return null
    return enc.encode(text).length
  }

  return { ready, count }
}
