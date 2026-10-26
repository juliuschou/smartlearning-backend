# Docker / WSL / Rancher Desktop 通用操作規則

## 0. 適用範圍

任何涉及 Docker、Docker Compose、資料庫、資料庫 migration、容器(container)、映像(image)、Volume、Network 的操作,**在所有專案**都必須遵守本規則。

本規則優先於「想把事情快點做完」的衝動。

名詞定義見「附錄 A:Glossary」。

## 1. 環境事實(範例基準,實際以當下指令輸出為準)

- 作業系統:Windows 11 + WSL2 Ubuntu。
- Docker CLI 來自 Windows 的 Rancher Desktop,路徑通常在 `/mnt/c/Users/<USER>/AppData/Local/Programs/Rancher Desktop/resources/resources/linux/bin/docker`。
- Docker Engine 跑在 Rancher Desktop 自己的 WSL distribution,不在 Ubuntu 裡。
- Endpoint:`unix:///var/run/docker.sock`。
- 範例版本:Client 29.6.2-rd、Server 29.5.3、Compose 5.3.1、Buildx 0.35.0。Client 與 Server 版本不同是正常的。
- 健康狀態的樣子:`docker version`、`docker info`、`docker ps` 皆成功。
- 專案的 Port、服務名稱、Volume 名稱、資料庫種類,每個專案都不同。**一律從該專案的 Compose 檔案與設定檔讀取,不可假設或沿用其他專案的值。**
- 上述版本與路徑只是「某個時間點的基準」。操作前,先用指令確認當下狀態。

## 2. 五個核心原則

1. **先唯讀,後修改**:任何診斷都從唯讀指令開始。
2. **有證據才下結論**:沒有指令輸出支持的事,只能說「尚未驗證」。
3. **資料優先於速度**:不確定會不會弄丟資料,就不要執行。
4. **不確定就停下來問**:列出你看到的事實和你的疑問,等使用者決定。
5. **分階段**:「Docker 基礎環境」和「專案服務」是兩個獨立階段,不可混在一起處理。

## 3. 可直接執行的唯讀指令

以下指令不會建立、修改、刪除任何 Docker 資源:

- `docker version`、`docker info`、`docker ps`、`docker ps -a`
- `docker image ls`、`docker volume ls`、`docker network ls`、`docker system df`
- `docker context ls`、`docker context show`
- `docker inspect`(只查看)、`docker logs`(只查看)
- `docker compose ps -a`、`docker compose config`
- `printenv DOCKER_HOST DOCKER_CONTEXT`
- `command -v docker`、`type -a docker`、`file`、`readlink -f`
- `ls -l /var/run/docker.sock`、`readlink -f /var/run/docker.sock`

> 注意:`docker compose config` 會把環境變數展開後印出。輸出裡若有密碼或 token,回報時必須遮蔽。

## 4. 未經使用者明確同意,絕對不可執行

**刪除類**

- `docker rm`、`docker rmi`、`docker volume rm`、`docker network rm`
- `docker system prune`、`docker volume prune`、`docker image prune`、`docker container prune`
- `docker compose down -v`(`-v` 會連 Volume 一起刪)
- Rancher Desktop 的重置或 `rdctl` 相關破壞性指令

**啟動與資料庫類**

- `docker compose up`、`docker compose run`(可能自動觸發資料庫 migration)
- 任何 migration 或 schema 變更指令,例如:
  - Prisma:`prisma migrate dev` / `deploy` / `reset`、`prisma db push`、`prisma db seed`
  - Flyway / Liquibase:`flyway migrate`、`flyway clean`、`liquibase update`
  - 其他框架(TypeORM、Django、Rails、Spring Boot 啟動時的自動 migration 設定)的同類指令
- 任何會對資料庫執行 `DROP`、`TRUNCATE`、`DELETE`、`ALTER` 的 SQL

**環境類**

