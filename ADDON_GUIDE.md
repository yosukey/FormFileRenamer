# Google Forms ファイルリネーマー — 組織内アドオン導入ガイド

Google Workspace 組織内で **Google Forms 用 Editor add-on** を配布するための手順です。公開対象を **Private（非公開）** にすれば、組織内ユーザーだけが Marketplace から見つけてインストールできます。Private のストア掲載は Google 審査なしで即時公開されます。

> 本ガイドが参照している Google 公式ドキュメント:
> - [Configure your app in the Google Workspace Marketplace SDK](https://developers.google.com/workspace/marketplace/enable-configure-sdk?hl=ja)
> - [Create a store listing](https://developers.google.com/workspace/marketplace/create-listing?hl=ja)
> - [Update or unpublish an app listing](https://developers.google.com/workspace/marketplace/manage-app-listing?hl=ja)
> - [Configure the OAuth consent screen and choose scopes](https://developers.google.com/workspace/guides/configure-oauth-consent?hl=ja)
> - [Create and manage deployments](https://developers.google.com/apps-script/concepts/deployments?hl=ja)
> - [Test an Editor add-on](https://developers.google.com/workspace/add-ons/how-tos/testing-editor-addons?hl=ja)
> - [Open and use installed add-ons](https://developers.google.com/workspace/add-ons/guides/using-addons?hl=ja)

ただし、すべての最新情報に追従するとか、正確性を担保することは難しく、なにぶん著者の経験則に基づいて実行した結果をまとめたドキュメントであることを、はじめにお断りします。。。

---

## サマリー

このアドオンを組織内配布するには、最低限次の 4 点が必要です。

1. **Google Workspace アカウント** で作成した Google Cloud プロジェクト
2. そのプロジェクトで **Google Workspace Marketplace SDK** を有効化
3. **スタンドアロンの Apps Script プロジェクト** を標準 Cloud プロジェクトに紐付けて、**Editor add-on** としてバージョン付きデプロイを作成
4. Marketplace SDK の **App Configuration** と **Store Listing** を埋めて **Publish**

> `@gmail.com` の個人アカウントでは Private 公開はできません。組織ドメインの Google Workspace アカウントが必要です。

---

## 前提条件

- Google Workspace（Business / Enterprise / Education など）のアカウントがあること
- 対象の Google Cloud プロジェクトを作成できること
- 対象の Google Cloud プロジェクトで Marketplace SDK を設定できる権限があること
  - 推奨: 必要最小限なら `roles/appmetadata.workspaceMarketplaceAppConfigurationAdmin`
  - 暫定的には `Editor` / `Owner` でも設定可能
- Apps Script プロジェクトを作成・編集できること

> Marketplace SDK の構成権限エラーは、公式にも `workspacemarketplace.appconfiguration.view / update` 権限不足として案内されています。`Editor` / `Owner` は動きますが、権限設計としては専用ロールのほうが安全です。

---

## ファイル構成

```text
プロジェクト/
├── appsscript.json   ← マニフェスト
├── Code.gs           ← メインロジック
└── Sidebar.html      ← 設定 GUI
```

---

## Step 1 — Google Cloud プロジェクトを準備する

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. 画面上部のプロジェクト選択から **新しいプロジェクト** を作成
3. 作成したプロジェクトを選択する
4. **Google Workspace Marketplace SDK** を有効化する
   - 「API とサービス」→「ライブラリ」→ `Google Workspace Marketplace SDK` を検索 → **有効にする**

> ⚠️ 有効化するのは **Google Workspace Marketplace SDK** です。名前が似ている **Google Workspace Marketplace API** は別物です。

### このガイドで有効化する API

この構成で有効化が必要な API は以下のとおりです。

1. **Google Workspace Marketplace SDK** — Marketplace 公開に必須（Step 1-4 で有効化済み）
2. **Apps Script API** — Apps Script プロジェクトを標準 Cloud プロジェクトに紐付ける際に必要

**Apps Script API の有効化手順:**

1. Cloud Console で対象プロジェクトを選択する
2. 「API とサービス」→「ライブラリ」→ `Apps Script API` を検索 → **有効にする**

> ⚠️ Apps Script API が無効のまま Step 2 のプロジェクト紐付けを行うと、「プロジェクトが存在しないか、プロジェクトの編集権限がありません」エラーになることがあります。**Marketplace SDK と合わせて、この段階で Apps Script API も有効化してください。**

3. 同じく「ライブラリ」で `Google Drive API` を検索 → **有効にする**

> ⚠️ カスタム GCP プロジェクトでは、`DriveApp` などの組み込みサービスであっても対応する API を明示的に有効化する必要があります。Drive API を有効化しないと、`DriveApp.getFileById()` や `DriveApp.getRootFolder()` が「サーバー エラー」で失敗します。

### プロジェクト番号を確認する

**プロジェクト番号（Project number）** は、プロジェクトを作成した時点で自動的に発行されます。OAuth クライアントの作成前でも確認できます。

1. Cloud Console 左上のプロジェクト選択で対象プロジェクトを選ぶ
2. 左メニュー **IAM と管理 → 設定** を開く（または Cloud Console ダッシュボードの **プロジェクト情報** カードを見る）
3. **プロジェクト番号** の数値を控える

> ⚠️ 「プロジェクト番号」と「プロジェクト ID」は別物です。Apps Script 側の切り替えで必要なのは通常 **数字だけの Project number** です。必要なら **プロジェクト ID** も控えてください。

### OAuth 同意画面を設定する

Google Cloud Console の導線は、現在は **Google Auth platform** 配下にあります。OAuth 同意画面を構成しておかないと、アドオン利用時の認可フローが正しく動作しません。

#### 1. Branding を設定する

1. Cloud Console 左メニューから **Google Auth platform → Branding** を開く
   - 初回の場合は「始める」や「構成」ボタンからウィザードが開始されることがある
2. 以下を入力する

| 項目 | 設定 |
|---|---|
| App name | `フォームファイルリネーマー` |
| User support email | 自分またはチームの連絡先 |
| App logo | 任意（省略可） |
| Application home page | 任意（省略可） |
| Application privacy policy link | プライバシーポリシーの URL |
| Application terms of service link | 利用規約の URL |
| Authorized domains | 必要に応じて追加 |
| Developer contact information | 自分またはチームの連絡先メール |

3. **保存** をクリックする

#### 2. Audience を設定する

1. **Google Auth platform → Audience** を開く
2. **User type** で **Internal** を選択する
   - Internal にすると、同一 Google Workspace 組織のユーザーだけがアプリを利用できる
   - Private 配布の場合は Internal が適切

> ⚠️ User type を **External** にすると、Google による検証が必要になる場合があります。組織内配布なら **Internal** を選んでください。

#### 3. OAuth クライアントを作成する

Editor add-on では、Apps Script が内部的に OAuth フローを処理するため、**手動で OAuth クライアント ID を作成しなくてもアドオンは動作します**。ただし、OAuth 同意画面の構成を完了するために、Google Auth platform 上で **クライアントの作成** を求められる場合があります。

求められた場合は以下の手順で作成します。

1. **Google Auth platform → Clients**（または **API とサービス → 認証情報**）を開く
2. **＋ クライアントを作成**（または **＋ 認証情報を作成 → OAuth クライアント ID**）をクリック
3. 以下を設定する

| 項目 | 設定 |
|---|---|
| アプリケーションの種類 | **ウェブ アプリケーション** |
| 名前 | `フォームファイルリネーマー`（任意の識別名） |
| 承認済みのリダイレクト URI | （空のままでよい） |

4. **作成** をクリックする
5. クライアント ID とクライアント シークレットが表示されるが、**Editor add-on ではこれらの値を直接使う必要はない**。OAuth 同意画面の構成が完了したことが重要

> この手順で作成した OAuth クライアント ID / シークレットは、Apps Script の Editor add-on 配布では **直接使いません**。Apps Script と Marketplace SDK が認可フローを管理するためです。ただし、OAuth 同意画面の Branding・Audience が正しく構成されていないと、利用者の認可時にエラーが出たり、アプリ名が「不明なアプリ」と表示されたりします。

#### 4. Data Access（外部公開の場合のみ）

外部公開アプリや追加審査が絡む場合は、**Google Auth platform → Data Access** でスコープの管理が必要になります。

- **Internal（組織内向け）の場合**: Data Access でスコープを列挙しなくてもよい、というのが現行公式の扱い
- **External（外部向け）の場合**: 使用するスコープをすべて登録し、必要に応じて Google の検証を受ける

---

## Step 2 — Apps Script プロジェクトを作成し、標準 Cloud プロジェクトへ切り替える

Editor add-on は **スタンドアロンの Apps Script プロジェクト** で作成します。Google フォームにバインドされたスクリプトではなく、独立したプロジェクトにしてください。

1. [Apps Script](https://script.google.com/) を開く
2. **新しいプロジェクト** を作成
3. プロジェクト名を `フォームファイルリネーマー` に変更
4. 左メニュー **プロジェクトの設定** を開く
5. **Google Cloud Platform (GCP) Project** セクションで **プロジェクトを変更**
6. Step 1 で控えた **Project number** を入力して関連付ける
7. 同じ画面で **`appsscript.json` マニフェスト ファイルをエディタで表示する** をオンにする
8. 同じ画面の **IDs** セクションで **Script ID** を控える

> Apps Script のデプロイ公式では、Editor add-on をバージョン付きデプロイする前に、既定プロジェクトではなく **standard project** に切り替える必要があります。

> ⚠️ **手順 6 で「プロジェクトが存在しないか、プロジェクトの編集権限がありません」エラーが出る場合**
>
> 以下を順に確認してください。
>
> 1. **Apps Script API が有効化されているか**
>    - Cloud Console →「API とサービス」→「有効な API とサービス」で `Apps Script API` が一覧にあるか確認する
>    - なければ「ライブラリ」から `Apps Script API` を検索して **有効にする**
> 2. **入力した値が Project number（数字のみ）であるか**
>    - Project ID（英数字とハイフン）を入力していないか確認する
>    - Cloud Console の「IAM と管理 → 設定」またはダッシュボードの「プロジェクト情報」で確認できる
> 3. **Cloud プロジェクトへの編集権限があるか**
>    - 最低でも `Editor` ロール（または `Owner`）が必要
>    - Cloud Console →「IAM と管理 → IAM」で自分のアカウントのロールを確認する
> 4. **Apps Script と Cloud Console で同じ Google アカウントにログインしているか**
>    - 複数アカウントを使い分けている場合、別アカウントでログインしていることがある
>    - ブラウザのプロフィールアイコンでアカウントを確認する

### 紐付けの確認方法

Cloud プロジェクトの紐付けが正しく完了したことを必ず確認してください。後の Step 5・Step 6 で「プロジェクト キーが関連付けられていない」エラーが出る主な原因は、この紐付けの失敗または未実施です。

1. Apps Script エディタ → 左メニュー **プロジェクトの設定** を開く
2. **Google Cloud Platform (GCP) Project** セクションを確認する
3. 以下のように **Project number** が表示されていれば紐付け済み

```
Google Cloud Platform (GCP) Project
Project number: 123456789012   ← Step 1 で控えた番号と一致すること
```

4. 「プロジェクトを変更」ボタンしか表示されず、番号が空の場合は紐付けが未完了

> ⚠️ 紐付けは **バージョン付きデプロイ（Step 5）の前に** 完了させてください。既定プロジェクトのままデプロイを作ると、Marketplace SDK から参照できないデプロイになります。この順序を間違えた場合は、紐付けを行った後に **デプロイを作り直して** ください。

---

## Step 3 — コードを配置する

エディタに戻り、以下の 3 ファイルを配置します。

| 操作 | ファイル名 | 内容 |
|---|---|---|
| 既存の `Code.gs` を開いて上書き | `Code.gs` | Add-on 版 `Code.gs` の全文 |
| 左パネル「＋」→「HTML」で新規作成 | `Sidebar` | `Sidebar.html` の全文 |
| 左パネルで `appsscript.json` を開いて上書き | `appsscript.json` | 下記マニフェスト |

> `Sidebar.html` を追加する際、Apps Script 上のファイル名入力は `Sidebar` で構いません。拡張子 `.html` は自動付与されます。

### `appsscript.json`

```json
{
  "timeZone": "Asia/Tokyo",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/forms",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.container.ui",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
```

> ⚠️ この構成は **Editor add-on** です。`addOns` セクションを書く **Google Workspace add-on** のマニフェストとは別系統です。`FormApp.getUi()` と HTML Service のサイドバーを使う実装では、`Code.gs` 側のメニュー処理が中心になります。

### appsscript.json のスコープについて

`appsscript.json` の `oauthScopes` には、このアドオンが必要とする権限を明示的に宣言しています。

| スコープ | 用途 | 分類 |
|---|---|---|
| `https://www.googleapis.com/auth/forms` | フォームの項目情報を取得（フルスコープ） | 制限付き |
| `https://www.googleapis.com/auth/drive` | アップロード済みファイルのリネーム | 制限付き |
| `https://www.googleapis.com/auth/script.container.ui` | フォーム編集画面でサイドバーを表示 | 非機密 |
| `https://www.googleapis.com/auth/script.scriptapp` | installable trigger（onFormSubmit）の作成・管理 | 制限付き |
| `https://www.googleapis.com/auth/userinfo.email` | トリガー作成者の識別（複数編集者でのトリガー重複防止） | 非機密 |

> ⚠️ `oauthScopes` を明示しない場合、Apps Script はコードから自動推定しますが、意図しないスコープが含まれたり必要なスコープが漏れたりします。Marketplace に公開するアドオンでは **必ず明示的に記載してください**。

この同じスコープを、後の Step 6 で Marketplace SDK 側にも入力します。**両方が一致していないと権限エラーの原因になります**。この時点では `appsscript.json` に正しく記載されていることだけ確認してください。

---

## Step 4 — テストデプロイで UI と導線を確認する

Apps Script には **Test deployments** があり、Forms 上で Editor add-on の見え方を検証できます。

1. Apps Script エディタで **Deploy → Test deployments**
2. `Select type` で **Editor add-on** を有効化
3. **Create new test** を作成
4. `Latest Code` またはテストしたいバージョンを選ぶ
5. テスト用の Google フォームを選ぶ
6. **Execute** で開く

### この段階で確認すること

- アドオンがフォーム編集画面に読み込まれること
- メニューやサイドバー UI が期待どおり表示されること
- 権限承認フローに問題がないこと
- 項目一覧の取得や設定保存が期待どおり動くこと

### 重要な制約

> ⚠️ **Test deployments では installable trigger はテストできません。**
>
> つまり、このアドオンのように `onFormSubmit` のインストール型トリガーに依存する処理は、**この段階では完全には検証できません**。
>
> したがって Step 4 は **UI / 導線 / 認可の確認** に使い、**実際のフォーム送信でのリネーム動作確認は Step 6 の Private 公開後** に実施してください。

---

## Step 5 — バージョン付きデプロイを作成する

Marketplace に載せる Editor add-on は **versioned deployment** を使います。

1. Apps Script エディタで **Deploy → New deployment**
2. `Select type` で **Add-on** を選ぶ
3. 説明欄にデプロイ説明を入力（例: `v1.0 初回リリース`）
4. **Deploy** をクリック
5. 続けて **Deploy → Manage deployments** を開く
6. 対象デプロイの **Configuration** 欄に表示される **Version** を控える

> Marketplace SDK の Editor add-on 統合では、ここで作ったデプロイの **Script ID ではなく**、Apps Script プロジェクトの **Script ID** と、この **Version 番号** を使います。

### デプロイ前の確認事項

バージョン付きデプロイを作成する前に、以下を確認してください。

- [ ] Step 2 で Cloud プロジェクトへの紐付けが完了していること（プロジェクトの設定で Project number が表示されている）
- [ ] Step 3 で `appsscript.json` を含むすべてのコードが配置・保存済みであること

> ⚠️ Cloud プロジェクトの紐付けが済んでいない状態でデプロイを作ると、Step 6 の Marketplace SDK で「プロジェクト キーが関連付けられていない」エラーになります。その場合は紐付けを行った上で、**新しいデプロイを作り直して** ください。

---

## Step 6 — Marketplace SDK で組織内公開する

Apps Script のデプロイだけでは、組織の利用者が Marketplace から見つけて入れられる状態にはなりません。Google Cloud 側で **Marketplace SDK** の設定が必要です。

Cloud Console で **API とサービス → Google Workspace Marketplace SDK** を開くと、主に次の 2 タブがあります。

- **App Configuration**
- **Store Listing**

### 6-1. App Configuration

#### App visibility

| 項目 | 設定 |
|---|---|
| App visibility | **Private** |

- 組織全体に見せたい場合: **Private**
- 限定メンバーにだけ URL 共有したい場合: **Private + Unlisted** を検討

> ⚠️ Visibility は保存後に変更できません。誤って Public にしないよう注意してください。

#### Installation settings

| 項目 | 設定 |
|---|---|
| Installation settings | **Individual + Admin Install**（通常はこちら） |

- 利用者が自分で入れる運用なら `Individual + Admin Install`
- 管理者だけが配布したいなら `Admin only install`

#### App integration

| 項目 | 設定 |
|---|---|
| App integration | **Editor add-on** |
| Script ID | Step 2 で控えた **Script ID** |
| Version | Step 5 で確認した **Version** |

> ⚠️ **「プロジェクト キーが関連付けられていない」「スクリプトのバージョンが存在しません」エラーが出る場合**
>
> このエラーは、以下のいずれかが原因です。
>
> 1. **Apps Script プロジェクトが、この Cloud プロジェクトに紐付いていない**
>    - Apps Script エディタ → プロジェクトの設定 → GCP Project で、**この Cloud プロジェクトの Project number** が正しく設定されているか確認する
>    - 別の Cloud プロジェクトに紐付いている場合、Marketplace SDK 側からは「関連付けられていない」と見える
> 2. **Script ID が間違っている**
>    - Apps Script エディタ → プロジェクトの設定 → IDs セクションに表示される **Script ID** をコピーして使う
>    - デプロイ時に表示される Deployment ID と混同しないこと
> 3. **Version が存在しない**
>    - Apps Script エディタ → Deploy → Manage deployments で、入力した Version 番号のデプロイが実際に存在するか確認する
>    - デプロイを作成していない、または Version 番号を間違えている場合にこのエラーが出る
> 4. **バージョン付きデプロイが Cloud プロジェクト紐付け前に作られた**
>    - Step 2 の Cloud プロジェクト切り替え **より前に** デプロイを作成した場合、そのデプロイは既定プロジェクトに紐付いたままになっている可能性がある
>    - この場合、Cloud プロジェクトの紐付けを確認した上で、**新しいバージョン付きデプロイを作り直す**

#### OAuth Scopes

Step 3 の `appsscript.json` に記載したスコープと **まったく同じもの** を入力します（1 行に 1 スコープ）。

```text
https://www.googleapis.com/auth/forms
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/script.container.ui
https://www.googleapis.com/auth/script.scriptapp
https://www.googleapis.com/auth/userinfo.email
```

各スコープの役割:

| スコープ | 用途 |
|---|---|
| `forms` | フォームの項目情報を取得（フルスコープ） |
| `drive` | アップロード済みファイルのリネーム |
| `script.container.ui` | フォーム編集画面でサイドバーを表示 |
| `script.scriptapp` | installable trigger（onFormSubmit）の作成・管理 |
| `userinfo.email` | トリガー作成者の識別（複数編集者でのトリガー重複防止） |

> ⚠️ **スコープ整合性について**: `appsscript.json` と Marketplace SDK の OAuth Scopes が一致していないと、利用者の認可時に権限エラーが発生します。**両方にまったく同じスコープを設定してください。**
>
> - Marketplace SDK 側が不足 → 「権限が不足しています」エラー
> - `appsscript.json` 側が不足 → 認可画面にスコープが出ない、機能が動かない

##### 外部公開の場合: Data Access にもスコープを登録する

Internal（組織内向け）アプリではこの手順は不要です。External アプリの場合のみ、Google Auth platform にもスコープを登録します。

1. Cloud Console 左メニューから **Google Auth platform → Data Access** を開く
2. **＋ スコープを追加** をクリック
3. フィルタ欄でスコープ名を検索し、該当するスコープにチェックを入れる
   - `forms` — Google Forms API のフィルタで見つかる
   - `drive` — Google Drive API のフィルタで見つかる
   - `script.container.ui` — Apps Script API のフィルタで見つかる
4. **更新** をクリック

> `drive` や `forms` は **制限付きスコープ** に分類されます。External アプリでこれらを使う場合、Google によるセキュリティ審査が求められることがあります。Internal アプリではこの審査は不要です。

#### Developer Information

| 項目 | 内容 |
|---|---|
| Developer name | 自分の名前、チーム名、または社内組織名 |
| Developer email | 連絡先メール |
| Application website URL | 任意 |
| Developer website URL | 任意 |

> `Developer email` はストア画面に公開されない連絡先です。Google からの連絡や、Editor add-on の issue 報告導線で利用されます。

ここまでの全セクション（App visibility / Installation settings / App integration / OAuth Scopes / Developer Information）を入力したら、**Save Draft** をクリックします。

> ⚠️ Save Draft は App Configuration **全体** をまとめて保存します。一部のセクションだけを先に保存することはできません。特に **App integration** が未入力だと「アプリの統合を少なくとも 1 つ選んでください」エラーになります。

---

### 6-2. Store Listing

Private 配布でも **Store Listing の必須項目は必要** です。雑に埋めるのではなく、実在する情報を入れてください。

#### 最低限そろえるもの

| 項目 | 内容 |
|---|---|
| App name | `フォームファイルリネーマー` |
| Short description | 1 行説明 |
| Detailed description | 詳細説明 |
| Category | 適切なカテゴリ |
| Graphic assets | アイコン、バナー等 |
| Screenshots | 実際の画面キャプチャ |
| Terms of service URL | 実在する利用規約ページ |
| Privacy policy URL | 実在するプライバシーポリシーページ |
| Support URL | 実在する問い合わせ・サポート案内ページ |

#### 実務上の注意

- **Terms of service / Privacy policy / Support URL は有効な URL を用意する**
- 社内専用運用なら、社内ポータルや社内ドキュメントへの URL でもよい
- ただし、インストール対象ユーザーが実際にアクセスできることを確認する
- Editor add-on では必要に応じて **Help URL / Report issue URL** も設定可能

入力後、**Publish** をクリックします。

> Private app の掲載は、現行公式では **すぐ公開** されます。Public app のようなレビュー待ちは通常発生しません。

---

### 6-3. 反映待ちと確認

- Private app は通常すぐ公開されます
- ただし、Marketplace や Forms 側の表示には **数分〜数十分** の反映待ちが起こり得ます
- 組織ポリシーや allowlist により、ユーザーが見つけられないことがあります

公開後は、**実際の利用者アカウント** で以下を確認します。

1. Marketplace でアプリが見つかるか
2. インストールできるか
3. Google Forms 編集画面でアドオンが使えるか
4. フォーム送信後、`onFormSubmit` によるファイルリネームが動くか

---

## Step 7 — 利用者への配布方法

### 利用者に案内するインストール手順

Google Forms の現行 UI では、Forms add-on は **フォーム編集画面左上付近の拡張機能アイコン** からアクセスします。従来の説明で見かけた「三点メニュー → アドオン」は、現在の Forms UI では案内として不正確になりやすいので避けたほうが安全です。

案内文の例:

```text
1. Google Forms の編集画面を開く
2. 画面左上付近の拡張機能アイコンから Marketplace / Add-ons を開く
3. 「フォームファイルリネーマー」を検索してインストールする
4. インストール後、同じ拡張機能アイコンから本アドオンを開く
```

> 組織の管理者が Google Admin Console から Marketplace アプリを一括配布する運用も可能です。個別インストールを禁止している組織では、管理者配布が必要になることがあります。

### 利用者向けの操作手順（配布時にコピペ可）

```text
1. Google Forms の編集画面で、拡張機能アイコンから「フォームファイルリネーマー」を開く
2. 「設定を開く」でサイドバーを表示する
3. 以下を設定する
   - ファイルアップロード項目: 対象の質問を選ぶ
   - ファイル名の構成: 使用する項目を追加し、順番を調整する
   - 区切り文字: _ や - などを指定する
   - 拡張子ルール: 必要なら .jpeg → .jpg などを追加する
4. 「保存」をクリックする
5. 「トリガーを有効化」を実行する
6. 以後、フォーム送信時にファイル名が自動で変わる
```

---

## 更新手順

コードを修正して利用者へ反映するときは、**既存デプロイを新バージョンへ差し替えます**。

### Apps Script 側

1. Apps Script エディタでコードを修正・保存
2. **Deploy → Manage deployments**
3. 対象の active deployment を選んで **Edit**
4. **Version** に新しいバージョンを指定して **Deploy**
5. 新しい **Version** 番号を確認

Apps Script の現行デプロイ仕様では、既存デプロイを新バージョンへ更新すると、**その deployment を使うユーザーには新バージョンが自動で適用** されます。

### Marketplace SDK 側

Editor add-on の掲載情報は **Script ID + Version** を持つため、Version を上げたら Marketplace SDK 側の値も更新します。

6. Cloud Console の **Marketplace SDK → App Configuration** を開く
7. **App integration** の **Version** を新しい番号へ更新
8. **Save Draft**
9. 必要に応じて **Store Listing** を確認し、**Publish**

### スコープ変更がある場合

- `appsscript.json`
- Marketplace SDK の **OAuth Scopes**
- 必要なら Google Auth platform **Data Access**

をすべて更新します。

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| Apps Script で「プロジェクトが存在しないか、プロジェクトの編集権限がありません」 | ① Cloud Console で **Apps Script API** が有効か確認 ② 入力値が Project ID ではなく **Project number（数字のみ）** か確認 ③ Cloud プロジェクトへの `Editor` 以上の権限があるか確認 ④ Apps Script と Cloud Console で同じアカウントにログインしているか確認 |
| Marketplace SDK で「プロジェクト キーが関連付けられていない」または「スクリプトのバージョンが存在しません」 | ① Apps Script がこの Cloud プロジェクトに紐付いているか確認（プロジェクトの設定で Project number が一致するか）② Script ID がデプロイ ID ではなくプロジェクトの Script ID であるか確認 ③ 入力した Version 番号のデプロイが存在するか確認 ④ Cloud プロジェクト紐付け前にデプロイを作った場合はデプロイを作り直す |
| Marketplace SDK の構成ページで権限エラー | `workspacemarketplace.appconfiguration.view / update` を含む権限が不足している。`roles/appmetadata.workspaceMarketplaceAppConfigurationAdmin` か、必要に応じて `Editor` / `Owner` を確認 |
| Marketplace に表示されない | Marketplace SDK の **App Configuration** と **Store Listing** の両方を埋めて **Publish** したか確認。反映待ちや Admin 側ポリシーの影響もある |
| 特定ユーザーに見えない | 組織の Marketplace 利用制限、allowlist、OU / グループ配布制限を管理者に確認 |
| Forms 上で起動場所がわからない | 現行 UI では **フォーム編集画面左上付近の拡張機能アイコン** から開く |
| サイドバーが開かない | `script.container.ui` がマニフェストと Marketplace SDK の両方に入っているか確認 |
| テストデプロイでは送信時リネームが確認できない | 仕様どおり。**installable trigger は Test deployments では未対応**。Private 公開後に実フォームで確認する |
| 更新したのに古いまま | Apps Script 側の deployment を新バージョンへ差し替えたか、Marketplace SDK 側の **Version** を更新したか確認 |
| OAuth / 権限エラーが出る | `appsscript.json` と Marketplace SDK のスコープ不一致を確認。外部公開や Data Access 利用時は OAuth consent screen 側も確認 |
| トリガー有効化で「指定された権限では ScriptApp.getUserTriggers を呼び出すことができません」 | `appsscript.json` の `oauthScopes` に `https://www.googleapis.com/auth/script.scriptapp` が含まれているか確認。Marketplace SDK の OAuth Scopes にも同スコープを追加し、再デプロイ・再承認する |
| 認可時に「不明なアプリ」と表示される | Google Auth platform の **Branding** でアプリ名やロゴが正しく設定されているか確認。OAuth 同意画面の構成が未完了の可能性がある |
| Marketplace SDK の Save Draft で「アプリの統合を少なくとも 1 つ選んでください」エラー | **App integration** で Editor add-on を選択し、Script ID と Version を入力してから保存する。OAuth Scopes だけを先に保存することはできない |

---

## 技術メモ

### この実装が使う OAuth スコープ

| スコープ | 用途 |
|---|---|
| `forms` | フォームの項目情報を取得（フルスコープ） |
| `drive` | アップロード済みファイルのリネーム |
| `script.container.ui` | フォーム編集画面でサイドバーを表示 |
| `script.scriptapp` | installable trigger（onFormSubmit）の作成・管理 |
| `userinfo.email` | トリガー作成者の識別（複数編集者でのトリガー重複防止） |

> `forms.currentonly`（現在開いているフォームのみ）ではなく `forms`（フルスコープ）を使用しています。`currentonly` スコープではサイドバーから `google.script.run` 経由でフォーム項目を取得する際に承認エラーが発生するためです。

### 設定保存先

この実装では `DocumentProperties` を使用します。フォームごとに設定が分かれるため、複数フォームで使っても設定が混線しません。

### ログ運用とデバッグモード

通常運用では、ファイル ID・回答由来のファイル名要素・元/新ファイル名・メールアドレス・フォームタイトルなどの**機微情報はログに出力しません**（件数・処理結果・項目数のみ）。詳細を確認したい場合は、`DocumentProperties` に `DEBUG_LOGGING = true` を設定するとデバッグログが有効になります（`[FileRenamer][debug]` 接頭辞）。調査が終わったら削除してください。フォーム送信時のエラーログに含まれるファイル ID は末尾 4 文字のみにマスクされます。

### トリガーと複数編集者運用の注意

トリガー状態は `DocumentProperties` の `TRIGGER_ENABLED` で管理し、FULL 権限でサイドバーを開いた際に `ScriptApp.getProjectTriggers()` と突き合わせて補正します。ただし Apps Script の仕様上、**別の編集者が作成した installable trigger は他ユーザーから参照・削除できません**。複数編集者がそれぞれ「有効化」すると各自のトリガーが並列に動作し多重リネームになり得ます。**フォーム単位でトリガー管理を一人の管理者に限定する運用を推奨します。**

### Editor add-on と Google Workspace add-on の違い

| | Editor add-on | Google Workspace add-on |
|---|---|---|
| 主な UI | メニュー、ダイアログ、サイドバー（HTML Service 可） | カードベース UI |
| Forms 上の起動位置 | フォーム編集画面の拡張機能導線 | 右サイドパネル型が中心 |
| Marketplace SDK 連携 | **Script ID + Version** | **Deployment ID** |
| マニフェスト | Editor add-on 向け構成 | `addOns` 構成が中心 |
| 典型的な用途 | Docs / Sheets / Slides / Forms の編集拡張 | Gmail / Calendar / Drive / Meet など横断拡張 |
