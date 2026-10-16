# 01 — 全体アーキテクチャ

ステータス: 確定 / 最終更新: 2026-10-17

## 1. 構成図

```
 familiar-desktop (Electron, M4)      familiar CLI (REPL / headless / serve)
        │                                   │
        └──────── JSON-RPC + イベントストリーム ─────┘
                        │ (localhost, protocol 定義は共用)
                 familiar-server(AgentServer)
                        │
     ┌──────────────────┼────────────────────┐
  AgentRunner        SessionStore          Integrations
  (agent loop)       (node:sqlite)         (ツール実行・将来: MCP/LSP)
     │
  Provider 層(openai_compatible / anthropic / mock / …)
```

- `AgentServer` はロジック層で HTTP とは独立。`familiar serve` が HTTP+WS トランスポートを付加。
- CLI の `run` / `chat` は **InProcessTransport** で同一 RPC インターフェースを直接呼ぶ(サーバ起動を要求しない)。外部クライアント(desktop 等)用に `familiar serve` で同名メソッドを公開。
- 将来 CLI → デーモン接続(`familiar serve` 自動 spawn)は M2。

## 2. パッケージ構成と依存方向

```
protocol  ←  core  ←  server  ←  cli
                ↑
              (tools/providers/session/agent は core 内部)
```

- `@familiar/protocol`: RPC メソッド型・AgentEvent・ChatMessage 等の純定義。依存ゼロ。
- `@familiar/core`: AgentRunner、Provider 実装、tool 実装、SessionStore、config。依存: yaml のみ。
- `@familiar/server`: AgentServer + HTTP/WS トランスポート。依存: core, ws。
- `@familiar/cli`: エントリポイント(bin: `familiar`)。依存: core, server。

## 3. データフロー(1 turn)

```
user text
  → SessionStore.appendMessage(user)
  → AgentRunner.sendUserMessage()
      loop:
        Provider.chat(messages + tools) ─ streaming
          │ emit: text.delta / tool.call
          ▼
        assistant msg 完了 → append(assistant)
        toolCalls あり?
          → 各 call: Permission check → Tool.execute → append(tool result)
          → 次の step へ(maxSteps 上限あり)
        toolCalls なし → turn 完了
  → 各イベントは SessionStore への書込とクライアント通知を並行して実施
```

## 4. コンテキスト管理(M1 の方針)

- 文字数ベースの単純ガード: 推定トークン(chars/4)が `context.token_soft_limit` を超えたら
  中間の tool_result / 古いメッセージを要約せず破棄し `[compacted: N messages dropped]` に置換。
- 本格的な要約 compaction(aux モデル使用)は M3。

## 5. システムプロンプト構成

1. ハーネス基本ペルソナ(組み込み・英語)
2. `~/.familiar/profiles/<profile>/SOUL.md`(任意、profile 機能 M2 だがファイル読込は M1 から)
3. cwd から親方向に見つけた `AGENTS.md`(全て連結、上限あり)
4. 有効ツール一覧と安全注意

## 6. セッション永続化

- `~/.familiar/state.db`(SQLite via node:sqlite)
- テーブル: `sessions(id, title, provider, model, profile, cwd, created_at, updated_at)`,
  `messages(id, session_id, seq, role, content, name, tool_call_id, tool_calls, meta, created_at)`
- M3 で `memories`, `skills_meta`, `approvals` 将来テーブルを追加予定(破壊的 migration はしない)。

## 7. セキュリティ設計

- トークン解決の優先順位: `auth.api_key`(永続化禁止配置のみ)→ `auth.api_key_file` → `auth.env`(環境変数名)。
  いずれも `resolveAuthSecret()` で統一処理し、ファイルパスは `~` 展開対応。
- `config.get` RPC はシークレットをサニタイズして返す(`***`(値非表示)マーカ)。
- サーバーは `127.0.0.1` バインドのみ(M1)。トークン認証オプションは `server.auth_token_file`(M2)。

## 8. Windows / Linux 両対応指針(コード規約)

- パスは `node:path` API 経由。`os.homedir()` 使用。
- bash ツールのシェル解決: Windows → `powershell.exe -NoProfile -NonInteractive -Command`(なしなら cmd.exe フォールバック)、それ以外 → `bash -c` (`resolveShellCommand()`)。
- glob/grep ツールの走査は自前ウォーカー(展開なし)。`node_modules` `.git` `dist` 等を既定スキップ。
- 改行: ファイル I/O は原状保持、内部正規化は行わない(edit ツールはバイト一致)。

## 9. ディレクトリレイアウト(実装)

```
packages/
  protocol/src/{types.ts, rpc.ts, events.ts, index.ts}
  core/src/
    {index.ts, config.ts, paths.ts, logger.ts}
    agent/{loop.ts, prompts.ts}
    providers/{base.ts, openai-compatible.ts, anthropic.ts, mock.ts, index.ts}
    tools/{registry.ts, permissions.ts, fs-tools.ts, bash.ts, index.ts}
    session/{store.ts, json-sqlite.ts}
  server/src/{agent-server.ts, http-transport.ts}
  cli/src/{familiar.ts, commands/*.ts, ui/display.ts}
  desktop/  (M4)
```
