/*
 * apps-script/Code.gs のテスト（Google のサービスを偽物に差し替えて node で動かす）。
 *
 *   node --test apps-script/test/
 *
 * 実際のスライドの文字で判定を確かめるときは、スライドをテキストで書き出したファイルを渡す
 * （リポジトリには置かない）。1枚ごとに空行で区切り、各ブロックの最後の行がページ番号の形式。
 *
 *   DECK_TXT=/path/to/deck.txt node --test apps-script/test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const CODE = fs.readFileSync(new URL("../Code.gs", import.meta.url), "utf8");
const DECK_ID = "DECK-ID-SECRET-1234567890";
const HOST_KEY = "test-host-key-0123456789";

/* ===== 偽物の Google サービス ===== */

const PageElementType = { SHAPE: "SHAPE", TABLE: "TABLE", GROUP: "GROUP", IMAGE: "IMAGE" };
const textOf = (text) => ({ getText: () => ({ asString: () => text }) });
const shape = (text) => ({ getPageElementType: () => PageElementType.SHAPE, asShape: () => textOf(text) });
const image = () => ({ getPageElementType: () => PageElementType.IMAGE });
const group = (...children) => ({ getPageElementType: () => PageElementType.GROUP, asGroup: () => ({ getChildren: () => children }) });
const table = (rows) => ({
  getPageElementType: () => PageElementType.TABLE,
  asTable: () => ({
    getNumRows: () => rows.length,
    getNumColumns: () => rows[0].length,
    getCell: (r, c) => {
      if (rows[r][c] === null) throw new Error("merged cell");
      return textOf(rows[r][c]);
    },
  }),
});
const slide = (objectId, elements, skipped = false) => ({
  getObjectId: () => objectId,
  getPageElements: () => elements,
  isSkipped: () => skipped,
});

/** Code.gs を、偽物のサービスを持つ新しい環境に読み込む。 */
function load({ sheets = {}, slides = [], props = { SLIDES_DECK_ID: DECK_ID, HOST_KEY }, thumbnail } = {}) {
  const store = new Map();
  const calls = { thumbnails: [], opened: [], locks: 0 };
  const env = {
    calls,
    props,
    cacheStore: store,
    Logger: { log: () => {} },
    Utilities: { getUuid: () => "00000000-1111-2222-3333-444444444444" },
    ContentService: {
      MimeType: { JSON: "JSON", JAVASCRIPT: "JAVASCRIPT" },
      createTextOutput: (text) => ({ text, mime: null, setMimeType(m) { this.mime = m; return this; } }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (store.has(k) ? store.get(k) : null),
        put: (k, v) => void store.set(k, v),
        remove: (k) => void store.delete(k),
        getAll: (keys) => Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)])),
        putAll: (obj) => Object.entries(obj).forEach(([k, v]) => store.set(k, v)),
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => void (calls.locks += 1), releaseLock: () => void (calls.locks -= 1) }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => void (props[k] = v),
      }),
    },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: (name) => (sheets[name] ? { getDataRange: () => ({ getValues: () => sheets[name] }) } : null) }),
      getActiveSpreadsheet: () => null,
    },
    SlidesApp: {
      PageElementType,
      openById: (id) => {
        calls.opened.push(id);
        if (id !== DECK_ID) throw new Error("Document " + id + " is missing");
        return { getSlides: () => slides };
      },
    },
    Slides: {
      Presentations: {
        Pages: {
          getThumbnail: (deckId, pageId, options) => {
            calls.thumbnails.push(pageId);
            assert.equal(deckId, DECK_ID);
            assert.equal(options["thumbnailProperties.thumbnailSize"], "LARGE");
            if (thumbnail) return thumbnail(pageId, calls.thumbnails.length);
            return { contentUrl: "https://lh7.example/thumb/" + pageId + "?n=" + calls.thumbnails.length };
          },
        },
      },
    },
  };
  vm.createContext(env);
  // テストから設定値を差し替えられるよう、スプレッドシートの ID だけ埋めておく
  vm.runInContext(CODE.replace('const QUIZ_SPREADSHEET_ID = "";', 'const QUIZ_SPREADSHEET_ID = "sheet";'), env, { filename: "Code.gs" });
  env.raw = (params) => env.doGet({ parameter: params || {} }).text;
  env.get = (params) => JSON.parse(env.raw(params));
  /** Code.gs から見た「いまの時刻」を固定する（T0 からの秒数）。 */
  env.at = (sec) => void (vm.runInContext("Date", env).now = () => T0 + sec * 1000);
  /** 司会キー付きで受付を切り替える。 */
  env.setOpen = (target, sec) => {
    if (sec !== undefined) env.at(sec);
    return env.get({ action: "setOpen", key: HOST_KEY, target });
  };
  return env;
}

