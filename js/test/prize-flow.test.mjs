/*
 * 司会画面の、ランキングと景品のスライドを行き来する進み方（js/prize-flow.js）のテスト。
 *
 *   node --test js/test/prize-flow.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { PRIZE_MAX_PLACE, prizePlaceOf, prizeRun, prizeSteps, prizeFlow, flowPos, stepFlow, flowExit, inFlow } = await import("../prize-flow.js");
const { normalizeRanking, rankGroups, RANK_MAX_LIMIT } = await import("../ranking.js");
const { createDemoBackend } = await import("../host-demo.js");
const { panelSlides } = await import("../host-panel.js");

/** 正解数の一覧から、順位の取得状況（status: "ok"）を作る。 */
const ok = (scores, limit = 5) => ({
  status: "ok",
  data: normalizeRanking({ ...rankGroups(scores.map((score, i) => ({ name: "人" + (i + 1), score })), limit), answered: [1] }),
});
const prize = (place) => ({ kind: "prize", place });
const plain = { kind: "slide" };
const RANKING = { kind: "ranking" };
/** 表紙・ランキング・（後ろに続くスライド）の並び。ランキングは添字 1。 */
const deck = (...after) => [plain, RANKING, ...after];

/**
 * → を押し続けたときに映るものの並びを、読みやすい文字にする。
 * "R0" = ランキングのスライドだけ / "R2" = ランキングで下から2組 / "P2" = 2位の景品のスライド / "S4" = 添字4のスライドへ出る
 */
function walk(slides, ranking) {
  const flow = prizeFlow(slides, ranking);
  if (!flow) return null;
  const label = (step) => (step.prize ? "P" + step.prize.place : "R" + step.shown);
  const seen = [];
  let pos = 0;
  for (;;) {
    seen.push(label(flow.steps[pos]));
    const next = stepFlow(flow, pos, "advance");
    if (next.leave) {
      assert.equal(next.leave, "next");
      seen.push("S" + flowExit(flow, slides.length));
      return seen;
    }
    pos = next.pos;
  }
}

test("success: 順位を映したあとに、その順位の景品のスライドをはさむ", () => {
  const tests = {
    "success: 1位・2位(2人)・4位 と 2位・1位の景品（2位が同点でも、2位の組の直後）": {
      args: { scores: [9, 8, 8, 7, 7, 7, 5], after: [prize(2), prize(1), plain] },
      expected: ["R0", "R1", "R2", "P2", "R3", "P1", "S4"],
    },
    "success: 1位・2位・3位（同点なし）": {
      args: { scores: [9, 8, 7], after: [prize(2), prize(1), plain] },
      expected: ["R0", "R1", "R2", "P2", "R3", "P1", "S4"],
    },
    "success: 景品のスライドの並びが逆でも、順位に合わせて映す": {
      args: { scores: [9, 8, 7], after: [prize(1), prize(2), plain] },
      expected: ["R0", "R1", "R2", "P2", "R3", "P1", "S4"],
    },
    "success: 1位が同点2人で2位がいない → 2位の景品は、1位を映す直前": {
      args: { scores: [9, 9, 7, 6], after: [prize(2), prize(1), plain] },
      expected: ["R0", "R1", "R2", "P2", "R3", "P1", "S4"],
    },
    "success: 全員が1位 → 2位の景品 → 1位 → 1位の景品": {
      args: { scores: [4, 4, 4], after: [prize(2), prize(1), plain] },
      expected: ["R0", "P2", "R1", "P1", "S4"],
    },
    "success: 1人だけ": {
      args: { scores: [3], after: [prize(2), prize(1), plain] },
      expected: ["R0", "P2", "R1", "P1", "S4"],
    },
    "success: 3位・2位・1位の景品": {
      args: { scores: [9, 8, 7, 6], after: [prize(3), prize(2), prize(1), plain] },
      expected: ["R0", "R1", "R2", "P3", "R3", "P2", "R4", "P1", "S5"],
    },
    "success: 2位が同点2人で3位がいない → 3位の景品は、2位を映す直前": {
      args: { scores: [9, 8, 8, 6], after: [prize(3), prize(2), prize(1), plain] },
      expected: ["R0", "R1", "P3", "R2", "P2", "R3", "P1", "S5"],
    },
    "success: 2位の景品のスライドが無い（1位の景品だけ）": {
      args: { scores: [9, 8, 7], after: [prize(1), plain] },
      expected: ["R0", "R1", "R2", "R3", "P1", "S3"],
    },
    "success: 1位の景品のスライドが無い（2位の景品だけ）→ 1位を映したら次のスライドへ": {
      args: { scores: [9, 8, 7], after: [prize(2), plain] },
      expected: ["R0", "R1", "R2", "P2", "R3", "S3"],
    },
    "success: 同じ順位の景品が2枚 → 2枚目は進み方に入れず、終わったあとに並び順どおり映す": {
      args: { scores: [9, 8], after: [prize(2), prize(2), prize(1), plain] },
      expected: ["R0", "R1", "P2", "R2", "P1", "S3"],
    },
    "success: 景品のスライドが最後のスライド → 出る先がない（-1）": {
      args: { scores: [9, 8], after: [prize(2), prize(1)] },
      expected: ["R0", "R1", "P2", "R2", "P1", "S-1"],
    },
  };
  for (const [name, tt] of Object.entries(tests)) {
    assert.deepEqual(walk(deck(...tt.args.after), ok(tt.args.scores)), tt.expected, name);
  }
});

