/**
 * Wedding-game 司会画面用の集計 API（Google Apps Script ウェブアプリ）
 *
 * Google フォームの回答が入るスプレッドシートを読み、選択肢ごとの「人数だけ」を JSON で返す。
 * 名前は集計の重複排除にだけ使い、レスポンスには一切含めない。
 *
 * 返す JSON:
 *   {
 *     "updatedAt": "2026-11-16T09:00:00.000Z",
 *     "quiz": { "1": {"A":3,"B":5,"C":1,"D":0,"total":9}, ... , "10": {...} },
 *     "pred": { "0問":0, "1問":2, ... , "5問":1, "total":9 }
 *   }
 *   シートが見つからないなど設定に問題があるときは "errors": ["..."] が付く（その分の人数は 0）。
 *
 * 呼び出し方:
 *   .../exec                          → 集計の JSON（司会画面は通常こちらを fetch する。誰でも読める）
 *   .../exec?callback=関数名           → JSONP（fetch が使えない環境向けの予備）
 *   .../exec?action=slides&key=司会キー → スライド一覧の JSON（司会キーが合うときだけ返す。下の「スライド一覧」を参照）
 *
 * 【秘密の値はコードに書かない】スライドの ID と司会キーは「スクリプト プロパティ」に置く
 * （プロジェクトの設定 → スクリプト プロパティ）。このファイルは公開リポジトリにも置かれるため。
 *   SLIDES_DECK_ID : Google スライドの ID（URL https://docs.google.com/presentation/d/【ここ】/edit）
 *   HOST_KEY       : 司会キー（16文字以上のランダムな英数字。setupHostKey を実行すると自動で作れる）
 *
 * スライド一覧を使うには、左の「サービス」から「Google Slides API」（識別子 Slides）を追加しておく。
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
const QUIZ_SHEET_NAME = "クイズ回答";

// 予想用フォームの回答が入るスプレッドシートの ID。
// クイズと同じスプレッドシート（タブ違い）なら空文字 "" のままでよい。
// 別のスプレッドシートなら、その ID を入れる。
const PRED_SPREADSHEET_ID = "";

// 予想の回答が入るタブ（シート）の名前。
const PRED_SHEET_NAME = "予想回答";

// 【将来用・現在は未使用】正解を書いておくタブの名前（A列: 問題番号 1〜10、B列: 正解 A/B/C/D）。
// 正解発表の機能を足すときにここから読む。いまはこのタブを読まないし、JSON にも含めない。
const ANSWER_SHEET_NAME = "正解";

// 見出し（1行目）から列を探すためのキーワード。列の並び順には依存しない。
const NAME_HEADER_KEYWORD = "名前"; // 「お名前」の列
const PRED_HEADER_KEYWORD = "何問"; // 「新郎新婦の答えは何問そろいますか？」の列
// クイズの列は、見出しに「第1問」〜「第10問」を含む列を自動で探す。

const QUESTION_COUNT = 10;
const QUIZ_CHOICES = ["A", "B", "C", "D"];
const PRED_CHOICES = ["0問", "1問", "2問", "3問", "4問", "5問"];

// 集計結果をキャッシュする秒数。司会画面は約3秒ごとに取りに来る。
const CACHE_SECONDS = 2;
const CACHE_KEY = "wg_stats_v2";

/* ---- スライド一覧（?action=slides）用。値そのものはスクリプト プロパティに置く ---- */
const PROP_DECK_ID = "SLIDES_DECK_ID";
const PROP_HOST_KEY = "HOST_KEY";
const HOST_KEY_MIN_LENGTH = 16;

// スライドの並びと種類（どれがグラフのスライドか）をキャッシュする秒数。
// スライドを並べ替えたり文字を直したりしたあと、この秒数以内に反映される。
const SLIDE_LIST_CACHE_SECONDS = 60;
const SLIDE_LIST_CACHE_KEY = "wg_slide_list_v1";