/* ===== シートの行 ===== */

const T0 = new Date(2026, 10, 23, 19, 0, 0).getTime();
const QUIZ_SHEET = "フォームの回答 1";
const PRED_SHEET = "フォームの回答 2";
const QUIZ_HEADER = ["タイムスタンプ", "お名前", ...Array.from({ length: 10 }, (_, i) => `第${i + 1}問`)];
const PRED_HEADER = ["タイムスタンプ", "お名前", "新郎新婦の答えは何問そろいますか？"];
/** T0 から sec 秒後に記録された、第 no 問への回答の行。 */
const quizRow = (sec, name, no, value) => {
  const row = [new Date(T0 + sec * 1000), name, ...Array(10).fill("")];
  row[1 + no] = value;
  return row;
};
const predRow = (sec, name, value) => [new Date(T0 + sec * 1000), name, value];
const ANSWER_SHEET = [["問題番号", "正解"], [1, "B"], ["2", "ｄ"], ["第3問", "A"], [4, "E"], ["", "C"], [5, ""], [10, "C"], [1, "A"]];

/* ===== 受付状態（?action=state / setOpen） ===== */

test("success: 受付状態の初期値は「何も受け付けていない」", () => {
  const state = load().get({ action: "state" });
  assert.deepEqual({ ...state }, { open: null, lastClosed: null, done: [], rev: 0, updatedAt: null });
});

test("success: setOpen で開ける → none で締め切る → idle で待ち受けに戻る", () => {
  const env = load();
  const opened = env.setOpen("q5", 0);
  assert.equal(opened.ok, true);
  assert.deepEqual([opened.state.open, opened.state.lastClosed, opened.state.done, opened.state.rev], ["q5", null, [], 1]);
  assert.equal(env.get({ action: "state" }).open, "q5"); // ゲストが読む状態にもすぐ反映される

  const closed = env.setOpen("none", 30).state;
  assert.deepEqual([closed.open, closed.lastClosed, closed.done, closed.rev], [null, "q5", ["q5"], 2]);
  assert.deepEqual(env.get({ action: "state" }).done, ["q5"]);

  const idle = env.setOpen("idle", 40).state;
  assert.deepEqual([idle.open, idle.lastClosed, idle.done, idle.rev], [null, null, ["q5"], 3]);
  assert.equal(env.calls.locks, 0); // ロックは必ず返している
});

test("success: 別の問題を開けると前の問題は閉じる / 同じ呼び出しの繰り返しでは何も変わらない", () => {
  const env = load();
  env.setOpen("q5", 0);
  const again = env.setOpen("q5", 5).state;
  assert.equal(again.rev, 1);
  const next = env.setOpen("pred", 20).state;
  assert.deepEqual([next.open, next.lastClosed, next.done, next.rev], ["pred", null, ["q5"], 2]);
  env.setOpen("none", 30);
  assert.equal(env.setOpen("none", 35).state.rev, 3);
  const gate = JSON.parse(env.props.WG_GATE);
  assert.deepEqual(gate.windows, { q5: [[T0, T0 + 20000]], pred: [[T0 + 20000, T0 + 30000]] });
});

test("success: キャッシュが消えても、受付状態はスクリプト プロパティから読める", () => {
  const env = load();
  env.setOpen("q3", 0);
  env.cacheStore.clear();
  assert.equal(env.get({ action: "state" }).open, "q3");
  assert.equal(env.get().state.open, "q3");
});

test("success: 開け直しを繰り返しても、覚える受付時間は増えすぎず、最初と最後の時間は残る", () => {
  const env = load();
  for (let i = 0; i < 12; i++) {
    env.setOpen("q1", i * 10);
    env.setOpen("none", i * 10 + 5);
  }
  const list = JSON.parse(env.props.WG_GATE).windows.q1;
  assert.equal(list.length, 8);
  assert.equal(list[0][0], T0);
  assert.deepEqual(list[7], [T0 + 110000, T0 + 115000]);
});

