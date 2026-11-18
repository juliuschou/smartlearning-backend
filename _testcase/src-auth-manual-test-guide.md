# `src/auth` 測試閱讀指南

這份指南帶你從測試程式往下追到實際程式碼，了解登入、登入狀態、防偽檢查、帳號資料、密碼重設和寄信流程。建議一次只跑一個測試檔，先看測試在準備什麼，再追實作如何處理。

> 以下是閱讀與執行建議，不會修改程式碼。工作區目前有尚未提交的變更；跑測試前請確認不要使用會清空資料或修改資料庫的指令。

---

## 1. 測試在做什麼？

測試程式會準備輸入，呼叫被測程式，再確認結果是否符合預期。

例如，測試登入時通常會先安排一份「假帳號資料」，再呼叫登入服務。這樣可以專心確認登入判斷，不必真的連資料庫。

在測試中常見的寫法：

- `mockResolvedValue(...)`：安排假資料，讓某個呼叫回傳指定結果。
- `toHaveBeenCalledWith(...)`：確認程式是否用預期的內容呼叫了另一段程式。
- `rejects`：確認這次操作應該被拒絕。
- `resolves`：確認這次操作應該成功。

這些名稱看起來像術語，可以先把它們當成「安排假回應」和「檢查程式有沒有照預期做事」來理解。

---

## 2. 開始前：確認測試指令

在專案根目錄執行單一測試檔：

```bash
npm test -- --runInBand src/auth/auth.service.spec.ts
```

`--runInBand` 會讓測試依序執行，通常比較容易閱讀輸出，也避免同時跑多個測試造成干擾。若想看到每個測試案例的名稱，可加上 `--verbose`：

```bash
npm test -- --runInBand --verbose src/auth/auth.service.spec.ts
```

測試通過時，Jest 會顯示通過的測試數量。若失敗，先看：

1. 哪一個測試案例失敗。
2. 預期結果與實際結果各是什麼。
3. 錯誤指向的檔案與行數。

一次只處理一個失敗，不要先改測試或實作來讓它通過。

### 資料庫注意事項

先從單元測試開始。它們通常會用假資料，不需要啟動資料庫；但仍應檢查測試檔和測試設定，確認呼叫路徑沒有連到資料庫或外部服務。

不要把整合測試當成單元測試來跑。若測試會使用資料庫，必須依專案規則先確認它連到的是**本次新建、隔離且可丟棄的測試資料庫**；不要使用開發資料庫。資料庫或容器測試需要額外的環境確認，不包含在本指南的基本練習中。

---

## 3. 第一站：登入

### 閱讀檔案

- 測試：`src/auth/auth.service.spec.ts`
- 實作：`src/auth/auth.service.ts`

先跑：

```bash
npm test -- --runInBand src/auth/auth.service.spec.ts
```

### 從成功登入案例開始追

在 `auth.service.spec.ts` 找登入成功的案例，依序查看：

1. **測試準備的帳號資料**  
   找 `activeAccount` 或相近名稱的資料。觀察帳號是否啟用、信箱是否確認、角色是否符合登入條件。

2. **測試如何安排假帳號**  
   找 `repository.findAccountForLogin.mockResolvedValue(...)`。它表示測試讓資料查詢回傳一份預先準備好的帳號資料，而非真的查資料庫。

3. **服務如何判斷能否登入**  
   打開 `auth.service.ts` 的 `login()`。依序看它如何整理 Email、取得帳號資料、檢查帳號狀態和密碼。

4. **成功後做了什麼**  
   看測試是否確認 `repository.createSession` 被呼叫，以及登入服務回傳了什麼。

5. **回到測試核對結果**  
   找 `expect(...)`，確認測試驗證的是「登入成功」、登入資料，還是資料庫寫入呼叫。

### 再看登入失敗案例

找登入失敗的測試，看看每個案例改變了什麼條件，例如：

- 帳號不存在。
- 帳號未啟用。
- 信箱尚未確認。
- 密碼不正確。
- 帳號角色不符合登入條件。

