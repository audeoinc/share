# Looker Studio Design

## 1. 目的

Repositoryの健全性、解析量、失敗、変更、Impactを運用者が日次確認できる画面を提供します。

## 2. ページ案

### Overview

- 最終実行日時
- active definition数
- changed definition数
- failed definition数
- Direct Dependency数
- Impact数
- ERROR・WARNING数
- Scheduled Query・DAGジョブ数

### Analysis Health

- analysis status別件数
- 日別ERROR・WARNING
- 失敗オブジェクト一覧
- Diagnostic code別件数

### Lineage Explorer

フィルター:

- origin project
- origin dataset
- origin object
- origin column
- impacted object
- impact rank

表示:

- 影響先一覧
- path
- rank
- generation type

### Job Sources

- Scheduled Query件数
- DAG件数
- 実行ユーザー別件数
- destination table
- source detection method

## 3. データソース

基本はRepositoryテーブルまたは運用向けViewを使用します。Looker Studioから複雑な再帰処理を行わず、必要な集計はBigQuery Viewとして準備します。

カラム影響分析 `lnge_t_column_usage_impact`（static テーブル。元ビューは
`lnge_vw_t_column_usage_impact`）のカラム定義・粒度・集計時の注意は
[`VIEW_COLUMN_USAGE_IMPACT.md`](VIEW_COLUMN_USAGE_IMPACT.md) を参照してください（レポート作成者向け）。

オブジェクト（テーブル/ビュー）単位の依存関係 `lnge_t_object_dependency`（static テーブル。
元ビューは `lnge_vw_t_object_dependency`）は
[`VIEW_OBJECT_DEPENDENCY.md`](VIEW_OBJECT_DEPENDENCY.md) を参照してください。カラムを意識せず
「このテーブルを変えたらどのテーブルが影響を受けるか」を引く用途向けで、1行＝1ペア（推移的依存、
`impact_rank` は最短ホップ）です。Looker Studio は `ARRAY` を読めないため、配列カラムには
必ず文字列版（`*_text`）が併設されています。

## 4. 完成条件

- 運用担当者がERRORを一画面で把握できる
- 物理カラムからImpactを検索できる
- 登録外アカウントを検出できる
- 日次処理の遅延・未実行を判定できる

本資料は設計案です。実環境で実行ログと利用者要件を確認した後に画面を確定します。
