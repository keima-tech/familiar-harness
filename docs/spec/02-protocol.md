# 02 — RPC プロトコル(@familiar/protocol)

ステータス: 確定(M1 サブセットを実装) / 最終更新: 2026-10-17

## 1. 原則

- すべてのクライアント(CLI / Desktop / 将来 Web)は同一の RPC インターフェースのみを利用。
  コアのロジックに直接触れない。
- リクエスト/レスポンスは JSON-RPC 2.0 形式(`POST /rpc`)。
- ストリーミングは WebSocket(`/ws`)経由の `event` 通知。

## 2. トランスポート(M1)

### HTTP RPC

```
POST /rpc
{ "jsonrpc": "2.0", "id": 1, "method": "session.list", "params": {} }
→ 200 { "jsonrpc": "2.0", "id": 1, "result": [ ... ] }
```

### WebSocket イベント

- 接続先 `/ws`。
- サーバ→クライアント: `{ "type": "event", "sessionId": "...", "event": AgentEvent }`
- クライアント→サーバ(M2 以降): 購読フィルタ・キャンセル。

### InProcessTransport(CLI 用)

`AgentServer.dispatch(method, params, { onEvent })` を直接呼ぶ。イベントは
`onEvent` コールバックに同期的に流れる。WS と同一のメソッド・イベント集合。

## 3. メソッド一覧(M1 実装)

| メソッド | 引数 | 返却 |
|---|---|---|
| `ping` | — | `"pong"` |
| `config.get` | — | サニタイズ済み設定(シークレットは `"***"` 表示) |
| `models.list` | `{ provider?: string }` | `ModelInfo[]` |
| `session.create` | `{ title?, provider?, model?, profile?, effort?, cwd? }` | `SessionRecord` |
| `session.list` | — | `SessionRecord[]`(updated_at 降順) |
| `session.get` | `{ id }` | `{ session, messages }` |
| `session.update` | `{ id, title?, provider?, model?, profile?, effort?, cwd? }` | `SessionRecord` |
| `session.delete` | `{ id }` | `{ deleted: true }` |
| `session.send` | `{ id, text, provider?, model?, effort?, maxSteps?, yolo?, plan? }` | `{ turnId, steps, toolCalls, usage }`(イベントは WS / onEvent で流れる) |
| `session.abort` | `{ id }` | `{ aborting: boolean }` — 実行中 turn を中断(API 呼び出しを abort。実行中ツールはそのステップ完了後に停止) |
| `permission.respond`(M2) | `{ requestId, approved }` | `{ resolved: true }` — serve モードの動的承認 |
| `memory.list`(M3) | `{}` | `{ memories: MemoryEntry[], pendingCount }` |
| `memory.pending`(M3) | `{}` | `{ items: PendingItem[] }` |
| `memory.approve`(M3) | `{ id }` | `{ approved: true }`(id は 8 文字 prefix 可) |
| `memory.reject`(M3) | `{ id }` | `{ rejected: true }` |
| `memory.approval`(M3) | `{ set?: "on"\|"off" }` | `{ memoryWriteApproval, skillsWriteApproval }` |
| `skills.list`(M3) | `{}` | `{ skills: SkillCatalogEntry[], pendingCount }` |
| `skills.view`(M3) | `{ name }` | `{ body, warnings }` |
| `skills.pending`(M3) | `{}` | `{ items: PendingItem[] }` |
| `skills.approve`(M3) | `{ prefix?, all?: true }` | `{ approved: n, failed?: [..CAS 拒否..] }` |
| `skills.reject`(M3) | `{ prefix }` | `{ rejected: n }` |
| `curator.status`(M4) | `{}` | `{ curator: { enabled, paused, consolidate, lastRunAt?, nextDueAt?, stale[], archived[], snapshots } }` |
| `curator.run`(M4) | `{ dryRun?, consolidate? }` | `{ phase1, consolidation? }` — phase-1 遷移 + (opt-in) 統合提案の staging |
| `mcp.status`(M5) | `{}` | `{ servers: [{ name, state, tools[], error? }] }` — 各 MCP サーバの接続状態とツール一覧 |
| `cron.status`(M5) | `{}` | `{ started, jobs: [{ name, everyMinutes, prompt, lastRunAt?, lastStatus?, nextRunAt?, onceAtBoot, ranOnce }] }` |

