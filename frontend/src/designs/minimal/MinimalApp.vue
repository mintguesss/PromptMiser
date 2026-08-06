<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { models, providers } from '../../composables/usePricing'
import type { OptimizeResult } from '../../types'
import HAnalysis from '../hybrid/HAnalysis.vue'
import HResult from '../hybrid/HResult.vue'
// 另外兩版（designs/minimal 的 MAnalysis/MResult、designs/cards 的 CAnalysis/CResult）
// 暫時保留在專案裡，目前沒有掛上來。

// 極簡版外殼：亮色編輯感。狀態（prompt/模型/結果）由 App.vue 持有，跟現行畫面共用。
const props = defineProps<{
  loading: boolean
  result: OptimizeResult | null
  error: string | null
}>()
const emit = defineEmits<{ optimize: [] }>()

const prompt = defineModel<string>('prompt', { required: true })
const currentModel = defineModel<string>('currentModel', { required: true })

type Tab = 'analysis' | 'result'
const tab = ref<Tab>('analysis')
watch(
  () => props.result,
  (r) => {
    if (r) tab.value = 'result'
  },
)

const modelGroups = computed(() =>
  providers
    .map((provider) => ({ provider, items: models.filter((m) => m.provider === provider) }))
    .filter((g) => g.items.length > 0),
)
const currentModelPricing = computed(
  () => models.find((m) => m.id === currentModel.value) ?? models[0],
)

</script>

<template>
  <div class="flex min-h-screen flex-col bg-[#faf9f6] font-sans text-[#1d2129] lg:h-screen lg:overflow-hidden">
    <!-- 頂欄：身分 + 分頁 + 模型 + 主行動 -->
    <header class="shrink-0 border-b border-[#e8e6e0]">
      <div
        class="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2.5 px-4 py-2.5 sm:px-8 sm:py-3"
      >
        <span class="flex shrink-0 items-center gap-2 text-sm font-bold tracking-tight"
          ><span class="text-lg">⛏️</span>PromptMiser</span
        >
        <nav class="flex shrink-0 gap-5 text-[13px] sm:gap-6">
          <button
            type="button"
            class="border-b-2 pb-0.5 transition"
            :class="tab === 'analysis' ? 'border-emerald-500 font-semibold' : 'border-transparent text-[#767e8c] hover:text-[#1d2129]'"
            @click="tab = 'analysis'"
          >
            即時分析
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 border-b-2 pb-0.5 transition"
            :class="[
              tab === 'result' ? 'border-emerald-500 font-semibold' : 'border-transparent text-[#767e8c]',
              result ? 'hover:text-[#1d2129]' : 'cursor-not-allowed opacity-40',
            ]"
            @click="result && (tab = 'result')"
          >
            優化結果
            <span
              v-if="result"
              class="rounded-full bg-emerald-100 px-1.5 font-mono text-[10px] font-bold tabular-nums text-emerald-700"
              >-{{ result.reduction_pct }}%</span
            >
          </button>
        </nav>
        <!-- 手機：模型選單與主按鈕獨立成一列（避免擠成兩行 + 名稱被截斷） -->
        <div class="ml-auto flex w-full items-center gap-2 sm:w-auto sm:gap-3">
          <label class="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-[#767e8c] sm:flex-none">
            <span class="hidden shrink-0 sm:inline">你用</span>
            <select
              v-model="currentModel"
              class="min-w-0 flex-1 cursor-pointer border border-[#e0ddd4] bg-white text-[#1d2129] focus:outline-emerald-400 sm:max-w-44 sm:flex-none rounded-full px-3.5 py-2 text-[13px] shadow-[0_1px_2px_rgba(28,25,18,0.04)] sm:rounded-lg sm:px-2 sm:py-1.5 sm:text-xs"
            >
              <optgroup v-for="g in modelGroups" :key="g.provider" :label="g.provider">
                <option v-for="m in g.items" :key="m.id" :value="m.id">{{ m.name }}</option>
              </optgroup>
            </select>
          </label>
          <button
            type="button"
            class="shrink-0 whitespace-nowrap rounded-full bg-[#1d2129] px-5 py-2 text-[13px] font-semibold text-white shadow-[0_2px_8px_-2px_rgba(28,25,18,0.4)] transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40 sm:px-5 sm:py-2 sm:text-xs sm:shadow-none"
            :disabled="loading || !prompt.trim()"
            @click="emit('optimize')"
          >
            <span class="sm:hidden">{{ loading ? '分析中…' : '壓縮 ⚡' }}</span>
            <span class="hidden sm:inline">{{ loading ? '分析中…' : '壓縮 + 省錢建議 →' }}</span>
          </button>
        </div>
      </div>
      <p v-if="error" class="border-t border-[#f3d9d3] bg-[#fdf3f1] px-4 py-2 text-xs text-[#c26a54] sm:px-8">
        ⚠️ {{ error }}
      </p>
    </header>

    <HAnalysis
      v-if="tab === 'analysis'"
      v-model="prompt"
      :current-model-id="currentModel"
      :llm-profile="result?.consumption_profile ?? null"
      :llm-estimate="result?.usage_estimate ?? null"
    />
    <HResult v-else-if="result" :result="result" :model-pricing="currentModelPricing" />
  </div>
</template>