test("failed: 司会キーが違う・無いときは、受付の切り替え・正解・リセットを受け付けない", () => {
  const env = load({ sheets: { 正解: ANSWER_SHEET } });
  env.setOpen("q5", 0);
  for (const key of [undefined, "", "wrong", HOST_KEY + "x", HOST_KEY.slice(0, -1), HOST_KEY.toUpperCase()]) {
    for (const params of [{ action: "setOpen", target: "q6" }, { action: "setOpen", target: "none" }, { action: "answers" }, { action: "reset" }]) {
      const text = env.raw({ ...params, key });
      assert.deepEqual(Object.keys(JSON.parse(text)), ["error", "message"]);
      assert.equal(JSON.parse(text).error, "unauthorized");
    }
  }
  const state = env.get({ action: "state" });
  assert.deepEqual([state.open, state.rev], ["q5", 1]);
});

test("failed: 司会キーが未設定なら not_configured（空のキーで通さない）", () => {
  for (const props of [{}, { HOST_KEY: "short" }]) {
    const env = load({ props, sheets: { 正解: ANSWER_SHEET } });
    for (const action of ["setOpen", "answers", "reset", "slides"]) {
      assert.equal(env.get({ action, key: props.HOST_KEY || "", target: "q1" }).error, "not_configured");
    }
    assert.equal(env.get({ action: "state" }).open, null);
  }
});

test("failed: target が想定外なら bad_target で、状態は変わらない", () => {
  const env = load();
  for (const target of [undefined, "", "q0", "q11", "Q5", "5", "quiz", "__proto__"]) {
    assert.equal(env.get({ action: "setOpen", key: HOST_KEY, target }).error, "bad_target");
  }
  assert.equal(env.get({ action: "state" }).rev, 0);
});

test("success: reset は受付の記録を消す（番号は戻さない）", () => {
  const env = load({ sheets: { [QUIZ_SHEET]: [QUIZ_HEADER, quizRow(5, "山田", 1, "A")], [PRED_SHEET]: [PRED_HEADER] } });
  env.setOpen("q1", 0);
  env.setOpen("none", 10);
  assert.equal(env.get().quiz["1"].total, 1);
  const res = env.get({ action: "reset", key: HOST_KEY });
  assert.deepEqual([res.state.open, res.state.lastClosed, res.state.done, res.state.rev], [null, null, [], 3]);
  assert.equal(env.get().quiz["1"].total, 0); // リハーサルの回答は数えなくなる
  env.setOpen("q1", 100);
  env.resetGame();
  assert.equal(env.get({ action: "state" }).open, null);
});

/* ===== 集計（受付時間内の回答だけを数える） ===== */

test("success: 受付時間内の回答だけを数える（締め切り後 5 秒までは数える）", () => {
  const env = load({
    sheets: {
      [QUIZ_SHEET]: [
        QUIZ_HEADER,
        quizRow(-30, "早井", 1, "A"), // 受付前にフォームへ直接送った → 数えない
        quizRow(-1, "境", 1, "A"), // 開ける1秒前まで（時計のずれの分）は数える
        quizRow(10, "山田", 1, "A"),
        quizRow(20, "佐藤", 1, "D"),
        quizRow(21, "鈴木", 1, "Ｄ"), // 全角
        quizRow(22, "田中", 1, "d"), // 小文字
        quizRow(23, "高橋", 1, "E"), // 選択肢にない値は数えない
        quizRow(25, "山田", 1, "D"), // 同じ人の送り直しは新しい方だけ
        quizRow(64, "滑込", 1, "B"), // 締め切り（60秒）の4秒後 → 数える
        quizRow(70, "遅井", 1, "C"), // 締め切りの10秒後 → 数えない
        quizRow(80, "佐藤", 1, "A"), // 締め切り後の送り直しで、受付中の回答は上書きされない
        quizRow(30, "山田", 2, "C"), // 第2問はまだ受け付けていない → 数えない
        ["", "時刻なし", "A", ...Array(9).fill("")], // タイムスタンプが無い行は数えない
      ],
      [PRED_SHEET]: [PRED_HEADER, predRow(10, "山田", "3問"), predRow(130, "佐藤", "３問"), predRow(140, "鈴木", 5), predRow(200, "遅井", "1問")],
    },
  });
  env.setOpen("q1", 0);
  env.setOpen("none", 60);
  env.setOpen("pred", 120);
  env.setOpen("none", 150);
  env.at(300);

  const full = env.buildStats_(env.readGate_());
  assert.equal(full.errors, undefined);
  assert.deepEqual({ ...full.quiz["1"] }, { A: 1, B: 1, C: 0, D: 4, total: 6 });
  assert.equal(full.quiz["2"].total, 0);
  assert.deepEqual({ ...full.pred }, { "0問": 0, "1問": 0, "2問": 0, "3問": 1, "4問": 0, "5問": 1, total: 2 });

  const stats = env.get();
  assert.equal(stats.quiz["1"].total, 6);
  assert.equal(stats.pred.total, 2);
});

