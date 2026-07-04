// ============================================================
// Google Form File Renamer
// ============================================================

// --------------- 定数 ---------------
const FILENAME_MAX_LENGTH_ = 200;   // ファイル名本体の最大文字数（拡張子・連番は別途）
const EXT_MAX_LENGTH_ = 20;         // 拡張子本体（ドットを除く）の最大文字数
const FILENAME_TOTAL_MAX_LENGTH_ = 250; // 連番・拡張子込みの最終ファイル名の上限（Drive の 255 制限に余裕）
const AFFIX_MAX_LENGTH_ = 100;      // 接頭辞・接尾辞 1 つあたりの最大文字数（DocumentProperties 肥大化防止）
const SEPARATOR_MAX_LENGTH_ = 10;   // 区切り文字の最大文字数（UI の maxlength=5 より緩め。連番が削られる異常を防ぐ）
const RETRY_DELAYS_MS_ = [3000, 6000]; // DriveApp getFileById リトライ間隔
const LOCK_TIMEOUT_MS_ = 10000;     // サブフォルダ作成ロックの最大待機時間

// ファイル名/サブフォルダ名に使える項目種別（単一のスカラー値で表せるもの）。
// サーバー側のガード isNameEligibleItem_ と、クライアント側 (Sidebar.html) の
// NAME_ELIGIBLE_ITEM_TYPES の両方がこのリストを唯一の真実として参照する。
// クライアントへは showSettingsSidebar() が initData.nameEligibleTypes で配布する。
const NAME_ELIGIBLE_TYPE_NAMES_ = ['TEXT', 'MULTIPLE_CHOICE', 'LIST', 'DATE', 'TIME', 'SCALE'];

// --------------- ログ ---------------

/**
 * 詳細ログ（デバッグモード）を有効化するか。
 * DocumentProperties の 'DEBUG_LOGGING' === 'true' のときだけ true。
 * ファイル ID・回答由来の値・元/新ファイル名などの機微情報は、有効時のみ出力し
 * 通常運用では Stackdriver に残さない。
 * @private
 */
