from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class OptimizeRequest(BaseModel):
    prompt: str = Field(min_length=1, description="含 [[ ]] 保護標記的原始 prompt")
    protected_sections: List[str] = Field(default_factory=list, description="[[ ]] 內的文字")
    current_model: str = Field(default="gpt-5.6-terra", description="使用者目前使用的模型 id")
    available_models: List[str] = Field(
        default_factory=list,
        description="前端的模型清單摘要（名稱 + 定價 + 效能），供 LLM 推薦時引用真實存在的模型",
    )


class DiffSegment(BaseModel):
    type: Literal["keep", "delete", "add"]
    text: str


class Suggestion(BaseModel):
    icon: str
    title: str
    description: str
    estimated_saving_pct: float


class UsageEstimate(BaseModel):
    """LLM 精算的實際消耗（比前端關鍵字規則準）"""

    expected_output_min: int = 0
    expected_output_max: int = 0
    context_overhead_min: int = 0
    context_overhead_max: int = 0
    calls_min: int = 1
    calls_max: int = 1
    reason: str = ""


class ModelPick(BaseModel):
    """模型推薦（同品牌 / 跨品牌共用同一結構）"""

    model: str
    reason: str
    estimated_saving_pct: float = 0


class OptimizeResponse(BaseModel):
    task_type: str
    consumption_profile: Literal["single", "search", "conversation", "agent"] = "single"
    usage_estimate: Optional[UsageEstimate] = None
    # 完成這個任務至少需要的模型效能門檻（對照 Artificial Analysis Intelligence Index）。
    # 0 = LLM 沒給，前端就不顯示勝任度。
    required_perf: int = 0
    required_perf_reason: str = ""
    original_tokens: int
    compressed_prompt: str
    compressed_tokens: int
    reduction_pct: float
    diff: List[DiffSegment]
    same_provider_pick: Optional[ModelPick] = None
    cross_provider_pick: Optional[ModelPick] = None
    suggestions: List[Suggestion]
    total_estimated_saving_pct: float