test("success: 受付中は締め切り時刻がないので、いま届いた回答まで数える / 開け直した時間も数える", () => {
  const rows = [QUIZ_HEADER, quizRow(5, "山田", 3, "A"), quizRow(50, "佐藤", 3, "B"), quizRow(105, "鈴木", 3, "C")];
  const env = load({ sheets: { [QUIZ_SHEET]: rows, [PRED_SHEET]: [PRED_HEADER] } });
  assert.equal(env.get().quiz["3"].total, 0); // 一度も開けていなければ 0
  env.setOpen("q3", 0);
  assert.equal(env.get().quiz["3"].total, 3); // 受付中
  env.setOpen("none", 10);
  assert.equal(env.get().quiz["3"].total, 1); // 切り替えた直後から新しい数字になる（集計のキャッシュを捨てる）
  env.setOpen("q3", 100); // O キーで開け直した
  env.setOpen("none", 110);
  assert.equal(env.get().quiz["3"].total, 2);
});

test("success: 公開する応答には、名前・正解・選択肢ごとの人数・受付時間・秘密の値が含まれない / JSONP も返せる", () => {
  const env = load({
    sheets: { [QUIZ_SHEET]: [QUIZ_HEADER, quizRow(5, "山田太郎", 1, "D")], [PRED_SHEET]: [PRED_HEADER, predRow(5, "山田太郎", "3問")], 正解: ANSWER_SHEET },
  });
  env.setOpen("q1", 0);
  env.setOpen("pred", 3);
  const stats = env.get();
  assert.deepEqual(Object.keys(stats).sort(), ["pred", "quiz", "state", "updatedAt"]);
  assert.deepEqual(Object.keys(stats.quiz), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.deepEqual({ ...stats.quiz["1"] }, { total: 1 });
  assert.deepEqual({ ...stats.pred }, { total: 1 });
  assert.deepEqual(Object.keys(stats.state).sort(), ["done", "lastClosed", "open", "rev", "updatedAt"]);
  assert.deepEqual(Object.keys(env.get({ action: "state" })).sort(), ["done", "lastClosed", "open", "rev", "updatedAt"]);

  for (const params of [{}, { action: "state" }, { action: "answers" }, { action: "slides" }, { action: "unknown" }]) {
    const text = env.raw(params);
    for (const secret of ["山田", "正解", "answers", "windows", DECK_ID, HOST_KEY, String(T0)]) assert.ok(!text.includes(secret), JSON.stringify(params) + " " + secret);
    assert.ok(!/"[A-D]"/.test(text), "選択肢の文字を含まない: " + JSON.stringify(params));
  }

  const out = env.doGet({ parameter: {} });
  assert.equal(out.mime, "JSON");
  const jsonp = env.doGet({ parameter: { action: "state", callback: "cb1" } });
  assert.equal(jsonp.mime, "JAVASCRIPT");
  assert.match(jsonp.text, /^cb1\(\{.*\}\);$/);
});

test("success: シートが無い・タイムスタンプの列が無いときは errors を付け、人数は 0 で返す", () => {
  const missing = load().get();
  assert.equal(missing.errors.length, 2);
  assert.deepEqual({ ...missing.quiz["1"] }, { total: 0 });

  const env = load({ sheets: { [QUIZ_SHEET]: [QUIZ_HEADER.slice(1), ["山田", "A"]], [PRED_SHEET]: [PRED_HEADER] } });
  env.setOpen("q1", 0);
  const stats = env.get();
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0], /タイムスタンプ/);
});

/* ===== 正解（?action=answers） ===== */