// スライド画像の URL をキャッシュする秒数。Slides API が返す URL は約30分で切れるので、それより短くする。
// スライドの見た目を直したあとは、司会画面で R キー（refresh=all）を押すと作り直す。
const THUMB_CACHE_SECONDS = 1200;
const THUMB_CACHE_PREFIX = "wg_thumb_v1_";
const THUMB_SIZE = "LARGE"; // 幅 1600px

// 1回の呼び出しで画像作りに使う時間の上限（ミリ秒）。超えた分は imageUrl: null で返し、
// 司会画面がもう一度取りに来たときに続きを作る（応答が遅くなりすぎないようにするため）。
const THUMB_BUDGET_MS = 20000;

/* ===================== ウェブアプリの入口 ===================== */

function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action === "slides") return respond_(JSON.stringify(buildSlidesResponse_(params)), params.callback);
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

/* ===================== スライド一覧（?action=slides&key=司会キー） ===================== */

/*
 * 司会画面（host.html）が Google スライドを1枚ずつ画像で映すための一覧を返す。
 *
 *   {
 *     "updatedAt": "…",
 *     "slides": [
 *       { "objectId": "p",   "kind": "slide",      "imageUrl": "https://lh7-…googleusercontent.com/…" },
 *       { "objectId": "g12", "kind": "quizCounts", "imageUrl": null, "question": 5 },
 *       { "objectId": "g34", "kind": "predCounts", "imageUrl": null }
 *     ],
 *     "pending": 0            // まだ画像を作れていない枚数。0 より大きければ、少し待ってもう一度呼ぶ
 *   }
 *   失敗時は { "error": "unauthorized" | "not_configured" | "deck_error", "message": "…" }
 *
 * kind の決め方（スライド上の文字で判定する。ページ番号や並び順には依存しない）:
 *   quizCounts … 「第N問 回答数」のスライド。司会画面は画像の代わりに第N問の回答数グラフを映す
 *   predCounts … 「予想 回答数」のスライド。以心伝心ゲーム予想の回答数グラフを映す
 *   slide      … それ以外。スライドの画像をそのまま映す
 *   詳しい条件は classifySlideTexts_ を参照。
 *
 * 守っていること:
 *   - スライドの ID・スライド上の文字（正解を含む）は返さない。返すのは種類・問題番号・画像の URL だけ。
 *   - 画像の URL は Slides API のサムネイル（googleusercontent.com）で、スライドの ID を含まない。
 *     スライド自体は「限定公開」のままでよい（ウェブ公開やリンク共有は不要）。
 *   - 司会キーが合わない呼び出しには何も返さない。
 *
 * 追加のパラメータ:
 *   refresh=all            キャッシュを使わず、一覧も画像も作り直す（スライドを直した直後に使う）
 *   refresh=objectId,…     指定したスライドの画像だけ作り直す（画像の URL が切れて読めなかったとき）
 */
function buildSlidesResponse_(params) {
  let hostKey = "";
  let deckId = "";
  try {
    const props = PropertiesService.getScriptProperties();
    hostKey = String(props.getProperty(PROP_HOST_KEY) || "").trim();
    deckId = String(props.getProperty(PROP_DECK_ID) || "").trim();
  } catch (err) {
    return { error: "not_configured", message: "スクリプト プロパティを読めません" };
  }
  // キーが未設定・短すぎるときは、誰にも返さない（空のキーで通ってしまわないように）
  if (hostKey.length < HOST_KEY_MIN_LENGTH) {
    return { error: "not_configured", message: "スクリプト プロパティ " + PROP_HOST_KEY + " が未設定か、" + HOST_KEY_MIN_LENGTH + "文字未満です" };
  }
  if (!keyMatches_(params.key, hostKey)) return { error: "unauthorized", message: "司会キーが違います" };
  if (!deckId) return { error: "not_configured", message: "スクリプト プロパティ " + PROP_DECK_ID + " が未設定です" };

  const refresh = String(params.refresh || "");
  const refreshAll = refresh === "all" || refresh === "1";
  const refreshIds = refreshAll ? [] : refresh.split(",").filter(String);

  let list;
  try {
    list = getSlideList_(deckId, refreshAll);
  } catch (err) {
    return { error: "deck_error", message: "スライドを開けません: " + hideId_(err && err.message, deckId) };
  }

  const result = attachThumbnails_(deckId, list, refreshAll, refreshIds);
  const response = { updatedAt: new Date().toISOString(), slides: result.slides, pending: result.pending };
  if (result.errors.length > 0) response.errors = result.errors;
  return response;
}

