/*
 * 司会画面の「予想結果」のスライドの進み方（js/pred-result.js）と、デモ・仮のスライドのテスト。
 *
 *   node --test js/test/pred-result.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { PRED_START, PRED_MAX, matchedCountOf, namesReady, predStep, stepPred, hitsNote, normalizePredHits, namesLayout, nameWidth, nameScale } =
  await import("../pred-result.js");
const { panelSlides } = await import("../host-panel.js");
const { createDemoBackend } = await import("../host-demo.js");
const { SECTIONS } = await import("../config.js");

const ok = (n, names = ["あ", "い"]) => ({ n, status: "ok", count: names.length, names });
const loading = (n) => ({ n, status: "loading" });

test("success: PRED_MAX は予想の選択肢（0問〜5問）と合っている", () => {
  const choices = SECTIONS.find((s) => s.id === "pred").choices;
  assert.equal(choices.length, PRED_MAX + 1);
  assert.equal(choices[PRED_MAX], PRED_MAX + "問");
});

test("success: matchedCountOf は 0〜5 のキーだけを数にする", () => {
  const tests = {
    "success: 0": ["0", 0],
    "success: 3": ["3", 3],
    "success: 5": ["5", 5],
    "success: 6 は範囲外": ["6", null],
    "success: 9 は範囲外": ["9", null],
    "success: 文字のキー": ["a", null],
    "success: 矢印キー": ["ArrowRight", null],
    "success: 全角の数字": ["３", null],
    "success: 2桁": ["10", null],
    "success: 文字列でない": [3, null],
  };
  for (const [name, [key, want]] of Object.entries(tests)) assert.equal(matchedCountOf(key), want, name);
});

test("success: 数を入れる → → で名前 → → で次のスライド（← で1段ずつ戻る）", () => {
  let pred = PRED_START;
  assert.equal(predStep(pred, null), "input");

  // 数を入れると「そろったのは」の段へ
  pred = stepPred(pred, 3, null).pred;
  assert.deepEqual(pred, { n: 3, step: "count" });

  // 名前を取得中でも、→ で名前の段へ進める（「読み込み中…」と出す）
  let result = stepPred(pred, "advance", loading(3));
  assert.deepEqual(result, { pred: { n: 3, step: "names" }, leave: null });
  pred = result.pred;
  assert.equal(predStep(pred, ok(3)), "names");

  // 名前の段から → で次のスライドへ
  assert.equal(stepPred(pred, "advance", ok(3)).leave, "next");

  // ← で 名前 → そろったのは → 入力 → 前のスライド
  result = stepPred(pred, "retreat", ok(3));
  assert.deepEqual(result, { pred: { n: 3, step: "count" }, leave: null });
  result = stepPred(result.pred, "retreat", ok(3));
  assert.deepEqual(result, { pred: PRED_START, leave: null });
  assert.equal(stepPred(result.pred, "retreat", ok(3)).leave, "prev");
});

test("success: 数を入れずに → を押すと、そのまま次のスライドへ", () => {
  assert.deepEqual(stepPred(PRED_START, "advance", null), { pred: PRED_START, leave: "next" });
});

test("success: どの段からでも、別の数を押すと入れ直せる（範囲外の数は無視する）", () => {
  assert.deepEqual(stepPred({ n: 3, step: "count" }, 4, ok(3)).pred, { n: 4, step: "count" });
  assert.deepEqual(stepPred({ n: 3, step: "names" }, 0, ok(3)).pred, { n: 0, step: "count" });
  assert.deepEqual(stepPred({ n: 3, step: "names" }, 3, ok(3)).pred, { n: 3, step: "count" });
  for (const bad of [6, -1, 1.5, NaN]) assert.deepEqual(stepPred({ n: 3, step: "names" }, bad, ok(3)).pred, { n: 3, step: "names" });
});

test("success: 名前を取得できないとき（司会キーなし・古い Code.gs・通信エラー）は、名前の段を飛ばす", () => {
  for (const status of ["nokey", "unsupported", "error", "failed"]) {
    const hits = { n: 3, status };
    assert.equal(namesReady(hits, 3), false, status);
    assert.deepEqual(stepPred({ n: 3, step: "count" }, "advance", hits), { pred: { n: 3, step: "count" }, leave: "next" }, status);
    // 名前の段に進んだあとで取得に失敗したら、「そろったのは」の表示に戻り、→ で次のスライドへ進める
    assert.equal(predStep({ n: 3, step: "names" }, hits), "count", status);
    assert.equal(stepPred({ n: 3, step: "names" }, "advance", hits).leave, "next", status);
    assert.deepEqual(stepPred({ n: 3, step: "names" }, "retreat", hits), { pred: PRED_START, leave: null }, status);
  }
  // まだ取得を始めていない・前の数の結果しかない
  assert.equal(namesReady(null, 3), false);
  assert.equal(namesReady(ok(2), 3), false);
  assert.equal(stepPred({ n: 3, step: "count" }, "advance", ok(2)).leave, "next");
});

test("success: 次のスライドから ← で戻ってきたら、発表した続き（名前の段）から", () => {
  assert.deepEqual(stepPred({ n: 3, step: "names" }, "return", ok(3)).pred, { n: 3, step: "names" });
  assert.deepEqual(stepPred({ n: 3, step: "count" }, "return", ok(3)).pred, { n: 3, step: "names" });
  assert.deepEqual(stepPred(PRED_START, "return", null).pred, PRED_START);
  // 名前を映せなかった場合は「そろったのは」が映る
  assert.equal(predStep(stepPred({ n: 3, step: "count" }, "return", { n: 3, status: "nokey" }).pred, { n: 3, status: "nokey" }), "count");
});

test("success: 名前を映せない理由（司会者への知らせ）", () => {
  assert.equal(hitsNote({ n: 3, status: "nokey" }, 3), "名前を表示するには司会キーが必要です");
  assert.equal(hitsNote({ n: 3, status: "unsupported" }, 3), "名前を表示するには Apps Script を更新してください");
  assert.match(hitsNote({ n: 3, status: "error" }, 3), /名前を取得できません/);
  assert.equal(hitsNote({ n: 3, status: "failed", message: "予想を読めません" }, 3), "名前を表示できません: 予想を読めません");
  assert.equal(hitsNote(ok(3), 3), "");
  assert.equal(hitsNote(loading(3), 3), "");
  assert.equal(hitsNote({ n: 2, status: "nokey" }, 3), ""); // 前の数の結果
  assert.equal(hitsNote(null, null), "");
  assert.equal(hitsNote(null, 3), "");
});

test("success: normalizePredHits は応答の形を確かめる", () => {
  assert.deepEqual(normalizePredHits({ n: 3, count: 2, names: [" 山田 ", "佐藤"] }, 3), { n: 3, count: 2, names: ["山田", "佐藤"] });
  // 名前のない回答は人数にだけ入る / 文字列でないものは捨てる / 人数は名前の数より小さくならない
  assert.deepEqual(normalizePredHits({ n: 3, count: 3, names: ["山田", "", null, 5] }, 3), { n: 3, count: 3, names: ["山田"] });
  assert.deepEqual(normalizePredHits({ n: 0, count: "x", names: ["山田"] }, 0), { n: 0, count: 1, names: ["山田"] });
  assert.deepEqual(normalizePredHits({ n: 0, count: 0, names: [] }, 0), { n: 0, count: 0, names: [] });
});

test("failed: normalizePredHits は想定外の応答（古い Code.gs の人数の JSON など）を null にする", () => {
  const tests = {
    "failed: 人数の JSON": [{ updatedAt: "x", quiz: {}, pred: { total: 3 } }, 3],
    "failed: 別の数の結果": [{ n: 2, count: 0, names: [] }, 3],
    "failed: names が配列でない": [{ n: 3, count: 1, names: "山田" }, 3],
    "failed: n がない": [{ count: 1, names: [] }, 3],
    "failed: null": [null, 3],
    "failed: 文字列": ["oops", 3],
  };
  for (const [name, [data, n]] of Object.entries(tests)) assert.equal(normalizePredHits(data, n), null, name);
});

test("success: namesLayout は人数に合わせて列の数と文字の大きさを決める（30人は 5列×6段）", () => {
  assert.equal(namesLayout(30).columns, 5);
  assert.equal(Math.ceil(30 / namesLayout(30).columns), 6);
  assert.equal(namesLayout(1).columns, 1);
  assert.equal(namesLayout(2).columns, 2);
  assert.equal(namesLayout(0).columns, 1);
  assert.equal(namesLayout(6).columns, 3);
  assert.equal(namesLayout(12).columns, 4);
  assert.equal(namesLayout(42).columns, 6);
  assert.equal(namesLayout(80).columns, 7);
  // 人数が増えるほど文字は小さくなる。どの段階でも、全角5文字（「山田 太郎」など）は縮めずに収まる
  let font = Infinity;
  for (const count of [1, 6, 7, 12, 13, 20, 21, 30, 31, 42, 43, 80]) {
    const layout = namesLayout(count);
    assert.ok(layout.font <= font, String(count));
    assert.ok(layout.fit >= 5.5, String(count));
    font = layout.font;
  }
  // 1920×1080 に収まる: 横は 90vw（= 160vh）以内、縦は名前の領域（約 65vh）以内
  for (const count of [1, 6, 12, 20, 30, 42]) {
    const layout = namesLayout(count);
    const rows = Math.ceil(count / layout.columns);
    assert.ok(layout.columns * layout.width + (layout.columns - 1) * 1.778 <= 160, "横 " + count);
    assert.ok(rows * (layout.font * 1.3 + 2.4 + 0.4) + (rows - 1) * 1.4 <= 65, "縦 " + count);
  }
});

test("success: nameScale は長い名前だけを縮める", () => {
  assert.equal(nameWidth("山田 太郎"), 4.35);
  assert.ok(nameWidth("Alex Morgan") < 7);
  const { fit } = namesLayout(30);
  assert.equal(nameScale("山田 太郎", fit), 1);
  assert.equal(nameScale("長谷川 はるか", fit), 1);
  const long = nameScale("勅使河原 ゆきのじょう", fit);
  assert.ok(long < 1 && long >= 0.45);
  assert.ok(nameWidth("勅使河原 ゆきのじょう") * long <= fit + 0.1);
  assert.equal(nameScale("あ".repeat(60), fit), 0.45);
  assert.equal(nameScale("", fit), 1);
});

test("success: 仮のスライドの最後に、予想結果のスライドがある", () => {
  const slides = panelSlides();
  assert.equal(slides.length, 12);
  assert.deepEqual(slides.map((s) => s.kind).slice(-2), ["prediction", "predResult"]);
  assert.equal(new Set(slides.map((s) => s.objectId)).size, slides.length);
  assert.match(slides.at(-1).imageUrl, /^data:image\/svg\+xml/);
});

test("success: デモは予想結果のスライドと、架空の名前を返す", async () => {
  const demo = createDemoBackend();
  const { slides } = await demo.loadSlides();
  const kinds = slides.map((s) => s.kind);
  assert.equal(kinds.filter((kind) => kind === "predResult").length, 1);
  assert.ok(kinds.indexOf("predResult") > kinds.indexOf("prediction")); // 予想より後ろ

  const counts = [];
  const all = [];
  for (let n = 0; n <= PRED_MAX; n++) {
    const raw = await demo.loadPredHits(n);
    const res = normalizePredHits(raw, n);
    assert.deepEqual(res, { n: raw.n, count: raw.count, names: raw.names }); // 本物と同じ形
    assert.equal(res.count, res.names.length);
    counts.push(res.count);
    all.push(...res.names);
  }
  assert.equal(counts[0], 0); // 的中なしの表示を確認できる
  assert.equal(counts[3], 30); // 30人の並びを確認できる
  assert.equal(new Set(all).size, all.length); // 同じ人が2つの数に入らない
});

test("failed: デモは範囲外の数を受け付けない", async () => {
  const demo = createDemoBackend();
  for (const n of [6, -1, 1.5, "3"]) await assert.rejects(demo.loadPredHits(n), { code: "bad_request" });
});
