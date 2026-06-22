# INTEGRATE_TASK.md — 修正の統合と反映

## 前提
- バグ修正は `recover` ブランチ上で完了済み（挙動確認済みの想定）。
- `main` は be14d39 のまま動かしていない。
- `codex-wip`(57eed9c) は壊れた作業のアーカイブとして保全済み。

## ゴール
直った `recover` を `main` に統合し、状態を整理して GitHub に反映する。

## ガードレール
- 破壊的 git 操作（`push --force` / `branch -D` / `reset --hard` など）は実行前に必ず確認。
- **リモートへの push は実行前に必ず確認を取る。** 勝手に push しない。
- `codex-wip` は当面削除しない（アーカイブとして残す）。
- 想定外の状態（後述の ff-only 失敗など）になったら、止めて状況を報告する。

## 手順

### 1. recover の作業を確定する
- `git switch recover`
- `git status` で未コミットの変更がないか確認する。あれば内容を要約して報告し、意味のあるメッセージで 1 コミットにまとめる
  （例：`fix: rotate left label/nmb for OCR and reconcile rows per side`）。
- リポジトリ内の作業用ドキュメント（`TASK.md` / `FIX_TASK.md` / `instructions.md` など）の扱いを確認する。
  コミットに含める・削除する・`.gitignore` する のどれにするか、判断に迷えばユーザーに聞く。

### 2. main に統合する
- `git switch main`
- recover を取り込む：`git merge --ff-only recover`
  - main は動いていないはずなので fast-forward できる想定。
  - **ff-only が失敗した場合**は main が想定外に動いている可能性があるので、止めて状況を報告する（勝手に通常マージや rebase をしない）。
- 統合後、main で再度確認する：`python -m py_compile` ＋ `import app.main` ＋ `npm run build`、可能なら起動 smoke test。
  recover と同じく動くことを確認して報告する。

### 3. GitHub へ反映する
- `git remote -v` と `git log origin/main..main --oneline` で、push 対象（リモートに無いコミット）を確認して報告する。
- **push は実行前に必ず確認を取る。** OK が出てから `git push origin main` を実行する。
- `--force` は使わない。

### 4. 後片付けと最終報告
- `codex-wip` と `recover` は当面残す（削除のタイミングは別途相談）。
- 最終状態を報告する：各ブランチがどのコミットを指すか、リモートとの同期状況、main がビルド/起動できる状態か。