留意這些情況是否收到相同的登入錯誤，以及失敗時是否沒有建立登入狀態。這樣設計可以避免外人從錯誤回覆猜出帳號狀態。

### 練習問題

看完後，試著回答：

- 成功登入前必須符合哪些條件？
- 找不到帳號時，服務仍做了什麼？
- 登入失敗時，測試如何確認沒有建立登入狀態？

---

## 4. 第二站：登入狀態如何保存與確認

### 閱讀檔案

- 測試：`src/auth/auth.repository.spec.ts`
- 實作：`src/auth/auth.repository.ts`

登入服務準備好資料後，會呼叫 `createSession()` 保存登入狀態。接著在 `auth.repository.ts` 找這個方法，觀察保存了哪些欄位。

再看 `touchValidSession()`。這段負責確認登入狀態能不能繼續使用。閱讀時可以先用以下問題拆解：

- 帳號還有效嗎？
- 信箱是否已確認？
- 登入狀態是否過期？
- 帳號角色是否仍可使用？
- 權限資料的格式是否合理？
- 確認有效後，程式如何更新最近使用時間？

### 追蹤登出

在 repository 中找 `revokeSession()`、`revokeAllSessionsForAccount()` 和 `revokeSessionsForRole()`。這些方法分別處理不同範圍的登入狀態失效。

可以對照 `auth.service.ts` 的 `logout()`，看看服務如何把瀏覽器送來的登入憑證轉成資料庫可查的值，再要求 repository 撤銷對應的登入狀態。

---

## 5. 第三站：登入狀態保護與防偽檢查

### 閱讀檔案

- 測試：`src/auth/auth-session.guard.spec.ts`
- 實作：`src/auth/auth-session.guard.ts`
- 測試：`src/auth/csrf.guard.spec.ts`
- 實作：`src/auth/csrf.guard.ts`
- 測試：`src/auth/auth-security.service.spec.ts`
- 實作：`src/auth/auth-security.service.ts`

### 先看 `AuthSessionGuard`

在 `auth-session.guard.spec.ts` 看兩種情況：

- 沒有登入憑證。
- 有憑證，但登入狀態無效。

再到 `auth-session.guard.ts` 找 `canActivate()`，看它如何讀取瀏覽器保存的登入值、要求服務確認登入狀態，以及如何阻擋不符合條件的請求。

### 再看 `CsrfGuard`

`csrf.guard.ts` 的 `canActivate()` 會先處理請求來源，再檢查防偽值。閱讀時可以問：

1. 哪些請求方法會直接略過這項檢查？
2. 其他請求會從哪裡讀取來源？
3. 防偽值在瀏覽器和請求中是否必須相同？
4. 登入前和登入後的檢查有什麼不同？

### 最後看 `AuthSecurityService`

在 `auth-security.service.ts` 找建立和檢查防偽值的方法。先不必研究加密細節，只要了解：

- 防偽值由伺服器產生。
- 伺服器會檢查它是否過期或遭到修改。
- 比對方式避免讓錯誤回應的快慢透露太多資訊。
- 登入憑證和防偽值的瀏覽器保存方式不同，目的也不同。

### 練習問題

- 為什麼只有「有登入憑證」還不夠，還要向服務確認登入狀態？
- 防偽值為什麼要同時出現在瀏覽器記錄與請求中？
- 哪些請求會被拒絕？

---

## 6. 第四站：請求來源與設定

### 閱讀檔案

- 測試：`src/auth/auth.config.spec.ts`
- 實作：`src/auth/auth.config.ts`
- 實作：`src/auth/origin-policy.service.ts`

`auth.config.ts` 會讀取認證相關設定。先找 `allowedOrigins`，看它如何檢查允許的網站清單；再到 `origin-policy.service.ts` 看 `isAllowed()` 和 `assertAllowed()` 如何使用這份清單。

對照 `auth.config.spec.ts`，確認測試涵蓋了：

- 正確格式的網站來源。
- 不被允許的來源。
- 不明確或不安全的設定。

### 練習問題

