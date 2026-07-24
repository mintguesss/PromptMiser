"""Vercel Serverless Function 進入點（前後端同一個專案、同網域）。

Vercel 會把 /api/optimize 的請求送到這個檔案，並載入頂層的 `app`（ASGI）。
實際邏輯仍在 backend/app/ 底下，本機用 uvicorn 跑的是同一份程式碼。
"""

import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent

# tiktoken 預設會在第一次使用時上網下載編碼檔（~3.6MB）。
# serverless 冷啟動時這是額外延遲＋外部相依，所以改讀專案內預先下載好的快取。
# 必須在 import 到 tiktoken 之前設定。
_CACHE_DIR = _ROOT / "tiktoken_cache"
if _CACHE_DIR.is_dir():
    os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(_CACHE_DIR))

# 讓 `from app...` 找得到 backend/app
sys.path.insert(0, str(_ROOT / "backend"))

from app.main import app as app  # noqa: E402  (Vercel 載入的就是這個名字)
from app.routers import optimize as _optimize_router  # noqa: E402

# backend/app/main.py 已把 router 掛在 /api 底下（對應本機 uvicorn 的行為）。
# Vercel 依檔名路由時，函式收到的路徑可能不含 /api 前綴，這裡再掛一次不帶前綴的，
# 兩種情況都能正確回應。
app.include_router(_optimize_router.router)


@app.get("/api/health")
def _health_with_prefix():
    return {"status": "ok"}