function isDebugLogging_() {
  try {
    return PropertiesService.getDocumentProperties()
      .getProperty('DEBUG_LOGGING') === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * 機微情報を含み得る詳細ログ。デバッグモード時のみ出力する。
 * @private
 */
function dbgLog_(msg) {
  if (isDebugLogging_()) console.log('[FileRenamer][debug] ' + msg);
}

/**
 * ファイル ID / メールアドレスなどの識別子をログ用にマスクする。
 * 末尾 4 文字のみ残し、それ以前は省略する。
 * @private
 */
function maskId_(id) {
  const s = String(id == null ? '' : id);
  if (s.length <= 4) return '****';
  return '…' + s.slice(-4);
}

/**
 * 項目 ID を数値に正規化する。数値化できない場合は -1（未設定扱い）を返す。
 * saveSettings / loadSettings の双方で使い、保存経路（旧バージョン・手動編集・
 * localStorage 由来の保留設定）で ID が文字列でも実行時の form.getItemById() と
 * 型を一致させる。
 * @private
 */
function coerceItemId_(v) {
  // null / 空文字は Number() が 0 に化けるため、明示的に未設定 (-1) へ倒す。
  // これを怠ると「未設定」のはずが「ID=0 の項目」として扱われ、実行時に
  // form.getItemById(0) が null を返して紛らわしい「項目が見つかりません」に化ける。
  if (v == null || v === '') return -1;
  const n = Number(v);
  return Number.isFinite(n) ? n : -1;
}

// --------------- Add-on ライフサイクル ---------------

/**
 * フォームエディタで開かれた時（AuthMode.NONE or LIMITED）
 * Google Apps Script の simple trigger として自動的に呼ばれる
 */
function onOpen(e) {
  const menu = FormApp.getUi().createAddonMenu();
  menu.addItem('設定を開く', 'showSettingsSidebar');

  // AuthMode.LIMITED 以上なら DocumentProperties でトリガー状態を判定し
  // メニューを動的に切り替える。NONE の場合は両方表示（フォールバック）
  let triggerKnown = false;
  try {
    const stored = PropertiesService.getDocumentProperties()
      .getProperty('TRIGGER_ENABLED');
    if (stored === 'true') {
      menu.addItem('✅ トリガー有効 → 無効化', 'uninstallTrigger');
    } else {
      menu.addItem('⚠️ トリガー無効 → 有効化', 'installTrigger');
    }
    triggerKnown = true;
  } catch (_) {
    // AuthMode.NONE では PropertiesService にアクセスできない
  }

  if (!triggerKnown) {
    menu.addItem('トリガーを有効化', 'installTrigger');
    menu.addItem('トリガーを無効化', 'uninstallTrigger');
  }

  menu.addToUi();
}

/**
 * アドオンがインストールされた時（AuthMode.FULL）
 * トリガーも同時に自動インストールする
 */
function onInstall(e) {
  onOpen(e);
  // インストール時に FULL 権限があればトリガーを自動登録
  if (e && e.authMode === ScriptApp.AuthMode.FULL) {
    setTriggerEnabled(true);
  }
}

// --------------- サイドバー ---------------

function showSettingsSidebar() {
  // サイドバーの google.script.run が「承認が必要です」エラーになる環境向け対策:
  // メニュー経由（FULL 権限）で全データを事前取得し、テンプレート経由で HTML に埋め込む
  // 各データを個別に取得し、1つの失敗が他に影響しないようにする
  const initData = {};
  const initErrors = [];

  try { initData.codeVersion = getCodeVersion(); } catch (e) {
    initErrors.push('codeVersion: ' + e.message);
  }
  try { initData.driveAccess = checkDriveAccess(); } catch (e) {
    initData.driveAccess = false;
    initErrors.push('driveAccess: ' + e.message);
  }
  // FULL 権限コンテキストでは実体トリガーと突き合わせて補正する（getTriggerStatus
  // は GSR フォールバック専用に DocumentProperties のみを見る）。
  try { initData.triggerStatus = reconcileTriggerStatus_(); } catch (e) {
    initData.triggerStatus = false;
    initErrors.push('triggerStatus: ' + e.message);
  }
  try { initData.formItems = getFormItems(); } catch (e) {
    initData.formItems = [];
    initErrors.push('formItems: ' + e.message);
  }
  try { initData.settings = loadSettings(); } catch (e) {
    initData.settings = null;
    initErrors.push('settings: ' + e.message);
  }
  // クライアントが保留設定 (localStorage) のキーをフォーム単位で分離するために使う。
  // 診断 (diag.formId) とは独立に取得し、診断の失敗に巻き込まれて欠けないようにする。
  try { initData.formId = FormApp.getActiveForm().getId(); } catch (e) {
    initErrors.push('formId: ' + e.message);
  }
  try { initData.diag = getDiagnostics_(); } catch (e) {
    initErrors.push('diag: ' + e.message);
  }
  // 許可項目種別の単一の真実をクライアントへ配布する（定義の二重管理を避ける）
  initData.nameEligibleTypes = NAME_ELIGIBLE_TYPE_NAMES_;

  if (initErrors.length > 0) {
    initData.partialErrors = initErrors;
    console.warn('[FileRenamer] showSettingsSidebar 部分エラー: ' + initErrors.join('; '));
  }

  // サイドバーから保留中の設定があれば、この FULL 権限コンテキストで保存する。
  // パース・保存が成功した「後」にだけ PENDING_SAVE を削除する。途中で失敗した
  // 場合に退避データが失われ「保存できなかったのに保留も消える」事態を避ける。
  try {
    const pending = PropertiesService.getDocumentProperties()
      .getProperty('PENDING_SAVE');
    if (pending) {
      let parsed;
      try {
        parsed = JSON.parse(pending);
      } catch (parseErr) {
        // パース不能な保留データは復旧不可能。保持し続けても開くたびに失敗する
        // だけなので、ここで破棄して無限リトライを止める。
        PropertiesService.getDocumentProperties().deleteProperty('PENDING_SAVE');
        throw new Error('PENDING_SAVE が不正な JSON のため破棄しました: ' + parseErr.message);
      }
      saveSettings(parsed);
      // 保存成功後に削除し、正規化済みの結果を読み直して UI と整合させる
      PropertiesService.getDocumentProperties().deleteProperty('PENDING_SAVE');
      initData.settings = loadSettings();
      initData.pendingSaved = true;
      console.log('[FileRenamer] 保留中の設定をサイドバー表示時に保存しました');
    }
  } catch (e) {
    // 失敗時は PENDING_SAVE を保持したままエラーを記録し、次回の再試行に委ねる
    console.warn('[FileRenamer] 保留設定の保存に失敗（保留データは保持）: ' + e.message);
    try {
      PropertiesService.getDocumentProperties()
        .setProperty('PENDING_SAVE_ERROR', new Date().toISOString() + ': ' + e.message);
    } catch (_) {}
  }

  // テンプレートエンジンを使用して SERVER_INIT_DATA を正しく注入する
  // ※ getContent() + createHtmlOutput() パターンは google.script.run の
  //   ランタイム接続を壊すため使用しない
  // ※ <script> 内での HTML ブレイクアウト (</script>, <!--, <script ...) を
  //   防ぐため '<' をすべて \u003c にエスケープする
  // ※ U+2028 / U+2029 は JSON では生のままだが、JavaScript の文字列リテラル中
  //   では改行扱いとなり SyntaxError を引き起こすためエスケープする
  //   （フォーム項目タイトルに混入しているケースがある）
  const template = HtmlService.createTemplateFromFile('Sidebar');
  template.initDataJson = JSON.stringify(initData)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const html = template.evaluate()
    .setTitle('ファイルリネーム設定')
    .setWidth(360);
  FormApp.getUi().showSidebar(html);
}

/**
 * 保留中の設定を DocumentProperties に一時保存する
 * google.script.run 経由で saveSettings が失敗する環境向け。
 * PropertiesService のみ使用するため認証要件が低い。
 * 次回メニューから「設定を開く」時に showSettingsSidebar が保存を完了する。
 */
function storePendingSave(settings) {
  PropertiesService.getDocumentProperties()
    .setProperty('PENDING_SAVE', JSON.stringify(settings));
  return true;
}

// --------------- トリガー管理 ---------------

/**
 * Drive アクセスが可能かを確認する（サイドバー診断用）
 * @return {boolean} true = OK, false = drive スコープ未承認
 */
function checkDriveAccess() {
  try {
    DriveApp.getRootFolder();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * デプロイバージョン確認用（サービス不要）
 * サイドバーから呼んでどのコードが動いているか確認する
 */
function getCodeVersion() {
  return 'v2026-07-04-A';
}

/**
 * サイドバーのデバッグログ用: 環境診断情報を返す
 * showSettingsSidebar の FULL 権限コンテキストで呼ばれる
 * @private
 */
function getDiagnostics_() {
  const diag = {};
  try { diag.activeUser = Session.getActiveUser().getEmail(); } catch (e) { diag.activeUser = 'ERR: ' + e.message; }
  try { diag.effectiveUser = Session.getEffectiveUser().getEmail(); } catch (e) { diag.effectiveUser = 'ERR: ' + e.message; }
  try { diag.scriptId = ScriptApp.getScriptId(); } catch (e) { diag.scriptId = 'ERR: ' + e.message; }
  try {
    const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    diag.authStatus = info.getAuthorizationStatus().toString();
    diag.authUrl = info.getAuthorizationUrl();
  } catch (e) { diag.authStatus = 'ERR: ' + e.message; }
  try { diag.formId = FormApp.getActiveForm().getId(); } catch (e) { diag.formId = 'ERR: ' + e.message; }
  try { diag.formTitle = FormApp.getActiveForm().getTitle(); } catch (e) { diag.formTitle = 'ERR: ' + e.message; }
  try {
    const triggers = ScriptApp.getUserTriggers(FormApp.getActiveForm());
    diag.triggerCount = triggers.length;
    diag.triggers = triggers.map(function(t) {
      return t.getHandlerFunction() + '/' + t.getEventType();
    });
  } catch (e) { diag.triggerInfo = 'ERR: ' + e.message; }
  diag.timestamp = new Date().toISOString();
  // メールアドレス・フォーム ID・フォームタイトルを含むためデバッグ時のみ出力する
  dbgLog_('getDiagnostics_: ' + JSON.stringify(diag));
  return diag;
}

/**
 * google.script.run の疎通確認用
 * サイドバーから呼んで google.script.run が動作するか診断する
 * @param {string} callerContext 呼び出し元の識別子
 * @return {object} 診断結果
 */
function gsrPing(callerContext) {
  const result = {
    ok: true,
    callerContext: callerContext,
    timestamp: new Date().toISOString(),
    effectiveUser: ''
  };
  try { result.effectiveUser = Session.getEffectiveUser().getEmail(); } catch (e) { result.effectiveUser = 'ERR: ' + e.message; }
  console.log('[FileRenamer] gsrPing from "' + callerContext + '": OK');
  return result;
}

/**
 * トリガーが有効かを返す
 * DocumentProperties (TRIGGER_ENABLED) のみを使用する。
 * ScriptApp.getUserTriggers() は google.script.run 経由で呼ぶと
 * "承認が必要" エラーになるため一切使用しない。
 * 未設定時（onInstall 前など）は false を返す。
 */
function getTriggerStatus() {
  try {
    const stored = PropertiesService.getDocumentProperties()
      .getProperty('TRIGGER_ENABLED');
    return stored === 'true';
  } catch (e) {
    console.error('[FileRenamer] getTriggerStatus エラー: ' + e.message);
    return false;
  }
}

/**
 * FULL 権限コンテキスト（showSettingsSidebar / onInstall 経由）でのみ呼ぶ。
 * 保存値 TRIGGER_ENABLED と実際の installable trigger の有無を突き合わせ、
 * ズレていれば実体に合わせて補正する。手動でトリガーを削除した場合や、
 * setTriggerEnabled() の途中失敗で状態がズレた場合を解消する。
 *
 * 注意: ScriptApp.getProjectTriggers() は「現在のユーザーが作成した」トリガー
 *      のみを返す（Apps Script の仕様）。別の編集者が作成したトリガーは検出
 *      できないため、複数編集者運用ではこの補正も完全ではない。フォーム単位で
 *      トリガー管理を一人に限定する運用を推奨する（ADDON_GUIDE 参照）。
 * @return {boolean} 補正後の有効状態
 * @private
 */
function reconcileTriggerStatus_() {
  const props = PropertiesService.getDocumentProperties();
  const stored = props.getProperty('TRIGGER_ENABLED') === 'true';
  const owner = props.getProperty('TRIGGER_OWNER') || '';
  let me = '';
  try { me = Session.getEffectiveUser().getEmail() || ''; } catch (_) {}
  let actual;
  try {
    actual = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getHandlerFunction() === 'onFormSubmit'
        && t.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT;
    });
  } catch (e) {
    // 実体を取得できない場合は保存値をそのまま返す（補正しない）
    console.warn('[FileRenamer] トリガー実体確認に失敗、保存値を使用: ' + e.message);
    return stored;
  }
  if (actual === stored) return actual;

  if (actual && !stored) {
    // 実体があるのに「無効」記録 → 有効へ補正（安全: 自分のトリガーが実在する）。
    // 併せて作成者を自分として記録する。
    props.setProperty('TRIGGER_ENABLED', 'true');
    if (me) props.setProperty('TRIGGER_OWNER', me);
    console.log('[FileRenamer] トリガー状態を実体に合わせて補正: false → true');
    return true;
  }

  // !actual && stored: 自分にはトリガーが見えないが「有効」記録あり。
  // getProjectTriggers() は「現在のユーザーが作成した」トリガーしか返さないため、
  // 別の編集者が作成したトリガーは自分から見えないだけで実際は動作している。
  // その場合まで「無効」に補正すると、他ユーザーが再度「有効化」して
  // トリガーが重複＝二重リネームを誘発する。したがって無効へ倒すのは、
  // 記録上の作成者が自分（＝自分のトリガーが本当に消えた）か、作成者が
  // 未記録のときだけに限定する。
  if (!owner || owner === me) {
    props.setProperty('TRIGGER_ENABLED', 'false');
    props.deleteProperty('TRIGGER_OWNER');
    console.log('[FileRenamer] トリガー状態を実体に合わせて補正: true → false');
    return false;
  }
  console.log('[FileRenamer] トリガーは別の編集者 (' + maskId_(owner)
    + ') が作成済みのため有効表示を維持します。');
  return true;
}

/**
 * トリガーの有効/無効を切り替える（サイドバーから呼ばれる）
 * @param {boolean} enabled true で有効化、false で無効化
 * @return {boolean} 切り替え後の状態
 */
function setTriggerEnabled(enabled) {
  // 状態の整合性を保つため、まず先に「無効」を記録してから操作する。
  // create() が途中で失敗してもプロパティと実体の不一致が残らない。
  const props = PropertiesService.getDocumentProperties();
  const prevState = props.getProperty('TRIGGER_ENABLED'); // 失敗時の復元用
  props.setProperty('TRIGGER_ENABLED', 'false');
  try {
    // 既存トリガーの削除に失敗した場合は作成を行わない（重複登録防止）
    removeAllSubmitTriggers_();
    if (enabled) {
      ScriptApp.newTrigger('onFormSubmit')
        .forForm(FormApp.getActiveForm())
        .onFormSubmit()
        .create();
      props.setProperty('TRIGGER_ENABLED', 'true');
      // 作成者を記録する。reconcileTriggerStatus_ が別編集者のトリガーを
      // 誤って「無効」に補正しないよう突き合わせに使う。
      try { props.setProperty('TRIGGER_OWNER', Session.getEffectiveUser().getEmail() || ''); } catch (_) {}
    } else {
      // 無効化: 自分のトリガーは removeAllSubmitTriggers_ で削除済み。
      // 記録上の作成者が自分（または未記録）なら所有者情報も消す。別編集者が
      // 作成したトリガーは自分からは削除できないため、その所有者情報は残す。
      try {
        const owner = props.getProperty('TRIGGER_OWNER') || '';
        let me = '';
        try { me = Session.getEffectiveUser().getEmail() || ''; } catch (_) {}
        if (!owner || owner === me) props.deleteProperty('TRIGGER_OWNER');
      } catch (_) {}
    }
    return enabled;
  } catch (err) {
    // 失敗時はできる限り整合性を保つ: 新規作成に失敗したなら残存トリガーを
    // もう一度除去し、プロパティを「無効」で確定させる。
    // （旧状態が 'true' でも実体は壊れた可能性があるため false に倒す）
    try { removeAllSubmitTriggers_(); } catch (_) {}
    props.setProperty('TRIGGER_ENABLED', 'false');
    console.error('[FileRenamer] setTriggerEnabled 失敗 (prev=' + prevState
      + ', requested=' + enabled + '): ' + err.message);
    throw err;
  }
}

/**
 * onFormSubmit の installable trigger を登録（メニュー用 — UI フィードバックあり）
 */
function installTrigger() {
  try {
    setTriggerEnabled(true);
    FormApp.getUi().alert('✅ フォーム送信時のトリガーを有効化しました。');
  } catch (e) {
    console.error('[FileRenamer] installTrigger エラー: ' + e.message);
    FormApp.getUi().alert('❌ トリガー有効化に失敗しました: ' + e.message);
  }
}

/**
 * トリガー無効化（メニュー用 — UI フィードバックあり）
 */
function uninstallTrigger() {
  try {
    setTriggerEnabled(false);
    FormApp.getUi().alert('✅ フォーム送信時のトリガーを無効化しました。');
  } catch (e) {
    console.error('[FileRenamer] uninstallTrigger エラー: ' + e.message);
    FormApp.getUi().alert('❌ トリガー無効化に失敗しました: ' + e.message);
  }
}

/**
 * このスクリプトが持つ onFormSubmit トリガーを全削除（内部ヘルパー）
 *
 * ScriptApp.getProjectTriggers() は「現在のユーザーが作成した、このスクリプト
 * プロジェクトの全トリガー」を返す。本スクリプトはフォームに bind されており
 * 他フォームの混入はあり得ないが、万一 CLOCK 等の別種トリガーが混ざっても
 * EventType で onFormSubmit のみに限定して安全に除去する。
 *
 * 注意: Apps Script の仕様上、別ユーザー（他の編集者）が作成したトリガーは
 *      どのユーザーコンテキストからも削除できない。複数編集者がそれぞれ
 *      「有効化」した場合、各自のトリガーが並列に動作し多重リネームになる
 *      可能性がある点は、運用ドキュメントで注意喚起する必要がある。
 * @private
 */
function removeAllSubmitTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'onFormSubmit'
        && t.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  if (removed > 1) {
    console.warn('[FileRenamer] onFormSubmit トリガーが複数検出されました ('
      + removed + '件)。重複状態を解消しました。');
  }
}

// --------------- 設定の読み書き ---------------

/**
 * フォームの全項目を取得して返す（GUI 用）
 * google.script.run 経由で呼ばれるため try-catch 必須
 */
function getFormItems() {
  try {
    const form = FormApp.getActiveForm();
    if (!form) {
      throw new Error('フォームが取得できません。スクリプトがフォームにバインドされているか確認してください。');
    }
    const items = form.getItems().map(item => ({
      id: item.getId(),
      title: item.getTitle(),
      type: item.getType().toString()
    }));
    // 個別タイトルはログに出さない（Stackdriver 漏洩防止）
    console.log('[FileRenamer] getFormItems: ' + items.length + ' 件');
    return items;
  } catch (e) {
    console.error('[FileRenamer] getFormItems エラー: ' + e.message);
    throw new Error('フォーム項目の取得に失敗: ' + e.message);
  }
}

/**
 * 保存済みの設定を返す
 * DocumentProperties を使用し、設定はフォーム単位で保存される
 * （同じフォームのすべての編集者が同一の設定を共有する）
 */
function loadSettings() {
  const raw = PropertiesService.getDocumentProperties()
    .getProperty('RENAME_SETTINGS');
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // 後続コードが安全に参照できるよう正規化する。
  // 旧バージョンで保存された設定は ID が文字列のことがあり、そのままだと
  // onFormSubmit の Number.isFinite() 判定で弾かれて「未設定」扱いになり、
  // 無言でリネームがスキップされる。ここで数値化して型を揃える。
  parsed.fileFieldId = coerceItemId_(parsed.fileFieldId);
  parsed.subfolderFieldId = coerceItemId_(parsed.subfolderFieldId);
  // nameFields は要素単位で正規化する。null 要素や文字列 ID が混ざっていても
  // onFormSubmit のループ（fieldCfg.id 参照）で TypeError を起こさないようにする。
  parsed.nameFields = (Array.isArray(parsed.nameFields) ? parsed.nameFields : [])
    .map(function(f) {
      if (!f || typeof f !== 'object') return null;
      return {
        id: coerceItemId_(f.id),
        prefix: f.prefix == null ? '' : String(f.prefix),
        suffix: f.suffix == null ? '' : String(f.suffix)
      };
    })
    .filter(function(f) { return f && f.id !== -1; });
  // extRules も要素単位で正規化する。null 要素や from/to が欠けた要素が混入して
  // いると（手動編集された DocumentProperties・旧バージョン由来など）、クライアントの
  // applySettings が r.from 参照で TypeError を起こし、サイドバー初期化が途中で
  // 止まって「読み込み中」のまま固まる。nameFields と対称的に防御する。
  parsed.extRules = (Array.isArray(parsed.extRules) ? parsed.extRules : [])
    .map(function(r) {
      if (!r || typeof r !== 'object') return null;
      return {
        from: r.from == null ? '' : String(r.from),
        to: r.to == null ? '' : String(r.to)
      };
    })
    .filter(function(r) { return r && r.from && r.to; });
  if (typeof parsed.separator !== 'string') parsed.separator = '_';
  // lowercaseExt は「明示的に false のときのみ false、それ以外は true」で
  // 保存側 (saveSettings) と同じセマンティクスに統一する。
  parsed.lowercaseExt = parsed.lowercaseExt !== false;
  return parsed;
}

/**
 * 設定を保存する
 */
function saveSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    throw new Error('saveSettings: 不正な設定オブジェクト');
  }
  // separator はファイル名の構成要素になるため禁止文字を除去する。
  // サニタイズ結果が空になる場合はデフォルトの '_' にフォールバック。
  // 長さ上限も設ける。極端に長い separator だと連番 suffix が最終 sanitize で
  // 削られ、複数ファイルが同名になり得るため（UI の maxlength=5 の裏道対策）。
  let sep = typeof settings.separator === 'string' ? settings.separator : '_';
  sep = sanitizeFileName(sep).slice(0, SEPARATOR_MAX_LENGTH_);
  if (!sep) sep = '_';

  const _str = function(v) { return v == null ? '' : String(v); };
  // 接頭辞・接尾辞は上限を設けて DocumentProperties（1 プロパティ約 9KB）の
  // 肥大化と、極端に長いファイル名を防ぐ。
  const _affix = function(v) { return _str(v).slice(0, AFFIX_MAX_LENGTH_); };

  // nameFields を { id: number, prefix: string, suffix: string } に正規化する。
  // localStorage 由来の保留設定などで文字列 ID が混ざっても、実行時の
  // form.getItemById() / クライアントの findItemById() と型が一致するようにする。
  const nameFields = (Array.isArray(settings.nameFields) ? settings.nameFields : [])
    .map(function(f) {
      if (!f || typeof f !== 'object') return null;
      return { id: coerceItemId_(f.id), prefix: _affix(f.prefix), suffix: _affix(f.suffix) };
    })
    .filter(function(f) { return f && f.id !== -1; });

  // extRules を { from, to } に正規化する。
  // 拡張子は単一セグメント（ドットなし）に統一する。実行時のマッチングは
  // originalName.lastIndexOf('.') で「最後のセグメント」だけを見るため、複合拡張子
  // (例: tar.gz) は from としてマッチできない。UI 側も oninput でドットを全除去する。
  // 三者（UI・保存・実行）の挙動を揃えるため、ここでも from/to からドットを全除去する。
  // - from: ドット全除去 → 小文字化 → サニタイズ → 長さ制限（実行時 buildExtRulesMap と同義）
  // - to:   ドット全除去 → サニタイズ → 長さ制限
  // 同じ from が複数あれば最初の定義を優先（重複排除）。
  const seenFrom = Object.create(null);
  const extRules = (Array.isArray(settings.extRules) ? settings.extRules : [])
    .map(function(r) {
      if (!r || typeof r !== 'object') return null;
      const from = sanitizeFileName(_str(r.from).replace(/\./g, ''))
        .toLowerCase().slice(0, EXT_MAX_LENGTH_);
      const to = sanitizeFileName(_str(r.to).replace(/\./g, '')).slice(0, EXT_MAX_LENGTH_);
      if (!from || !to) return null;
      return { from: from, to: to };
    })
    .filter(function(r) {
      if (!r) return false;
      if (seenFrom[r.from]) return false;
      seenFrom[r.from] = true;
      return true;
    });

  const normalized = {
    fileFieldId: coerceItemId_(settings.fileFieldId),
    subfolderFieldId: coerceItemId_(settings.subfolderFieldId),
    separator: sep,
    lowercaseExt: settings.lowercaseExt !== false,
    nameFields: nameFields,
    extRules: extRules
  };
  console.log('[FileRenamer] saveSettings 呼び出し keys=' + Object.keys(normalized).join(','));
  PropertiesService.getDocumentProperties()
    .setProperty('RENAME_SETTINGS', JSON.stringify(normalized));
  console.log('[FileRenamer] saveSettings 完了');
  return true;
}

