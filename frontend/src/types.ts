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
  /** 完成這個任務至少需要的模型效能（對照 AA Intelligence Index）；0 = LLM 沒判定 */
  required_perf: number
  required_perf_reason: string
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
