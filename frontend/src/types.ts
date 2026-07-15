export interface DiffSegment {
  type: 'keep' | 'delete' | 'add'
  text: string
}

export interface Suggestion {
  icon: string
  title: string
  description: string
  estimated_saving_pct: number
}

export interface ModelPick {
  model: string
  reason: string
  estimated_saving_pct: number
}

export type ConsumptionProfile = 'single' | 'search' | 'conversation' | 'agent'

export interface UsageEstimate {
  expected_output_min: number
  expected_output_max: number
  context_overhead_min: number
  context_overhead_max: number
  calls_min: number
  calls_max: number
  reason: string
}

export interface OptimizeResult {
  task_type: string
  consumption_profile: ConsumptionProfile
  usage_estimate: UsageEstimate | null
  original_tokens: number
  compressed_prompt: string
  compressed_tokens: number
  reduction_pct: number
  diff: DiffSegment[]
  same_provider_pick: ModelPick | null
  cross_provider_pick: ModelPick | null
  suggestions: Suggestion[]
  total_estimated_saving_pct: number
}