- 安裝 `docker.io`、`docker-ce` 或其他 Docker Engine(WSL Ubuntu 不需要自己的 Engine)
- 修改 `DOCKER_HOST`、`DOCKER_CONTEXT`,或執行 `docker context use` / `create` / `rm`
- 修改或刪除 `/var/run/docker.sock`
- 修改或刪除 `.env`、docker-compose 檔案、Dockerfile

要執行以上任何一項時,必須先說明:會影響什麼、可能丟失什麼資料、怎麼復原,然後等使用者回答「同意」。

## 5. Docker 出問題時的診斷順序

症狀範例:`failed to connect to the docker API at unix:///var/run/docker.sock`、`no such file or directory`。

1. 確認 CLI:`command -v docker`、`type -a docker`
2. 確認 endpoint:`docker context show`、`printenv DOCKER_HOST DOCKER_CONTEXT`
3. 確認 Socket:`ls -l /var/run/docker.sock`、`readlink -f /var/run/docker.sock`
4. 確認 Engine:`docker version`、`docker info`
5. 把每一步的結果整理成表格回報,然後停下來。

不要用「安裝 Docker」「重啟」「重置」當作第一步。根因不明時,誠實寫「根因尚未確認」,不要編造原因。

## 6. 對 `docker ps` 結果的正確解讀

- `docker ps` 只顯示執行中的容器。0 個,不代表沒有已停止的容器。
- 不能只靠 `docker ps` 推論映像、Volume、Network 是否存在。要用 `docker ps -a`、`docker image ls`、`docker volume ls`、`docker network ls` 分別確認。
- 不能因為 Rancher Desktop 剛重置、重裝或重建,就假設資料都被清除。要檢查才知道。
- Docker 通訊正常,不等於專案的資料庫、migration、應用程式能正常啟動。

## 7. 專案服務啟動前檢查清單

在任何專案中,以下全部完成前,不可執行 `docker compose up`。

1. 盤點資源:`docker ps -a`、`docker volume ls`,找出這個專案舊的資料庫 Volume。
2. 檢查 Compose 檔案:服務名稱、Volume 名稱、Port 對應、`env_file`。
3. 檢查是否有自動 migration:在 compose 的 `command`、`entrypoint`、Dockerfile、啟動腳本(`package.json` scripts、`pom.xml`、`application.yml` 等)中搜尋 `migrate`、`db push`、`flyway`、`liquibase`、`ddl-auto`。
4. 確認資料庫連線字串(例如 `DATABASE_URL`、`spring.datasource.url`)指向的資料庫,是你以為的那一個。
5. 確認 Compose 裡宣告的 Port,沒有被其他程式或其他專案占用。
6. 如果 Volume 裡有舊資料:先請使用者決定要保留還是重建,必要時先備份。
7. 以上結果回報給使用者,等待確認後才進入下一步。

## 8. 效能量測規則

- 感覺 Docker 指令變慢時,先量測,不要先換工具。
- 可用:

  ```bash
  for i in 1 2 3 4 5; do
    /usr/bin/time -f '%e seconds' docker version --format '{{.Server.Version}}'
  done
  ```

- Docker CLI 位在 `/mnt/c`,跨越 WSL 與 Windows 檔案系統,可能有額外延遲,但這不代表有問題。
- 即使要改用 Linux 原生 CLI,也必須連到同一個 Rancher Desktop Engine。不可同時管理兩套 Docker Engine。

## 9. 錯誤做法與正確做法

**錯誤**:`docker ps` 顯示 0 個容器,所以資料都不見了。
**正確**:`docker ps` 只看執行中的容器。我會再執行 `docker ps -a`、`docker volume ls`,確認後再說。

**錯誤**:看到 `docker.sock` 找不到,先 `apt install docker.io`。
**正確**:Engine 在 Rancher Desktop,不在 Ubuntu。我先依第 5 節檢查 context、環境變數、Socket,再回報。

**錯誤**:`docker version` 成功了,專案沒問題了,直接 `docker compose up`。
**正確**:Docker 通訊正常,只是第一階段。啟動服務前,先完成第 7 節檢查清單。

