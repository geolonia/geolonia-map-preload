# Geolonia Map Preload

Geolonia Map 用のタイルのプリロードデモです。

- 表示範囲の **上下左右（neighbors）** と
- 指定段数の **親ズームタイル（zoomOutLevels）**

を **先読み（fetch してブラウザキャッシュを温める）** して、地図操作を滑らかにします。  
さらに、先読みしたタイルを青（neighbors）／赤（parents）で可視化できます。

---

## セットアップ

```bash
git clone git@github.com:geolonia/geolonia-map-preload.git
cd geolonia-map-preload
npx serve .
````

---

## 使い方

HTML にスクリプトを読み込み、初期化するだけです。

```javascript
  const map = new geolonia.Map({
    container: "map",
    style: "geolonia/basic-v1",
    center: [139.74135744, 35.65809922],
    zoom: 12
  });

  const prefetcher = new TilePrefetcher(map, {
    neighbors: 1,        // 上下左右1リング
    zoomOutLevels: 1,    // 親ズーム1段
    maxRequestsPerMove: 140,
    debugFill: true      // true=塗りつぶし表示, false=線だけ
  });

  // 実行中に塗りON/OFF切替
  // prefetcher.setFillEnabled(false);
```

---

## どのタイミングでタイルを読み込むか

1. **スタイルロード時**

   * map の style.sources からタイルテンプレートを解析
   * TileJSON (`url`) の場合は一度だけ fetch して展開

2. **moveend イベント発火時（パン・ズーム後）**

   * 現在のズームと表示範囲から可視タイル座標を計算
   * neighbors 分の上下左右タイルと、zoomOutLevels 分の親タイルを列挙
   * 重複を除去して URL を生成
   * fetch() で先読みし、ブラウザ HTTP キャッシュに格納
   * デバッグ表示を更新（青＝neighbors、赤＝parents）

3. **次回描画時**

   * MapLibre が同じ URL のタイルを要求すると、ブラウザキャッシュから即座に応答される

---

## オプション

| オプション                | 型           | デフォルト     | 説明                         |
| -------------------- | ----------- | --------- | -------------------------- |
| `neighbors`          | number      | 1         | 同ズームで外側何タイル先読みするか          |
| `zoomOutLevels`      | number      | 1         | 何段上の親タイルを先読みするか            |
| `maxRequestsPerMove` | number      | 160       | 1回の移動で最大リクエスト数             |
| `debugFill`          | boolean     | true      | デバッグ表示で塗りつぶすか（false で枠線のみ） |
| `sourceIds`          | string\[]   | undefined | 対象とするソースIDを絞る場合            |
| `requestInit`        | RequestInit | undefined | fetch オプション（ヘッダ追加など）       |

---

## デバッグ

* コンソールに先読みタイルIDを表示（neighbors=青、parents=赤）。
* 青=neighbors、赤=親ズームタイルを地図上に表示。
* 表示負荷が高い場合は `neighbors=0` や `zoomOutLevels=0` に調整。

---

## 開発メモ

* タイルURLテンプレートは `tiles: []` または TileJSON (`url`) から自動解決。
* 先読みは `fetch()` で行い、描画は MapLibre の HTTP キャッシュに任せる。
* スタイル再読込時にもレイヤー/ソースを再生成。

```