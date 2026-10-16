# 03 — ツール仕様

ステータス: 確定(M1 の 6 ツールを実装) / 最終更新: 2026-10-17

## 1. 共通インターフェース

```ts
interface ToolContext {
  sessionId: string;
  cwd: string;            // ツールの基準ディレクトリ(session に紐づく)
  yolo: boolean;          // 承認フロー抑止(CLI フラグ)
  config: ResolvedConfig;
  approval: ApprovalAdapter;
}
interface Tool {
  name: string;
  description: string;    // LLM 表示用(英語)
  parameters: JSONSchema; // type: object
  needsApproval?(args: Record<string, unknown>, ctx: ToolContext): Promise<{ required: true, summary: string } | { required: false }>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}
type ToolOutput = { content: string; isError?: boolean };
```

- JSON Schema 検証は簡易バリデータ(`required` / `type` / `enum` / `minLength`)。
  不備は isError メッセージとして LLM に返す(ループは継続)。
- エラーも `role: "tool"` メッセージとしてセッションに保存される(LLM が自己修復できるように)。
- 安全: 相対パスは `ctx.cwd` 基準。絶対パス可だが、`write/edit` は作業領域外の場合承認要求。

## 2. M1 ツール一覧

### read

| param | 型 | 既定 | 説明 |
|---|---|---|---|
| `path` | string | 必須 | 対象ファイル |
| `offset` | number(1始まり) | 省略 | 開始行 |
| `limit` | number | 2000 | 最大行数 |

- 出力は `行番号<TAB>内容` 形式(Claude Code 方式)。行長 > 2000 文字は切り詰め。
- 全体サイズ上限 ~256KB。バイナリ(NUL 検出)はエラー。

### write

| param | 型 | 説明 |
|---|---|---|
| `path` | string | 対象ファイル(親ディレクトリは自動作成) |
| `content` | string | 全文(既存は上書き) |

### edit

| param | 型 | 説明 |
|---|---|---|
| `path` | string | 対象ファイル |
| `old_string` | string | 置換対象(完全一致・省略時必須ユニーク) |
| `new_string` | string | 置換後 |
| `replace_all` | boolean | 既定 false。true で全箇所 |

- `old_string` が 0 件 → エラー(読み直しを促す)。複数件 → エラー(前後文脈で一意化を指示)。
- 置換は行末スタイルを保ったバイト置換(CRLF 要求時のみ対応)。

### glob

| param | 型 | 既定 | 説明 |
|---|---|---|---|
| `pattern` | string | 必須 | `**/*.ts` 形式(`**`, `*`, `?`, `[...]` 対応) |
| `path` | string | ctx.cwd | 検索ルート |

- スキップ: `.git`, `node_modules`, `dist`, 隠しディレクトリ(`.` 始まり)。
- 上限 200 件、mtime 降順。

### grep

| param | 型 | 既定 | 説明 |
|---|---|---|---|
| `pattern` | string | 必須 | 正規表現(JS RegExp) |
| `path` | string | ctx.cwd | 検索ルート(ファイル可) |
| `include` | string | 省略 | ファイル名 glob フィルタ |
| `case_sensitive` | boolean | true | |
| `literal` | boolean | false | 正規表現を文字列として扱う |
| `max_results` | number | 100 | 上限 |

- 出力は ripgrep 風: `path:line: プレビュー`。
- バイナリ判定(先頭1KB の NUL / 1MB 超)でスキップ。

### bash

| param | 型 | 既定 | 説明 |
|---|---|---|---|
| `command` | string | 必須 | シェルコマンド |
| `timeout_ms` | number | 30000 | 最大 600000 |
| `cwd` | string | ctx.cwd | サブディレクトリまで可 |

- シェル: `resolveShellCommand()`(Windows: PowerShell / それ以外: bash)。
- stdout+stderr 結合、上限 256KB(超過で末尾を残す)。
- **承認**: `config.permissions.bash.allow`(先頭一致 or 正規表現)で OK / `deny` で拒否 /
  それ以外は ApprovalAdapter(desktop はダイアログ、CLI は y/n プロンプト、非対話は拒否)。
  `yolo` で全許可。

## 3. 承認フロー

```
needsApproval → required でない → 実行
              → required 且つ allowlist → 実行
              → required 且つ yolo → 実行
              → required → ApprovalAdapter.request({tool, summary, detail})
                    → approved? 実行 : tool result に "[denied]" を返す
```

- UI アダプタ: CLI は readline y/n(headless は deny 既定、desktop は M4 ダイアログ + `permission.respond`)。
- **deny パターンは allow より優先**。
- plan モード時は read_only 以外のツールがそもそも広告されず、呼ばれても実行拒否(§5)。

## 4. M2 ツール(webfetch / websearch / todo / task)と plan モード

### webfetch(read_only)

| param | 型 | 説明 |
|---|---|---|
| `url` | string | 取得対象 |
| `max_chars` | number | 返すテキスト上限(既定 20000) |

- HTML は簡易 text 化(script/style 除去・タグ剥ぎ・実体参照デコード)。
- content-type は text/* / json のみ(バイナリ拒否)。取得上限 1MB。
- ドメインポリシー `permissions.webfetch.{allow_domains,deny_domains}`。**既定で内部アドレス(localhost / 127.* / ::1 / 10.* / 192.168.* / 172.16–31.* / 169.254.*)を deny**(SSRF 対策)。allow が deny に優先。

### websearch(read_only)

| param | 型 | 説明 |
|---|---|---|
| `query` | string | 検索語 |
| `count` | number | 既定 5(上限 20) |

- バックエンド: SearXNG JSON API(`permissions.websearch.base_url`)。未設定なら設定方法のヒント付きエラー。
- 返却: `n. title — url` + snippet。

### todo(セッション単位の作業リスト)

| param | 型 | 説明 |
|---|---|---|
| `action` | enum: set/add/update/remove | |
| `items` | array | set 時 `{title,status?}[]`(id 自動採番) |
| `id` / `title` / `status` | string | add/update/remove 用 |

- 保管はメモリ(TodoStore、server 保持)。system prompt に `# Current todo state` として毎 step 注入。
- status: `pending | in_progress | done`。

### task(read_only=false / サブエージェント)

| param | 型 | 説明 |
|---|---|---|
| `description` | string | 委任内容(短く) |
| `prompt` | string | サブエージェントへの完全な指示 |

- 親セッションの provider/model/cwd を継承した新セッションで `AgentRunner` を起動(maxSteps 15)、最後の assistant テキストを返す。通常セッションとして永続化。並列化は M5。

### plan モード(M2)

- 有効化: `session.send {plan:true}` / CLI `--plan` / chat `/plan`。
- system prompt に計画専用の節を追加(調査と設計のみ)。
- 広告は `read_only: true` のみ(read / glob / grep / webfetch / websearch)。
- 非 read_only ツールは実行されずエラー返却("not available in plan mode")。ループ継続。
- plan は turn 単位のフラグ(セッションには保存しない)。

### fallback チェーン(M2)

- `fallback: ["provider/model", ...]`。
- `FallbackProvider`: **ストリーミング開始前**のエラー(接続不能 / 5xx / 429 / timeout)で次候補へ。chunk 出力済みなら fail-over しない。
- `models.list` は主プロバイダのみ照会。

### worktree(CLI コマンド / M2)

- `familiar worktree list | add <name>| remove <name>`(開発リポジトリ自体への git worktree 操作、実装は `git worktree` の薄いラッパ)。

## 5. 実装上の追加予定

| ツール | Phase |
|---|---|
| memory_manage / skill_view / skill_manage | M3 |
| MCP 動的ツール | M5 |
