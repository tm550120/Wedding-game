/**
 * Wedding-game 用の API（Google Apps Script ウェブアプリ）
 *
 * 1つの URL（…/exec）で、次のものを JSON で返す。
 *
 *   誰でも読める（名前・正解・選択肢ごとの人数は含めない）
 *     …/exec                → 回答した「人数だけ」と受付状態
 *         { "updatedAt": "…", "quiz": { "1": {"total": 9}, …, "10": {"total": 0} }, "pred": {"total": 9},
 *           "state": { "open": "q5", "lastClosed": null, "done": ["q1","q2"], "rev": 12, "updatedAt": "…" } }
 *     …/exec?action=state   → 受付状態だけ（ゲストの回答ページが2〜3秒ごとに読む）
 *         { "open": "q5" | "pred" | null, "lastClosed": "q4" | null, "done": [...], "rev": 12, "updatedAt": "…" }
 *
 *   司会キーが合うときだけ（&key=司会キー）
 *     …/exec?action=setOpen&target=q5|pred|none|idle → 受付の切り替え。{ "ok": true, "state": {…} }
 *     …/exec?action=answers                          → 正解の一覧。{ "answers": { "1": "B", … }, "missing": [3] }
 *     …/exec?action=slides                           → スライド一覧（下の「スライド一覧」を参照）
 *     …/exec?action=reset                            → 受付の記録をすべて消す（リハーサルのあと）
 *
 *   どれも ?callback=関数名 を付けると JSONP で返す（fetch が使えない環境向けの予備）。
 *
 * 【受付状態と「受付時間」】
 *   司会画面が setOpen を呼ぶたびに、問題ごとの「受付を開けた時刻・閉じた時刻」を記録する。
 *   人数に数えるのは、タイムスタンプが受付時間内（閉じたあと WINDOW_GRACE_MS までを含む）の行だけ。
 *   受付前・締め切り後に Google フォームへ直接送られた回答は、シートには残るが数えない。
 *
 * 【秘密の値はコードに書かない】スライドの ID と司会キーは「スクリプト プロパティ」に置く
 * （プロジェクトの設定 → スクリプト プロパティ）。このファイルは公開リポジトリにも置かれるため。
 *   SLIDES_DECK_ID : Google スライドの ID（URL https://docs.google.com/presentation/d/【ここ】/edit）
 *   HOST_KEY       : 司会キー（16文字以上のランダムな英数字。setupHostKey を実行すると自動で作れる）
 * 正解は、クイズのスプレッドシートの「正解」タブに書く（A列: 問題番号 1〜10、B列: 正解 A/B/C/D）。
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
const QUIZ_SHEET_NAME = "フォームの回答 1";

// 予想用フォームの回答が入るスプレッドシートの ID。
// クイズと同じスプレッドシート（タブ違い）なら空文字 "" のままでよい。
// 別のスプレッドシートなら、その ID を入れる。
const PRED_SPREADSHEET_ID = "";

// 予想の回答が入るタブ（シート）の名前。
const PRED_SHEET_NAME = "フォームの回答 2";

// 正解を書いておくタブの名前（クイズのスプレッドシートの中。A列: 問題番号 1〜10、B列: 正解 A/B/C/D）。
// 司会キーが合う ?action=answers にだけ返す。集計や受付状態の JSON には含めない。
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
const CACHE_KEY = "wg_stats_v3";

/* ---- 受付状態（どの問題の回答を受け付けているか） ---- */
const GATE_PROP = "WG_GATE"; // 本体。スクリプト プロパティに JSON で置く（司会画面の setOpen だけが書き換える）
const GATE_CACHE_KEY = "wg_gate_v1"; // 公開用の受付状態の写し（ゲストが読むたびにプロパティを読まないため）
const GATE_CACHE_SECONDS = 300;
// 締め切ったあと、この時間（ミリ秒）までに記録された回答は数える（送信の途中だった人の分）
const WINDOW_GRACE_MS = 5000;
// 受付を開けた時刻より、この時間（ミリ秒）だけ早い回答も数える（時計のずれの分）
const WINDOW_EARLY_MS = 1000;
// 1つの問題につき覚えておく受付時間の数（開け直しを繰り返したときは、古い2つを1つにまとめる）
const MAX_WINDOWS = 8;