// --------------- フォーム送信時の処理 ---------------

/**
 * ファイル名/サブフォルダ名に使える項目種別かを判定する（サーバー側ガード）。
 * Sidebar.html の NAME_ELIGIBLE_ITEM_TYPES と一致させる。
 * 設定保存後に項目種別が変更された場合や、手動編集された DocumentProperties
 * から不適切な種別が混入した場合に、実行時にここで弾く。
 * @private
 */
function isNameEligibleItem_(item) {
  if (!item) return false;
  return NAME_ELIGIBLE_TYPE_NAMES_.indexOf(item.getType().toString()) !== -1;
}

function onFormSubmit(e) {
  // e.response がなければ直接呼び出しなどのためスキップ
  if (!e || !e.response) return;

  try {
    console.log('[FileRenamer] onFormSubmit 開始 authMode=' + e.authMode);

    const settings = loadSettings();
    if (!settings) {
      console.log('[FileRenamer] 設定が見つかりません。サイドバーから設定を行ってください。');
      return;
    }
    console.log('[FileRenamer] 設定読込完了 fileFieldId=' + settings.fileFieldId
      + ' nameFields=' + settings.nameFields.length);

    const form = FormApp.getActiveForm();

    // --- ファイルアップロード項目を特定 ---
    const fileFieldId = settings.fileFieldId;
    if (!Number.isFinite(fileFieldId) || fileFieldId === -1) {
      console.log('[FileRenamer] ファイルアップロード項目が設定されていません。');
      return;
    }

    const fileItem = form.getItemById(fileFieldId);
    if (!fileItem) {
      console.log('[FileRenamer] ID=' + fileFieldId + ' の項目がフォームに見つかりません。');
      return;
    }
    // 設定ミスで FILE_UPLOAD 以外が選ばれていた場合、getResponse() が
    // 文字列や配列を返してファイル ID 扱いされる危険があるため早期 return。
    if (fileItem.getType() !== FormApp.ItemType.FILE_UPLOAD) {
      console.log('[FileRenamer] ID=' + fileFieldId
        + ' の項目はファイルアップロードではありません (type='
        + fileItem.getType() + ')。設定を確認してください。');
      return;
    }

    const fileItemResponse = e.response.getResponseForItem(fileItem);
    if (!fileItemResponse) {
      console.log('[FileRenamer] ファイルアップロードの回答がありません。');
      return;
    }

    const fileResponse = fileItemResponse.getResponse();
    const fileIds = (Array.isArray(fileResponse) ? fileResponse : [fileResponse])
      .filter(function(id) { return id != null && id !== ''; });
    if (fileIds.length === 0) {
      console.log('[FileRenamer] アップロードされたファイルがありません。');
      return;
    }
    console.log('[FileRenamer] アップロードファイル数: ' + fileIds.length);
    dbgLog_('ファイルID: ' + fileIds.join(', '));

    // --- ファイル名の本体を組み立てる ---
    const separator = settings.separator || '_';
    const nameParts = [];

    for (const fieldCfg of settings.nameFields) {
      if (fieldCfg.id == null || fieldCfg.id === -1) continue;
      const item = form.getItemById(fieldCfg.id);
      if (!item) {
        console.log('[FileRenamer] nameField ID=' + fieldCfg.id + ' が見つかりません。スキップ。');
        continue;
      }
      // ファイル名に使える種別（短文/ラジオ/プルダウン/日付/時刻/均等目盛）以外は
      // 値が複雑になりファイル名として不適切なため弾く。
      if (!isNameEligibleItem_(item)) {
        console.log('[FileRenamer] nameField ID=' + fieldCfg.id
          + ' は対象外の種別 (' + item.getType() + ') のためスキップ。');
        continue;
      }
      const itemResponse = e.response.getResponseForItem(item);
      if (!itemResponse) continue;
      let value = itemResponse.getResponse();
      if (value == null) continue;
      if (Array.isArray(value)) value = value.join(',');
      value = String(value).trim();
      if (fieldCfg.prefix) value = fieldCfg.prefix + value;
      if (fieldCfg.suffix) value = value + fieldCfg.suffix;
      // 各 part を個別にサニタイズしておくことで、禁止文字が完全除去された
      // 結果として区切り文字が重複する（例: "X__Y"）のを防ぐ
      value = sanitizeFileName(value);
      if (value) nameParts.push(value);
    }
    console.log('[FileRenamer] ファイル名構成項目数: ' + nameParts.length);
    dbgLog_('nameParts: ' + JSON.stringify(nameParts));

    if (nameParts.length === 0) {
      console.log('[FileRenamer] ファイル名を構成する値がすべて空のため、リネームをスキップ。');
      return;
    }

    // join 後も念のためサニタイズ（separator 自体に禁止文字が入った場合の保険）
    const baseName = sanitizeFileName(nameParts.join(separator));
    if (!baseName) {
      console.log('[FileRenamer] サニタイズ後のファイル名が空のため、リネームをスキップ。');
      return;
    }
    const extRules = buildExtRulesMap(settings.extRules || []);
    const lowercaseExt = settings.lowercaseExt !== false;

    // Drive スコープ基本確認（スコープ未承認の早期検出）
    try {
      DriveApp.getRootFolder();
      dbgLog_('Drive 基本アクセス: OK');
    } catch (driveRootErr) {
      console.error('[FileRenamer] ⚠️ Drive 基本アクセス失敗 — '
        + 'Marketplace SDK の OAuth Scopes に https://www.googleapis.com/auth/drive が含まれているか、'
        + 'アドオンを再インストール/再承認してください。エラー: ' + driveRootErr.message);
      return;
    }

    // Forms のアップロード直後に Drive 書き込みが完了していない場合があるが、
    // getFileWithRetry_ がリトライで吸収するため無条件 sleep は行わない。

    // --- サブフォルダの特定（設定されている場合） ---
    let targetFolder = null;
    if (Number.isFinite(settings.subfolderFieldId) && settings.subfolderFieldId !== -1) {
      const subItem = form.getItemById(settings.subfolderFieldId);
      if (subItem) {
        // サブフォルダ名もファイル名と同じ allowlist で限定する。
        // チェックボックス・グリッド・長文回答などは値が複雑でフォルダ名として不適切。
        if (!isNameEligibleItem_(subItem)) {
          console.log('[FileRenamer] サブフォルダ項目 ID=' + settings.subfolderFieldId
            + ' は対象外の種別 (' + subItem.getType() + ') のためスキップ。');
        } else {
          const subResponse = e.response.getResponseForItem(subItem);
          if (subResponse) {
            let subValue = subResponse.getResponse();
            // null ガード: getResponse() が null のとき String(null)="null" が
            // サニタイズを通過し「null」という名前のフォルダが作られるのを防ぐ。
            if (subValue != null) {
              if (Array.isArray(subValue)) subValue = subValue.join(',');
              subValue = sanitizeFileName(String(subValue).trim());
              if (subValue) {
                // サブフォルダ解決の失敗（getFileById 恒久エラー・createFolder 失敗）は
                // ここで捕捉し targetFolder=null に落とす。捕捉しないと外側 catch まで
                // 飛び、1 件もリネームされずに終わってしまう（移動だけ諦めれば済む）。
                try {
                  targetFolder = getOrCreateSubfolder_(fileIds[0], subValue);
                } catch (subErr) {
                  targetFolder = null;
                  console.error('[FileRenamer] サブフォルダの解決/作成でエラー。ファイル移動はスキップしリネームは続行します: '
                    + (subErr && subErr.message ? subErr.message : subErr));
                }
                if (targetFolder) {
                  console.log('[FileRenamer] サブフォルダ解決: OK');
                  dbgLog_('サブフォルダ名: ' + subValue);
                } else {
                  console.warn('[FileRenamer] サブフォルダの解決/作成に失敗したため、ファイル移動をスキップします。');
                  dbgLog_('解決失敗サブフォルダ名: ' + subValue);
                }
              }
            }
          }
        }
      } else {
        console.log('[FileRenamer] サブフォルダ項目 ID=' + settings.subfolderFieldId + ' が見つかりません。スキップ。');
      }
    }

    // --- 各ファイルをリネーム（＋サブフォルダ移動） ---
    // 連番幅は総ファイル数に合わせて決定（例: 100件以上は3桁）。
    const indexWidth = Math.max(2, String(fileIds.length).length);
    let successCount = 0;
    let failureCount = 0;
    fileIds.forEach((fileId, i) => {
      // 各ファイルを独立した try/catch で処理する。1件の失敗で残りの
      // ファイルのリネーム/移動が巻き添えで止まらないようにする。
      try {
        const file = getFileWithRetry_(fileId);
        const originalName = file.getName();

        // dotIdx > 0 をチェック: ".gitignore" のような dotfile 名を
        // ファイル全体＝拡張子と誤認するのを防ぐ
        const dotIdx = originalName.lastIndexOf('.');
        let extBody = dotIdx > 0 ? originalName.substring(dotIdx + 1) : '';
        const extKey = extBody.toLowerCase();
        if (extRules[extKey]) {
          // マッピングが存在する場合はルール値をそのまま採用
          extBody = extRules[extKey];
        } else if (lowercaseExt) {
          extBody = extKey;
        }
        // 拡張子ルールに一致しない大多数のケースでは、元ファイル名由来の拡張子が
        // そのまま最終ファイル名に連結される。本体 (baseName) は sanitizeFileName で
        // 双方向オーバーライド文字・ゼロ幅文字・OS 禁止文字を除去しているのに、
        // 拡張子側が素通りすると拡張子偽装（例: U+202E を仕込んだ拡張子）への
        // 対策が不完全になる。拡張子本体もサニタイズし、併せて長さ上限を設ける。
        // extBody は最後のドット以降でありドットを含まないため拡張子構造は壊れない。
        // extRules 値は保存時に sanitize 済みで、この再サニタイズは冪等。
        extBody = sanitizeFileName(extBody).slice(0, EXT_MAX_LENGTH_);

        const ext = extBody ? '.' + extBody : '';

        const suffix = fileIds.length > 1
          ? separator + String(i + 1).padStart(indexWidth, '0')
          : '';
        // 連番 suffix と拡張子の長さを確保したうえで本体を切り詰め、最終ファイル名
        // 全体が上限を超えないようにする。連番が消えると複数ファイルで衝突するため、
        // 削るのは常に本体側にする。
        // 最後の sanitizeFileName(trimmedBase + suffix) が FILENAME_MAX_LENGTH_ で
        // 再スライスするため、本体長は (FILENAME_MAX_LENGTH_ - suffix) にも収める。
        // これを怠ると本体が長いとき末尾の連番が削られ、複数ファイルが同名になる。
        const bodyBudget = Math.max(1, Math.min(
          FILENAME_MAX_LENGTH_ - suffix.length,
          FILENAME_TOTAL_MAX_LENGTH_ - suffix.length - ext.length));
        const trimmedBase = sanitizeFileName(baseName).slice(0, bodyBudget);
        // 最終ファイル名を再度サニタイズして禁止文字の混入を防ぐ
        // （separator に異常値が入っていた場合の保険。拡張子のドットは残す）
        const newName = sanitizeFileName(trimmedBase + suffix) + ext;

        file.setName(newName);
        console.log('[FileRenamer] リネーム完了 (' + (i + 1) + '/' + fileIds.length + ')');
        dbgLog_('リネーム: 「' + originalName + '」→「' + newName + '」');

        // サブフォルダへ移動
        if (targetFolder) {
          file.moveTo(targetFolder);
          console.log('[FileRenamer] サブフォルダへ移動完了');
        }
        successCount++;
      } catch (perFileErr) {
        failureCount++;
        console.error('[FileRenamer] ファイル処理失敗 (fileId=' + maskId_(fileId) + '): '
          + (perFileErr && perFileErr.message ? perFileErr.message : perFileErr)
          + '\n' + (perFileErr && perFileErr.stack || ''));
      }
    });
    console.log('[FileRenamer] onFormSubmit 完了: 成功=' + successCount
      + ' 失敗=' + failureCount + ' / 全' + fileIds.length + '件');

  } catch (error) {
    console.error('[FileRenamer] エラー: ' + error.toString() + '\n' + (error.stack || ''));
  }
}

