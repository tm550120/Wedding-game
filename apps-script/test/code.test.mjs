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
const QUIZ_SHEET = "クイズ回答";
const PRED_SHEET = "予想回答";
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
    for (const action of ["setOpen", "answers", "reset", "slides", "predHits", "ranking"]) {
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

/* ===== 予想が的中した人（?action=predHits） ===== */

/** 予想の受付を 100〜160 秒に開けた環境。rows は予想のシートの行（見出しを除く）。 */
function predEnv(rows, header = PRED_HEADER) {
  const env = load({ sheets: { [QUIZ_SHEET]: [QUIZ_HEADER, quizRow(5, "クイズだけの人", 1, "A")], [PRED_SHEET]: [header, ...rows], 正解: ANSWER_SHEET } });
  env.setOpen("q1", 0);
  env.setOpen("pred", 100);
  env.setOpen("none", 160);
  env.at(300);
  return env;
}
const hits = (env, n) => env.get({ action: "predHits", key: HOST_KEY, n });

const PRED_ROWS = [
  predRow(110, "たなか", "3問"),
  predRow(111, "　さとう　", "３問"), // 全角の数字・名前の前後の空白
  predRow(112, "あいだ", 3), // 数値のセル
  predRow(113, "やまだ", "2問"),
  predRow(114, "すずき", "5問"),
  predRow(115, "山田  太郎", "3問"), // 途中の空白の連続は1つにする
];

test("success: predHits は、その数を予想した人の名前を日本語の並び順で返す", () => {
  const env = predEnv(PRED_ROWS);
  const res = hits(env, "3");
  assert.deepEqual(Object.keys(res).sort(), ["count", "n", "names", "updatedAt"]);
  assert.equal(res.n, 3);
  assert.equal(res.count, 4);
  assert.deepEqual([...res.names], ["あいだ", "さとう", "たなか", "山田 太郎"]);
  assert.deepEqual([...hits(env, "2").names], ["やまだ"]);
  assert.deepEqual([...hits(env, "5").names], ["すずき"]);
  // 人数は、集計の選択肢ごとの人数と同じ
  const pred = env.buildStats_(env.readGate_()).pred;
  for (let n = 0; n <= 5; n++) assert.equal(hits(env, String(n)).count, pred[n + "問"], n + "問");
});

test("success: predHits で的中した人がいなければ、空の一覧を返す", () => {
  const res = hits(predEnv(PRED_ROWS), "0");
  assert.deepEqual([res.n, res.count, [...res.names]], [0, 0, []]);
  const empty = hits(predEnv([]), "3");
  assert.deepEqual([empty.n, empty.count, [...empty.names]], [3, 0, []]);
});

test("success: predHits は同じ名前の最新の予想だけを見る（送り直しで外れた人は入らない・当たった人は入る）", () => {
  const env = predEnv([
    predRow(110, "たなか", "3問"),
    predRow(120, "たなか", "4問"), // 3問 → 4問 に送り直した
    predRow(111, "さとう", "1問"),
    predRow(121, "ｻﾄｳ", "2問"), // 別の人（カタカナ）
    predRow(125, " さとう", "3問"), // 1問 → 3問 に送り直した（空白のゆれは同じ人）
    predRow(112, "ＡＢＣ", "3問"),
    predRow(126, "ABC", "3問"), // 全角/半角のゆれは同じ人。名前は最新の行の書き方で出す
    predRow(130, "", "3問"), // 名前のない行は1人に数えるが、名前の一覧には入らない
  ]);
  const three = hits(env, "3");
  assert.deepEqual([...three.names].sort(), ["ABC", "さとう"]);
  assert.equal(three.count, 3);
  assert.deepEqual([...hits(env, "4").names], ["たなか"]);
  assert.deepEqual([...hits(env, "1").names], []);
  assert.deepEqual([...hits(env, "2").names], ["ｻﾄｳ"]);
});

test("success: predHits は受付時間内の予想だけを見る（受付前・締め切り後の行は入らない）", () => {
  const env = predEnv([
    predRow(50, "早井", "3問"), // 受付前にフォームへ直接送った
    predRow(99.5, "境", "3問"), // 開ける1秒前まで（時計のずれの分）は入る
    predRow(130, "山田", "3問"),
    predRow(164, "滑込", "3問"), // 締め切り（160秒）の4秒後 → 入る
    predRow(170, "遅井", "3問"), // 締め切りの10秒後 → 入らない
    predRow(140, "佐藤", "3問"),
    predRow(200, "佐藤", "0問"), // 締め切り後の送り直しでは、受付中の予想は上書きされない
    predRow(141, "鈴木", "1問"),
    predRow(210, "鈴木", "3問"), // 締め切り後に結果を見てから送り直しても、的中にはならない
    ["", "時刻なし", "3問"], // タイムスタンプが無い行は入らない
  ]);
  assert.deepEqual([...hits(env, "3").names].sort(), ["佐藤", "境", "山田", "滑込"].sort());
  assert.equal(hits(env, "3").count, 4);
  assert.equal(hits(env, "0").count, 0);
  assert.deepEqual([...hits(env, "1").names], ["鈴木"]);

  // 予想を一度も受け付けていなければ、行があっても誰も入らない / 受付の記録を消したあとも同じ
  const never = load({ sheets: { [PRED_SHEET]: [PRED_HEADER, predRow(130, "山田", "3問")] } });
  assert.deepEqual([...hits(never, "3").names], []);
  env.get({ action: "reset", key: HOST_KEY });
  assert.equal(hits(env, "3").count, 0);

  // O キーで開け直した時間の予想は入る
  const reopened = predEnv([predRow(130, "山田", "3問"), predRow(405, "遅刻", "3問")]);
  reopened.setOpen("pred", 400);
  reopened.setOpen("none", 410);
  assert.equal(hits(reopened, "3").count, 2);
});

test("failed: predHits は司会キーが違う・無いときは名前を返さない", () => {
  const env = predEnv(PRED_ROWS);
  for (const key of [undefined, "", "wrong", HOST_KEY + "x", HOST_KEY.slice(0, -1), HOST_KEY.toUpperCase()]) {
    for (const n of [undefined, "3", "9"]) {
      const text = env.raw({ action: "predHits", key, n });
      assert.deepEqual(Object.keys(JSON.parse(text)), ["error", "message"]);
      assert.equal(JSON.parse(text).error, "unauthorized");
      for (const name of ["たなか", "さとう", "あいだ", "やまだ", "すずき", "山田"]) assert.ok(!text.includes(name), name);
    }
  }
  for (const props of [{}, { HOST_KEY: "short" }]) {
    const unset = load({ props, sheets: { [PRED_SHEET]: [PRED_HEADER, predRow(5, "たなか", "3問")] } });
    const text = unset.raw({ action: "predHits", key: props.HOST_KEY || "", n: "3" });
    assert.equal(JSON.parse(text).error, "not_configured");
    assert.ok(!text.includes("たなか"));
  }
});

test("failed: predHits の n が 0〜5 の整数でなければ bad_request（名前は返さない）", () => {
  const env = predEnv(PRED_ROWS);
  for (const n of [undefined, "", "6", "-1", "10", "03", "3.0", "1.5", "3問", "３", " 3", "abc", "NaN", "__proto__", "0x3", "1e0"]) {
    const text = env.raw({ action: "predHits", key: HOST_KEY, n });
    assert.deepEqual(Object.keys(JSON.parse(text)), ["error", "message"], String(n));
    assert.equal(JSON.parse(text).error, "bad_request", String(n));
    assert.ok(!text.includes("たなか"), String(n));
  }
});

test("failed: 予想のシートを読めなければ pred_error", () => {
  const env = load({ sheets: {} });
  assert.equal(hits(env, "3").error, "pred_error");
  const noTs = load({ sheets: { [PRED_SHEET]: [PRED_HEADER.slice(1), ["山田", "3問"]] } });
  const text = noTs.raw({ action: "predHits", key: HOST_KEY, n: "3" });
  assert.equal(JSON.parse(text).error, "pred_error");
  assert.ok(!text.includes("山田"));
});

test("success: 司会キーのない応答には、どの呼び出しでも名前が含まれない（predHits を呼んだあとも）", () => {
  const env = predEnv(PRED_ROWS);
  assert.equal(hits(env, "3").count, 4); // 司会キー付きで名前を取得したあとでも、キャッシュなどから漏れない
  const names = ["たなか", "さとう", "あいだ", "やまだ", "すずき", "山田", "太郎", "クイズだけの人"];
  const actions = [undefined, "state", "predHits", "answers", "slides", "setOpen", "reset", "unknown"];
  for (const action of actions) {
    for (const extra of [{}, { n: "3" }, { n: "3", key: "wrong" }, { n: "3", key: "" }, { n: "3", callback: "cb" }]) {
      const text = env.raw({ action, ...extra });
      for (const name of names) assert.ok(!text.includes(name), JSON.stringify({ action, ...extra }) + " " + name);
      assert.ok(!text.includes("names"), JSON.stringify({ action, ...extra }));
    }
  }
  for (const value of env.cacheStore.values()) for (const name of names) assert.ok(!String(value).includes(name));
  // 司会キー付きでも、名前を返すのは predHits だけ
  for (const params of [{}, { action: "state" }, { action: "answers" }, { action: "setOpen", target: "idle" }]) {
    const text = env.raw({ ...params, key: HOST_KEY });
    for (const name of names) assert.ok(!text.includes(name), JSON.stringify(params) + " " + name);
  }
  // JSONP でも返せる（司会キー付き）
  const jsonp = env.doGet({ parameter: { action: "predHits", key: HOST_KEY, n: "2", callback: "cb1" } });
  assert.equal(jsonp.mime, "JAVASCRIPT");
  assert.match(jsonp.text, /^cb1\(\{.*"names":\["やまだ"\].*\}\);$/);
});

/* ===== クイズの成績の順位（?action=ranking） ===== */

/** 第1問〜第10問の正解がすべて同じ文字の「正解」タブ。 */
const answerSheet = (value = "A", numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) => [["問題番号", "正解"], ...numbers.map((no) => [no, value])];
/** 第 no 問の受付時間は no×100 秒 〜 (no+1)×100 秒。その中（+ offset 秒）に記録された回答の行。 */
const answerRow = (name, no, value, offset = 10) => quizRow(no * 100 + offset, name, no, value);
/** 正解がすべて A のとき、score 問だけ正解した人の行（第1問から score 問は A、残りは B）。 */
const scoreRows = (name, score) => Array.from({ length: 10 }, (_, i) => answerRow(name, i + 1, i < score ? "A" : "B"));
/** { 名前: 正解数 } から、クイズのシートの行を作る。 */
const scoreSheet = (scores) => Object.entries(scores).flatMap(([name, score]) => scoreRows(name, score));

/** 第1問〜第10問の受付を順に開けて締め切った環境。rows はクイズのシートの行（見出しを除く）。 */
function rankEnv(rows, answers = answerSheet()) {
  const sheets = { [QUIZ_SHEET]: [QUIZ_HEADER, ...rows], [PRED_SHEET]: [PRED_HEADER, predRow(5, "予想だけの人", "3問")] };
  if (answers) sheets["正解"] = answers;
  const env = load({ sheets });
  for (let no = 1; no <= 10; no++) env.setOpen("q" + no, no * 100);
  env.setOpen("none", 1100);
  env.at(2000);
  return env;
}
const ranking = (env, limit) => env.get({ action: "ranking", key: HOST_KEY, limit });
/** 組を [順位, 正解数, 名前…] の配列にする。 */
const groupsOf = (res) => res.groups.map((g) => [g.place, g.score, ...g.names]);
const cutoffOf = (res) => (res.cutoff ? [res.cutoff.place, res.cutoff.slots, ...res.cutoff.names] : null);

const SEVEN = { あおき: 9, いとう: 8, うえの: 8, えんどう: 7, おおた: 7, かとう: 7, きむら: 5 };

test("success: ranking は正解数の多い順に組を返し、景品の数をまたぐ同点の組を cutoff にする", () => {
  const res = ranking(rankEnv(scoreSheet(SEVEN)), "5");
  assert.deepEqual(Object.keys(res).sort(), ["answered", "cutoff", "groups", "limit", "total", "updatedAt"]);
  assert.equal(res.total, 7);
  assert.equal(res.limit, 5);
  assert.deepEqual([...res.answered], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // [9, 8, 8, 7, 7, 7, 5]・景品 5つ → 1位(1人) 2位(2人) 4位(3人)。4位の3人で、残り2枠
  assert.deepEqual(groupsOf(res), [[1, 9, "あおき"], [2, 8, "いとう", "うえの"], [4, 7, "えんどう", "おおた", "かとう"]]);
  assert.deepEqual(cutoffOf(res), [4, 2, "えんどう", "おおた", "かとう"]);
  assert.ok(!JSON.stringify(res).includes("きむら")); // 景品に届かない人は返さない
});

test("success: ranking の順位と cutoff / slots の決まり", () => {
  const tests = {
    "success: limit を省くと 5": [SEVEN, undefined, [[1, 9, 1], [2, 8, 2], [4, 7, 3]], [4, 2]],
    "success: ちょうど届く組は cutoff にしない": [SEVEN, "3", [[1, 9, 1], [2, 8, 2]], null],
    "success: 2位の同点が景品 2つをまたぐ": [SEVEN, "2", [[1, 9, 1], [2, 8, 2]], [2, 1]],
    "success: 景品 1つ": [SEVEN, "1", [[1, 9, 1]], null],
    "success: 景品 6つ（4位の3人まででちょうど）": [SEVEN, "6", [[1, 9, 1], [2, 8, 2], [4, 7, 3]], null],
    "success: 景品が人数より多ければ全員": [SEVEN, "30", [[1, 9, 1], [2, 8, 2], [4, 7, 3], [7, 5, 1]], null],
    "success: 1位が同点で景品 1つ": [{ あ: 9, い: 9, う: 8 }, "1", [[1, 9, 2]], [1, 1]],
    "success: 1位が同点で景品 2つ": [{ あ: 9, い: 9, う: 8 }, "2", [[1, 9, 2]], null],
    "success: 同点のあとの順位は人数ぶん飛ぶ": [{ あ: 9, い: 9, う: 8, え: 7 }, "5", [[1, 9, 2], [3, 8, 1], [4, 7, 1]], null],
    "success: 0問正解の人も、枠が余っていれば入る": [{ あ: 3, い: 0, う: 0 }, "5", [[1, 3, 1], [2, 0, 2]], null],
    "success: 0問正解の人は、枠が埋まっていれば出ない": [{ あ: 5, い: 4, う: 3, え: 2, お: 1, か: 0, き: 0 }, "5", [[1, 5, 1], [2, 4, 1], [3, 3, 1], [4, 2, 1], [5, 1, 1]], null],
    "success: 全員 0問正解で景品より多い": [{ あ: 0, い: 0, う: 0 }, "2", [[1, 0, 3]], [1, 2]],
    "success: 全員が同点": [{ あ: 6, い: 6, う: 6, え: 6, お: 6, か: 6 }, "5", [[1, 6, 6]], [1, 5]],
    "success: 1人だけ": [{ あ: 4 }, "5", [[1, 4, 1]], null],
  };
  for (const [name, [scores, limit, wantGroups, wantCutoff]] of Object.entries(tests)) {
    const res = ranking(rankEnv(scoreSheet(scores)), limit);
    assert.deepEqual(res.groups.map((g) => [g.place, g.score, g.names.length]), wantGroups, name);
    assert.deepEqual(res.cutoff ? [res.cutoff.place, res.cutoff.slots] : null, wantCutoff, name);
    assert.equal(res.total, Object.keys(scores).length, name);
    // cutoff の名前は、その順位の組の名前と同じ。枠は「1人以上・その組の人数未満」
    if (res.cutoff) {
      assert.deepEqual([...res.cutoff.names], [...res.groups.at(-1).names], name);
      assert.ok(res.cutoff.slots >= 1 && res.cutoff.slots < res.cutoff.names.length, name);
    }
  }
});

test("success: ranking は誰も答えていなければ、空の一覧を返す", () => {
  const res = ranking(rankEnv([]), "5");
  assert.deepEqual([res.total, [...res.groups], res.cutoff], [0, [], null]);
});

test("success: ranking の組の中は日本語の並び順。名前は前後の空白を除く", () => {
  const rows = [...scoreRows("たなか", 3), ...scoreRows("　あいだ　", 3), ...scoreRows("さとう", 3), ...scoreRows("山田  太郎", 3)];
  assert.deepEqual(groupsOf(ranking(rankEnv(rows), "5")), [[1, 3, "あいだ", "さとう", "たなか", "山田 太郎"]]);
});

test("success: ranking は同じ名前 × 同じ問題の最新の回答だけを採点する", () => {
  const env = rankEnv([
    answerRow("たなか", 1, "B", 10),
    answerRow("たなか", 1, "A", 20), // 不正解 → 正解 に送り直した
    answerRow("さとう", 1, "A", 10),
    answerRow("さとう", 1, "B", 20), // 正解 → 不正解 に送り直した
    answerRow("さとう", 2, "A"),
    answerRow(" さとう ", 3, "A"), // 空白のゆれは同じ人
    answerRow("ＡＢＣ", 1, "A"),
    answerRow("ABC", 2, "A"), // 全角/半角のゆれは同じ人。名前はいちばん新しい行の書き方で出す
    answerRow("ABC", 2, "ａ", 30), // 同じ回答の送り直しは1問ぶん（全角・小文字も同じ回答）
    answerRow("", 1, "A"), // 名前のない行は、誰か分からないので順位に入れない
    answerRow("", 2, "A"),
    answerRow("すずき", 4, "E"), // 選択肢にない値は回答に数えない
  ]);
  const res = ranking(env, "5");
  assert.deepEqual(groupsOf(res), [[1, 2, "ABC", "さとう"], [3, 1, "たなか"]]);
  assert.equal(res.total, 3);
  assert.equal(res.cutoff, null);
});

test("success: ranking は受付時間内の回答だけを採点する（受付前・締め切り後の行は入らない）", () => {
  const env = rankEnv([
    quizRow(50, "早井", 1, "A"), // 受付前にフォームへ直接送った
    quizRow(99.5, "境", 1, "A"), // 開ける1秒前まで（時計のずれの分）は入る
    answerRow("山田", 1, "A"),
    answerRow("山田", 2, "A"),
    quizRow(250, "山田", 1, "B"), // 締め切り後の送り直しでは、受付中の回答は上書きされない
    answerRow("佐藤", 1, "B"),
    quizRow(250, "佐藤", 1, "A"), // 締め切り後に正解を見てから送り直しても、正解にはならない
    quizRow(1104, "滑込", 10, "A"), // 第10問の締め切り（1100秒）の4秒後 → 入る
    quizRow(1110, "遅井", 10, "A"), // 締め切りの10秒後 → 入らない
    quizRow(350, "先回り", 9, "A"), // 第9問はまだ受け付けていない時刻 → 入らない
    ["", "時刻なし", "A", ...Array(9).fill("")], // タイムスタンプが無い行は入らない
  ]);
  const res = ranking(env, "30");
  assert.deepEqual(groupsOf(res), [[1, 2, "山田"], [2, 1, "滑込", "境"], [4, 0, "佐藤"]]); // 漢字は読みではなく文字の順
  assert.equal(res.total, 4);

  // クイズを一度も受け付けていなければ、行があっても誰も入らない / 受付の記録を消したあとも同じ
  const never = load({ sheets: { [QUIZ_SHEET]: [QUIZ_HEADER, answerRow("山田", 1, "A")], 正解: answerSheet() } });
  assert.deepEqual([ranking(never, "5").total, [...ranking(never, "5").groups]], [0, []]);
  env.get({ action: "reset", key: HOST_KEY });
  assert.equal(ranking(env, "5").total, 0);

  // O キーで開け直した時間の回答は入る
  const reopened = rankEnv([answerRow("山田", 1, "A"), quizRow(1505, "遅刻", 1, "A")]);
  reopened.setOpen("q1", 1500);
  reopened.setOpen("none", 1510);
  reopened.at(2000);
  const again = ranking(reopened, "5");
  assert.deepEqual(again.groups.map((g) => [g.place, g.score]), [[1, 1]]);
  assert.deepEqual([...again.groups[0].names].sort(), ["山田", "遅刻"].sort());
});

test("success: ranking は正解が書かれた問題だけを採点し、その番号を answered で返す", () => {
  const rows = [...scoreRows("たなか", 10), ...scoreRows("さとう", 2), ...scoreRows("すずき", 0)];
  // 正解が第1問・第2問・第10問にだけ書かれている（ほかは未記入）
  const partial = ranking(rankEnv(rows, answerSheet("A", [10, 1, 2])), "5");
  assert.deepEqual([...partial.answered], [1, 2, 10]);
  assert.deepEqual(groupsOf(partial), [[1, 3, "たなか"], [2, 2, "さとう"], [3, 0, "すずき"]]);
  // 正解の書き方のゆれ（全角・小文字・「第3問」）と、想定外の行（E・空欄・範囲外）
  const messy = ranking(rankEnv(rows, [["問題番号", "正解"], ["第3問", "ａ"], [4, "E"], [5, ""], [11, "A"], ["", "A"]]), "5");
  assert.deepEqual([...messy.answered], [3]);
  assert.deepEqual(groupsOf(messy), [[1, 1, "たなか"], [2, 0, "さとう", "すずき"]]);
  // 正解が A でないとき
  const other = ranking(rankEnv(rows, answerSheet("B")), "5");
  assert.deepEqual(groupsOf(other), [[1, 10, "すずき"], [2, 8, "さとう"], [3, 0, "たなか"]]);
});

test("failed: 「正解」タブが無い・正解が1つも無いときは answers_error、クイズのシートを読めなければ ranking_error（名前は返さない）", () => {
  const rows = scoreSheet(SEVEN);
  const names = Object.keys(SEVEN);
  const tests = {
    "failed: 「正解」タブが無い": [rankEnv(rows, null), "answers_error", /正解を読めません.*正解/],
    "failed: 「正解」タブに見出ししか無い": [rankEnv(rows, [["問題番号", "正解"]]), "answers_error", /1つも書かれていません/],
    "failed: 「正解」タブに有効な行が無い": [rankEnv(rows, [["問題番号", "正解"], [1, "E"], [11, "A"], [2, ""]]), "answers_error", /1つも書かれていません/],
    "failed: クイズのタブが無い": [load({ sheets: { 正解: answerSheet() } }), "ranking_error", /クイズの回答を読めません/],
    "failed: タイムスタンプの列が無い": [load({ sheets: { [QUIZ_SHEET]: [QUIZ_HEADER.slice(1), ["あおき", "A"]], 正解: answerSheet() } }), "ranking_error", /タイムスタンプ/],
  };
  for (const [name, [env, error, message]] of Object.entries(tests)) {
    const text = env.raw({ action: "ranking", key: HOST_KEY, limit: "5" });
    const res = JSON.parse(text);
    assert.deepEqual(Object.keys(res), ["error", "message"], name);
    assert.equal(res.error, error, name);
    assert.match(res.message, message, name);
    for (const who of names) assert.ok(!text.includes(who), name + " " + who);
  }
});

test("failed: ranking は司会キーが違う・無いときは名前も正解数も返さない", () => {
  const env = rankEnv(scoreSheet(SEVEN));
  for (const key of [undefined, "", "wrong", HOST_KEY + "x", HOST_KEY.slice(0, -1), HOST_KEY.toUpperCase()]) {
    for (const limit of [undefined, "5", "99"]) {
      const text = env.raw({ action: "ranking", key, limit });
      assert.deepEqual(Object.keys(JSON.parse(text)), ["error", "message"]);
      assert.equal(JSON.parse(text).error, "unauthorized");
      for (const who of Object.keys(SEVEN)) assert.ok(!text.includes(who), who);
      assert.ok(!/groups|score|place/.test(text));
    }
  }
  for (const props of [{}, { HOST_KEY: "short" }]) {
    const unset = load({ props, sheets: { [QUIZ_SHEET]: [QUIZ_HEADER, ...scoreRows("たなか", 3)], 正解: answerSheet() } });
    const text = unset.raw({ action: "ranking", key: props.HOST_KEY || "", limit: "5" });
    assert.equal(JSON.parse(text).error, "not_configured");
    assert.ok(!text.includes("たなか"));
  }
});

test("failed: ranking の limit が 1〜30 の整数でなければ bad_request（名前は返さない）", () => {
  const env = rankEnv(scoreSheet(SEVEN));
  for (const limit of ["0", "31", "99", "100", "-1", "05", "5.0", "1.5", "5人", "５", " 5", "5 ", "abc", "NaN", "__proto__", "0x5", "1e1", "Infinity"]) {
    const text = env.raw({ action: "ranking", key: HOST_KEY, limit });
    assert.deepEqual(Object.keys(JSON.parse(text)), ["error", "message"], limit);
    assert.equal(JSON.parse(text).error, "bad_request", limit);
    assert.match(JSON.parse(text).message, /1〜30/, limit);
    for (const who of Object.keys(SEVEN)) assert.ok(!text.includes(who), limit);
  }
  // 省略・空なら 5。1 と 30 は受け付ける
  for (const [limit, want] of [[undefined, 5], ["", 5], ["1", 1], ["5", 5], ["10", 10], ["30", 30]]) {
    const res = ranking(env, limit);
    assert.equal(res.error, undefined, String(limit));
    assert.equal(res.limit, want, String(limit));
  }
});

test("success: 司会キーのない応答には、どの呼び出しでも名前・正解数が含まれない（ranking を呼んだあとも）", () => {
  const env = rankEnv(scoreSheet(SEVEN));
  assert.equal(ranking(env, "5").groups.length, 3); // 司会キー付きで取得したあとでも、キャッシュなどから漏れない
  const names = [...Object.keys(SEVEN), "予想だけの人"];
  const actions = [undefined, "state", "ranking", "predHits", "answers", "slides", "setOpen", "reset", "unknown"];
  for (const action of actions) {
    for (const extra of [{}, { limit: "5" }, { limit: "5", key: "wrong" }, { limit: "5", key: "" }, { limit: "5", callback: "cb" }]) {
      const text = env.raw({ action, ...extra });
      for (const who of names) assert.ok(!text.includes(who), JSON.stringify({ action, ...extra }) + " " + who);
      assert.ok(!/names|groups|cutoff|score|answered/.test(text), JSON.stringify({ action, ...extra }));
    }
  }
  for (const value of env.cacheStore.values()) for (const who of names) assert.ok(!String(value).includes(who));
  // 司会キー付きでも、名前を返すのは ranking と predHits だけ
  for (const params of [{}, { action: "state" }, { action: "answers" }, { action: "setOpen", target: "idle" }]) {
    const text = env.raw({ ...params, key: HOST_KEY });
    for (const who of names) assert.ok(!text.includes(who), JSON.stringify(params) + " " + who);
  }
  // 人数の集計は、これまでと同じ形のまま（名前を持ち回すようになっても、公開する応答は変わらない）
  const stats = env.get();
  assert.deepEqual(Object.keys(stats).sort(), ["pred", "quiz", "state", "updatedAt"]);
  assert.deepEqual({ ...stats.quiz["1"] }, { total: 7 });
  assert.deepEqual({ ...env.buildStats_(env.readGate_()).quiz["1"] }, { A: 7, B: 0, C: 0, D: 0, total: 7 });
  // JSONP でも返せる（司会キー付き）
  const jsonp = env.doGet({ parameter: { action: "ranking", key: HOST_KEY, limit: "1", callback: "cb1" } });
  assert.equal(jsonp.mime, "JAVASCRIPT");
  assert.match(jsonp.text, /^cb1\(\{.*"groups":\[\{"place":1,"score":9,"names":\["あおき"\]\}\],"cutoff":null\}\);$/);
});

test("success: testRanking は順位ごとの人数だけをログに出す（名前は出さない）", () => {
  const env = rankEnv(scoreSheet(SEVEN));
  const logs = [];
  env.Logger.log = (line) => logs.push(String(line));
  env.testRanking();
  const text = logs.join("\n");
  assert.match(text, /1位: 9問正解 × 1人/);
  assert.match(text, /2位: 8問正解 × 2人/);
  assert.match(text, /4位の 3人で残り 2枠/);
  for (const who of Object.keys(SEVEN)) assert.ok(!text.includes(who), who);
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
  "success: 予想結果（題名）": [["以心伝心ゲーム", "予想結果"], { kind: "predResult" }],
  "success: 予想の結果 / 全角・空白・改行": [["予想 の\n結果　"], { kind: "predResult" }],
  "success: 予想結果発表！": [["予想結果発表！"], { kind: "predResult" }],
  "success: 以心伝心ゲーム 予想の結果発表": [["以心伝心ゲーム 予想の結果発表"], { kind: "predResult" }],
  "success: 予想的中者発表": [["予想的中者発表："], { kind: "predResult" }],
  "success: 予想結果のスライドに 何問そろ があっても、予想の受付は開けない": [["予想結果", "新郎新婦の答えは 何問そろったでしょう？"], { kind: "predResult" }],
  "success: 予想タイム は予想結果ではない": [["予想タイム", "結果はあとで発表します"], { kind: "prediction" }],
  "success: 文中の 予想 と 結果 は目印ではない": [["予想の結果は最後に発表します", "結果を予想してみましょう"], { kind: "slide" }],
  "success: 結果発表 だけでは予想結果ではない": [["結果発表", "的中者"], { kind: "slide" }],
  "success: 問題の題名は予想結果より優先": [["Q3", "予想結果"], { kind: "question", question: 3 }],
  "success: ランキング（題名）": [["クイズ大会", "ランキング"], { kind: "ranking" }],
  "success: クイズランキング / 全角・空白・改行": [["クイズ\nランキング　"], { kind: "ranking" }],
  "success: 成績発表": [["成績発表"], { kind: "ranking" }],
  "success: ランキング発表！ / クイズ成績発表 / クイズのランキング": [["ランキング発表！"], { kind: "ranking" }],
  "success: クイズ成績発表": [["クイズ成績発表："], { kind: "ranking" }],
  "success: クイズのランキング": [["クイズのランキング"], { kind: "ranking" }],
  "success: 半角カナの ﾗﾝｷﾝｸﾞ": [["ﾗﾝｷﾝｸﾞ"], { kind: "ranking" }],
  "success: 続きのある ランキング は目印ではない": [["ランキングは最後に発表します", "ランキング上位に景品"], { kind: "slide" }],
  "success: 成績 / 結果発表 / クイズ だけではランキングではない": [["成績", "結果発表", "クイズ", "クイズ結果"], { kind: "slide" }],
  "success: 問題の題名はランキングより優先": [["Q3", "ランキング"], { kind: "question", question: 3 }],
  "success: 予想結果はランキングより優先": [["予想結果", "ランキング"], { kind: "predResult" }],
  "success: ランキングのスライドに 何問そろ があっても、予想の受付は開けない": [["ランキング", "何問そろったでしょう"], { kind: "ranking" }],
  "success: 予想タイム はランキングではない": [["予想タイム", "ランキングはあとで"], { kind: "prediction" }],
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

test("success: 予想結果のスライドは predResult で返す（2枚目は普通のスライド。文字は返さない）", () => {
  const deck = [
    slide("r1", [shape("予想タイム"), shape("何問そろいますか？")]),
    slide("r2", [shape("以心伝心ゲーム"), group(shape("予想結果"))]),
    slide("r3", [shape("予想結果"), shape("おめでとうございます")]),
  ];
  const out = load({ slides: deck }).doGet({ parameter: { action: "slides", key: HOST_KEY } });
  assert.deepEqual(JSON.parse(out.text).slides.map((s) => [s.objectId, s.kind]), [["r1", "prediction"], ["r2", "predResult"], ["r3", "slide"]]);
  assert.ok(!out.text.includes("予想結果"));
});

test("success: ランキングのスライドは ranking で返す（2枚目は普通のスライド。文字は返さない）", () => {
  const deck = [
    slide("k1", [shape("Q1"), shape("問題文")]),
    slide("k2", [shape("予想結果")]),
    slide("k3", [shape("クイズ大会"), group(shape("ランキング"))]),
    slide("k4", [shape("成績発表"), shape("おめでとうございます")]),
  ];
  const env = load({ slides: deck });
  const out = env.doGet({ parameter: { action: "slides", key: HOST_KEY } });
  assert.deepEqual(JSON.parse(out.text).slides.map((s) => [s.objectId, s.kind]), [["k1", "question"], ["k2", "predResult"], ["k3", "ranking"], ["k4", "slide"]]);
  assert.ok(!out.text.includes("ランキング") && !out.text.includes("成績"));
  env.testSlides();
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
