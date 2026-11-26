# 00 — 概要とプロダクト方針

ステータス: 確定 / 最終更新: 2026-11-27

## 1. Familiar とは

ローカルファーストのクライアント/サーバ型エージェントハーネス。LLM エージェントの
実行基盤(ループ・ツール・権限・永続化・自己改善)を単一のコアとして提供し、
CLI / Web UI / デスクトップアプリの3フロントエンドがそのコアを共有する。

## 2. 参考プロダクトから取り入れた設計判断

| 参考元 | 取り入れた設計 | 用途 |
|---|---|---|
| OpenCode | client/server 分離、複数 UI、provider カタログ(models.dev 互換思想)、plugin/hooks、worktree 対応(M2 以降) | デスクトップと CLI を同一コアで支える土台 |
| Claude Code | ツールインターフェース(read/edit の一意マッチ制等)、plan モード、AGENTS.md 的プロジェクトメモリ、headless 実行(`run -p`) | CLI の使い勝手とツール品質 |
| Hermes Agent | 自己改善ループ(memory+skills+self-review+write_approval+curator)、aux model slot、SOUL.md プロファイル、cron/閑散時保守 | 差別化中核機能 |

## 3. 製品要件(確定事項)

1. **コア**: TypeScript / Node 24+ (ESM)。npm workspaces monorepo(tsc -b project references)。
2. **UI**: CLI(Node 版 TUI/REPL)、Web UI(`familiar serve`)、Electron デスクトップ。通信はすべて `@familiar/protocol` 定義の JSON-RPC + イベントストリーム。デスクトップは後日 Tauri への移植が可能な薄クライアント。
3. **OS**: Windows / Linux 両対応を全機能の前提とする(macOS は追従対象)。
4. **プロバイダ**: OpenAI 互換(OpenAI/OpenRouter/Ollama/LM Studio 等)、Anthropic、mock(テスト)。Google は M2。
5. **自己改善**: Hermes 方式を段階投入(M3: memory/skills/self-review/write_approval、M4: curator)。
6. **周辺機能 v1**: MCP / LSP / hooks / cron / コネクタ / Web 検索 / ユーザー編集可能な MEMORY.md。
   独立性の高いプラグイン API は v1.1 以降の継続課題(メッセージング gateway は v2)。

## 4. Non-goals(v1)

- メッセージング gateway(Discord/Slack/WhatsApp)— v2 で検討
- クラウド Sync / マルチユーザ
- ブラウザ自動化・voice 系(将来検討)
- トークン直書き設定(禁止。secret はファイル/環境変数参照のみ)

## 5. 用語

- **turn**: ユーザーの1回の発話から最終応答までの一連のループ実行
- **step**: turn 内の LLM 呼び出し1回(ツール実行を挟んで複数 step)
- **part**: メッセージ内部の要素(text / tool_call / tool_result)。M1 では message 1 = パート集合を保持
- **aux モデル**: 要約・自己レビュー・curator など副作用の強い/低コストで済む副タスク用モデルスロット
- **staged write**: 自己改善プロセスが生成した未承認の memory/skill 変更