### serve の静的配信(M4)

- `GET /` / `/app.js` / `/app.css` … 単一ページ Web UI(照: `packages/server/public`)。セッション一覧・チャット・動的承認ボタン・自己改善 Inbox を含む。
- `GET /healthz` … `{ ok: true, protocol: "familiar/1" }`(desktop や CLI probe の生存確認に使用)。
- 上記以外の GET とディレクトリトラバーサルは 404。
| `config.get` に含まれるサニタイズ項目は 05 を参照 | | |

`ModelInfo = { id: string; provider: string; contextTokens?: number }`
`SessionRecord = { id, title, provider, model, profile?, effort? (low|medium|high|null), cwd, createdAt, updatedAt }`

## 4. AgentEvent 型

すべての turn 関連イベントは `sessionId` を添えて通知される。

```ts
type AgentEvent =
  | { type: "turn.start";    turnId: string }
  | { type: "step.start";    turnId: string; index: number }
  | { type: "message.start"; messageId: string; role: "assistant" }
  | { type: "text.delta";    messageId: string; text: string }
  | { type: "message.end";   messageId: string; stopReason?: string; usage?: Usage }
  | { type: "tool.call";     messageId: string; toolCall: ToolCall }
  | { type: "tool.result";   toolCallId: string; name: string;
                             content: string; isError: boolean; durationMs: number }
  | { type: "turn.end";      turnId: string; usage?: Usage }
  | { type: "turn.aborted";  turnId: string }                       // ユーザー中断(session.abort)。turn.error と同時に出ない
  | { type: "turn.error";    turnId: string; error: string; recoverable: boolean }
  | { type: "compaction";    dropped: number; kept: number; summarized?: boolean }
  // M2: dynamic approval (serve mode)
  | { type: "permission.request";  requestId: string; tool: string; summary: string; detail?: string }
  | { type: "permission.resolved"; requestId: string; approved: boolean }
  // M3: self-improvement
  | { type: "improvement.staged"; memoryCount: number; skillCount: number }
  | { type: "memory.truncation"; dropped: number }
  // M5: scheduled prompts (serve)
  | { type: "cron.run"; name: string; status: "ok" | "error"; durationMs: number };
Usage = { promptTokens?: number; completionTokens?: number };
ToolCall = { id: string; name: string; arguments: string /* JSON text */ };
```

- `text.delta` は streaming 中のみ。UI は `message.start … text.delta* … message.end` を
  ひとつのアシスタント応答として描画。
- `tool.call` はループ内で新しく観測されたツール呼び出し完成時点(`tool_use` 確定時)。
- `turn.error` は provider 通信エラー等の復帰不能エラー。turn は異常終了し、メッセージは
  保存済みの状態までコミットされる。
- `turn.aborted` は `session.abort` による正常中断(provider の API 呼び出しを abort)。
  `session.send` 自体は `{ turnId: "", aborted: true }` で正常応答し、`turn.error` は出ない。

## 5. 承認の流れ(serve モード / M2)

1. ツールが `ctx.approval.request()` を呼ぶ(例： bash の承認必要コマンド)
2. serve モードでは `RpcApprovalAdapter` が `permission.request` を全 WS クライアントへ
   ブロードキャストし、応答を待つ(既定 300 秒タイムアウト = deny)
3. クライアントは `permission.respond { requestId, approved }` を `POST /rpc` で返す
   → `permission.resolved` が全クライアントに配信され、ツール実行が継続 / 拒否される
4. 接続 UI がない場合・タイムアウトは **deny(安全側)**

## 6. CLI リモートモード(M2)

- `run` / `chat` 起動時に `POST /rpc ping` をプローブし、`familiar serve` が生きていれば
  **リモートモード**(RPC + WS)で動作、なければ従来の InProcess モード。
- `--local` で常時 InProcess 強制、`--server URL` で明示指定。
- リモートモードでは CLI が permission.request をローカルの y/n プロンプトにブリッジし
  `permission.respond` を返す。

## 7. M3 以降の追加予定

- `session.fork`、`session.rename`
- file diff 通知(desktop のエディタ連携)
- `memory.get|pending|approve`、`skills.*`(自己改善 M3)

