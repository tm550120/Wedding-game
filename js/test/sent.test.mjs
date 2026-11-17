/*
 * 送信済みロックの見直し（js/gate.js の pruneSent と js/storage.js の updateAllSent）のテスト。
 *
 *   node --test js/test/sent.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// storage.js が使う localStorage の偽物
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
};

const { pruneSent, normalizeGate } = await import("../gate.js");
const { loadSent, saveSent, updateAllSent } = await import("../storage.js");

const gate = (open, done, lastClosed = null) => ({ open, lastClosed, done, rev: 7 });
const SENT = { quiz: { 0: "A", 2: "C" }, pred: { 0: "3問" } };

test("記録を消したあと（done が空）は、ロックがすべて外れる", () => {
  assert.deepEqual(pruneSent(SENT, gate(null, [])), {});
});

test("受付中の問題のロックは残る", () => {
  assert.deepEqual(pruneSent(SENT, gate("q1", [])), { quiz: { 0: "A" } });
  assert.deepEqual(pruneSent(SENT, gate("pred", [])), { pred: { 0: "3問" } });
});

test("締め切り済み（done）の問題のロックは残る", () => {
  assert.deepEqual(pruneSent(SENT, gate(null, ["q3", "pred"], "q3")), { quiz: { 2: "C" }, pred: { 0: "3問" } });
});

test("外すものが無ければ、同じオブジェクトを返す", () => {
  assert.equal(pruneSent(SENT, gate("q1", ["q3", "pred"])), SENT);
  const empty = {};
  assert.equal(pruneSent(empty, gate(null, [])), empty);
});

test("知らないセクションや壊れた値には触らない", () => {
  const odd = { other: { 0: "x" }, quiz: "broken" };
  assert.equal(pruneSent(odd, gate(null, [])), odd);
  assert.equal(pruneSent(null, gate(null, [])), null);
});

test("Apps Script の応答（normalizeGate の結果）でそのまま使える", () => {
  const fresh = normalizeGate({ open: "q2", lastClosed: null, done: ["q1"], rev: 30 });
  assert.deepEqual(pruneSent({ quiz: { 0: "A", 1: "B", 4: "D" } }, fresh), { quiz: { 0: "A", 1: "B" } });
});

test("updateAllSent: 全員分を直して保存する。変わらなければ書き込まない", () => {
  saveSent("たろう", SENT);
  saveSent("__proto__", { quiz: { 4: "B" } });
  updateAllSent((sent) => pruneSent(sent, gate("q1", [])));
  assert.deepEqual(loadSent("たろう"), { quiz: { 0: "A" } });
  assert.deepEqual(loadSent("__proto__"), {});

  let writes = 0;
  const setItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (...args) => (writes++, setItem(...args));
  updateAllSent((sent) => pruneSent(sent, gate("q1", [])));
  globalThis.localStorage.setItem = setItem;
  assert.equal(writes, 0);
});
