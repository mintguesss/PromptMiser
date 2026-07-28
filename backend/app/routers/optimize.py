from typing import List, Optional

from fastapi import APIRouter, HTTPException

from ..models.schemas import (
    ModelFit,
    ModelPick,
    OptimizeRequest,
    OptimizeResponse,
    Suggestion,
    UsageEstimate,
)
from ..services.diff import compute_diff
from ..services.groq_client import run_optimize
from ..services.tokenizer import count_tokens, strip_protection_markers

router = APIRouter()


def _parse_suggestions(raw: object) -> List[Suggestion]:
    suggestions: List[Suggestion] = []
    if not isinstance(raw, list):
        return suggestions
    # 固定四格版面：兩格模型推薦 + 兩格使用建議，多給的裁掉
    for item in raw[:2]:
        if not isinstance(item, dict):
            continue
        try:
            suggestions.append(
                Suggestion(
                    icon=str(item.get("icon") or "💡"),
                    title=str(item.get("title") or "").strip() or "省錢建議",
                    description=str(item.get("description") or "").strip(),
                    estimated_saving_pct=float(item.get("estimated_saving_pct") or 0),
                )
            )
        except (TypeError, ValueError):
            continue
    return suggestions


def _parse_model_pick(raw: object) -> Optional[ModelPick]:
    if not isinstance(raw, dict):
        return None
    model = str(raw.get("model") or "").strip()
    # 模型清單是用「提供商｜名稱｜定價…」的格式給 LLM 的，它有時會整串複製回來，
    # 這裡把提供商前綴與後面的定價欄位切掉，只留模型名稱。
    if "｜" in model:
        model = model.split("｜")[1].strip() if len(model.split("｜")) > 1 else model
    if not model:
        return None
    try:
        pct = float(raw.get("estimated_saving_pct") or 0)
    except (TypeError, ValueError):
        pct = 0.0
    return ModelPick(
        model=model,
        reason=str(raw.get("reason") or "").strip(),
        estimated_saving_pct=pct,
    )


def _parse_model_fit(raw: object) -> List[ModelFit]:
    """LLM 對各模型的任務適合度評分；格式不對的項目跳過，不讓整個回應失敗。"""
    fits: List[ModelFit] = []
    if not isinstance(raw, list):
        return fits
    seen = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("model") or "").strip()
        # 模型清單是「提供商｜名稱｜定價…」格式，LLM 有時會整串複製回來
        if "｜" in name:
            parts = [p.strip() for p in name.split("｜")]
            name = parts[1] if len(parts) > 1 else parts[0]
        if not name or name in seen:
            continue
        try:
            score = int(float(item.get("score")))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        seen.add(name)
        fits.append(ModelFit(model=name, score=max(0, min(100, score))))
    return fits


def _parse_usage_estimate(raw: object) -> Optional[UsageEstimate]:
    if not isinstance(raw, dict):
        return None

    def num(key: str, default: int) -> int:
        try:
            return max(int(float(raw.get(key) or default)), 0)
        except (TypeError, ValueError):
            return default

    est = UsageEstimate(
        expected_output_min=num("expected_output_min", 0),
        expected_output_max=num("expected_output_max", 0),
        context_overhead_min=num("context_overhead_min", 0),
        context_overhead_max=num("context_overhead_max", 0),
        calls_min=max(num("calls_min", 1), 1),
        calls_max=max(num("calls_max", 1), 1),
        reason=str(raw.get("reason") or "").strip(),
    )
    # 區間順序防呆
    if est.expected_output_max < est.expected_output_min:
        est.expected_output_max = est.expected_output_min
    if est.context_overhead_max < est.context_overhead_min:
        est.context_overhead_max = est.context_overhead_min
    if est.calls_max < est.calls_min:
        est.calls_max = est.calls_min
    if est.expected_output_max == 0:
        return None
    return est


@router.post("/optimize", response_model=OptimizeResponse)
async def optimize(req: OptimizeRequest) -> OptimizeResponse:
    original_text = strip_protection_markers(req.prompt)
    original_tokens = count_tokens(original_text)

    result = await run_optimize(req.prompt, req.current_model, req.available_models)

    # LLM 偶爾會把 [[ ]] 括號留在輸出裡，一律再清一次
    compressed = strip_protection_markers(str(result.get("compressed_prompt") or "")).strip()
    if not compressed:
        raise HTTPException(status_code=502, detail="LLM 沒有回傳壓縮後的 prompt，請再試一次")

    compressed_tokens = count_tokens(compressed)
    reduction_pct = (
        round((1 - compressed_tokens / original_tokens) * 100, 1) if original_tokens else 0.0
    )

    suggestions = _parse_suggestions(result.get("suggestions"))
    try:
        total_pct = float(result.get("total_estimated_saving_pct"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        # LLM 沒給總數就用各條建議加總（上限 90%，疊加不會線性相加）
        total_pct = min(90.0, sum(s.estimated_saving_pct for s in suggestions))

    profile = str(result.get("consumption_profile") or "single")
    if profile not in ("single", "search", "conversation", "agent"):
        profile = "single"

    # 任務所需的模型效能門檻（0-100）；超出範圍或給不出來就當作沒有
    try:
        required_perf = int(float(result.get("required_perf") or 0))
    except (TypeError, ValueError):
        required_perf = 0
    if not 0 <= required_perf <= 100:
        required_perf = 0

    return OptimizeResponse(
        task_type=str(result.get("task_type") or "一般任務"),
        consumption_profile=profile,  # type: ignore[arg-type]
        usage_estimate=_parse_usage_estimate(result.get("usage_estimate")),
        required_perf=required_perf,
        required_perf_reason=str(result.get("required_perf_reason") or "").strip(),
        model_fit=_parse_model_fit(result.get("model_fit")),
        original_tokens=original_tokens,
        compressed_prompt=compressed,
        compressed_tokens=compressed_tokens,
        reduction_pct=reduction_pct,
        diff=compute_diff(original_text, compressed),
        same_provider_pick=_parse_model_pick(result.get("same_provider_pick")),
        cross_provider_pick=_parse_model_pick(result.get("cross_provider_pick")),
        suggestions=suggestions,
        total_estimated_saving_pct=round(total_pct, 1),
    )