test("success: 順位を映せない・景品のスライドが続いていないときは、進み方を使わない（並び順どおり）", () => {
  const slides = deck(prize(2), prize(1), plain);
  const tests = {
    "success: まだ取得していない": { args: { slides, ranking: null } },
    "success: 取得中": { args: { slides, ranking: { status: "loading" } } },
    "success: 司会キーがない": { args: { slides, ranking: { status: "nokey" } } },
    "success: Code.gs が古い": { args: { slides, ranking: { status: "unsupported" } } },
    "success: 通信エラー": { args: { slides, ranking: { status: "error" } } },
    "success: 正解を読めない": { args: { slides, ranking: { status: "failed", message: "x" } } },
    "success: 誰も答えていない": { args: { slides, ranking: ok([]) } },
    "success: 景品のスライドが無い": { args: { slides: deck(plain), ranking: ok([9, 8]) } },
    "success: 景品のスライドがランキングのすぐ後ろではない": { args: { slides: deck(plain, prize(2), prize(1)), ranking: ok([9, 8]) } },
    "success: 景品のスライドがランキングより前": { args: { slides: [prize(2), prize(1), RANKING, plain], ranking: ok([9, 8]) } },
    "success: ランキングのスライドが無い": { args: { slides: [plain, prize(2), prize(1)], ranking: ok([9, 8]) } },
    "success: 順位のない景品（古い形）": { args: { slides: deck({ kind: "prize" }, plain), ranking: ok([9, 8]) } },
  };
  for (const [name, tt] of Object.entries(tests)) assert.equal(prizeFlow(tt.args.slides, tt.args.ranking), null, name);
});

test("success: ← は同じ順番を逆にたどり、最初まで戻ると前のスライドへ", () => {
  const slides = deck(prize(2), prize(1), plain);
  const flow = prizeFlow(slides, ok([9, 8, 8, 7, 7, 7, 5]));
  const forward = [];
  let pos = 0;
  for (;;) {
    forward.push(pos);
    const next = stepFlow(flow, pos, "advance");
    if (next.leave) break;
    pos = next.pos;
  }
  // 次のスライドから ← で戻ると、最後（1位の景品）から
  pos = stepFlow(flow, -1, "return").pos;
  assert.deepEqual(flow.steps[pos], { shown: 3, prize: { index: 3, place: 1 } });
  const backward = [];
  for (;;) {
    backward.push(pos);
    const prev = stepFlow(flow, pos, "retreat");
    if (prev.leave) {
      assert.equal(prev.leave, "prev");
      break;
    }
    pos = prev.pos;
  }
  assert.deepEqual(backward, [...forward].reverse());
  assert.deepEqual(forward, [0, 1, 2, 3, 4, 5]);
  // 途中で向きを変えても、1つずつ行き来する（2位の景品 ⇄ 1位）
  assert.deepEqual(stepFlow(flow, stepFlow(flow, 3, "advance").pos, "retreat"), { pos: 3, leave: null });
  assert.deepEqual(stepFlow(flow, 2, "unknown"), { pos: 2, leave: null });
});

