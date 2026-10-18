# Familiar — リポジトリ方針(AI エージェント向け指示を含む)

## プロジェクトの目的

client/server 型エージェントハーネス。コア(`packages/core`)は UI 非依存の純粋ロジック、
`server`/`cli`/`desktop` は `@familiar/protocol` の RPC 経由でコアを利用する。

詳細仕様は `docs/spec/`。仕様と実装が乖離したら、まず spec を更新してから実装を変える。

## 技術スタック

- TypeScript(Node 24+)、ESM(`"module": "NodeNext"`、**相対 import は必ず `.js` 拡張子付き**)
- monorepo: npm workspaces + `tsc -b`(project references)
- 依存は最小限に(現状 `yaml`, `ws` のみ)。新しい依存を足す前に AGENTS.md に追記して共有すること
- ストレージ: Node 組み込み `node:sqlite`(ネイティブ依存を増やさない)

## コーディング規約

- strict TypeScript(`noUncheckedIndexedAccess` 有効)。`any` は理由をコメントなしで使わない
- エラーは `UnknownError` 形式の文字列メッセージでなく、具体的な型/メッセージで API 側に伝播させる
- Windows/Linux 両対応を常に意識:
  - パスは `node:path` の API で組み立て(OS 固有の `/` 直書き禁止)
  - シェル実行は `resolveShellCommand()` を経由(Windows は PowerShell 既定)
  - 改行・エンコーディングを決め打ちしない
- UI 文字列: CLI表示は英語。README は二言語(README.md=英語・README.ja.md=日本語、内容を同期)、docs/spec は日本語

## セキュリティ(最重要)

- **トークン/秘密情報をソースコード・コミット・ログ・テストに出力しない**
  - 認証情報は `~/.familiar/*.token` ファイルまたは環境変数から解決(`packages/core/src/config.ts` の `resolveAuthSecret`)
  - `config.get` 等 API の応答にはシークレットを含めない(サニタイズ)
  - GUI/CLI から設定した API キーは `~/.familiar/secrets/<provider>.key`(0600)にのみ保存し、
    config.yaml には `api_key_file` 参照のみを書く(`writeProviderToDisk`)
- 破壊的な操作(rm -rf、sudo、外部送信)は必ず承認フロー(`ApprovalAdapter`)を通す
- テストはネットワーク不要(mock プロバイダ)で完結させる

## テスト

- `npm run smoke` — mock プロバイダで headless run 全経路(ループ・ツール呼び出し・保存)を検証。**コミット前に必ず通す**
- `npm run typecheck` — 型チェック。コミット前に必ず通す

## コミット

- Conventional Commits(`feat(core): ...` / `docs: ...` / `chore: ...`)
- スコープはパッケージ名(core, server, cli, protocol, docs)

## 作業時の注意

- このリポジトリの外のファイル(特に `~/.hermes/` 以下)を読み書きしない
- `~/.familiar/state.db` は実データなので試験でも削除・変更しない(テストは `--config` で isolated 設定を渡す)