test("success: 正解は司会キーが合うときだけ返す（見出し・範囲外・空欄の行は飛ばす）", () => {
  const env = load({ sheets: { 正解: ANSWER_SHEET } });
  const res = env.get({ action: "answers", key: HOST_KEY });
  assert.deepEqual({ ...res.answers }, { 1: "B", 2: "D", 3: "A", 10: "C" });
  assert.deepEqual([...res.missing], [4, 5, 6, 7, 8, 9]);
});

test("failed: 「正解」タブが無ければ answers_error", () => {
  assert.equal(load().get({ action: "answers", key: HOST_KEY }).error, "answers_error");
});

test("success: ランキングは受付時間内の回答だけで数える（エディタ専用）", () => {
  const rows = [
    QUIZ_HEADER,
    quizRow(5, "山田", 1, "B"),
    quizRow(6, "佐藤", 1, "A"),
    quizRow(30, "佐藤", 1, "B"), // 締め切り後に直した → 数えない
    quizRow(45, "山田", 2, "D"),
    quizRow(46, "佐藤", 2, "D"),
    quizRow(47, "", 2, "D"),
  ];
  const env = load({ sheets: { [QUIZ_SHEET]: rows, 正解: ANSWER_SHEET } });
  env.setOpen("q1", 0);
  env.setOpen("none", 10);
  env.setOpen("q2", 40);
  env.setOpen("none", 50);
  const ranking = env.rankQuiz_(rows, env.readGate_().windows, env.readAnswerKey_());
  assert.deepEqual(
    Array.from(ranking, (r) => [r.name, r.correct, r.answered]),
    [["山田", 2, 2], ["（名前なし・6行目）", 1, 1], ["佐藤", 1, 2]]
  );
  env.logRanking();
});

/* ===== スライドの種類の判定 ===== */

const classifyCases = {
  "success: Q表記の題名": [["Q5", "5 / 10", "[第5問の問題文がここに入ります]", "A", "[選択肢A]"], { kind: "question", question: 5 }],
  "success: 第N問の題名": [["第5問", "問題文"], { kind: "question", question: 5 }],
  "success: 全角・空白・改行": [["第 １０ 問\n", "問題文"], { kind: "question", question: 10 }],
  "success: 全角Q・小文字q・ピリオド": [["ｑ．７"], { kind: "question", question: 7 }],
  "success: 第N問目 / コロン": [["第3問目："], { kind: "question", question: 3 }],
  "success: Question N": [["Question 2"], { kind: "question", question: 2 }],
  "success: 問題文に 正解 の文字があっても問題スライド": [["Q4", "次のうち正解はどれ？"], { kind: "question", question: 4 }],
  "success: 5 / 10 や 1・2・3 だけの箱は問題番号に数えない": [["ルール説明", "1", "2", "3", "5 / 10"], { kind: "slide" }],
  "success: 続きのある題名は問題スライドではない（正解）": [["第5問 正解", "正解は B"], { kind: "slide" }],
  "success: 続きのある題名は問題スライドではない（解説）": [["Q5 解説"], { kind: "slide" }],
  "success: 文中の 第5問 は題名ではない": [["つぎは第5問です"], { kind: "slide" }],
  "success: 範囲外の問題番号": [["Q11"], { kind: "slide" }],
  "success: Q0": [["Q0"], { kind: "slide" }],
  "success: 違う番号の題名が2つあれば決めない": [["Q5", "Q6"], { kind: "slide" }],
  "success: 同じ番号の題名が2つ": [["Q5", "第5問"], { kind: "question", question: 5 }],
  "success: 予想タイム（題名）": [["予想タイム", "スマホで答えてください"], { kind: "prediction" }],
  "success: 予想（題名だけ）": [["以心伝心ゲーム", "予想"], { kind: "prediction" }],
  "success: 以心伝心ゲーム予想（題名）": [["以心伝心ゲーム 予想"], { kind: "prediction" }],
  "success: 予想の質問文": [["以心伝心ゲーム", "新郎新婦の答えは\n5問中 何問そろいますか？"], { kind: "prediction" }],
  "success: 予想の質問文（漢字）": [["何問揃うでしょう"], { kind: "prediction" }],
  "success: 問題の題名は予想より優先": [["Q10", "予想タイム"], { kind: "question", question: 10 }],
  "success: 以心伝心ゲームの題名スライドは普通のスライド": [["Telepathy Game", "以心伝心ゲーム", "「せーの！」で答えをそろえよう", "全5問"], { kind: "slide" }],
  "success: 以心伝心ゲームのお題は普通のスライド": [["以心伝心ゲーム", "1 / 5", "お題 1", "[お題1がここに入ります]", "せーの！"], { kind: "slide" }],
  "success: 文中の 予想 は目印ではない": [["結果を予想してみましょう"], { kind: "slide" }],
  "success: 以前の 第N問 回答数 は映さない": [["第5問 回答数", "回答数のグラフをここに貼ります"], { kind: "legacy" }],
  "success: 以前の Q5 回答数 は映さない": [["Q5：回答数"], { kind: "legacy" }],
  "success: 以前の 予想 回答数 は映さない": [["予想 回答数"], { kind: "legacy" }],
  "success: 回答数だけ": [["回答数"], { kind: "slide" }],
  "success: 文字なし": [[], { kind: "slide" }],
};

