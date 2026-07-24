# PromptMiser 安裝教學（SETUP）

從零開始把 PromptMiser 在自己電腦上跑起來，最後附部署到 Vercel + Railway 的步驟。

---

## 1. 事前準備

| 工具 | 版本需求 | 檢查指令 | 下載 |
|------|---------|---------|------|
| Node.js | 18+（建議 20+） | `node --version` | https://nodejs.org |
| Python | 3.9+（建議 3.11+） | `python --version` | https://www.python.org/downloads |
| Git（選用） | 任意 | `git --version` | https://git-scm.com |

> Windows 安裝 Python 時記得勾選「Add Python to PATH」。

## 2. 申請 Groq API Key（免費）

壓縮和省錢建議功能靠 Groq 的 Llama 3.3 70B 執行，完全免費：

1. 打開 https://console.groq.com 並註冊（可用 Google 帳號）
2. 左側選單點 **API Keys** → **Create API Key**
3. 取個名字（例如 `promptmiser`）→ 複製產生的 key（`gsk_` 開頭，**只會顯示一次**）

## 3. 設定並啟動後端

```bash
cd backend

# 建立虛擬環境
python -m venv .venv

# 安裝依賴
# Windows：
.venv\Scripts\pip install -r requirements.txt
# macOS / Linux：
# .venv/bin/pip install -r requirements.txt

# 建立環境變數檔
copy .env.example .env        # Windows（macOS/Linux 用 cp）
```

用編輯器打開 `backend/.env`，把剛剛的 key 貼進去：

```env
GROQ_API_KEY=gsk_你的key
GROQ_MODEL=llama-3.3-70b-versatile
CORS_ORIGINS=http://localhost:5173
```

啟動後端：

```bash
# Windows：
.venv\Scripts\python -m uvicorn app.main:app --port 8000 --reload
# macOS / Linux：
# .venv/bin/python -m uvicorn app.main:app --port 8000 --reload
```

看到 `Uvicorn running on http://127.0.0.1:8000` 就成功了。可以開 http://localhost:8000/health 確認回傳 `{"status":"ok"}`。

## 4. 設定並啟動前端

**另開一個終端機**（後端要繼續跑著）：

```bash
cd frontend
npm install
npm run dev
```

打開 http://localhost:5173 就能用了。

> 前端預設打 `http://localhost:8000` 的後端。如果你的後端跑在別的位址，複製 `frontend/.env.example` 成 `frontend/.env` 並修改 `VITE_API_BASE`。

## 5. 驗證整條流程

1. 在輸入框貼一段 prompt，右側 token 數和成本表應該**即時更新**（這部分純前端，不需要後端）
2. 用 `[[ ]]` 包一段文字，應該看到淡黃色 highlight
3. 按「⚡ 壓縮 + 省錢建議」，幾秒後下方應出現壓縮 diff 和建議卡片

## 6. 常見問題

**按按鈕出現「連不上後端」**
→ 後端沒啟動，回到步驟 3。

**出現「後端尚未設定 GROQ_API_KEY」**
→ `backend/.env` 沒建立或 key 沒填。注意檔名是 `.env` 不是 `.env.example`，改完要重啟後端。

**出現 Groq API 錯誤（HTTP 401）**
→ key 貼錯或已被撤銷，去 Groq console 重新產生一把。

**Port 被占用（8000 或 5173）**
→ 換 port：後端 `--port 8001`（同時在 `frontend/.env` 設 `VITE_API_BASE=http://localhost:8001`）；前端 `npm run dev -- --port 5174`。

**`npm run dev` 說 Node 版本不支援**
→ 升級到 Node 20.19+ 或 22+（本專案的 Vite 已固定在 v6，Node 20.x 都能跑）。

## 7. 部署到 Vercel

前端與後端**放在同一個 Vercel 專案、同一個網域**：靜態網站由 CDN 提供，`/api/optimize`
交給 Python Serverless Function（`api/optimize.py`，載入的是 `backend/app` 的同一份程式碼）。
因為同網域，不需要設定 CORS，也沒有另一個後端網址要維護。

### 步驟

1. 把專案推上 GitHub
2. https://vercel.com → **Add New Project** → 選這個 repo
3. **Root Directory 保持在專案根目錄，不要指到 `frontend`**
   （建置指令與輸出目錄已寫在 `vercel.json`，畫面上留空即可）
4. 展開 **Environment Variables**，加上：
   - `GROQ_API_KEY` ＝ 你的 Groq key（`gsk_` 開頭）
   - 選填 `GROQ_MODEL`（預設 `llama-3.3-70b-versatile`）
5. **Deploy**，等 1-2 分鐘

### 部署後檢查

- 開 `https://<你的網址>/api/health` → 應該看到 `{"status":"ok"}`
- 回首頁貼一段 prompt 按「壓縮 + 省錢建議」→ 有結果就成功了
- 若壓縮失敗，多半是 `GROQ_API_KEY` 沒設或設錯：到 Vercel 專案的
  **Settings → Environment Variables** 確認，改完要 **Redeploy** 才會生效

### 相關設定檔

| 檔案 | 作用 |
|------|------|
| `vercel.json` | 建置指令、輸出目錄、Function 逾時（60 秒） |
| `api/optimize.py` | Serverless Function 進入點，載入 `backend/app` |
| `requirements.txt`（根目錄） | Function 的 Python 相依套件，需與 `backend/requirements.txt` 一致 |
| `tiktoken_cache/` | 預先下載的 tiktoken 編碼檔，避免冷啟動時上網抓 |

> 後端也保留了 `backend/Dockerfile`，若日後想改成獨立部署（Railway / Render / Fly.io）仍然可用。
