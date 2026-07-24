<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import PromptInput from './components/PromptInput.vue'
import AnalysisPanel from './components/AnalysisPanel.vue'
import CompressionResult from './components/CompressionResult.vue'
import SuggestionCards from './components/SuggestionCards.vue'
import MinimalApp from './designs/minimal/MinimalApp.vue'
import { optimizePrompt } from './api'
import { models } from './composables/usePricing'
import type { OptimizeResult } from './types'

// 畫面風格：極簡為正式版；舊版程式碼保留但不提供切換入口，
// 需要時在 console 執行 localStorage.setItem('promptmiser.design', 'legacy') 再重整即可看到。
type Design = 'legacy' | 'minimal'
const design = ref<Design>(
  localStorage.getItem('promptmiser.design') === 'legacy' ? 'legacy' : 'minimal',
)

const prompt = ref('')

// 還原上次選的模型；設定檔改版後 id 可能不存在，要驗證
const DEFAULT_MODEL = 'claude-opus-5'
const storedModel = localStorage.getItem('promptmiser.currentModel')
const fallbackModel = models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0].id
const currentModel = ref(
  storedModel && models.some((m) => m.id === storedModel) ? storedModel : fallbackModel,
)
watch(currentModel, (v) => localStorage.setItem('promptmiser.currentModel', v))

const loading = ref(false)
const result = ref<OptimizeResult | null>(null)
const error = ref<string | null>(null)

type Tab = 'analysis' | 'result'
const activeTab = ref<Tab>('analysis')
const panelEl = ref<HTMLElement | null>(null)

const currentModelPricing = computed(
  () => models.find((m) => m.id === currentModel.value) ?? models[0],
)

function switchTab(tab: Tab) {
  if (tab !== 'analysis' && !result.value) return
  activeTab.value = tab
}

async function runOptimize() {
  if (loading.value || !prompt.value.trim()) return
  loading.value = true
  error.value = null
  try {
    result.value = await optimizePrompt(prompt.value, currentModel.value)
    activeTab.value = 'result'
    // 手機版輸入卡在上方，切完分頁再把面板帶進視野；桌面版本來就在眼前
    if (window.innerWidth < 1024) {
      await nextTick()
      panelEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  } catch (e) {
    result.value = null
    activeTab.value = 'analysis'
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <MinimalApp
    v-if="design === 'minimal'"
    v-model:prompt="prompt"
    v-model:current-model="currentModel"
    :loading="loading"
    :result="result"
    :error="error"
    @optimize="runOptimize"
  />

  <div v-else class="min-h-screen">
    <nav class="sticky top-0 z-10 border-b border-line/80 bg-base/75 backdrop-blur-md">
      <div class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <span
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-brand-2 text-base shadow-lg shadow-brand/20"
          >⛏️</span
        >
        <div class="flex flex-col leading-tight">
          <span class="text-[15px] font-semibold tracking-tight text-txt">PromptMiser</span>
          <span class="text-[10px] text-txt-dim">看清成本 · 壓縮 Prompt · 省錢建議</span>
        </div>
      </div>
    </nav>

    <main class="mx-auto max-w-[88rem] px-4 py-5">
      <!-- 桌面版左右兩欄（輸入 4 / 工作面板 8），手機版上下排列 -->
      <div class="grid gap-4 lg:grid-cols-12">
        <!-- 左欄跟右欄等高：輸入卡填滿，文字框吃掉多餘高度 -->
        <div class="lg:col-span-4">
          <PromptInput
            v-model="prompt"
            v-model:current-model="currentModel"
            :loading="loading"
            class="h-full"
            @optimize="runOptimize"
          />
        </div>

        <!-- 右側工作面板：分析 / 優化結果 分頁 -->
        <div ref="panelEl" class="flex scroll-mt-16 flex-col gap-3 lg:col-span-8">
          <div class="flex gap-1 rounded-xl border border-line bg-panel-2 p-1">
            <button
              type="button"
              class="flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
              :class="activeTab === 'analysis' ? 'bg-panel text-txt shadow-sm' : 'text-txt-dim hover:text-txt'"
              @click="switchTab('analysis')"
            >
              📊 即時分析
            </button>
            <button
              type="button"
              class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors"
              :class="[
                activeTab === 'result' ? 'bg-panel text-txt shadow-sm' : 'text-txt-dim',
                result ? 'hover:text-txt' : 'cursor-not-allowed opacity-40',
              ]"
              @click="switchTab('result')"
            >
              ⚡ 優化結果
              <span
                v-if="result"
                class="rounded bg-save/15 px-1 py-0.5 font-mono text-[10px] tabular-nums text-save"
                >-{{ result.reduction_pct }}% · 省 {{ result.total_estimated_saving_pct }}%</span
              >
            </button>
          </div>

          <p
            v-if="error"
            class="rounded-xl border border-spend/30 bg-spend/10 px-4 py-3 text-sm text-spend"
          >
            ⚠️ {{ error }}
          </p>

          <AnalysisPanel
            v-show="activeTab === 'analysis'"
            :prompt="prompt"
            :current-model-id="currentModel"
            :llm-profile="result?.consumption_profile ?? null"
            :llm-estimate="result?.usage_estimate ?? null"
          />
          <!-- 優化結果分頁：LLM 精算 + 壓縮 + 省錢建議合在同一頁 -->
          <template v-if="result">
            <div v-show="activeTab === 'result'" class="flex flex-col gap-3">
              <CompressionResult :result="result" :model-pricing="currentModelPricing" />
              <div class="card p-4">
                <SuggestionCards
                  :task-type="result.task_type"
                  :suggestions="result.suggestions"
                  :same-pick="result.same_provider_pick"
                  :cross-pick="result.cross_provider_pick"
                  :current-model-name="currentModelPricing.name"
                  :total-saving-pct="result.total_estimated_saving_pct"
                />
              </div>
            </div>
          </template>
        </div>
      </div>
    </main>

    <footer class="mx-auto max-w-6xl px-4 pb-8 text-center text-[11px] text-txt-dim/60">
      Token 數與成本皆為估算值，實際費用以各家官方帳單為準。
    </footer>
  </div>
</template>
