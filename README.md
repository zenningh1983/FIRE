# 退休現金流規劃

以原生 ES Modules 開發的退休規劃工具。公開 repository 只保存程式，財務 JSON 保存於 Private `zenningh1983/Json-data`。

## 本機預覽

```bash
node server.js
```

開啟 <http://localhost:8080>。

## 私人資料儲存

- 退休設定：`Json-data/retirement-settings.json`
- 每月收支：`Json-data/cashflows.json`
- 資產與勞退：`Json-data/assets.json`
- 房貸：`Json-data/mortgage.json`
- 個人預設值：`Json-data/defaults.json`

登入時需提供具備 Private `Json-data` repository Contents 讀寫權限的 GitHub Personal Access Token。Token 只會存入該瀏覽器的 `localStorage`；線上更新會透過 GitHub Contents API 寫入私人 JSON。

`FIRE` GitHub Pages 可保持公開，但不包含財務 JSON；未通過 Token 驗證時不會載入私人資料。

## GitHub Pages

GitHub Pages 直接從 `main` 分支根目錄部署靜態前端。

## 版本規則

版本格式為 `YY.MMDD.N`，例如 `26.0922.1`；同一天再次發布時依序增加最後一碼為 `.2`、`.3`。
