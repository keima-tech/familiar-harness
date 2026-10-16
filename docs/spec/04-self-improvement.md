# 04 — 自己改善ループ(中核機能)

ステータス: 設計確定(M3/M4 実装) / 最終更新: 2026-10-17

Hermes Agent の実装を参考に、以下の 5 部品で構成する。**memory は「常時コンテキストに載る小さな事実」、skills は「関連時のみロードする手続き」**という役割分担が原則。

```
  turn 完了
    │
    ▼
 [background self-review]   ── 対話とは独立した aux エージェント
    │  (訂正点・再利用可能な手順の抽出)
    ├─→ memory への書き込み案  ─┐
    ├─→ skill への書き込み案   ─┤
    │                          ▼
    │                 [staged writes: ~/.familiar/pending/{memory,skills}/]
    │                          ▼
    │              write_approval=true → 人間が承認(approve/reject)
    │                                     │ approve で反映
    ▼                                     ▼
  次の turn (memory 注入 / skills カタログ参照)
    ... 時間経過 ...
    ▼
 [curator] 使用統計・stale 化・archival・(opt-in)統合
```

## 1. memory(常時コンテキスト)

- 格納: `~/.familiar/memories/<namespace>.json`(エントリ = `{ id, content, tags[], createdAt, updatedAt, source: "foreground"|"background" }`)
- system prompt に毎ターン注入(合計文字数上限あり、超過は新しめ順でカットし `turn` イベント通知)
- 操作: `memory_manage` ツール(create / patch / remove / list)
- ユーザー側: `familiar memory pending|approve <id>|reject <id>|approval on|off`
- 設定: `memory: { write_approval: true(既定), max_prompt_chars: 4000 }`。承認 on/off の実行時上書きは `~/.familiar/settings.json`。

## 2. skills(遅延ロード手続き)

- 形式: `~/.familiar/skills/<name>/SKILL.md`(+ `references/`, `scripts/`, `templates/` 任意)
  - frontmatter: `name`, `description`
  - SKILL.md 本体はカタログ一覧でのみ description を参照し、該当タスク時に `skill_view` で全文ロード
- 操作: `skill_manage` ツール(create / edit / patch / delete / write_file / remove_file)
- **リンタ(warn のみ、書込ブロックなし)** — Hermes 準拠:
  - `incident-log-shape`: 本文が PR/issue 番号密度の高い「事件ログ」になっている
  - `oversized-body`: SKILL.md 本文 > ~24k 文字
  - `references-sprawl`: references/ > 60 ファイル
- 原則 **lessons, not logs**: 一般化可能なルール + その理由(1文)を付属させる。PR番号・日付・会話の引用は書かない。

## 3. background self-review(ターン毎の内省)

- **トリガ**: turn 完了後、フォアグラウンドとは別の文脈(別 prompt cache)で aux エージェントを起動
- 入力: 直近 turn の(ユーザー発話 → ツール実行 → 応答)要約対象原文、既存 memory/skill カタログ
- 動作:
  1. ユーザーに訂正された点、失敗して見つかった正しい手順、再利用に値する手順を抽出
  2. 既存 memory/skill と重複しないか照合し、新規 create か patch(既存参照)かを決定
  3. **書き込みは必ず staging**(直接反映しない)。patch は対象エントリのスナップショットを保存
- 非目標: 対話への割込、フォアグラウンド途中での書き込み、ユーザーが拒否した内容の再提案
- ユーザーへの通知: 完了時に要約通知(desktop ではトースト、CLI は次ターン先頭の短い表示、`display.memory_notifications` 相当)

## 4. write_approval(承認ゲート)

- `memory.write_approval: true`(既定)/ `skills.write_approval: true`(既定)
- staging 格納先: `~/.familiar/pending/memory/`(エントリ JSON)、`~/.familiar/pending/skills/<name>/`
- staged patch は** CAS 的保護**: 承認時に対象が staging 以外から更新されていたら適用拒否(不整合を防ぐ)
- UI: CLI `familiar memory pending / approve / reject`、desktop は「承認 Inbox」ビュー(diff + approve/reject)
- 承認者は元ネタ(どの turn 由来か)を確認できるよう source を記録

## 5. curator(スキル園芸のバックグラウンド保守)

cron ではなく**非アクティブ & 閑散時チェック**で実行(desktop 起動時・`familiar serve` の maintenance timer)。

### 実行条件

- 前回実行から `interval_hours`(既定 168 = 7日)経過
- かつ `min_idle_hours`(既定 2h)アイドル
- 初回は観測のみ(last_run_at を起点に設定し 1 interval 遅らせて開始)

### Phase 1: 自動遷移(deterministic、LLM 不要・常時有効)

- 14 日未使用 → `stale`、30 日未使用 → `~/.familiar/skills/.archive/` へ移動
- pinned / cron 参照中スキルは対象外
- 未使用(use_count==0)スキルは作成後 `stale_after_days` 経過まで archiving 対象としない
- **削除はしない**(最悪値 archival。復元可能)

### Phase 2: LLM consolidation(既定 OFF・opt-in)

- aux モデル(loop とは別)がスキル群を精査し、保持 / patch / 統合(umbrella 化) / archival(証跡 `absorbed_into` 付き)を決定
- 1 sweep で 50-100 回の API 呼び出しになりうる重い処理 → 必ず snapshot してから実行

### 運用コマンド

```
familiar curator status|run [--consolidate|--dry-run|--background]
        |backup|rollback [--id] |pause|resume
        |pin <skill>|unpin <skill>|adopt [--all-unmanaged]
        |restore <skill>|list-archived|prune [--days N]
        |ledger [--skill <name>]
```

- 全 mutate は **ledger**(監査ログ: actor, action, ts, skill, before/after ハッシュ)に記録
- snapshot: `~/.familiar/skills/.snapshot/<ts>/`
- aux モデル: `auxiliary.curator` スロット(config で provider/model 指定。未指定なら主対話モデル)

## 6. 安全原則(全コンポーネント適用)

1. 書き込み内容は **lessons のみ**(リンタで記録的な書き方を warn)
2. v1 は **write_approval 既定 ON** で観察する(信頼が積めたら OFF)
3. 削除は常に archival(復元可能)+ snapshot と ledger
4. 自己改善の aux タスクは主ループのセッションを一切変更しない(書込みは staging 経由のみ)

## 7. 状態遷移図(skill のライフサイクル)

```
(active)
   │ 14日未使用
   ▼
 stale ──(使用されたら)→ active
   │ 30日未使用
   ▼
 archived ──(restore/pin/使用)→ active
   ※ どの遷移でも snapshot + ledger 記録
```

## 8. 実装配置予定

```
core/src/selfimprove/
  memory/{store.ts, tool.ts, inject.ts, approval.ts}
  skills/{store.ts, tool.ts, view.ts, lint.ts, approval.ts}
  review/{post-turn.ts, prompt.ts}
  curator/{scheduler.ts, runner.ts, ledger.ts, snapshot.ts}
```
