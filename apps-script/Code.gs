/**
 * Wedding-game 司会画面用の集計 API（Google Apps Script ウェブアプリ）
 *
 * Google フォームの回答が入るスプレッドシートを読み、選択肢ごとの「人数だけ」を JSON で返す。
 * 名前は集計の重複排除にだけ使い、レスポンスには一切含めない。
 *
 * 返す JSON:
 *   {
 *     "updatedAt": "2026-11-16T09:00:00.000Z",
 *     "quiz": { "1": {"A":3,"B":5,"C":1,"total":9}, ... , "10": {...} },
 *     "pred": { "0問":0, "1問":2, ... , "5問":1, "total":9 }
 *   }
 *   シートが見つからないなど設定に問題があるときは "errors": ["..."] が付く（その分の人数は 0）。
 *
 * 呼び出し方:
 *   .../exec                 → JSON（司会画面は通常こちらを fetch する）
 *   .../exec?callback=関数名  → JSONP（fetch が使えない環境向けの予備）
 *
 * セットアップ手順は README.md の「司会画面」を参照。
 */

/* ===================== 設定（ここだけ編集する） ===================== */

// クイズ用フォームの回答が入るスプレッドシートの ID。
// URL  https://docs.google.com/spreadsheets/d/【ここが ID】/edit  の【】部分。
// 空文字 "" のままにできるのは、このスクリプトをそのスプレッドシートの
// 「拡張機能 → Apps Script」から作った場合だけ（そのスプレッドシート自身を読む）。
const QUIZ_SPREADSHEET_ID = "";

// クイズの回答が入るタブ（シート）の名前。画面下のタブに表示されている文字と完全に一致させる。
const QUIZ_SHEET_NAME = "フォームの回答 1";

// 予想用フォームの回答が入るスプレッドシートの ID。
// クイズと同じスプレッドシート（タブ違い）なら空文字 "" のままでよい。
// 別のスプレッドシートなら、その ID を入れる。
const PRED_SPREADSHEET_ID = "";

// 予想の回答が入るタブ（シート）の名前。
const PRED_SHEET_NAME = "フォームの回答 2";

// 【将来用・現在は未使用】正解を書いておくタブの名前（A列: 問題番号 1〜10、B列: 正解 A/B/C）。
// 正解発表の機能を足すときにここから読む。いまはこのタブを読まないし、JSON にも含めない。
const ANSWER_SHEET_NAME = "正解";

// 見出し（1行目）から列を探すためのキーワード。列の並び順には依存しない。
const NAME_HEADER_KEYWORD = "名前"; // 「お名前」の列
const PRED_HEADER_KEYWORD = "何問"; // 「新郎新婦の答えは何問そろいますか？」の列
// クイズの列は、見出しに「第1問」〜「第10問」を含む列を自動で探す。

const QUESTION_COUNT = 10;
const QUIZ_CHOICES = ["A", "B", "C"];
const PRED_CHOICES = ["0問", "1問", "2問", "3問", "4問", "5問"];

// 集計結果をキャッシュする秒数。司会画面は約3秒ごとに取りに来る。
const CACHE_SECONDS = 2;
const CACHE_KEY = "wg_stats_v1";

/* ===================== ウェブアプリの入口 ===================== */

function doGet(e) {
  const params = (e && e.parameter) || {};
  return respond_(getStatsJson_(), params.callback);
}

/** エディタから手動実行して、権限の承認と集計結果の確認をするための関数。 */
function testAggregate() {
  Logger.log(JSON.stringify(buildStats_(), null, 2));
}

function respond_(json, callback) {
  // callback は関数名として安全な文字だけを受け付ける（それ以外は普通の JSON を返す）
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$.]{0,63}$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function getStatsJson_() {
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const hit = cache.get(CACHE_KEY);
    if (hit) return hit;
  } catch (err) {
    cache = null; // キャッシュが使えなくても集計は続ける
  }
  const stats = buildStats_();
  const json = JSON.stringify(stats);
  if (cache && !stats.errors) {
    try {
      cache.put(CACHE_KEY, json, CACHE_SECONDS);
    } catch (err) {
      /* 保存できなくても続行する */
    }
  }
  return json;
}

/* ===================== 集計 ===================== */

function buildStats_() {
  const stats = { updatedAt: new Date().toISOString(), quiz: emptyQuiz_(), pred: emptyCounts_(PRED_CHOICES) };
  const errors = [];

  // クイズと予想は別々に読む。片方の設定が間違っていても、もう片方は表示できるようにする
  try {
    stats.quiz = aggregateQuiz_(readRows_(QUIZ_SPREADSHEET_ID, QUIZ_SHEET_NAME));
  } catch (err) {
    errors.push("クイズ: " + err.message);
  }
  try {
    stats.pred = aggregatePred_(readRows_(PRED_SPREADSHEET_ID || QUIZ_SPREADSHEET_ID, PRED_SHEET_NAME));
  } catch (err) {
    errors.push("予想: " + err.message);
  }

  if (errors.length > 0) stats.errors = errors;
  return stats;
}

/** シート全体を2次元配列で読む（1行目が見出し）。 */
function readRows_(spreadsheetId, sheetName) {
  const book = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error("スプレッドシートを開けません（ID が未設定です）");
  const sheet = book.getSheetByName(sheetName);
  if (!sheet) throw new Error("タブ「" + sheetName + "」が見つかりません");
  return sheet.getDataRange().getValues();
}

