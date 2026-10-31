# Familiar Desktop

Electron シェル(M4)。方針(spec 01/06):
- 薄クライアントとして `familiar serve` の JSON-RPC + WebSocket イベントに接続
- コアの状態を一切持たないため、後日 Tauri への移植も可能
- v1 画面: セッション一覧 / チャット + tool diff 表示 / 承認 Inbox(memory・skill の staged writes)/ curator ダッシュボード

## ウィンドウ/タスクバー アイコン(Linux)

タスクバーに歯車等の汎用アイコンが出る場合は次の 2 点を確認する:

1. **Wayland app_id**: Electron は `package.json` の `desktopName`(`.desktop` を除いた値)を
   xdg app_id に使う(`platform_util::GetXdgAppId`)。`.desktop` ファイル名 /
   `StartupWMClass` と一致させること。本パッケージは `"desktopName": "familiar-harness.desktop"`。
   X11 の WM_CLASS は `app.name` 由来(変更には `productName` が必要で userData も動く)
   のため、X11 は `_NET_WM_ICON` 側でアイコンを表示する。
2. **実行時アイコン**: `BrowserWindow({ icon })` に PNG を渡す(`resources/icon.png` を
   extraResources で同梱。dev は `build/icon.png`)。AppImage を展開して `AppRun` で起動する
   使い方では .desktop がタスクバーに届かないため、この指定が必須。

electron-builder 側は `linux.syncDesktopName: true`(生成 .desktop 名を desktopName に合わせる)
と `build/icon.ico`(Windows の exe アイコン)を使う。
