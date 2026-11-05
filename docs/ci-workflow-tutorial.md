# CI 工作流程教材：Lint、單元測試與 Pull Request

## 學習目標

完成本教材後，你將能夠：

- 說明 CI 如何自動執行程式碼檢查。
- 閱讀本專案的 GitHub Actions workflow，理解 lint 與單元測試如何平行執行。
- 將變更推送到功能分支、建立 Pull Request，並檢視 CI 結果。
- PR 合併後，安全地更新本機 `main`。

## 1. CI 是什麼？

CI（Continuous Integration，持續整合）會在程式碼推送或建立 Pull Request 時，自動執行檢查，讓問題能在變更合併前被發現。

本專案的 workflow 位於 `.github/workflows/ci.yml`，目前包含兩個獨立 jobs：

- **Lint**：執行 `npm run lint:check`，檢查 TypeScript 程式碼風格與部分常見問題。
- **Unit tests**：執行 `npm test -- --runInBand`，執行 Jest 單元測試。

兩個 job 沒有相依關係，因此 GitHub Actions 可以平行執行。workflow 在 `push` 與 `pull_request` 事件時觸發，使用 Node.js 22、`npm ci` 安裝 lockfile 指定的依賴，並透過 npm cache 加快安裝。

> CI 使用 `lint:check`，而不是會帶 `--fix` 並修改檔案的 `npm run lint`。

## 2. 空測試範圍的處理

目前這份 checkout 可能沒有 `src/`、其他 lint 目錄或 `*.spec.ts` 測試檔。workflow 會在沒有對應檔案時明確顯示 skip notice，而不是讓空範圍造成命令錯誤。

**Skip 不等於測試通過。** Job 顯示成功只表示 workflow 步驟正常完成；若 job 跳過 lint 或 unit tests，該項檢查並沒有實際執行。查看 GitHub Actions log，確認 job 是執行命令還是走 skip 路徑。當程式碼或測試檔加入後，應確認 workflow 進入實際檢查路徑。

這個 workflow 目前只負責 lint 與 unit tests，不會啟動 PostgreSQL、Redis，也不會執行 integration 或 E2E tests。需要外部服務的整合測試應使用獨立、隔離、可拋棄的測試環境，不能讓一般 unit-test job 連到共享開發資料庫。

## 3. 本機提交前檢查

先確認分支、工作目錄與變更內容：

```bash
git status -sb
git branch --show-current
git diff --check
git diff
```

確認工作目錄只包含預期的變更，且沒有 whitespace errors。若要查看目前分支比 `main` 多出的 commit：

```bash
git fetch origin
git log --oneline origin/main..HEAD
```

推送前務必檢查 commit 範圍，避免意外帶上其他尚未預期的本機 commit。

## 4. 使用功能分支提交與推送

不要直接把未審查的變更推到預設分支。從最新的 `main` 建立功能分支：

```bash
git switch main
git pull --ff-only origin main
git switch -c ci/my-change
```

將要提交的檔案加入 staging，檢查 staged diff，再提交：

```bash
git add path/to/file
git diff --staged --check
git diff --staged
git commit -m "ci: describe the change"
```

推送功能分支：

```bash
git push -u origin ci/my-change
```

`-u` 會設定 upstream，之後可直接使用 `git push` 和 `git pull`。

## 5. 建立 Pull Request 並查看 CI

可以在 GitHub 網頁建立 PR，或使用 GitHub CLI：

```bash
gh pr create --base main --head ci/my-change
```

查看 PR 狀態與 checks：

```bash
gh pr view --json number,state,url,statusCheckRollup
```

也可以直接在 GitHub PR 頁面的 **Checks** 區塊查看 Lint 和 Unit tests 的結果。合併前確認：

1. 變更內容符合預期。
2. CI checks 已完成。
3. 若 check 顯示成功，進一步確認是否真的執行測試，或只是因空範圍而 skip。

CI 是自動化驗證，不取代程式碼審查。

## 6. PR 合併後更新本機 `main`

PR 合併後，先取得遠端最新分支資訊，再切換到本機 `main` 並 fast-forward：

```bash
git fetch origin
git switch main
git pull --ff-only origin main
```

最後確認本機分支與遠端同步、工作目錄乾淨：

```bash
git status -sb
git log -1 --oneline
```

`--ff-only` 只允許 fast-forward。如果本機與遠端歷史已分岔，Git 會停止，不會自行建立 merge commit；此時先檢查差異再決定如何處理。

## 常見注意事項

- CI job 成功不一定代表 lint 或測試實際跑過；要區分 pass 與 skip。
- 使用 `npm run lint:check`，不要在 CI 中使用會修改檔案的 lint 命令。
- Unit tests 與 integration tests 分開執行；不要為 unit tests 啟動不必要的 DB/Redis 服務。
- 推送前查看 `git log origin/main..HEAD`，確認會推送哪些 commits。
- 在功能分支透過 PR 審查與合併，不要假設本機 `main` 會自動更新。
- 使用 `git pull --ff-only` 更新本機 `main`；遇到分岔時先查明原因，不要用強制覆寫處理。

## 練習

1. 在 `src/` 新增一個符合 Jest 設定的 `*.spec.ts` 測試。
2. 建立功能分支、提交並推送，然後開 PR。
3. 確認 Unit tests job 由 skip 轉為實際執行，並查看測試結果。
4. 在獨立練習分支中引入一個 lint 問題，觀察 CI 如何回報；修正後確認檢查成功。
5. PR 合併後，執行本教材第 6 節命令並確認本機 `main` 同步。
