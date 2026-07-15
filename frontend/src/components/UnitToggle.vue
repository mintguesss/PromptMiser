<script setup lang="ts">
import { useCostUnit } from '../composables/usePricing'

// 全站共用的成本欄單位切換：跟 API 成本對比表欄位標題上的切換是同一份狀態
const unit = useCostUnit()
</script>

<template>
  <span class="flex select-none items-center text-[11px] text-txt-dim">
    <button
      type="button"
      class="cursor-pointer transition-colors"
      :class="unit === 'cost' ? 'font-semibold text-txt' : 'hover:text-txt'"
      title="顯示每次成本"
      @click="unit = 'cost'"
    >
      成本/次
    </button>
    <span class="px-1 text-txt-dim/50">·</span>
    <button
      type="button"
      class="cursor-pointer transition-colors"
      :class="unit === 'tokens' ? 'font-semibold text-txt' : 'hover:text-txt'"
      title="顯示這段 prompt 在各模型 tokenizer 下的 token 數"
      @click="unit = 'tokens'"
    >
      tokens
    </button>
  </span>
</template>