test("success: flowPos は、いまのスライドと映している組の数から位置を決める", () => {
  const slides = deck(prize(2), prize(1), plain);
  const flow = prizeFlow(slides, ok([9, 8, 8, 7, 7, 7, 5])); // R0 R1 R2 P2 R3 P1
  const tests = {
    "success: ランキングのスライドだけ": { args: [1, 0], expected: 0 },
    "success: ランキングで2組（2位まで）": { args: [1, 2], expected: 2 },
    "success: ランキングで3組（1位まで）": { args: [1, 3], expected: 4 },
    "success: 2位の景品のスライド（組の数は見ない）": { args: [2, 0], expected: 3 },
    "success: 1位の景品のスライド": { args: [3, 3], expected: 5 },
    "success: 進み方の外（次のスライド）": { args: [4, 3], expected: -1 },
    "success: 進み方の外（前のスライド）": { args: [0, 0], expected: -1 },
  };
  for (const [name, tt] of Object.entries(tests)) assert.equal(flowPos(flow, ...tt.args), tt.expected, name);
  assert.deepEqual([2, 3, 4, 1, 0].map((index) => inFlow(flow, index)), [true, true, false, false, false]);
});

test("success: prizeRun はランキングのすぐ後ろに続く景品だけを、順位ごとに最初の1枚ずつ拾う", () => {
  const tests = {
    "success: 2位・1位": { args: deck(prize(2), prize(1), plain), expected: [[2, 2], [3, 1]] },
    "success: 普通のスライドで途切れる": { args: deck(prize(2), plain, prize(1)), expected: [[2, 2]] },
    "success: 同じ順位の2枚目は入れない": { args: deck(prize(2), prize(2), prize(1)), expected: [[2, 2], [4, 1]] },
    "success: 続いていない": { args: deck(plain, prize(1)), expected: [] },
    "success: ランキングが最後": { args: deck(), expected: [] },
  };
  for (const [name, tt] of Object.entries(tests)) assert.deepEqual(prizeRun(tt.args, 1).map((p) => [p.index, p.place]), tt.expected, name);
});

test("success: prizePlaceOf は 1〜30 の整数の順位だけを景品のスライドにする", () => {
  const tests = {
    "success: 2位": { args: prize(2), expected: 2 },
    "success: 30位": { args: prize(30), expected: 30 },
    "success: 0位": { args: prize(0), expected: null },
    "success: 31位": { args: prize(31), expected: null },
    "success: 文字列": { args: prize("2"), expected: null },
    "success: 小数": { args: prize(1.5), expected: null },
    "success: 順位なし": { args: { kind: "prize" }, expected: null },
    "success: 普通のスライドに place": { args: { kind: "slide", place: 2 }, expected: null },
    "success: スライドなし": { args: undefined, expected: null },
  };
  for (const [name, tt] of Object.entries(tests)) assert.equal(prizePlaceOf(tt.args), tt.expected, name);
  assert.equal(PRIZE_MAX_PLACE, RANK_MAX_LIMIT);
  assert.deepEqual(prizeSteps([], []), [{ shown: 0, prize: null }]);
});

test("success: デモと仮のスライドで、4位 → 2位 → 2位の景品 → 1位 → 1位の景品 → 次のスライド の流れになる", async () => {
  const demo = createDemoBackend();
  const { slides } = await demo.loadSlides();
  const ranking = { status: "ok", data: await demo.loadRanking(5) };
  assert.deepEqual(slides.slice(10).map((s) => [s.kind, s.place ?? null]), [["ranking", null], ["prize", 2], ["prize", 1], ["slide", null]]);
  assert.deepEqual(walk(slides, ranking), ["R0", "R1", "R2", "P2", "R3", "P1", "S13"]);
  // 仮のスライド（?panel=1）は景品のスライドが最後
  assert.deepEqual(walk(panelSlides(), ranking), ["R0", "R1", "R2", "P2", "R3", "P1", "S-1"]);
});
