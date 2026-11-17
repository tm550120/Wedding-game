/*
 * 回答ページの表示の種類（js/gate.js の guestMode）のテスト。
 *
 *   node --test js/test/guest-mode.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { guestMode, reduceGate, EMPTY_GATE } = await import("../gate.js");

const gate = (open, done, lastClosed = null) => ({ open, lastClosed, done, rev: 7 });

test("予想が締め切り済みで、何も受け付けていなければ finished", () => {
  assert.equal(guestMode(gate(null, ["q1", "pred"])), "finished");
  // 予想を締め切った直後（lastClosed が pred）も、そのまま finished
  assert.equal(guestMode(gate(null, ["q1", "pred"], "pred")), "finished");
});

test("何かを受け付けていれば、予想が締め切り済みでも question", () => {
  assert.equal(guestMode(gate("q3", ["q1", "pred"])), "question");
  assert.equal(guestMode(gate("pred", ["q1"])), "question");
});

test("開け直した問題を締め切ると、finished に戻る", () => {
  assert.equal(guestMode(gate(null, ["pred", "q3"], "q3")), "finished");
});

test("予想がまだなら、これまでどおり closed / waiting", () => {
  assert.equal(guestMode(gate(null, ["q1"], "q1")), "closed");
  assert.equal(guestMode(gate(null, ["q1"])), "waiting");
});

test("記録を消したあと（done が空）は waiting", () => {
  assert.equal(guestMode(gate(null, [])), "waiting");
  assert.equal(guestMode(EMPTY_GATE), "waiting");
});

test("終了の文言が空（finishedEnabled = false）なら finished にしない", () => {
  assert.equal(guestMode(gate(null, ["pred"], "pred"), false), "closed");
  assert.equal(guestMode(gate(null, ["pred"]), false), "waiting");
});

test("司会画面の操作の流れ: 予想を開ける → 締め切る → 開け直す", () => {
  let g = reduceGate(EMPTY_GATE, "pred");
  assert.equal(guestMode(g), "question");
  g = reduceGate(g, "none");
  assert.equal(guestMode(g), "finished");
  g = reduceGate(g, "idle");
  assert.equal(guestMode(g), "finished");
  g = reduceGate(g, "q2");
  assert.equal(guestMode(g), "question");
});
