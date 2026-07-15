# PromptMiser ⛏️

幫開發者看清楚自己的 prompt 花了多少錢、怎麼壓縮、怎麼換個做法省更多。

> 貼上 prompt 就能看到各模型的成本、一鍵壓縮省 token、還能拿到針對你的任務的省錢建議。

## 功能

1. **即時分析**：貼上 prompt 即時計算 token 數（js-tiktoken，前端計算、零 API 花費）、20 個模型的 API 成本對比（OpenAI / Anthropic / Google / xAI / DeepSeek / Groq 六家，提供商分組挑選、相對成本條、可排序、標示最省最貴）、訂閱方案每日額度估算（Claude Pro / Claude Max / ChatGPT Plus / Google AI Pro）。
2. **壓縮 + 省錢建議**（一顆按鈕、一次 LLM call 同時回傳）：
   - 壓縮：砍冗詞、合併重複指令、精簡 few-shot，`[[ ]]` 保護標記內的文字原封不動；顯示 before/after diff（紅刪綠留）、壓縮率、省下的 token 與金額，一鍵複製壓縮後 prompt。
   - 建議：AI 判斷任務類型後給 2-4 張具體建議卡片（換模型、prompt caching、JSON 輸出、精簡範例…），每張附預估節省 %。

## 技術棧

- 前端：Vue 3（Composition API）+ Vite + TypeScript + Tailwind CSS v4 + js-tiktoken
- 後端：Python FastAPI + tiktoken + httpx
- LLM：Groq API（Llama 3.3 70B，免費）

## 快速開始

完整安裝教學（含 Groq API key 申請）請看 **[SETUP.md](SETUP.md)**。

```bash
# 後端（先在 backend/.env 填入 GROQ_API_KEY）
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --port 8000

# 前端（另開一個終端機）
cd frontend
npm install
npm run dev    # http://localhost:5173
```

## API

```
GET  /health          # 健康檢查
POST /api/optimize    # 壓縮 + 省錢建議（一次 LLM call）
```

`POST /api/optimize` 送出 `{ prompt, current_model, available_models }`，回傳壓縮後的 prompt、diff、任務型態、用量精算（`usage_estimate`）與省錢建議。詳細欄位見 [backend/app/models/schemas.py](backend/app/models/schemas.py)。

## 設定檔

- [frontend/src/data/pricing.json](frontend/src/data/pricing.json) — 各模型 API 定價（USD / 1M tokens），手動維護
- [frontend/src/data/subscriptions.json](frontend/src/data/subscriptions.json) — 訂閱方案每日額度估算（僅為估算，非官方數據）
- [backend/app/prompts/optimize.txt](backend/app/prompts/optimize.txt) — 給 Groq 的 system prompt（壓縮 + 建議合一）

## 專案結構

```
prompt-miser/
├── frontend/              # Vue 3 + Vite SPA
│   └── src/
│       ├── components/    # PromptInput / AnalysisPanel / CostTable /
│       │                  # ModelSelector / CompressionResult / SuggestionCards
│       ├── composables/   # useTokenizer / usePricing
│       ├── data/          # pricing.json / subscriptions.json
│       └── api.ts         # 後端 API client
├── backend/               # FastAPI
│   ├── app/
│   │   ├── routers/       # POST /api/optimize
│   │   ├── services/      # groq_client / tokenizer / diff
│   │   ├── models/        # Pydantic schemas
│   │   └── prompts/       # optimize.txt（LLM system prompt）
│   └── Dockerfile
└── SETUP.md               # 安裝教學
```

## 部署

- 前端：Vercel（靜態 SPA，設定環境變數 `VITE_API_BASE` 指向後端網址）
- 後端：Railway 或 Render（有 Dockerfile，設定 `GROQ_API_KEY` 與 `CORS_ORIGINS`）

詳細步驟見 [SETUP.md](SETUP.md) 的部署段落。