/**
 * クイズの集計。rows[0] が見出し。
 * 1行は「1人 × 1問」（その問題の列だけが埋まっている）。同じ名前 × 同じ問題は最新の行だけを数える。
 */
function aggregateQuiz_(rows) {
  const header = (rows[0] || []).map(normalize_);
  const nameCol = findColumn_(header, NAME_HEADER_KEYWORD);
  if (nameCol < 0) throw new Error("見出しに「" + NAME_HEADER_KEYWORD + "」を含む列がありません");
  const tsCol = findTimestampColumn_(header);

  // 問題番号 → 列番号。見出しに「第N問」を含む列を探す
  const questionCols = {};
  header.forEach(function (text, col) {
    const m = /第\s*(\d+)\s*問/.exec(text);
    if (!m || col === nameCol) return;
    const no = Number(m[1]);
    if (no >= 1 && no <= QUESTION_COUNT && !(no in questionCols)) questionCols[no] = col;
  });
  if (Object.keys(questionCols).length === 0) throw new Error("見出しに「第1問」などを含む列がありません");

  const latest = {}; // 問題番号 → { 回答者キー: {value, ts} }
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const who = respondentKey_(row[nameCol], r);
    const ts = timestampOf_(tsCol < 0 ? null : row[tsCol]);
    for (const no in questionCols) {
      const value = normalize_(row[questionCols[no]]).toUpperCase();
      if (QUIZ_CHOICES.indexOf(value) < 0) continue; // 空欄や想定外の値は数えない
      keepLatest_((latest[no] = latest[no] || {}), who, value, ts);
    }
  }

  const quiz = emptyQuiz_();
  for (const no in latest) quiz[no] = countValues_(latest[no], QUIZ_CHOICES);
  return quiz;
}

/** 予想の集計。同じ名前は最新の行だけを数える。 */
function aggregatePred_(rows) {
  const header = (rows[0] || []).map(normalize_);
  const nameCol = findColumn_(header, NAME_HEADER_KEYWORD);
  if (nameCol < 0) throw new Error("見出しに「" + NAME_HEADER_KEYWORD + "」を含む列がありません");
  const tsCol = findTimestampColumn_(header);

  let predCol = findColumn_(header, PRED_HEADER_KEYWORD);
  if (predCol < 0) {
    // キーワードで見つからなければ、タイムスタンプと名前以外の最初の列を予想の列とみなす
    predCol = header.findIndex(function (text, col) {
      return text !== "" && col !== nameCol && col !== tsCol;
    });
  }
  if (predCol < 0) throw new Error("予想の列が見つかりません");

  const latest = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const value = normalizePred_(row[predCol]);
    if (value === null) continue;
    keepLatest_(latest, respondentKey_(row[nameCol], r), value, timestampOf_(tsCol < 0 ? null : row[tsCol]));
  }
  return countValues_(latest, PRED_CHOICES);
}

/* ===================== 小さな部品 ===================== */

function emptyCounts_(choices) {
  const counts = {};
  choices.forEach(function (c) {
    counts[c] = 0;
  });
  counts.total = 0;
  return counts;
}

function emptyQuiz_() {
  const quiz = {};
  for (let no = 1; no <= QUESTION_COUNT; no++) quiz[String(no)] = emptyCounts_(QUIZ_CHOICES);
  return quiz;
}

/** 全角/半角のゆれと前後の空白をならした文字列にする。 */
function normalize_(value) {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 「3問」「３問」「3」（数値セルを含む）を "3問" にそろえる。選択肢にない値は null。 */
function normalizePred_(value) {
  const m = /^(\d+)\s*問?$/.exec(normalize_(value));
  if (!m) return null;
  const label = Number(m[1]) + "問";
  return PRED_CHOICES.indexOf(label) < 0 ? null : label;
}

function findColumn_(header, keyword) {
  return header.findIndex(function (text) {
    return text.indexOf(keyword) >= 0;
  });
}

function findTimestampColumn_(header) {
  return header.findIndex(function (text) {
    return text.indexOf("タイムスタンプ") >= 0 || text.toLowerCase().indexOf("timestamp") >= 0;
  });
}

/** 重複排除のキー。名前が空の行は他とまとめず、行ごとに別の人として数える。 */
function respondentKey_(name, rowIndex) {
  const text = normalize_(name);
  return text === "" ? "row:" + rowIndex : "name:" + text;
}

function timestampOf_(value) {
  return Object.prototype.toString.call(value) === "[object Date]" ? value.getTime() : NaN;
}

/**
 * その人の回答を「最新の行」で上書きする。
 * 基本は下の行ほど新しい。両方にタイムスタンプがあり、明らかに古い行のときだけ上書きしない
 * （シートを手で並べ替えた場合への備え）。
 */
function keepLatest_(map, who, value, ts) {
  const prev = map[who];
  if (prev && !isNaN(prev.ts) && !isNaN(ts) && ts < prev.ts) return;
  map[who] = { value: value, ts: ts };
}

function countValues_(latestByWho, choices) {
  const counts = emptyCounts_(choices);
  for (const who in latestByWho) {
    counts[latestByWho[who].value] += 1;
    counts.total += 1;
  }
  return counts;
}