/* ---- スライド一覧（?action=slides）用。値そのものはスクリプト プロパティに置く ---- */
const PROP_DECK_ID = "SLIDES_DECK_ID";
const PROP_HOST_KEY = "HOST_KEY";
const HOST_KEY_MIN_LENGTH = 16;

// スライドの並びと種類（どれが問題のスライドか）をキャッシュする秒数。
// スライドを並べ替えたり文字を直したりしたあと、この秒数以内に反映される。
const SLIDE_LIST_CACHE_SECONDS = 60;
const SLIDE_LIST_CACHE_KEY = "wg_slide_list_v2";

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
  // ゲスト全員が2〜3秒ごとに読むので、いちばん先に返す
  if (params.action === "state") return respond_(getPublicStateJson_(), params.callback);
  if (params.action === "setOpen") return respond_(JSON.stringify(handleSetOpen_(params)), params.callback);
  if (params.action === "answers") return respond_(JSON.stringify(buildAnswersResponse_(params)), params.callback);
  if (params.action === "reset") return respond_(JSON.stringify(handleReset_(params)), params.callback);
  if (params.action === "slides") return respond_(JSON.stringify(buildSlidesResponse_(params)), params.callback);
  return respond_(getStatsJson_(), params.callback);
}

/**
 * エディタから手動実行して、権限の承認と集計結果の確認をするための関数。
 * ログには選択肢ごとの人数も出る（ウェブアプリが返すのは合計だけ）。受付時間外の回答は数えない。
 */
function testAggregate() {
  Logger.log(JSON.stringify(buildStats_(readGate_()), null, 2));
}

function respond_(json, callback) {
  // callback は関数名として安全な文字だけを受け付ける（それ以外は普通の JSON を返す）
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$.]{0,63}$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/** 公開する集計（人数の合計だけ）に、いまの受付状態を付けて返す。 */
function getStatsJson_() {
  return '{"state":' + getPublicStateJson_() + "," + getTotalsJson_().slice(1);
}