// --------------- ユーティリティ ---------------

/**
 * DriveApp.getFileById のリトライ付きラッパー
 * Forms アップロード直後の一時的な遅延に対処する
 * @private
 */
function getFileWithRetry_(fileId) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS_.length; attempt++) {
    try {
      return DriveApp.getFileById(fileId);
    } catch (err) {
      lastErr = err;
      // Forms アップロード直後の「一時的にまだ見えない」状態こそ、この関数が
      // リトライで吸収したい本命ケースである。ところがその状態は
      //   "No item with the given ID could be found. Possibly because you have not
      //    been granted access to it or it has been deleted."
      //   （日本語ロケール: 「…アクセスする権限が付与されていないか、削除された…」）
      // というメッセージで現れ、これは "access" / "アクセス" / "権限" を含む。
      // これらを恒久エラーのキーワードにすると、本来リトライすべき伝播遅延まで
      // 「恒久」と誤判定して即 throw してしまい、リトライ機構が一度も発火しない
      // （＝主目的が死ぬ）。したがって恒久判定は、この not-found メッセージには
      // 決して現れない、誤検出しないキーワードだけに絞る:
      //   - "invalid argument" : 不正な ID（時間が経っても解消しない）
      //   - "denied" / "拒否"  : 明示的な拒否（"Access denied" 等）
      // それ以外（not-found を含む一時的失敗）はリトライ対象とする。リトライは
      // 最大 RETRY_DELAYS_MS_.length 回・計 9 秒に限定されるため、仮に恒久エラーでも
      // 待ち時間は限定的。全体的な Drive 権限不足は onFormSubmit 冒頭の
      // DriveApp.getRootFolder() で既に早期検出されている。
      const rawMsg = String(err && err.message || err);
      const msg = rawMsg.toLowerCase();
      const isPermanent = msg.indexOf('invalid argument') !== -1
        || msg.indexOf('denied') !== -1
        || rawMsg.indexOf('拒否') !== -1;
      if (isPermanent) {
        console.error('[FileRenamer] getFileById 恒久エラー (リトライせず throw): ' + err.message);
        throw err;
      }
      if (attempt < RETRY_DELAYS_MS_.length) {
        console.log('[FileRenamer] getFileById 失敗 (attempt ' + (attempt + 1) + '): '
          + err.message + ' — ' + RETRY_DELAYS_MS_[attempt] + 'ms 後にリトライ');
        Utilities.sleep(RETRY_DELAYS_MS_[attempt]);
      }
    }
  }
  throw lastErr;
}

