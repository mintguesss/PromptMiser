<script setup lang="ts">
import { computed } from 'vue'
import { models, providerColors } from '../composables/usePricing'
import type { ModelPick, Suggestion } from '../types'

const props = defineProps<{
  taskType: string
  suggestions: Suggestion[]
  samePick: ModelPick | null
  crossPick: ModelPick | null
  currentModelName: string
  totalSavingPct: number
}>()

// 從模型名稱反查提供商色點（LLM 應回傳清單裡的名稱；查不到就不顯示色點）
function pickInfo(pick: ModelPick | null) {
  if (!pick) return null
  const m = models.find((x) => x.name === pick.model)
  return {
    ...pick,
    color: m ? providerColors[m.provider] : null,
    isCurrent: pick.model === props.currentModelName,
  }
}

const same = computed(() => pickInfo(props.samePick))
const cross = computed(() => pickInfo(props.crossPick))
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center gap-2.5">
      <h2 class="section-label">省錢建議</h2>
      <span class="rounded-full border border-line bg-panel-2 px-2.5 py-0.5 text-[11px] text-txt-dim">
        任務類型：{{ taskType }}
      </span>
    </div>

    <!-- 固定四格：兩格模型推薦（同系列 / 跨系列）+ 兩格使用方式建議 -->
    <div class="grid gap-3 sm:grid-cols-2">
      <div v-if="same" class="relative flex gap-2.5 rounded-xl border border-brand/35 bg-brand/5 p-3">
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-lg leading-none"
          >🎯</span
        >
        <div class="min-w-0 pr-14">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-brand">同系列推薦</div>
          <h3 class="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-txt">
            <span
              v-if="same.color"
              class="h-2 w-2 shrink-0 rounded-full"
              :style="{ backgroundColor: same.color }"
            />
            {{ same.isCurrent ? `維持 ${same.model}` : same.model }}
          </h3>
          <p class="mt-0.5 text-[11px] leading-snug text-txt-dim">{{ same.reason }}</p>
        </div>
        <span
          v-if="same.estimated_saving_pct > 0"
          class="absolute right-3 top-3 rounded-md bg-save/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-save"
        >
          省 {{ same.estimated_saving_pct }}%
        </span>
      </div>

      <div v-if="cross" class="relative flex gap-2.5 rounded-xl border border-info/35 bg-info/5 p-3">
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info/15 text-lg leading-none"
          >🌐</span
        >
        <div class="min-w-0 pr-14">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-info">跨系列推薦</div>
          <h3 class="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-txt">
            <span
              v-if="cross.color"
              class="h-2 w-2 shrink-0 rounded-full"
              :style="{ backgroundColor: cross.color }"
            />
            {{ cross.model }}
          </h3>
          <p class="mt-0.5 text-[11px] leading-snug text-txt-dim">{{ cross.reason }}</p>
        </div>
        <span
          v-if="cross.estimated_saving_pct > 0"
          class="absolute right-3 top-3 rounded-md bg-save/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-save"
        >
          省 {{ cross.estimated_saving_pct }}%
        </span>
      </div>

      <div
        v-for="(s, i) in suggestions"
        :key="i"
        class="relative flex gap-2.5 rounded-xl border border-transparent bg-panel-2/70 p-3 transition-colors hover:border-line"
      >
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel text-lg leading-none"
          >{{ s.icon }}</span
        >
        <div class="min-w-0 pr-14">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-txt-dim">
            使用建議
          </div>
          <h3 class="mt-0.5 text-sm font-semibold text-txt">{{ s.title }}</h3>
          <p class="mt-0.5 text-[11px] leading-snug text-txt-dim">{{ s.description }}</p>
        </div>
        <span
          class="absolute right-3 top-3 rounded-md bg-save/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-save"
        >
          省 {{ s.estimated_saving_pct }}%
        </span>
      </div>
    </div>

    <p class="border-t border-line pt-2.5 text-[11px] text-txt-dim">
      以上建議全部採用，預估總共能省
      <span class="font-mono font-semibold tabular-nums text-save">{{ totalSavingPct }}%</span>
    </p>
  </div>
</template>
