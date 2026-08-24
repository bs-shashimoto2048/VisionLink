# VisionLink Documentation

VisionLink のドキュメント入口です。

> 基準: 2026-08-24 Prototype

## 利用者向け

| ドキュメント | 内容 |
|---|---|
| [USER_GUIDE.md](USER_GUIDE.md) | 検査担当者向け操作マニュアル。最初に読む文書 |
| [SPEC.md](SPEC.md) | 現在のシステム仕様・検査ルール |
| [OCR_STRATEGY.md](OCR_STRATEGY.md) | YOLO検出後のOCR、L/Label回転補正、端子と線番の対応付け |

## 開発・保守向け

| ドキュメント | 内容 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Frontend / Backend / AIパイプラインの構成 |
| [API.md](API.md) | Backend API仕様 |
| [SESSION_STATE.md](SESSION_STATE.md) | セッション状態・開発上の状態整理 |
| [TODO.md](TODO.md) | 未対応事項・改善候補 |

## 主要用語

- **Label / nmb**: 端子番号として使用する検出対象。左右線番の対応付けのアンカー。
- **Tube**: 端子左右の線番文字を含む検出対象。
- **L**: 左 Tube のOCR用クロップを180度回転して読むモード。
- **Label mode**: 右へ90度倒れた nmb を読むため、OCR用クロップを左へ90度回転するモード。
- **BBox**: YOLOが元画像上で検出した領域。OCR用画像を回転してもBBox座標そのものは回転しない。
- **行バンド**: 隣接Labelとの中間位置を境界として構成する、1端子分の左右線番候補範囲。

## ドキュメント運用方針

1. `USER_GUIDE.md` は実際の画面・操作を基準に記載する。
2. `SPEC.md` は「現在実装されている仕様」と「将来構想」を混在させない。
3. AI/OCRのアルゴリズム変更は `OCR_STRATEGY.md` に反映する。
4. API変更は `API.md` に反映する。
5. 未実装・改善候補は実装済みのように書かず `TODO.md` へ分離する。
6. プロトタイプ固有の制約は明記し、本番品質を保証する表現を避ける。
