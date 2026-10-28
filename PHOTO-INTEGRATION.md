# YA 拍照與留言頁整合

目前已完成互動頁拍照、預覽及 IndexedDB 儲存。本專案內未找到 MistyMessageBoard/mobile.html，尚未宣稱或啟用留言頁串接。沒有新增上傳端點或將相片放到網址、sessionStorage。

## 現在如何使用

用 Live Server 的 localhost / 127.0.0.1 或正式 HTTPS 開啟 index.html，啟動攝影機並允許權限。☝ 擦拭霧氣；✌ 食指、中指伸直，無名指、小指收起，連續維持 1.5 秒後開始 3、2、1 倒數。倒數後不用繼續比 YA；攝影機必須保持可用。

辨識斷開、換手、兩幀相隔超過 250ms 時重算穩定時間。YA 一出現便切斷繪畫筆觸。拍照後需解除 YA 才能重新觸發；在預覽期間解除也有效。

倒數依 render loop 的時間戳更新，不使用阻塞等待。每幀水滴、VideoTexture、霧氣、擦痕與回霧仍正常更新。倒數沒有清除筆觸的程式。攝影機中斷、分頁隱藏、WebGL context 遺失或視窗改變尺寸會中止尚未完成的倒數，避免輸出失效畫面。

在 Three.js renderer.render 完成後，同一任務內立即把 WebGL Canvas 複製到獨立 2D Canvas，再非同步編碼 PNG。因此不依賴 preserveDrawingBuffer，也不會因稍後取圖而擷取到已清空的 back buffer。照片保留 drawing buffer 的實際寬高、完整 Shader 合成、鏡像人物、霧氣、水滴、水痕及擦痕；另加入 Logo，沒有其他 HTML 介面、倒數、音符按鈕、手勢游標或狀態文字。

預覽提供「重新拍攝」與「留下我的故事」。重拍會返回現有互動畫面，保留原擦痕，不會重置霧膜。照片只有在選擇「留下我的故事」時寫入 IndexedDB；未儲存的預覽在關閉／重整頁面後不會保留。儲存失敗時保留目前預覽並提示重試。

## 留言頁接收協定

必須部署在**同一來源**：協定、主機名稱、連接埠皆相同。localhost 和 127.0.0.1、不同 Live Server port、不同網域都不是同一來源。不同路徑可以同源；檔案總管 file:// 開啟不作為正式整合方式。

IndexedDB schema：

| 項目 | 值 |
| --- | --- |
| Database | MistyWaterLabPhotos |
| Version | 1 |
| Object store | photos |
| keyPath | id |
| Record | `{ id, blob, width, height, mime, createdAt }` |
| blob | 完整 image/png Blob，非 base64 字串 |

留言頁必須先實作 photoId 的接收與讀取。以下僅為整合範例，並未修改其他專案：

```js
// 依實際部署路徑調整 import；此檔也可與留言頁共同部署。
import { loadPhoto } from '/interactive/photo-store.js';

const photoId = new URLSearchParams(location.search).get('photoId');
const record = photoId ? await loadPhoto(photoId) : null;
if (record?.blob instanceof Blob) {
  const previewUrl = URL.createObjectURL(record.blob);
  document.querySelector('#story-photo').src = previewUrl;
  // 把 record.blob 留給使用者主動送出故事時使用。
  // 預覽不再使用或頁面離開時 URL.revokeObjectURL(previewUrl)。
} else {
  // 顯示照片不存在／請回互動頁重新拍攝的提示。
}
```

確認接收端和照片預覽都完成後，才修改 photo.js 的 messageBoard 設定，例如：

```js
export const messageBoard = Object.freeze({
  url: '/MistyMessageBoard/mobile.html',
  photoImportReady: true,
});
```

啟用後只會導向同源 URL，附上 `?photoId=<UUID>`。照片內容不經網址傳送。不同來源需要另行設計明確的本機匯出／匯入或經使用者同意的傳輸流程，單靠 IndexedDB 不能共享。

## 驗證結果與待驗收

已用桌面 Chrome 真實時間執行 tests/photo.html：YA／食指互斥、旋轉姿勢、1.5 秒門檻、斷幀／換手重算、解除鎖定、倒數、最後一秒保留擦痕、實際正式 GLSL 擷取、PNG 與 WebGL 像素一致、無倒數介面污染、預覽／重拍、IndexedDB Blob 寫入讀取、未整合留言頁提示、攝影機失效中止皆通過。相片測試使用合成攝影機圖樣，不使用真人影像。

tests/gestures.html、tests/water.html、tests/audio.html 回歸檢查亦通過，涵蓋食指繪畫、固定參數與 GPU uniforms、Shader 編譯、凝結和水滴、桌面／手機 Logo 比例、音效控制。

手動測試：先擦幾筆，再短暫比 YA（不應倒數）；連續比 YA 1.5 秒，確認 3、2、1 期間畫面繼續動且擦痕不消失；預覽檢查鏡像人物、水滴、霧氣、擦痕、Logo 與正常寬高比，且沒有控制介面。保持 YA 點重拍應不連拍，解除後再比可重拍。「留下我的故事」應提示本機已暫存；在 DevTools → Application → IndexedDB 檢查 photos 記錄。

尚未驗收：真人 YA 在不同光線／手掌角度的辨識率、實體手機 Safari／Chrome 的相機與觸控操作，以及真正 mobile.html 的接收流程。這些不可由合成圖樣測試取代。

可直接用 Live Server 開啟各 tests/*.html 看 ALL CHECKS PASSED。照片儲存測試需要真實時間，避免 Chrome 的 virtual-time-budget 提早用完而未等到 IndexedDB。Windows 的可選無視窗測試：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\browser-check.ps1 -TestName photo
```

這只對當次測試程序允許執行腳本，不更改系統執行政策。測試只刪除自身建立的相片記錄，不刪除觀眾作品。
