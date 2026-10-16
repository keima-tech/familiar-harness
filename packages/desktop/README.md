# Familiar Desktop

Electron シェル(M4)。現状は placeholder。

方針(spec 01/06):
- 薄クライアントとして `familiar serve` の JSON-RPC + WebSocket イベントに接続
- コアの状態を一切持たないため、後日 Tauri への移植も可能
- v1 画面: セッション一覧 / チャット + tool diff 表示 / 承認 Inbox(memory・skill の staged writes)/ curator ダッシュボード

ビルドは M4 で追加(Electron + Vite + React)。