/**
 * アップロード先フォルダ内にサブフォルダを取得（なければ作成）
 * @param {string} sampleFileId アップロードされたファイルの ID（親フォルダ特定用）
 * @param {string} subfolderName サブフォルダ名
 * @return {Folder} サブフォルダ
 * @private
 */
function getOrCreateSubfolder_(sampleFileId, subfolderName) {
  // Forms アップロード直後の Drive 反映遅延に対処するためリトライ付きで取得
  const file = getFileWithRetry_(sampleFileId);
  const parents = file.getParents();
  const parentFolder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  // 複数同時送信時の同名フォルダ重複作成を防ぐためロックを取得。
  // 取得できなかった場合は競合作成のリスクがあるため、既存フォルダがあれば
  // そちらを使い、無ければ作成をスキップして null を返す（呼び出し元で移動を行わない）。
  const lock = LockService.getDocumentLock();
  let lockHeld = false;
  try {
    lock.waitLock(LOCK_TIMEOUT_MS_);
    lockHeld = true;
  } catch (e) {
    console.warn('[FileRenamer] サブフォルダ作成ロック取得失敗: ' + e.message);
  }
  try {
    const existing = parentFolder.getFoldersByName(subfolderName);
    if (existing.hasNext()) {
      return existing.next();
    }
    if (!lockHeld) {
      console.warn('[FileRenamer] ロック未取得のため新規サブフォルダ作成をスキップ: ' + subfolderName);
      return null;
    }
    return parentFolder.createFolder(subfolderName);
  } finally {
    if (lockHeld) {
      try { lock.releaseLock(); } catch (_) {}
    }
  }
}

