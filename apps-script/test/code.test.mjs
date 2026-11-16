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
  const calls = { thumbnails: [], opened: [] };
  const env = {
    calls,
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
        getAll: (keys) => Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)])),
        putAll: (obj) => Object.entries(obj).forEach(([k, v]) => store.set(k, v)),
      }),
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
  env.get = (params) => JSON.parse(env.doGet({ parameter: params || {} }).text);
  return env;
}

/* ===== 集計（4択） ===== */

const QUIZ_HEADER = ["タイムスタンプ", "お名前", ...Array.from({ length: 10 }, (_, i) => `第${i + 1}問`)];
const quizRow = (minute, name, no, value) => {
  const row = [new Date(2026, 10, 23, 19, minute), name, ...Array(10).fill("")];
  row[1 + no] = value;
  return row;
};
const PRED_SHEET = [["タイムスタンプ", "お名前", "新郎新婦の答えは何問そろいますか？"], [new Date(2026, 10, 23, 19, 0), "山田", "3問"]];

test("success: D を数え、quiz は A/B/C/D/total の形になる", () => {
  const env = load({
    sheets: {
      "フォームの回答 1": [
        QUIZ_HEADER,
        quizRow(0, "山田", 1, "A"),
        quizRow(1, "佐藤", 1, "D"),
        quizRow(2, "鈴木", 1, "Ｄ"), // 全角
        quizRow(3, "田中", 1, "d"), // 小文字
        quizRow(4, "高橋", 1, "E"), // 選択肢にない値は数えない
        quizRow(5, "山田", 1, "D"), // 同じ人の送り直しは新しい方だけ
        quizRow(6, "山田", 2, "C"),
      ],
      "フォームの回答 2": PRED_SHEET,
    },
  });
  const stats = env.get();
  assert.equal(stats.errors, undefined);
  assert.deepEqual(stats.quiz["1"], { A: 0, B: 0, C: 0, D: 4, total: 4 });
  assert.deepEqual(stats.quiz["2"], { A: 0, B: 0, C: 1, D: 0, total: 1 });
  assert.deepEqual(stats.quiz["10"], { A: 0, B: 0, C: 0, D: 0, total: 0 });
  assert.deepEqual(Object.keys(stats.quiz), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.deepEqual(stats.pred, { "0問": 0, "1問": 0, "2問": 0, "3問": 1, "4問": 0, "5問": 0, total: 1 });
});

test("success: 集計の応答には名前もスライドの情報も含まれない / JSONP も返せる", () => {
  const env = load({ sheets: { "フォームの回答 1": [QUIZ_HEADER, quizRow(0, "山田太郎", 1, "D")], "フォームの回答 2": PRED_SHEET } });
  const out = env.doGet({ parameter: {} });
  assert.equal(out.mime, "JSON");
  assert.ok(!out.text.includes("山田"));
  assert.ok(!out.text.includes(DECK_ID) && !out.text.includes(HOST_KEY));
  const jsonp = env.doGet({ parameter: { callback: "cb1" } });
  assert.equal(jsonp.mime, "JAVASCRIPT");
  assert.match(jsonp.text, /^cb1\(\{.*\}\);$/);
});

test("success: シートが無いときは errors を付け、人数は 0 のまま 4択の形で返す", () => {
  const stats = load().get();
  assert.equal(stats.errors.length, 2);
  assert.deepEqual(stats.quiz["1"], { A: 0, B: 0, C: 0, D: 0, total: 0 });
});

/* ===== スライドの種類の判定 ===== */

const classifyCases = {
  "success: 第N問 回答数（いまのスライド）": [["第5問 回答数", "回答数のグラフをここに貼ります"], { kind: "quizCounts", question: 5 }],
  "success: 題名だけ": [["第10問 回答数"], { kind: "quizCounts", question: 10 }],
  "success: 全角数字・全角空白": [["第５問　回答数"], { kind: "quizCounts", question: 5 }],
  "success: 改行入り": [["第7問\n回答数"], { kind: "quizCounts", question: 7 }],
  "success: Q表記": [["Q5 回答数"], { kind: "quizCounts", question: 5 }],
  "success: 全角Q・小文字q・コロン": [["ｑ１０：回答数"], { kind: "quizCounts", question: 10 }],
  "success: 第N問の回答数": [["第3問の回答数"], { kind: "quizCounts", question: 3 }],
  "success: 第N問 回答 + 別の箱に回答数": [["第2問 回答状況", "みなさんの回答数"], { kind: "quizCounts", question: 2 }],
  "success: Q5 と 回答数 が別の箱（ゆるい条件）": [["Q5", "回答数"], { kind: "quizCounts", question: 5 }],
  "success: 5 / 10 のような分数は問題番号に数えない": [["Q5", "5 / 10", "回答数"], { kind: "quizCounts", question: 5 }],
  "success: 予想 回答数": [["予想 回答数"], { kind: "predCounts" }],
  "success: 以心伝心ゲーム予想 + 回答数": [["以心伝心ゲーム 予想", "回答数のグラフをここに貼ります"], { kind: "predCounts" }],
  "success: 予想の回答数": [["以心伝心 予想の回答数"], { kind: "predCounts" }],
  "success: 第N問 回答数 は 予想 より優先": [["第10問 回答数", "以心伝心ゲーム予想"], { kind: "quizCounts", question: 10 }],
  "success: 正解スライドは画像": [["第5問 正解", "正解は [正解]"], { kind: "slide" }],
  "success: 問題スライドは画像": [["Q5", "5 / 10", "[第5問の問題文がここに入ります]", "A", "[選択肢A]"], { kind: "slide" }],
  "success: 回答数が無ければ画像（第N問 回答）": [["第5問 回答をどうぞ"], { kind: "slide" }],
  "success: 予想の案内（回答数なし）は画像": [["以心伝心ゲーム予想", "スマホから回答してください"], { kind: "slide" }],
  "success: 範囲外の問題番号は画像": [["第11問 回答数"], { kind: "slide" }],
  "success: 回答数 + 正解 で番号が離れていれば画像": [["第5問", "正解と回答数"], { kind: "slide" }],
  "success: 問題番号が2種類あれば画像": [["第5問", "第6問", "回答数"], { kind: "slide" }],
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
  slide("s3", [shape("第5問 回答数"), shape("回答数のグラフをここに貼ります")]),
  slide("s4", [shape("第5問 正解"), shape("正解は B")]),
  slide("s5", [group(shape("飾り"), group(shape("第６問\u000b回答数")))]),
  slide("s6", [table([["以心伝心ゲーム", null], ["予想", "回答数"]])]),
  slide("s7", [shape("第9問 回答数")], true), // スキップに設定したスライド
  slide("s8", [shape("Thank you!")]),
];

test("success: 種類・問題番号・画像URLを返し、IDや文字は返さない", () => {
  const env = load({ slides: DECK });
  const out = env.doGet({ parameter: { action: "slides", key: HOST_KEY } });
  const res = JSON.parse(out.text);
  assert.deepEqual(
    res.slides.map((s) => [s.objectId, s.kind, s.question ?? null, s.imageUrl === null ? null : "url"]),
    [
      ["s1", "slide", null, "url"],
      ["s2", "slide", null, "url"],
      ["s3", "quizCounts", 5, null],
      ["s4", "slide", null, "url"],
      ["s5", "quizCounts", 6, null],
      ["s6", "predCounts", null, null],
      ["s8", "slide", null, "url"],
    ]
  );
  assert.equal(res.pending, 0);
  assert.equal(res.errors, undefined);
  assert.deepEqual(env.calls.thumbnails, ["s1", "s2", "s4", "s8"]); // グラフのスライドは画像を作らない
  for (const secret of [DECK_ID, HOST_KEY, "正解", "Thank"]) assert.ok(!out.text.includes(secret), secret);
});

test("success: 2回目はキャッシュを使い、refresh で作り直す", () => {
  const env = load({ slides: DECK });
  const first = env.get({ action: "slides", key: HOST_KEY });
  const second = env.get({ action: "slides", key: HOST_KEY });
  assert.deepEqual(second.slides, first.slides);
  assert.equal(env.calls.thumbnails.length, 4);
  assert.equal(env.calls.opened.length, 1);

  const one = env.get({ action: "slides", key: HOST_KEY, refresh: "s4" });
  assert.deepEqual(env.calls.thumbnails.slice(4), ["s4"]);
  assert.notEqual(one.slides[3].imageUrl, first.slides[3].imageUrl);
  assert.equal(one.slides[0].imageUrl, first.slides[0].imageUrl);

  env.get({ action: "slides", key: HOST_KEY, refresh: "all" });
  assert.equal(env.calls.thumbnails.length, 9);
  assert.equal(env.calls.opened.length, 2);
});

test("failed: キーが違う・無いときは何も返さない", () => {
  const env = load({ slides: DECK });
  for (const key of [undefined, "", "wrong", HOST_KEY + "x", HOST_KEY.slice(0, -1), HOST_KEY.toUpperCase()]) {
    const res = env.get({ action: "slides", key });
    assert.equal(res.error, "unauthorized");
    assert.equal(res.slides, undefined);
  }
  assert.equal(env.calls.opened.length, 0);
  assert.equal(env.calls.thumbnails.length, 0);
});

test("failed: キーやスライドIDが未設定なら not_configured（空のキーで通さない）", () => {
  for (const props of [{}, { SLIDES_DECK_ID: DECK_ID }, { SLIDES_DECK_ID: DECK_ID, HOST_KEY: "short" }]) {
    const env = load({ slides: DECK, props });
    assert.equal(env.get({ action: "slides", key: props.HOST_KEY || "" }).error, "not_configured");
    assert.equal(env.calls.opened.length, 0);
  }
  assert.equal(load({ slides: DECK, props: { HOST_KEY } }).get({ action: "slides", key: HOST_KEY }).error, "not_configured");
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
  assert.equal(first.pending, 2);
  assert.equal(first.errors.length, 1);
  assert.ok(!out.text.includes(DECK_ID));
  assert.deepEqual(first.slides.map((s) => Boolean(s.imageUrl)), [true, true, false, false, false, false, false]);

  fail = false;
  const second = env.get({ action: "slides", key: HOST_KEY });
  assert.equal(second.pending, 0);
  assert.equal(second.slides[0].imageUrl, first.slides[0].imageUrl); // できていた分は作り直さない
  assert.deepEqual(env.calls.thumbnails, ["s1", "s2", "s4", "s4", "s8"]);
});

test("success: 時間の上限を超えたら残りは pending", () => {
  const env = load({ slides: DECK });
  let now = 1_000_000;
  vm.runInContext("Date", env).now = () => (now += 12_000); // 1枚ごとに 12 秒かかったことにする
  const res = env.get({ action: "slides", key: HOST_KEY });
  assert.ok(res.pending > 0 && res.pending < 4);
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
});

/* ===== 実際のスライドの文字（DECK_TXT を渡したときだけ） ===== */

test("success: 実際のスライド（DECK_TXT）の判定", { skip: !process.env.DECK_TXT }, () => {
  const blocks = fs.readFileSync(process.env.DECK_TXT, "utf8").trim().split(/\n\s*\n/);
  // 各行を1つのテキストボックスとして扱う（スピーカーノートの行も入れて、誤判定しないことを確かめる）
  const slides = blocks.map((block, i) => {
    const lines = block.split("\n");
    assert.equal(lines.pop().trim(), String(i + 1), "ブロックの最後の行はページ番号");
    return slide("page" + (i + 1), lines.map(shape));
  });
  const res = load({ slides }).get({ action: "slides", key: HOST_KEY });
  const charts = res.slides.map((s, i) => [i + 1, s.kind, s.question ?? null]).filter(([, kind]) => kind !== "slide");
  console.log("グラフに置き換わるページ:", JSON.stringify(charts));
  if (process.env.DECK_EXPECT) assert.deepEqual(charts, JSON.parse(process.env.DECK_EXPECT));
  assert.equal(res.slides.length, blocks.length);
  // 正解・問題のスライドは必ず画像のまま
  blocks.forEach((block, i) => {
    if (!block.includes("回答数")) assert.equal(res.slides[i].kind, "slide", "page " + (i + 1));
  });
});