for (const [name, [texts, want]] of Object.entries(classifyCases)) {
  test("classify " + name, () => {
    assert.deepEqual({ ...load().classifySlideTexts_(texts) }, want);
  });
}

/* ===== ?action=slides ===== */

const DECK = [
  slide("s1", [shape("Wedding After Party"), image()]),
  slide("s2", [shape("Q5"), shape("[第5問の問題文]")]),
  slide("s3", [shape("第5問 回答数"), shape("回答数のグラフをここに貼ります")]), // 以前の回答数スライド → 外す
  slide("s4", [shape("第5問 正解"), shape("正解は B")]),
  slide("s5", [group(shape("飾り"), group(shape("第６問\u000b")))]),
  slide("s6", [table([["以心伝心ゲーム", null], ["予想タイム", "何問そろう？"]])]),
  slide("s7", [shape("Q9")], true), // スキップに設定したスライド
  slide("s8", [shape("Q5"), shape("正解は B")]), // 同じ番号の2枚目 → 普通のスライド
  slide("s9", [shape("Thank you!")]),
];
const DECK_IDS = ["s1", "s2", "s4", "s5", "s6", "s8", "s9"];

test("success: 種類・問題番号・画像URLを返し、IDや文字は返さない", () => {
  const env = load({ slides: DECK });
  const out = env.doGet({ parameter: { action: "slides", key: HOST_KEY } });
  const res = JSON.parse(out.text);
  assert.deepEqual(
    res.slides.map((s) => [s.objectId, s.kind, s.question ?? null, s.imageUrl === null ? null : "url"]),
    [
      ["s1", "slide", null, "url"],
      ["s2", "question", 5, "url"],
      ["s4", "slide", null, "url"],
      ["s5", "question", 6, "url"],
      ["s6", "prediction", null, "url"],
      ["s8", "slide", null, "url"],
      ["s9", "slide", null, "url"],
    ]
  );
  assert.equal(res.pending, 0);
  assert.equal(res.errors, undefined);
  assert.deepEqual(env.calls.thumbnails, DECK_IDS);
  for (const secret of [DECK_ID, HOST_KEY, "正解", "Thank"]) assert.ok(!out.text.includes(secret), secret);
});

test("success: 2回目はキャッシュを使い、refresh で作り直す", () => {
  const env = load({ slides: DECK });
  const first = env.get({ action: "slides", key: HOST_KEY });
  const second = env.get({ action: "slides", key: HOST_KEY });
  assert.deepEqual(second.slides, first.slides);
  assert.equal(env.calls.thumbnails.length, 7);
  assert.equal(env.calls.opened.length, 1);

  const one = env.get({ action: "slides", key: HOST_KEY, refresh: "s4" });
  assert.deepEqual(env.calls.thumbnails.slice(7), ["s4"]);
  assert.notEqual(one.slides[2].imageUrl, first.slides[2].imageUrl);
  assert.equal(one.slides[0].imageUrl, first.slides[0].imageUrl);

  env.get({ action: "slides", key: HOST_KEY, refresh: "all" });
  assert.equal(env.calls.thumbnails.length, 15);
  assert.equal(env.calls.opened.length, 2);
});