function getTotalsJson_() {
  const cache = scriptCache_();
  if (cache) {
    try {
      const hit = cache.get(CACHE_KEY);
      if (hit) return hit;
    } catch (err) {
      /* 読めなければ集計し直す */
    }
  }
  const stats = toPublicStats_(buildStats_(readGate_()));
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

/** 選択肢ごとの人数を落として、合計だけにする（多数派が分かると答えのヒントになるため公開しない）。 */
function toPublicStats_(stats) {
  const out = { updatedAt: stats.updatedAt, quiz: {}, pred: { total: stats.pred.total } };
  for (const no in stats.quiz) out.quiz[no] = { total: stats.quiz[no].total };
  if (stats.errors) out.errors = stats.errors;
  return out;
}

/* ===================== 集計 ===================== */

/** gate.windows（問題ごとの受付時間）の中に記録された回答だけを数える。 */
function buildStats_(gate) {
  const stats = { updatedAt: new Date().toISOString(), quiz: emptyQuiz_(), pred: emptyCounts_(PRED_CHOICES) };
  const errors = [];

  // クイズと予想は別々に読む。片方の設定が間違っていても、もう片方は表示できるようにする
  try {
    stats.quiz = aggregateQuiz_(readRows_(QUIZ_SPREADSHEET_ID, QUIZ_SHEET_NAME), gate.windows);
  } catch (err) {
    errors.push("クイズ: " + err.message);
  }
  try {
    stats.pred = aggregatePred_(readRows_(PRED_SPREADSHEET_ID || QUIZ_SPREADSHEET_ID, PRED_SHEET_NAME), gate.windows);
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
 * クイズの有効な回答を集める。rows[0] が見出し。返すのは 問題番号 → { 回答者キー: {value, ts} }。
 * 1行は「1人 × 1問」（その問題の列だけが埋まっている）。その問題の受付時間内の行だけを対象にし、
 * 同じ名前 × 同じ問題は最新の行だけを残す（締め切り後の送り直しで、受付中の回答が上書きされることはない）。
 */
function collectQuiz_(rows, windows) {
  const header = (rows[0] || []).map(normalize_);
  const nameCol = findColumn_(header, NAME_HEADER_KEYWORD);
  if (nameCol < 0) throw new Error("見出しに「" + NAME_HEADER_KEYWORD + "」を含む列がありません");
  const tsCol = requireTimestampColumn_(header);

  // 問題番号 → 列番号。見出しに「第N問」を含む列を探す
  const questionCols = {};
  header.forEach(function (text, col) {
    const m = /第\s*(\d+)\s*問/.exec(text);
    if (!m || col === nameCol) return;
    const no = Number(m[1]);
    if (no >= 1 && no <= QUESTION_COUNT && !(no in questionCols)) questionCols[no] = col;
  });
  if (Object.keys(questionCols).length === 0) throw new Error("見出しに「第1問」などを含む列がありません");

  const latest = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const who = respondentKey_(row[nameCol], r);
    const ts = timestampOf_(row[tsCol]);
    for (const no in questionCols) {
      const value = normalize_(row[questionCols[no]]).toUpperCase();
      if (QUIZ_CHOICES.indexOf(value) < 0) continue; // 空欄や想定外の値は数えない
      if (!inWindows_(ts, (windows || {})["q" + no])) continue; // 受付時間外
      keepLatest_((latest[no] = latest[no] || {}), who, value, ts);
    }
  }
  return latest;
}

function aggregateQuiz_(rows, windows) {
  const latest = collectQuiz_(rows, windows);
  const quiz = emptyQuiz_();
  for (const no in latest) quiz[no] = countValues_(latest[no], QUIZ_CHOICES);
  return quiz;
}

/** 予想の集計。受付時間内の行だけを対象にし、同じ名前は最新の行だけを数える。 */
function aggregatePred_(rows, windows) {
  const header = (rows[0] || []).map(normalize_);
  const nameCol = findColumn_(header, NAME_HEADER_KEYWORD);
  if (nameCol < 0) throw new Error("見出しに「" + NAME_HEADER_KEYWORD + "」を含む列がありません");
  const tsCol = requireTimestampColumn_(header);

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
    const ts = timestampOf_(row[tsCol]);
    if (value === null || !inWindows_(ts, (windows || {}).pred)) continue;
    keepLatest_(latest, respondentKey_(row[nameCol], r), value, ts);
  }
  return countValues_(latest, PRED_CHOICES);
}

/**
 * 正解数のランキング（受付時間内の回答だけで数える）。[{ name, correct, answered }] を正解数の多い順に返す。
 * 名前を含むので、ウェブアプリからは返さない。エディタの logRanking からだけ使う。
 */
function rankQuiz_(rows, windows, answers) {
  const latest = collectQuiz_(rows, windows);
  const byWho = {};
  for (const no in latest) {
    for (const who in latest[no]) {
      const name = who.replace(/^name:/, "").replace(/^row:(\d+)$/, "（名前なし・$1行目）");
      const entry = (byWho[who] = byWho[who] || { name: name, correct: 0, answered: 0 });
      entry.answered += 1;
      if (latest[no][who].value === answers[no]) entry.correct += 1;
    }
  }
  return Object.keys(byWho)
    .map(function (who) {
      return byWho[who];
    })
    .sort(function (a, b) {
      return b.correct - a.correct || a.name.localeCompare(b.name);
    });
}

/** エディタから手動実行する。正解数のランキングを実行ログに出す（景品の順位決め用。このログはエディタでしか見えない）。 */
function logRanking() {
  const ranking = rankQuiz_(readRows_(QUIZ_SPREADSHEET_ID, QUIZ_SHEET_NAME), readGate_().windows, readAnswerKey_());
  ranking.forEach(function (entry, i) {
    Logger.log(i + 1 + ". " + entry.name + "  正解 " + entry.correct + " / 回答 " + entry.answered);
  });
  if (ranking.length === 0) Logger.log("受付時間内の回答がありません");
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

/** タイムスタンプの列。無いと受付時間内の回答かどうかを判定できないので、エラーにする。 */
function requireTimestampColumn_(header) {
  const col = header.findIndex(function (text) {
    return text.indexOf("タイムスタンプ") >= 0 || text.toLowerCase().indexOf("timestamp") >= 0;
  });
  if (col < 0) throw new Error("見出しに「タイムスタンプ」の列がありません（受付時間内の回答か判定できません）");
  return col;
}

/** その時刻が、受付時間 [[開けた時刻, 閉じた時刻 | null], …] のどれかに入っているか。時刻が不明な行は入っていない扱い。 */
function inWindows_(ts, list) {
  if (isNaN(ts) || !list) return false;
  return list.some(function (w) {
    return ts >= w[0] - WINDOW_EARLY_MS && (w[1] === null || ts <= w[1] + WINDOW_GRACE_MS);
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

/* ===================== 受付状態（?action=state / setOpen / reset） ===================== */

/*
 * 受付状態の本体（スクリプト プロパティ WG_GATE）:
 *   { open, lastClosed, rev, updatedAt, windows: { "q5": [[開けた時刻ms, 閉じた時刻ms | null], …], "pred": […] } }
 * 公開する形（publicState_）:
 *   open       … いま回答を受け付けている対象（"q1"〜"q10" / "pred"）。無ければ null
 *   lastClosed … 直前に締め切った対象。ゲストの画面に「締め切りました」と出す。待ち受けに戻すと null
 *   done       … 一度でも受付を開けて、いまは閉じている対象の一覧（司会画面が「締め切り済み」と分かるように）
 *   rev        … 状態が変わるたびに 1 増える番号
 * 受付時間の時刻そのものは公開しない。
 */

function isTarget_(target) {
  return target === "pred" || /^q([1-9]|10)$/.test(target);
}

function emptyGate_() {
  return { open: null, lastClosed: null, rev: 0, updatedAt: null, windows: {} };
}

function readGate_() {
  const gate = emptyGate_();
  let saved = null;
  try {
    saved = JSON.parse(PropertiesService.getScriptProperties().getProperty(GATE_PROP) || "null");
  } catch (err) {
    saved = null; // 読めない・壊れているときは「何も受け付けていない」として扱う
  }
  if (!saved || typeof saved !== "object") return gate;
  if (isTarget_(saved.open)) gate.open = saved.open;
  if (isTarget_(saved.lastClosed)) gate.lastClosed = saved.lastClosed;
  gate.rev = Number(saved.rev) || 0;
  gate.updatedAt = typeof saved.updatedAt === "string" ? saved.updatedAt : null;
  const windows = saved.windows && typeof saved.windows === "object" ? saved.windows : {};
  Object.keys(windows).forEach(function (target) {
    if (!isTarget_(target) || !Array.isArray(windows[target])) return;
    gate.windows[target] = windows[target]
      .filter(function (w) {
        return Array.isArray(w) && typeof w[0] === "number";
      })
      .map(function (w) {
        return [w[0], typeof w[1] === "number" ? w[1] : null];
      });
  });
  return gate;
}

function publicState_(gate) {
  const done = Object.keys(gate.windows).filter(function (target) {
    return target !== gate.open && gate.windows[target].length > 0;
  });
  return { open: gate.open, lastClosed: gate.lastClosed, done: done, rev: gate.rev, updatedAt: gate.updatedAt };
}

function getPublicStateJson_() {
  const cache = scriptCache_();
  if (cache) {
    try {
      const hit = cache.get(GATE_CACHE_KEY);
      if (hit) return hit;
    } catch (err) {
      /* 読めなければプロパティから作る */
    }
  }
  const json = JSON.stringify(publicState_(readGate_()));
  if (cache) {
    try {
      cache.put(GATE_CACHE_KEY, json, GATE_CACHE_SECONDS);
    } catch (err) {
      /* 保存できなくても続行する */
    }
  }
  return json;
}

/** 受付状態を保存し、キャッシュ（公開用の写しと集計）を新しくする。 */
function writeGate_(gate) {
  gate.rev += 1;
  gate.updatedAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(GATE_PROP, JSON.stringify(gate));
  const cache = scriptCache_();
  if (!cache) return;
  try {
    cache.remove(CACHE_KEY);
    cache.put(GATE_CACHE_KEY, JSON.stringify(publicState_(gate)), GATE_CACHE_SECONDS);
  } catch (err) {
    try {
      cache.remove(GATE_CACHE_KEY); // 古い写しが残らないようにする
    } catch (err2) {
      /* どちらもできなければ、写しは GATE_CACHE_SECONDS 後に消える */
    }
  }
}

/** 同時に2つの切り替えが来ても記録が壊れないよう、1つずつ処理する。 */
function withLock_(fn) {
  let lock = null;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(5000);
  } catch (err) {
    lock = null; // ロックを取れなくても切り替えは行う（司会画面は1つだけの想定）
  }
  try {
    return fn();
  } finally {
    if (lock) {
      try {
        lock.releaseLock();
      } catch (err) {
        /* 何もしない */
      }
    }
  }
}

/**
 * 受付を切り替える。
 *   "q1"〜"q10" / "pred" … その対象の受付を開ける（ほかに開いているものは閉じる）
 *   "none"              … 開いている受付を閉じる（ゲストには「締め切りました」と出る）
 *   "idle"              … 閉じたうえで、「締め切りました」も消して待ち受けに戻す
 * すでにその状態なら何も変えない（同じ呼び出しを繰り返しても、受付時間は増えない）。
 */
function setOpen_(target) {
  return withLock_(function () {
    const gate = readGate_();
    const now = Date.now();
    const wanted = isTarget_(target) ? target : null;
    let changed = false;

    if (gate.open && gate.open !== wanted) {
      const list = gate.windows[gate.open] || [];
      if (list.length > 0 && list[list.length - 1][1] === null) list[list.length - 1][1] = now;
      gate.lastClosed = gate.open;
      gate.open = null;
      changed = true;
    }
    if (wanted && gate.open !== wanted) {
      const list = (gate.windows[wanted] = gate.windows[wanted] || []);
      list.push([now, null]);
      if (list.length > MAX_WINDOWS) list.splice(0, 2, [list[0][0], list[1][1]]);
      gate.open = wanted;
      gate.lastClosed = null;
      changed = true;
    }
    if (target === "idle" && gate.lastClosed) {
      gate.lastClosed = null;
      changed = true;
    }
    if (changed) writeGate_(gate);
    return gate;
  });
}

function handleSetOpen_(params) {
  const denied = authorize_(params);
  if (denied) return denied;
  const target = String(params.target || "");
  if (!isTarget_(target) && target !== "none" && target !== "idle") {
    return { error: "bad_target", message: "target は q1〜q10 / pred / none / idle のどれかです" };
  }
  return { ok: true, state: publicState_(setOpen_(target)) };
}

/** 受付の記録（開けた・閉じた時刻）をすべて消す。リハーサルの回答を本番で数えないようにするため。 */
function resetGate_() {
  return withLock_(function () {
    const gate = emptyGate_();
    gate.rev = readGate_().rev; // 番号は戻さない（司会画面が古い状態と取り違えないように）
    writeGate_(gate);
    return gate;
  });
}

function handleReset_(params) {
  const denied = authorize_(params);
  if (denied) return denied;
  return { ok: true, state: publicState_(resetGate_()) };
}

/** エディタから手動実行する。リハーサルのあと、本番の前に1回実行する（シートの回答は消えない。数えなくなるだけ）。 */
function resetGame() {
  Logger.log("受付の記録を消しました: " + JSON.stringify(publicState_(resetGate_())));
}

/* ===================== 司会キーの確認 ===================== */

/** 司会キーが合っていれば null、合っていなければ返すべきエラーを返す。 */
function authorize_(params) {
  let hostKey = "";
  try {
    hostKey = String(PropertiesService.getScriptProperties().getProperty(PROP_HOST_KEY) || "").trim();
  } catch (err) {
    return { error: "not_configured", message: "スクリプト プロパティを読めません" };
  }
  // キーが未設定・短すぎるときは、誰にも返さない（空のキーで通ってしまわないように）
  if (hostKey.length < HOST_KEY_MIN_LENGTH) {
    return { error: "not_configured", message: "スクリプト プロパティ " + PROP_HOST_KEY + " が未設定か、" + HOST_KEY_MIN_LENGTH + "文字未満です" };
  }
  if (!keyMatches_(params.key, hostKey)) return { error: "unauthorized", message: "司会キーが違います" };
  return null;
}

/* ===================== 正解（?action=answers&key=司会キー） ===================== */

/** 「正解」タブを読む。問題番号 → "A"〜"D"。A列に 1〜10 の数字がない行（見出しなど）は飛ばす。 */
function readAnswerKey_() {
  const answers = {};
  readRows_(QUIZ_SPREADSHEET_ID, ANSWER_SHEET_NAME).forEach(function (row) {
    const m = /^\D*(\d{1,2})\D*$/.exec(normalize_(row[0]));
    const value = normalize_(row[1]).toUpperCase();
    const no = m ? Number(m[1]) : 0;
    if (no >= 1 && no <= QUESTION_COUNT && QUIZ_CHOICES.indexOf(value) >= 0 && !(no in answers)) answers[no] = value;
  });
  return answers;
}

/** 司会画面の正解発表用。司会キーが合うときだけ返す。キャッシュには置かない。 */
function buildAnswersResponse_(params) {
  const denied = authorize_(params);
  if (denied) return denied;
  let answers;
  try {
    answers = readAnswerKey_();
  } catch (err) {
    return { error: "answers_error", message: "正解を読めません: " + err.message };
  }
  const missing = [];
  for (let no = 1; no <= QUESTION_COUNT; no++) if (!(no in answers)) missing.push(no);
  return { updatedAt: new Date().toISOString(), answers: answers, missing: missing };
}

/** エディタから手動実行して、「正解」タブを読めることを確かめる（このログはエディタでしか見えない）。 */
function testAnswers() {
  Logger.log(JSON.stringify(readAnswerKey_()));
}

/* ===================== スライド一覧（?action=slides&key=司会キー） ===================== */

/*
 * 司会画面（host.html）が Google スライドを1枚ずつ画像で映すための一覧を返す。
 *
 *   {
 *     "updatedAt": "…",
 *     "slides": [
 *       { "objectId": "p",   "kind": "slide",      "imageUrl": "https://lh7-…googleusercontent.com/…" },
 *       { "objectId": "g12", "kind": "question",   "imageUrl": "https://…", "question": 5 },
 *       { "objectId": "g34", "kind": "prediction", "imageUrl": "https://…" }
 *     ],
 *     "pending": 0            // まだ画像を作れていない枚数。0 より大きければ、少し待ってもう一度呼ぶ
 *   }
 *   失敗時は { "error": "unauthorized" | "not_configured" | "deck_error", "message": "…" }
 *
 * kind の決め方（スライド上の文字で判定する。ページ番号や並び順には依存しない）:
 *   question   … 第N問のスライド。司会画面は、このスライドを映している間だけ第N問の回答を受け付ける
 *   prediction … 以心伝心ゲーム予想を尋ねるスライド。映している間だけ予想を受け付ける
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
  const denied = authorize_(params);
  if (denied) return denied;
  const deckId = String(PropertiesService.getScriptProperties().getProperty(PROP_DECK_ID) || "").trim();
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
  const seen = {}; // 同じ問題番号・予想のスライドが2枚あったら、最初の1枚だけを受付のスライドにする
  SlidesApp.openById(deckId).getSlides().forEach(function (slide) {
    if (isSkipped_(slide)) return;
    const found = classifySlideTexts_(collectSlideTexts_(slide));
    if (found.kind === "legacy") return; // 以前の「回答数」スライドは映さない
    const item = { objectId: slide.getObjectId(), kind: found.kind };
    if (found.kind === "question") item.question = found.question;
    const id = found.kind === "question" ? "q" + found.question : found.kind;
    if (found.kind !== "slide" && seen[id]) {
      item.kind = "slide";
      delete item.question;
    }
    seen[id] = true;
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

// 問題のスライドの題名。1つのテキストボックスが、これだけでできている（空白は取り除いたあとで照合する）
// 「第5問」「第5問目」「Q5」「Q.5」「QUESTION 5」。末尾の「.」「:」「。」は付いていてもよい
const QUESTION_TITLE_RE = /^(?:第(\d{1,2})問目?|Q(?:UESTION)?\.?(\d{1,2}))[.:。]?$/;
// 予想のスライドの題名。1つのテキストボックスが、これだけでできている。「予想タイム」「予想」「以心伝心ゲーム予想」など
const PRED_TITLE_RE = /^(?:以心伝心(?:ゲーム)?の?)?予想(?:タイム|クイズ)?[!.:。]?$/;
// 予想の質問文そのもの。スライドのどこかにあればよい。「…5問中何問そろいますか？」「何問揃う？」
const PRED_QUESTION_RE = /何問(?:そろ|揃)/;
// 以前の「第N問 回答数」スライドの題名（いまは使わないので、スライドショーから外す）
const LEGACY_COUNTS_RE = /(?:第\d{1,2}問目?|Q\.?\d{1,2})[-‐–—―:・|\/]*の?回答/;

/**
 * スライドの種類を、スライド上の文字（テキストボックス・表のセルごとの配列）から決める。
 * 文字は normalizeMarker_ でならしてから比べるので、全角/半角・大文字/小文字・空白や改行の有無は問わない。
 *
 * 1. question: 「第N問」または「QN」（N は 1〜10）だけが書かれたテキストボックスがある。
 *    例: 題名の箱に「Q5」「第5問」。「第5問 正解」「第5問 回答数」「Q5 解説」のように続きがある箱は当てはまらない。
 *    違う番号の題名が2つ以上あるスライドは、どの問題か決められないので slide にする。
 * 2. prediction: 「予想タイム」（または「予想」「以心伝心ゲーム予想」）だけが書かれたテキストボックスがある、
 *    またはスライドのどこかに「何問そろ」（何問揃）がある。例: 「新郎新婦の答えは5問中何問そろいますか？」
 * 3. legacy: 以前の「第N問 回答数」「予想 回答数」のスライド。スライドショーから外す。
 * 4. それ以外は slide。
 */
function classifySlideTexts_(texts) {
  const boxes = (texts || []).map(normalizeMarker_).filter(String);
  const whole = boxes.join("\n");

  const numbers = {};
  boxes.forEach(function (box) {
    const m = QUESTION_TITLE_RE.exec(box);
    const no = m ? Number(m[1] || m[2]) : 0;
    if (no >= 1 && no <= QUESTION_COUNT) numbers[no] = true;
  });
  const found = Object.keys(numbers);
  if (found.length === 1) return { kind: "question", question: Number(found[0]) };
  if (found.length > 1) return { kind: "slide" };

  const isPredTitle = function (box) {
    return PRED_TITLE_RE.test(box);
  };
  if (boxes.some(isPredTitle) || PRED_QUESTION_RE.test(whole)) return { kind: "prediction" };

  const isLegacyTitle = function (box) {
    return LEGACY_COUNTS_RE.test(box);
  };
  if (whole.indexOf("回答数") >= 0 && (boxes.some(isLegacyTitle) || whole.indexOf("予想") >= 0)) return { kind: "legacy" };
  return { kind: "slide" };
}

/**
 * スライドに imageUrl を付ける。URL はキャッシュし、無いものだけ Slides API で作る。
 * 時間の上限を超えたら残りは null（pending）で返す。
 */
function attachThumbnails_(deckId, list, refreshAll, refreshIds) {
  const cache = scriptCache_();
  const keyOf = function (item) {
    return THUMB_CACHE_PREFIX + item.objectId;
  };
  let cached = {};
  if (cache && !refreshAll && list.length > 0) {
    try {
      cached = cache.getAll(list.map(keyOf)) || {};
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
    if (item.kind === "question") out.question = item.question;

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
 * 第1問〜第10問がそれぞれ question、予想のスライドが prediction になっていることを確かめる
 * （同じ番号が2枚あるときは、最初の1枚だけが受付のスライドになる）。
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
    const label = found.kind === "question" ? "question 第" + found.question + "問" : found.kind === "legacy" ? "（以前の回答数スライド・映さない）" : found.kind;
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
