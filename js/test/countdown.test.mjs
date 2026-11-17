/*
 * 自動締め切りのカウントダウン（js/countdown.js）と、正解を映すときの受付の切り替え（js/gate.js の revealRequest）のテスト。
 *
 *   node --test js/test/countdown.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { autoCloseSeconds, countdownView, trackOpen, guestRemaining } = await import("../countdown.js");
const { EMPTY_GATE, reduceGate, revealRequest, pruneSent } = await import("../gate.js");
const { HOST } = await import("../config.js");

test("autoCloseSeconds: 設定の秒数。デモではデモ用の秒数。0 や変な値は「自動で締め切らない」", () => {
  assert.equal(autoCloseSeconds({ autoCloseSec: 60, demoAutoCloseSec: 15 }, false), 60);
  assert.equal(autoCloseSeconds({ autoCloseSec: 60, demoAutoCloseSec: 15 }, true), 15);
  assert.equal(autoCloseSeconds({ autoCloseSec: 60 }, true), 60);
  assert.equal(autoCloseSeconds({ autoCloseSec: 0, demoAutoCloseSec: 15 }, false), 0);
  assert.equal(autoCloseSeconds({ autoCloseSec: -5 }, false), 0);
  assert.equal(autoCloseSeconds({ autoCloseSec: "x" }, false), 0);
  assert.equal(autoCloseSeconds({}, false), 0);
  assert.equal(autoCloseSeconds(HOST, false), 60);
});

test("countdownView: 残り時間の表示と、残りわずか・時間切れの判定", () => {
  assert.deepEqual(countdownView(60000, 0), { seconds: 60, text: "1:00", urgent: false, expired: false });
  assert.deepEqual(countdownView(60000, 17500), { seconds: 43, text: "0:43", urgent: false, expired: false });
  assert.deepEqual(countdownView(60000, 49999), { seconds: 11, text: "0:11", urgent: false, expired: false });
  assert.deepEqual(countdownView(60000, 50000), { seconds: 10, text: "0:10", urgent: true, expired: false });
  assert.deepEqual(countdownView(60000, 59999), { seconds: 1, text: "0:01", urgent: true, expired: false });
  assert.deepEqual(countdownView(60000, 60000), { seconds: 0, text: "0:00", urgent: true, expired: true });
  assert.deepEqual(countdownView(60000, 99999), { seconds: 0, text: "0:00", urgent: true, expired: true });
  assert.equal(countdownView(125000, 0).text, "2:05");
});

test("trackOpen: 受付が開く瞬間を見たときだけ、見た時刻を覚える", () => {
  const g = (open, rev) => ({ open, lastClosed: null, done: [], rev });
  // 初めて読めたときにもう受付中だった → いつ開いたか分からない
  assert.deepEqual(trackOpen(null, g("q1", 3), 1000), { target: "q1", rev: 3, since: null });
  // 待ち受けを見てから開いた → 見た時刻を覚える
  const idle = trackOpen(null, g(null, 2), 1000);
  assert.deepEqual(idle, { target: null, rev: 2, since: null });
  const opened = trackOpen(idle, g("q1", 3), 2000);
  assert.deepEqual(opened, { target: "q1", rev: 3, since: 2000 });
  // 同じ受付が続いている間は変えない
  assert.equal(trackOpen(opened, g("q1", 3), 9000), opened);
  // 締め切り → 開け直し（O キー）で数え直す
  const closed = trackOpen(opened, { open: null, lastClosed: "q1", done: ["q1"], rev: 4 }, 10000);
  assert.equal(closed.since, null);
  assert.deepEqual(trackOpen(closed, g("q1", 5), 11000), { target: "q1", rev: 5, since: 11000 });
  // 読んでいない間に締め切って開け直された（同じ問題だが rev が違う）ときも数え直す
  assert.deepEqual(trackOpen(opened, g("q1", 5), 12000), { target: "q1", rev: 5, since: 12000 });
  // 別の問題に切り替わった
  assert.deepEqual(trackOpen(opened, g("q2", 5), 13000), { target: "q2", rev: 5, since: 13000 });
});

test("guestRemaining: およその残り秒数。分からないときは null、0 未満にはならない", () => {
  assert.equal(guestRemaining(1000, 1000, 60, 1500), 59);
  assert.equal(guestRemaining(1000, 17500, 60, 1500), 42);
  assert.equal(guestRemaining(1000, 59500, 60, 1500), 0);
  assert.equal(guestRemaining(1000, 999999, 60, 1500), 0);
  assert.equal(guestRemaining(1000, 1000, 60), 60);
  assert.equal(guestRemaining(null, 1000, 60, 1500), null);
  assert.equal(guestRemaining(1000, 1000, 0, 1500), null);
});

test("revealRequest: 正解を映すときは idle を頼む。すでに待ち受けなら頼まない", () => {
  const closed = reduceGate(reduceGate(EMPTY_GATE, "q2"), "none");
  assert.deepEqual(closed, { open: null, lastClosed: "q2", done: ["q2"], rev: 2 });
  assert.equal(revealRequest(closed), "idle");
  // ほかの問題が開いたまま正解に戻ってきたときも idle（その問題は締め切られる）
  assert.equal(revealRequest(reduceGate(closed, "q3")), "idle");
  const idle = reduceGate(closed, revealRequest(closed));
  assert.deepEqual(idle, { open: null, lastClosed: null, done: ["q2"], rev: 3 });
  assert.equal(revealRequest(idle), null);
  assert.equal(revealRequest(EMPTY_GATE), null);
});

test("正解を映したあと（idle）も done に残るので、送信済みロックは外れない", () => {
  const sent = { quiz: { 1: "B" } };
  let gate = reduceGate(EMPTY_GATE, "q2");
  assert.equal(pruneSent(sent, gate), sent); // 受付中
  gate = reduceGate(gate, "none");
  assert.equal(pruneSent(sent, gate), sent); // 締め切り
  gate = reduceGate(gate, revealRequest(gate));
  assert.equal(gate.lastClosed, null);
  assert.equal(pruneSent(sent, gate), sent); // 正解を表示（待ち受け）
  gate = reduceGate(gate, "q3");
  assert.equal(pruneSent(sent, gate), sent); // 次の問題へ
  // ほかの問題が開いたまま戻ってきて正解を映したとき: その問題も done に入り、ロックは残る
  const both = { quiz: { 1: "B", 2: "C" } };
  gate = reduceGate(gate, revealRequest(gate));
  assert.deepEqual(gate.done, ["q2", "q3"]);
  assert.equal(pruneSent(both, gate), both);
});
