# concept

ゲームコンセプトのプロトタイプ集です。

| フォルダ | 内容 |
|---|---|
| [1/](1/) | **色探しゲーム** — お題の色を記憶と言葉だけを頼りにフィールド（静止画・動画）から探すゲーム。Python 標準ライブラリ + ブラウザで動作 |
| [2/](2/) | **カメラ協力アクション** — 二人協力の 2D 横スクロール。P1 がキャラ操作、P2 がカメラ・ギミック操作。単一 HTML のプロトタイプ |
| [3/](3/) | **一筆書きパズル** — 星座を作るパズルゲーム。単一 HTML のプロトタイプ |

## 遊び方

- `1/`: `python server.py` を起動してブラウザで開く（詳細は [1/README.md](1/README.md)）。テストは `npm test`。
- `2/`: `camera_coop_prototype.html` をブラウザで開く（設計は [2/DESIGN.md](2/DESIGN.md)）。
- `3/`: `seiza_puzzle_prototype.html` をブラウザで開く（設計は [3/DESIGN.md](3/DESIGN.md)）。

## Web で遊ぶ

GitHub Pages でも公開しています（[一覧](https://ziat-user.github.io/#prototypes)）。

- [色探しゲーム](https://ziat-user.github.io/concept/color-search/) — 静的配信では素材一覧 API が無いため、設定画面の「手元のファイルを追加」で画像・動画を読み込んで遊びます。
- [カメラ協力アクション](https://ziat-user.github.io/concept/camera-coop/)
- [星座パズル](https://ziat-user.github.io/concept/seiza/)

## ライセンス

[MIT](LICENSE)