- 為什麼只比對完整網址，而不是只看其中一段文字？
- 設定不正確時，程式是放寬規則，還是拒絕繼續處理？

---

## 7. 第五站：讀取及修改自己的帳號資料

### 閱讀檔案

- 測試：`src/auth/account.dto.spec.ts`
- 測試：`src/auth/auth.controller.spec.ts`
- 測試：`src/auth/auth.service.spec.ts`
- 實作：`src/auth/account.dto.ts`
- 實作：`src/auth/auth.controller.ts`
- 實作：`src/auth/auth.service.ts`
- 實作：`src/auth/auth.repository.ts`

可以依序追：

1. 在 `account.dto.spec.ts` 看哪些姓名、電話和密碼輸入會被接受。
2. 在 `auth.controller.spec.ts` 找讀取或更新個人資料的案例，觀察請求如何進入控制器。
3. 在 `auth.controller.ts` 找 `getOwnProfile()`、`updateOwnProfile()`。
4. 在 `auth.service.ts` 找相同名稱的方法，確認控制器如何把操作交給服務。
5. 在 `auth.repository.ts` 找資料查詢與更新，確認程式只讀寫目前登入者的資料。

特別看 `account.dto.ts` 的電話欄位：沒有提供欄位和提供 `null` 的意思不同。測試可以幫助你確認哪一種表示「保留原值」，哪一種表示「清除電話」。

---

## 8. 第六站：本人變更密碼

### 閱讀檔案

- 測試：`src/auth/auth.service.spec.ts`
- 測試：`src/auth/auth.repository.spec.ts`
- 實作：`src/auth/auth.service.ts`
- 實作：`src/auth/auth.repository.ts`

先在 `auth.service.spec.ts` 找成功變更密碼和目前密碼錯誤的案例，再到 `auth.service.ts` 的 `changeOwnPassword()` 追蹤：

1. 新密碼是否符合規則。
2. 目前密碼是否正確。
3. 新密碼如何保存。
4. 更新完成後是否讓其他已登入的裝置失效。

接著查看 `auth.repository.spec.ts` 中確認「更新密碼和讓舊登入失效一起完成」的案例，再回到 `auth.repository.ts` 找 `changePasswordAndRevokeSessions()`。

### 練習問題

- 目前密碼錯誤時，測試如何確認新密碼沒有被寫入？
- 為什麼換密碼後要讓其他裝置重新登入？

---

## 9. 第七站：忘記密碼與重設

### 閱讀檔案

- 測試：`src/auth/password-reset.dto.spec.ts`
- 測試：`src/auth/password-reset.service.spec.ts`
- 測試：`src/auth/password-reset.repository.spec.ts`
- 實作：`src/auth/password-reset.dto.ts`
- 實作：`src/auth/password-reset.service.ts`
- 實作：`src/auth/password-reset.repository.ts`

先看 `password-reset.service.spec.ts`，分別找「提出重設申請」和「使用重設連結」的案例。

### 提出申請

在 `requestPasswordReset()` 追蹤：

1. Email 如何整理。
2. 程式如何準備一次性重設代碼。
3. 哪些內容會交給 repository 保存。
4. 回覆是否會透露帳號存在或是否符合條件。

### 使用重設連結

在 `resetPassword()` 追蹤：

1. 新密碼是否符合規則。
2. 重設代碼格式是否正確。
3. 程式交給資料庫的是原始代碼，還是轉換後的值。
4. 若代碼無效、過期或已使用，服務如何處理。

再到 `password-reset.repository.ts` 看 `consumePasswordReset()`。這裡把確認重設代碼、更新密碼和讓舊登入失效放在同一個資料庫操作中。請著重理解「成功要一起成功，失敗就不能只完成一半」這個目的，不必一開始逐行研究查詢語句。

### 練習問題

- 申請重設時，回覆為什麼不直接說帳號是否存在？
- 重設連結為什麼要設期限並且只能使用一次？
- 重設成功後，哪些舊狀態需要失效？

---

## 10. 第八站：寄信與重試