test("failed: キーが違う・無いときはスライドの情報を何も返さない", () => {
  const env = load({ slides: DECK });
  for (const key of [undefined, "", "wrong", HOST_KEY + "x", HOST_KEY.slice(0, -1), HOST_KEY.toUpperCase()]) {
    const res = env.get({ action: "slides", key });
    assert.equal(res.error, "unauthorized");
    assert.equal(res.slides, undefined);
  }
  assert.equal(env.calls.opened.length, 0);
  assert.equal(env.calls.thumbnails.length, 0);
});

test("failed: スライドIDが未設定なら not_configured", () => {
  const env = load({ slides: DECK, props: { HOST_KEY } });
  assert.equal(env.get({ action: "slides", key: HOST_KEY }).error, "not_configured");
  assert.equal(env.calls.opened.length, 0);
});

test("failed: スライドを開けないときは deck_error（エラー文に ID を出さない）", () => {
  const env = load({ slides: DECK, props: { HOST_KEY, SLIDES_DECK_ID: "OTHER-DECK-ID-999" } });
  const out = env.doGet({ parameter: { action: "slides", key: HOST_KEY } });
  assert.equal(JSON.parse(out.text).error, "deck_error");
  assert.ok(!out.text.includes("OTHER-DECK-ID-999"));
});

test("success: 画像作りが途中で失敗したら、残りを pending で返し、次の呼び出しで続きを作る", () => {
  let fail = true;
  const env = load({
    slides: DECK,
    thumbnail: (pageId, n) => {
      if (fail && n === 3) throw new Error("Rate limit exceeded for " + DECK_ID);
      return { contentUrl: "https://lh7.example/" + pageId + "/" + n };
    },
  });
  const out = env.doGet({ parameter: { action: "slides", key: HOST_KEY } });
  const first = JSON.parse(out.text);
  assert.equal(first.pending, 5);
  assert.equal(first.errors.length, 1);
  assert.ok(!out.text.includes(DECK_ID));
  assert.deepEqual(first.slides.map((s) => Boolean(s.imageUrl)), [true, true, false, false, false, false, false]);

  fail = false;
  const second = env.get({ action: "slides", key: HOST_KEY });
  assert.equal(second.pending, 0);
  assert.equal(second.slides[0].imageUrl, first.slides[0].imageUrl); // できていた分は作り直さない
  assert.deepEqual(env.calls.thumbnails, ["s1", "s2", "s4", "s4", "s5", "s6", "s8", "s9"]);
});

test("success: 時間の上限を超えたら残りは pending", () => {
  const env = load({ slides: DECK });
  let now = 1_000_000;
  vm.runInContext("Date", env).now = () => (now += 12_000); // 1枚ごとに 12 秒かかったことにする
  const res = env.get({ action: "slides", key: HOST_KEY });
  assert.ok(res.pending > 0 && res.pending < 7);
  assert.equal(res.errors, undefined);
});

test("success: setupHostKey は無いときだけ作る", () => {
  const props = { SLIDES_DECK_ID: DECK_ID };
  const env = load({ slides: DECK, props });
  env.setupHostKey();
  const key = props.HOST_KEY;
  assert.ok(key.length >= 32 && /^[0-9a-f]+$/.test(key));
  env.setupHostKey();
  assert.equal(props.HOST_KEY, key);
  assert.equal(env.get({ action: "slides", key }).pending, 0);
  env.testSlides();
});

/* ===== 実際のスライドの文字（DECK_TXT を渡したときだけ） ===== */

test("success: 実際のスライド（DECK_TXT）の判定", { skip: !process.env.DECK_TXT }, () => {
  const blocks = fs.readFileSync(process.env.DECK_TXT, "utf8").trim().split(/\n\s*\n/);
  // 各行を1つのテキストボックスとして扱う（スピーカーノートの行も入れて、誤判定しないことを確かめる）
  const env = load();
  const found = blocks.map((block, i) => {
    const lines = block.split("\n");
    assert.equal(lines.pop().trim(), String(i + 1), "ブロックの最後の行はページ番号");
    return [i + 1, { ...env.classifySlideTexts_(lines) }];
  });
  const marked = found.filter(([, c]) => c.kind !== "slide").map(([page, c]) => [page, c.kind, c.question ?? null]);
  console.log("受付のスライド・外すスライド:", JSON.stringify(marked));
  if (process.env.DECK_EXPECT) assert.deepEqual(marked, JSON.parse(process.env.DECK_EXPECT));
});
