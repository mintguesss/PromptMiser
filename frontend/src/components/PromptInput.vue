<script setup lang="ts">
import { computed, ref } from 'vue'
import { models, providers } from '../composables/usePricing'
import { stripProtectionMarkers, useTokenizer } from '../composables/useTokenizer'

defineProps<{
  loading: boolean
}>()

const emit = defineEmits<{
  optimize: []
}>()

const text = defineModel<string>({ required: true })
const currentModel = defineModel<string>('currentModel', { required: true })

const textareaEl = ref<HTMLTextAreaElement | null>(null)
const backdropEl = ref<HTMLDivElement | null>(null)

interface Segment {
  text: string
  protected: boolean
}

// 把 [[ ]] 保護段落切出來，overlay 用不同底色 highlight（含括號本身，維持字元對齊）
const segments = computed<Segment[]>(() => {
  const result: Segment[] = []
  const re = /\[\[[\s\S]*?\]\]/g
  let lastIndex = 0
  for (const match of text.value.matchAll(re)) {
    if (match.index > lastIndex) {
      result.push({ text: text.value.slice(lastIndex, match.index), protected: false })
    }
    result.push({ text: match[0], protected: true })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.value.length) {
    result.push({ text: text.value.slice(lastIndex), protected: false })
  }
  return result
})

const modelGroups = computed(() =>
  providers
    .map((provider) => ({ provider, items: models.filter((m) => m.provider === provider) }))
    .filter((g) => g.items.length > 0),
)

function syncScroll() {
  if (!textareaEl.value || !backdropEl.value) return
  backdropEl.value.scrollTop = textareaEl.value.scrollTop
  backdropEl.value.scrollLeft = textareaEl.value.scrollLeft
}

// token hero 放在輸入卡裡（貼完馬上看到，右側留給分析）
const { count } = useTokenizer()
const effectiveText = computed(() => stripProtectionMarkers(text.value))
const tokensO200k = computed(() => count(effectiveText.value, 'o200k_base'))
const tokensCl100k = computed(() => count(effectiveText.value, 'cl100k_base'))
</script>

<template>
  <section class="card flex flex-col gap-3.5 p-5">
    <div class="flex flex-col gap-1">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="section-label">輸入 Prompt</h2>
        <!-- 目前使用模型：影響「省了多少錢」計算與 LLM 的模型推薦建議 -->
        <label
          class="flex items-center gap-2 text-xs text-txt-dim"
          title="你打算用哪個模型送出？影響成本試算與模型推薦"
        >
          你用哪個模型
          <select
            v-model="currentModel"
            class="rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-xs text-txt focus:border-brand/50 focus:outline-none"
          >
            <optgroup v-for="g in modelGroups" :key="g.provider" :label="g.provider">
              <option v-for="m in g.items" :key="m.id" :value="m.id">{{ m.name }}</option>
            </optgroup>
          </select>
        </label>
      </div>
      <p class="text-[11px] text-txt-dim/80">
        把你要送給 AI（ChatGPT / Claude / Gemini…）的問題或指令貼進來，右側即時試算各家成本。
      </p>
    </div>

    <!-- 透明 textarea + 底層 highlight overlay，兩層字型/行高/padding 必須完全一致 -->
    <!-- flex-1：吃掉卡片多餘高度，讓左欄跟右欄等高 -->
    <div
      class="relative min-h-40 flex-1 rounded-xl border border-line bg-base/70 transition-colors focus-within:border-brand/40"
    >
      <div
        ref="backdropEl"
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-6 text-transparent"
      >
        <template v-for="(seg, i) in segments" :key="i">
          <span v-if="seg.protected" class="rounded-sm bg-amber-300/30">{{ seg.text }}</span>
          <span v-else>{{ seg.text }}</span>
        </template>
        <span>{{ '​' }}</span>
      </div>
      <textarea
        ref="textareaEl"
        v-model="text"
        spellcheck="false"
        placeholder="例如：幫我把這段話翻譯成英文… / 幫我寫一封請假信… / 分析這份資料的趨勢…"
        class="relative block h-full min-h-40 w-full resize-none whitespace-pre-wrap break-words bg-transparent px-4 py-3 font-mono text-sm leading-6 text-txt placeholder:text-txt-dim/50 focus:outline-none"
        @scroll="syncScroll"
      />
    </div>

    <!-- token hero：貼完立刻看到 -->
    <div class="flex items-baseline gap-2 rounded-xl bg-panel-2/70 px-3.5 py-2.5">
      <span class="text-2xl font-semibold tracking-tight text-txt">{{
        tokensO200k === null ? '…' : tokensO200k.toLocaleString('en-US')
      }}</span>
      <span class="text-xs text-txt-dim">tokens</span>
      <span class="ml-auto text-[10px] text-txt-dim/80">
        約 {{ effectiveText.length.toLocaleString('en-US') }} 字 · cl100k
        <span class="font-mono tabular-nums">{{
          tokensCl100k === null ? '…' : tokensCl100k.toLocaleString('en-US')
        }}</span>
      </span>
    </div>

    <p class="text-[11px] leading-relaxed text-txt-dim">
      用 <code class="rounded bg-amber-400/15 px-1 py-0.5 font-mono text-amber-300">[[ ]]</code>
      包住不能修改的段落，壓縮時會跳過。
    </p>

    <button
      type="button"
      :disabled="loading || !text.trim()"
      class="group relative flex items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-brand to-brand-2 px-4 py-3 text-sm font-semibold text-white shadow-md shadow-brand/25 transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100"
      @click="emit('optimize')"
    >
      <span
        v-if="loading"
        class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
      />
      {{ loading ? '分析中…' : '⚡ 壓縮 + 省錢建議' }}
    </button>
    <p class="text-center text-[10px] text-txt-dim/70">
      按下：用 AI 精算實際用量 → 壓縮 prompt → 給你省錢建議（一次呼叫、免費）
    </p>
  </section>
</template>