### 閱讀檔案

- 測試：`src/auth/reset-mail.service.spec.ts`
- 測試：`src/auth/email-outbox.processor.spec.ts`
- 實作：`src/auth/reset-mail.service.ts`
- 實作：`src/auth/email-outbox.processor.ts`
- 實作：`src/auth/password-reset.repository.ts`

### 信件準備與寄送

在 `reset-mail.service.spec.ts` 看郵件內容如何保存、還原，以及錯誤設定如何處理。再到 `reset-mail.service.ts` 找：

- `encryptPayload()`：將等待寄出的信件內容鎖起來保存。
- `decryptPayload()`：寄送前還原內容。
- `buildResetUrl()`：組出重設連結。
- `sendPasswordResetEmail()`：將信件送出。

### 背景寄信

在 `email-outbox.processor.spec.ts` 看成功、無效連結或寄信失敗的案例，再到 `email-outbox.processor.ts` 找 `drain()` 和 `deliver()`：

1. 程式如何領取待寄的信件。
2. 寄出前如何確認重設連結仍有效。
3. 成功後如何更新狀態。
4. 失敗後如何安排再試，或停止重試。

最後回到 `password-reset.repository.ts` 找 `claimOutboxBatch()`、`markOutboxSent()` 和 `markOutboxFailed()`，看寄信工作的領取、完成和失敗狀態如何保存。

### 練習問題

- 為什麼信件要先排隊，而不是收到申請就直接寄？
- 寄送前再次確認連結有效，可以避免什麼問題？
- 失敗後為什麼不是立刻不斷重試？

---

## 11. 最後看 API 如何串起流程

閱讀 `src/auth/auth.controller.spec.ts` 和 `src/auth/auth.controller.ts`，把 HTTP 請求入口和前面的服務連起來。

先找測試中呼叫的路徑，例如：

- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`
- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- `POST /auth/password/change`

每個路徑都依照這個順序追：

```text
測試送出什麼
→ 控制器接收什麼
→ 控制器呼叫哪個服務
→ 服務呼叫哪個資料存取程式
→ 測試檢查什麼回覆
```

控制器通常負責接收請求、設定瀏覽器保存的資料和呼叫服務；判斷能否登入或如何更新資料，主要在服務與 repository。

---

## 12. 建議的逐步執行清單

每次只跑一個測試檔，按順序進行：

```bash
npm test -- --runInBand src/auth/login.dto.spec.ts
npm test -- --runInBand src/auth/auth.service.spec.ts
npm test -- --runInBand src/auth/auth-session.guard.spec.ts
npm test -- --runInBand src/auth/auth-security.service.spec.ts
npm test -- --runInBand src/auth/csrf.guard.spec.ts
npm test -- --runInBand src/auth/auth.config.spec.ts
npm test -- --runInBand src/auth/account.dto.spec.ts
npm test -- --runInBand src/auth/auth.repository.spec.ts
npm test -- --runInBand src/auth/password-reset.dto.spec.ts
npm test -- --runInBand src/auth/password-reset.service.spec.ts
npm test -- --runInBand src/auth/password-reset.repository.spec.ts
npm test -- --runInBand src/auth/reset-mail.service.spec.ts
npm test -- --runInBand src/auth/email-outbox.processor.spec.ts
npm test -- --runInBand src/auth/auth.controller.spec.ts
```

如果某個測試失敗，先閱讀它的輸入、假資料和預期結果，再追到對應的實作。不要為了讓測試變綠而直接刪除斷言或放寬條件。

---

## 13. 每個測試檔的閱讀筆記模板

可以複製以下格式，逐檔填寫：

```text
測試檔：
對應實作檔：

這個測試想確認什麼：
測試準備了什麼輸入或假資料：
程式呼叫了哪些方法：
預期成功或失敗：
測試怎麼確認結果：
我還不清楚的地方：
```

完成一個測試檔後，再進到下一個流程。這樣你會逐步建立整個 `src/auth` 的圖像，而不是一次被整個資料夾的程式碼淹沒。