/** 司会キーの照合。途中で打ち切らず、最後まで比べてから結果を返す。 */
function keyMatches_(given, expected) {
  const a = String(given === null || given === undefined ? "" : given);
  const b = String(expected);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

/** エラー文にスライドの ID が混ざっていたら伏せる（エラー文は司会画面に表示されるため）。 */
function hideId_(message, deckId) {
  return String(message || "不明なエラー").split(deckId).join("（ID）");
}

function scriptCache_() {
  try {
    return CacheService.getScriptCache();
  } catch (err) {
    return null; // キャッシュが使えなくても続ける
  }
}

/** スライドの並びと種類。[{ objectId, kind, question? }]（スキップに設定したスライドは含めない）。 */
function getSlideList_(deckId, skipCache) {
  const cache = scriptCache_();
  if (cache && !skipCache) {
    try {
      const hit = cache.get(SLIDE_LIST_CACHE_KEY);
      if (hit) return JSON.parse(hit);
    } catch (err) {
      /* 読めなければ作り直す */
    }
  }
  const list = readSlideList_(deckId);
  if (cache) {
    try {
      cache.put(SLIDE_LIST_CACHE_KEY, JSON.stringify(list), SLIDE_LIST_CACHE_SECONDS);
    } catch (err) {
      /* 保存できなくても続行する */
    }
  }
  return list;
}

function readSlideList_(deckId) {
  const list = [];
  SlidesApp.openById(deckId).getSlides().forEach(function (slide) {
    if (isSkipped_(slide)) return;
    const found = classifySlideTexts_(collectSlideTexts_(slide));
    const item = { objectId: slide.getObjectId(), kind: found.kind };
    if (found.kind === "quizCounts") item.question = found.question;
    list.push(item);
  });
  return list;
}

/** スライドショーで「スキップ」に設定されたスライドか。 */
function isSkipped_(slide) {
  try {
    return slide.isSkipped() === true;
  } catch (err) {
    return false;
  }
}

/** スライド上の文字を、テキストボックス（図形）・表のセルごとに集める。グループの中も見る。スピーカーノートは見ない。 */
function collectSlideTexts_(slide) {
  const texts = [];
  slide.getPageElements().forEach(function (element) {
    collectElementTexts_(element, texts);
  });
  return texts;
}

function collectElementTexts_(element, texts) {
  try {
    const type = element.getPageElementType();
    if (type === SlidesApp.PageElementType.SHAPE) {
      texts.push(element.asShape().getText().asString());
    } else if (type === SlidesApp.PageElementType.TABLE) {
      const table = element.asTable();
      for (let r = 0; r < table.getNumRows(); r++) {
        for (let c = 0; c < table.getNumColumns(); c++) {
          try {
            texts.push(table.getCell(r, c).getText().asString());
          } catch (err) {
            /* 結合されたセルなど、文字を読めないセルは飛ばす */
          }
        }
      }
    } else if (type === SlidesApp.PageElementType.GROUP) {
      element.asGroup().getChildren().forEach(function (child) {
        collectElementTexts_(child, texts);
      });
    }
  } catch (err) {
    /* 文字を読めない要素は飛ばす */
  }
}

/** 判定用に、全角/半角・大文字/小文字のゆれをならし、空白と改行をすべて取り除く。 */
function normalizeMarker_(text) {
  return String(text === null || text === undefined ? "" : text).normalize("NFKC").toUpperCase().replace(/\s+/g, "");
}

// 「第5問 回答」「第5問の回答」「Q5 回答」「Q5：回答」など（空白は取り除いたあとで照合する）
const QUIZ_MARKER_RE = /(?:第(\d{1,2})問目?|Q\.?(\d{1,2}))[-‐–—―:・|\/]*の?回答/;
// スライド上の問題番号の書き方すべて（「第5問」「Q5」）
const QUESTION_MENTION_RE = /第(\d{1,2})問|Q\.?(\d{1,2})(?!\d)/g;

/**
 * スライドの種類を、スライド上の文字（テキストボックス・表のセルごとの配列）から決める。
 * 文字は normalizeMarker_ でならしてから比べるので、全角数字（第５問）や空白・改行の有無は問わない。
 *
 * 1. quizCounts: スライドのどこかに「回答数」があり、かつ1つのテキストボックスの中に
 *    「第N問 回答」または「QN 回答」（N は 1〜10）がある。例: 「第5問 回答数」「Q5 回答数」「第5問の回答数」
 * 2. predCounts: スライドのどこかに「回答数」と「予想」がある。例: 「予想 回答数」「以心伝心ゲーム予想 回答数」
 * 3. quizCounts（ゆるい条件）: スライドのどこかに「回答数」があり、「正解」がなく、
 *    問題番号（第N問 / QN）がちょうど1種類だけ書かれている。例: 「Q5」と「回答数」が別のテキストボックス
 * 4. それ以外は slide。
 *
 * 「第5問 正解」「Q5（問題）」のスライドには「回答数」がないので slide になる。
 */
function classifySlideTexts_(texts) {
  const boxes = (texts || []).map(normalizeMarker_).filter(String);
  const whole = boxes.join("\n");
  if (whole.indexOf("回答数") < 0) return { kind: "slide" };

  for (let i = 0; i < boxes.length; i++) {
    const m = QUIZ_MARKER_RE.exec(boxes[i]);
    const no = m ? Number(m[1] || m[2]) : 0;
    if (no >= 1 && no <= QUESTION_COUNT) return { kind: "quizCounts", question: no };
  }

  if (whole.indexOf("予想") >= 0) return { kind: "predCounts" };

  if (whole.indexOf("正解") < 0) {
    const mentioned = {};
    boxes.forEach(function (box) {
      let m;
      QUESTION_MENTION_RE.lastIndex = 0;
      while ((m = QUESTION_MENTION_RE.exec(box)) !== null) {
        const no = Number(m[1] || m[2]);
        if (no >= 1 && no <= QUESTION_COUNT) mentioned[no] = true;
      }
    });
    const numbers = Object.keys(mentioned);
    if (numbers.length === 1) return { kind: "quizCounts", question: Number(numbers[0]) };
  }
  return { kind: "slide" };
}

/**
 * 画像を映すスライド（kind: "slide"）に imageUrl を付ける。グラフのスライドは画像を使わないので作らない。
 * URL はキャッシュし、無いものだけ Slides API で作る。時間の上限を超えたら残りは null（pending）で返す。
 */
function attachThumbnails_(deckId, list, refreshAll, refreshIds) {
  const cache = scriptCache_();
  const keyOf = function (item) {
    return THUMB_CACHE_PREFIX + item.objectId;
  };
  const imageItems = list.filter(function (item) {
    return item.kind === "slide";
  });
  let cached = {};
  if (cache && !refreshAll && imageItems.length > 0) {
    try {
      cached = cache.getAll(imageItems.map(keyOf)) || {};
    } catch (err) {
      cached = {};
    }
  }

  const started = Date.now();
  const fresh = {};
  const errors = [];
  let stopped = false;
  let pending = 0;

  const slides = list.map(function (item) {
    const out = { objectId: item.objectId, kind: item.kind, imageUrl: null };
    if (item.kind === "quizCounts") out.question = item.question;
    if (item.kind !== "slide") return out;

    let url = refreshIds.indexOf(item.objectId) >= 0 ? "" : cached[keyOf(item)] || "";
    if (!url && !stopped) {
      if (Date.now() - started > THUMB_BUDGET_MS) {
        stopped = true;
      } else {
        try {
          url = fetchThumbnailUrl_(deckId, item.objectId);
          fresh[keyOf(item)] = url;
        } catch (err) {
          // 回数制限などで失敗したら、この回はここでやめる（司会画面が少し待ってから取り直す）
          stopped = true;
          errors.push("スライド画像を作れません: " + hideId_(err && err.message, deckId));
        }
      }
    }
    if (url) out.imageUrl = url;
    else pending += 1;
    return out;
  });

  if (cache && Object.keys(fresh).length > 0) {
    try {
      cache.putAll(fresh, THUMB_CACHE_SECONDS);
    } catch (err) {
      /* 保存できなくても続行する */
    }
  }
  return { slides: slides, pending: pending, errors: errors };
}

/** Slides API（拡張サービス）でスライド1枚の画像 URL を作る。URL は約30分有効で、スライドの ID を含まない。 */
function fetchThumbnailUrl_(deckId, pageObjectId) {
  if (typeof Slides === "undefined") {
    throw new Error("拡張サービス「Google Slides API」が追加されていません（エディタ左の「サービス」から追加する）");
  }
  const thumbnail = Slides.Presentations.Pages.getThumbnail(deckId, pageObjectId, {
    "thumbnailProperties.thumbnailSize": THUMB_SIZE,
    "thumbnailProperties.mimeType": "PNG",
  });
  if (!thumbnail || !thumbnail.contentUrl) throw new Error("画像の URL が返りませんでした");
  return thumbnail.contentUrl;
}

/* ===================== スライド一覧のセットアップ用（エディタから手動実行する） ===================== */

/**
 * 司会キー（HOST_KEY）がまだ無ければ、ランダムな値を作ってスクリプト プロパティに保存する。
 * 実行ログにキーが出るので、依頼元へ非公開の手段で伝える。すでにあるときは作り直さない。
 */
function setupHostKey() {
  const props = PropertiesService.getScriptProperties();
  let key = String(props.getProperty(PROP_HOST_KEY) || "").trim();
  if (key.length < HOST_KEY_MIN_LENGTH) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "").slice(0, 40);
    props.setProperty(PROP_HOST_KEY, key);
    Logger.log("HOST_KEY を新しく作りました: " + key);
  } else {
    Logger.log("HOST_KEY は設定済みです（作り直していません）: " + key);
  }
}

