<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  models,
  providers,
  providerColors,
  type ModelPricing,
} from '../composables/usePricing'

const selected = defineModel<string[]>({ required: true })
const open = ref(false)

const grouped = computed(() =>
  providers
    .map((provider) => ({
      provider,
      color: providerColors[provider],
      items: models.filter((m) => m.provider === provider),
    }))
    .filter((g) => g.items.length > 0),
)

function isSelected(id: string): boolean {
  return selected.value.includes(id)
}

function toggle(id: string) {
  selected.value = isSelected(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id]
}

function groupState(items: ModelPricing[]): 'all' | 'some' | 'none' {
  const count = items.filter((m) => isSelected(m.id)).length
  if (count === 0) return 'none'
  return count === items.length ? 'all' : 'some'
}

function toggleGroup(items: ModelPricing[]) {
  const ids = items.map((m) => m.id)
  if (groupState(items) === 'all') {
    selected.value = selected.value.filter((id) => !ids.includes(id))
  } else {
    selected.value = [...new Set([...selected.value, ...ids])]
  }
}

function priceHint(m: ModelPricing): string {
  if (m.free) return '免費'
  return `$${m.input_per_1m} / $${m.output_per_1m}`
}
</script>

<template>
  <div class="rounded-xl border border-line bg-panel-2/60">
    <!-- 收合列：摘要 + 展開按鈕，模型多也不佔版面 -->
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      @click="open = !open"
    >
      <span class="text-xs text-txt-dim">
        評估模型
        <span class="ml-1 font-mono text-txt">{{ selected.length }}</span>
        <span class="text-txt-dim/70"> / {{ models.length }}</span>
      </span>
      <span class="flex items-center gap-2">
        <!-- 已選提供商的色點摘要 -->
        <span class="flex items-center gap-1">
          <span
            v-for="g in grouped.filter((g) => g.items.some((m) => isSelected(m.id)))"
            :key="g.provider"
            class="h-2 w-2 rounded-full"
            :style="{ backgroundColor: g.color }"
            :title="g.provider"
          />
        </span>
        <span class="text-xs text-info">{{ open ? '收合 ▴' : '選擇模型 ▾' }}</span>
      </span>
    </button>

    <div v-if="open" class="border-t border-line px-3 py-3">
      <div class="flex flex-col gap-3">
        <div v-for="group in grouped" :key="group.provider">
          <div class="mb-1.5 flex items-center justify-between">
            <span class="flex items-center gap-1.5 text-xs font-medium text-txt">
              <span class="h-2 w-2 rounded-full" :style="{ backgroundColor: group.color }" />
              {{ group.provider }}
            </span>
            <button
              type="button"
              class="text-[11px] text-txt-dim transition-colors hover:text-txt"
              @click="toggleGroup(group.items)"
            >
              {{ groupState(group.items) === 'all' ? '取消全選' : '全選' }}
            </button>
          </div>
          <div class="grid gap-1 sm:grid-cols-2">
            <button
              v-for="m in group.items"
              :key="m.id"
              type="button"
              class="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors"
              :class="
                isSelected(m.id)
                  ? 'border-info/40 bg-info/10'
                  : 'border-transparent bg-panel hover:bg-panel-2'
              "
              @click="toggle(m.id)"
            >
              <span class="flex items-center gap-2 text-xs" :class="isSelected(m.id) ? 'text-txt' : 'text-txt-dim'">
                <span
                  class="flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px] leading-none"
                  :class="isSelected(m.id) ? 'border-info bg-info text-white' : 'border-line'"
                >
                  {{ isSelected(m.id) ? '✓' : '' }}
                </span>
                {{ m.name }}
              </span>
              <span class="font-mono text-[10px] tabular-nums" :class="m.free ? 'text-save' : 'text-txt-dim/70'">
                {{ priceHint(m) }}
              </span>
            </button>
          </div>
        </div>
        <p class="text-[10px] text-txt-dim/70">定價單位：USD / 1M tokens（input / output）</p>
      </div>
    </div>
  </div>
</template>
