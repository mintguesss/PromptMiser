# PromptMiser ⛏️

貼上 prompt，馬上知道它要花多少錢、能壓多少、還能怎麼省。

## 功能

### 成本分析

貼上 prompt 後即時計算 token 數，並列出各家模型跑這一題各要多少錢。

- 23 個模型、7 家供應商（OpenAI / Anthropic / Google / xAI / DeepSeek / Groq / Moonshot）
- 可依供應商挑選要比較的模型，表格可排序，並標示最省與最貴
- 成本可切換「每次」與「每 token」兩種看法
- 訂閱方案視角：換算成 Claude Pro、ChatGPT Plus 等 8 種方案的每日額度可用幾次

token 由前端計算（js-tiktoken），不會產生任何 API 費用。

### 壓縮與省錢建議

按一顆按鈕，一次取得兩件事。

- **壓縮**：刪冗詞、合併重複指令、精簡範例。以 `[[ ]]` 標記的文字不會被更動。
  結果以紅刪綠留的 diff 呈現，附壓縮率與省下的金額，可一鍵複製。
- **建議**：先判斷任務類型，再給幾張具體的省錢建議卡（換模型、開快取、改 JSON 輸出等），
  每張附預估節省幅度。
- **換模型評估**：不只比價，會針對這個任務替各模型評分，低於門檻的會標示為做不來，
  避免為了省錢換到不堪用的模型。

### 其他

- 支援手機安裝（PWA），版面自動適應手機與桌機

## 技術棧

- 前端：Vue 3（Composition API）+ Vite + TypeScript + Tailwind CSS v4 + js-tiktoken
- 後端：Python FastAPI + tiktoken
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

## 設定檔

- [frontend/src/data/pricing.json](frontend/src/data/pricing.json) — 各模型 API 定價（USD / 1M tokens），手動維護
- [frontend/src/data/subscriptions.json](frontend/src/data/subscriptions.json) — 訂閱方案每日額度估算（僅為估算，非官方數據）
- [backend/app/prompts/optimize.txt](backend/app/prompts/optimize.txt) — 給 Groq 的 system prompt

## 專案結構

```
PromptMiser/
├── frontend/              # Vue 3 + Vite SPA
│   └── src/
│       ├── designs/minimal/   # 目前使用的介面
│       ├── components/        # 成本表、模型挑選、壓縮結果、建議卡等
│       ├── composables/       # useTokenizer / usePricing / useScenario
│       └── data/              # pricing.json / subscriptions.json
├── backend/               # FastAPI（本機開發用）
│   └── app/
│       ├── routers/       # POST /api/optimize
│       ├── services/      # groq_client / tokenizer / diff
│       ├── models/        # Pydantic schemas
│       └── prompts/       # optimize.txt
├── api/optimize.py        # Vercel Python Serverless Function（部署用）
└── SETUP.md
```

## 部署

部署在 Vercel 上的單一專案：前端為靜態 SPA，後端以 Python Serverless Function
（`api/optimize.py`）跑在同一個網域下，因此不需要處理 CORS。

在 Vercel 專案設定中填入環境變數 `GROQ_API_KEY` 即可。詳細步驟見 [SETUP.md](SETUP.md)。