/**
 * 権限の承認と、スライドの種類の判定結果の確認をするための関数。
 * 実行ログに「ページ番号: 種類 | スライド上の文字の先頭」を出す（このログはエディタでしか見えない）。
 * 最後に画像を1枚だけ作って、Slides API が使えることを確かめる。
 */
function testSlides() {
  const props = PropertiesService.getScriptProperties();
  const deckId = String(props.getProperty(PROP_DECK_ID) || "").trim();
  if (!deckId) throw new Error("スクリプト プロパティ " + PROP_DECK_ID + " が未設定です");
  if (String(props.getProperty(PROP_HOST_KEY) || "").trim().length < HOST_KEY_MIN_LENGTH) {
    Logger.log("注意: " + PROP_HOST_KEY + " が未設定か短すぎます（setupHostKey を実行してください）");
  }

  let firstImageSlide = "";
  SlidesApp.openById(deckId).getSlides().forEach(function (slide, i) {
    const texts = collectSlideTexts_(slide);
    const found = classifySlideTexts_(texts);
    const skipped = isSkipped_(slide);
    const label = found.kind === "quizCounts" ? "quizCounts 第" + found.question + "問" : found.kind;
    const head = texts
      .map(function (t) {
        return String(t).replace(/\s+/g, " ").trim();
      })
      .filter(String)
      .join(" / ")
      .slice(0, 40);
    Logger.log(i + 1 + ": " + (skipped ? "（スキップ）" : label) + " | " + head);
    if (!firstImageSlide && found.kind === "slide" && !skipped) firstImageSlide = slide.getObjectId();
  });

  if (firstImageSlide) {
    fetchThumbnailUrl_(deckId, firstImageSlide);
    Logger.log("スライド画像の作成: OK");
  }
}