**錯誤**:環境亂掉了,`docker system prune -a` 清乾淨重來。
**正確**:prune 會刪除資源,可能包含資料。先盤點,說明影響,等使用者同意。

**錯誤**:`docker compose down -v`,重新建立比較快。
**正確**:`-v` 會刪除 Volume,資料庫資料會消失。除非使用者明確要求,不執行。

**錯誤**:上一個專案的資料庫 Port 是 5432,這個專案也一樣。
**正確**:Port 每個專案不同。從這個專案的 Compose 檔案讀取。

**錯誤**:這個問題一定是 Rancher Desktop 沒啟動造成的。
**正確**:目前證據只能證明 Socket 缺失。根因尚未確認,我列出可能原因與驗證方法。

**錯誤**:Client 是 29.6.2-rd,Server 是 29.5.3,版本不同,需要升級。
**正確**:Client 與 Server 版本不必完全相同。已通過 `version`、`info` 測試,維持現狀。

## 10. 回報格式

每次檢查後,依此格式回報:

1. **結論(一句話)**:可用 / 不可用 / 部分可用 / 尚未驗證。
2. **證據表**:檢查項目、指令、結果、PASS 或 FAIL。
3. **尚未驗證的事項**(明確列出)。
4. **建議的下一步**,以及是否需要使用者同意。

未驗證的事,不可寫成已確認。

## 11. 使用者溝通

使用者主要使用繁體中文(zh-TW),技術名詞保留英文。

解釋時先定義名詞,再用日常比喻說明,必要時先說明錯誤情況再說正確做法。

---

## 附錄 A:Glossary(名詞表)

| 名詞 | 定義 | 日常比喻 |
|---|---|---|
| 唯讀(read-only) | 只查看,不建立、修改、刪除。 | 走進倉庫看庫存,不搬任何東西。 |
| WSL2 | 在 Windows 裡執行的 Linux 環境。 | 一棟大樓裡的另一間獨立公寓。 |
| Rancher Desktop | 在 Windows 上提供 Docker Engine 的桌面應用程式。 | 一間負責供應 Docker 的發電廠。 |
| Docker CLI(Client) | 你打指令用的程式,例如 `docker ps`。 | 對講機。 |
| Docker Engine(Server) | 真正建立、執行容器的背景服務。 | 接收對講機訊息、實際做事的工人。 |
| Unix Socket(`/var/run/docker.sock`) | CLI 與 Engine 溝通的檔案式通道。 | 對講機的專線。線路在,才能通話。 |
| Endpoint | CLI 要連線的目標位址。 | 要撥打的電話號碼。 |
| Docker context | 記錄 CLI 預設要連到哪個 Engine 的設定。 | 手機通訊錄裡的「預設聯絡人」。 |
| Image(映像) | 容器的唯讀範本。 | 食譜。 |
| Container(容器) | 由映像啟動、正在運作的實例。 | 照食譜做出來的一盤菜。 |
| Volume | Docker 管理的持久儲存空間,資料庫資料常放這裡。 | 放資料的抽屜。刪掉抽屜,資料就沒了。 |
| Network | 容器之間互相連線的虛擬網路。 | 大樓內部的電話分機網。 |
| Docker Compose | 用一個設定檔同時定義、啟動多個容器。 | 一份「整桌菜」的菜單。 |
| Port | 程式對外接收連線的編號。 | 大樓裡的門牌號碼。兩家不能共用同一個。 |
| `.env` | 存放環境變數(含密碼)的檔案。 | 寫著鑰匙位置的便條紙。不可隨便外流。 |
| Migration | 用程式修改資料庫結構(加欄位、改表)。 | 對房子做裝修施工。裝錯房子,損失很大。 |
| Prune | 一次刪除大量未使用的 Docker 資源。 | 一鍵清空垃圾桶,但你分不清哪些不是垃圾。 |
| `-v`(`down -v`) | 連 Volume 一起刪除。 | 拆房子時連保險箱一起丟。 |
| PASS / FAIL | 檢查通過 / 未通過。 | 考試及格 / 不及格。 |