function buildExtRulesMap(rules) {
  // Object.create(null) を使い、`toString` 等のプロトタイプキーと衝突して
  // 関数オブジェクトがマッピングとして返ってしまう事故を防ぐ。
  const map = Object.create(null);
  for (const rule of rules) {
    if (!rule || !rule.from || !rule.to) continue;
    // 拡張子は単一セグメントに統一するためドットを全除去する（saveSettings と同義）。
    const fromKey = String(rule.from).replace(/\./g, '').toLowerCase().slice(0, EXT_MAX_LENGTH_);
    // 拡張子の値もファイル名に直接入るためサニタイズし、長さも制限する
    const toVal = sanitizeFileName(String(rule.to).replace(/\./g, '')).slice(0, EXT_MAX_LENGTH_);
    // 同じ from が複数あれば最初の定義を優先する（saveSettings の重複排除と規則を揃える）。
    if (fromKey && toVal && !(fromKey in map)) {
      map[fromKey] = toVal;
    }
  }
  return map;
}

/**
 * ファイル名に使えない文字を除去
 */
function sanitizeFileName(name) {
  // null/undefined ガード: 呼び出し側で文字列化していない経路に備えて防衛的に処理する
  return String(name == null ? '' : name)
    .replace(/[\/\\?%*:|"<>]/g, '')   // OS で禁止されている文字
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')  // 制御文字
    // 双方向オーバーライド (U+202A-202E) とゼロ幅文字 (U+200B-200F, U+2060, U+FEFF)。
    // これらは表示上不可視のまま拡張子偽装 (例: "gpj.exe" を "exe.jpg" に見せる) に
    // 悪用され得るため除去する。
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')             // 連続スペースを1つに
    .trim()
    .slice(0, FILENAME_MAX_LENGTH_);   // Google Drive の 255 文字制限に余裕を持って制限
}
