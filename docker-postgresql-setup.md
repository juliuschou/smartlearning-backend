# 開發環境 PostgreSQL（Docker）

本文件定義**開發環境（development）**使用的 PostgreSQL 資料庫，以 Docker 容器方式運行。
正式環境（production）與測試環境（test）應使用各自的設定，不要共用此容器。

> **請先確認 Docker daemon 已啟動後再執行。**
>
> **載入環境變數的方式**：NestJS 已設定 `ConfigModule.forRoot({ isGlobal: true })`，
> 預設會載入專案根目錄的 `.env`。開發時請以 `.env.development` 為來源，
> 並透過啟動指令指定環境檔，例如：
>
> ```bash
> NODE_ENV=development nest start --watch
> # 或使用 dotenv-cli 載入對應檔案
> npx dotenv -e .env.development -- npm run start:dev
> ```
>
> 若希望 NestJS 直接依 `NODE_ENV` 自動載入 `.env.[NODE_ENV]`，
> 可在 `ConfigModule.forRoot()` 加入 `envFilePath: ['.env.development', '.env']`（開發環境）。

---

## 1. 建立並啟動 PostgreSQL 容器（開發環境）

容器與 volume 命名加上 `-dev` 後綴，避免與其他環境衝突。

```bash
docker run -d \
  --name smart-learning-pg-dev \
  -e POSTGRES_USER=smartlearning \
  -e POSTGRES_PASSWORD=smartlearning123 \
  -e POSTGRES_DB=smartlearning_dev \
  -p 5432:5432 \
  -v pgdata_smartlearning_dev:/var/lib/postgresql/data \
  --restart unless-stopped \
  postgres:16
```

### 參數說明

| 參數 | 說明 |
|------|------|
| `-d` | 背景執行容器 |
| `--name smart-learning-pg-dev` | 開發環境容器名稱（`-dev` 後綴區隔環境） |
| `-e POSTGRES_USER` | 資料庫超級使用者帳號 |
| `-e POSTGRES_PASSWORD` | 資料庫超級使用者密碼 |
| `-e POSTGRES_DB` | 啟動時自動建立的開發環境預設資料庫 `smartlearning_dev` |
| `-p 5432:5432` | 將宿主機 5432 port 映射到容器 5432 port |
| `-v pgdata_smartlearning_dev:/var/lib/postgresql/data` | 開發環境資料持久化 volume（`_dev` 後綴區隔環境） |
| `--restart unless-stopped` | 容器異常退出或宿主機重啟時自動重啟 |
| `postgres:16` | 使用 PostgreSQL 16 映像檔 |

## 2. 驗證容器運行狀態

```bash
# 確認容器狀態
docker ps --filter name=smart-learning-pg-dev

# 檢視容器啟動日誌（確認 PostgreSQL 已準備好連線）
docker logs -f smart-learning-pg-dev
# 看到 "database system is ready to accept connections" 即代表啟動成功，按 Ctrl+C 離開
```

## 3. 測試連線

```bash
# 使用容器內的 psql 連線測試
docker exec -it smart-learning-pg-dev \
  psql -U smartlearning -d smartlearning_dev -c "SELECT version();"
```

## 4. 常用管理指令

```bash
# 停止容器
docker stop smart-learning-pg-dev

# 啟動容器（已存在時）
docker start smart-learning-pg-dev

# 移除容器（資料保留在 volume 中）
docker rm -f smart-learning-pg-dev

# 完整清除（含資料 volume，會刪除所有資料，謹慎使用）
docker rm -f smart-learning-pg-dev
docker volume rm pgdata_smartlearning_dev
```

## 5. 安全性注意事項

- 上述帳號密碼為本機開發用途，**請勿直接用於正式或測試環境**。
- 正式環境請改用環境變數檔（`.env.production`，已 gitignore）或 Docker secrets 管理密碼。
- 開發環境資料可隨時重建；若需重置資料庫，移除 volume 後重新啟動即可。
- 若不需對外暴露 port，可移除 `-p 5432:5432`，僅容器內部網路可連線。

---

## 開發環境連線資訊

| 項目 | 值 | 對應環境變數 |
|------|----|-------------|
| Host | `localhost` | `DB_HOST` |
| Port | `5432` | `DB_PORT` |
| Database | `smartlearning_dev` | `DB_NAME` |
| Username | `smartlearning` | `DB_USERNAME` |
| Password | `smartlearning123` | `DB_PASSWORD` |

### 對應的 `.env.development` 內容

```env
# Application
PORT=3000
NODE_ENV=development

# Database (development)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=smartlearning_dev
DB_USERNAME=smartlearning
DB_PASSWORD=smartlearning123
```