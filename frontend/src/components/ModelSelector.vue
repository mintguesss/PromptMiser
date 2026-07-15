<script setup lang="ts">
defineProps<{
  options: { id: string; label: string }[]
}>()

const selected = defineModel<string[]>({ required: true })

function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id]
}
</script>

<template>
  <div class="flex flex-wrap gap-1.5">
    <button
      v-for="opt in options"
      :key="opt.id"
      type="button"
      class="rounded-md border px-2 py-1 text-xs font-medium transition-colors"
      :class="
        selected.includes(opt.id)
          ? 'border-info/40 bg-info/15 text-info'
          : 'border-line bg-panel-2 text-txt-dim hover:text-txt'
      "
      @click="toggle(opt.id)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
