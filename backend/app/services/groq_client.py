import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List

import httpx
from fastapi import HTTPException

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"

_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "optimize.txt"


def _system_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _extract_json(text: str) -> Dict[str, Any]:
    """先直接 parse；失敗就撈出第一個 { 到最後一個 } 再試（LLM 偶爾會包 code fence）"""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise
        return json.loads(match.group(0))


async def run_optimize(
    prompt: str, current_model: str, available_models: List[str] = []
) -> Dict[str, Any]:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="後端尚未設定 GROQ_API_KEY，請參考 SETUP.md 申請並填入 backend/.env",
        )

    # 附上目前市面上的模型清單，讓「換模型」建議引用真實存在的模型，而不是 LLM 記憶裡的舊模型
    roster = ""
    if available_models:
        roster = (
            "\n\n可推薦的模型清單（格式：名稱｜input/output 定價 USD/1M tokens｜效能指數 0-100）：\n"
            + "\n".join(f"- {m}" for m in available_models)
            + "\n推薦換模型時只能從這份清單挑，不要提到清單外的模型。"
        )

    payload = {
        "model": os.getenv("GROQ_MODEL", DEFAULT_MODEL),
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": _system_prompt()},
            {
                "role": "user",
                "content": (
                    f"我目前使用的模型：{current_model}{roster}\n\n"
                    f"以下是要處理的 prompt：\n---\n{prompt}\n---"
                ),
            },
        ],
    }

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            GROQ_URL,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    if res.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Groq API 錯誤（HTTP {res.status_code}）：{res.text[:300]}",
        )

    content = res.json()["choices"][0]["message"]["content"]
    try:
        return _extract_json(content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="LLM 回傳的不是有效 JSON，請再試一次")
