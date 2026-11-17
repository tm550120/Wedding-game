/*
 * 司会画面の定期取得（js/poller.js）のテスト。時計とタイマーは偽物を使う。
 *
 *   node --test js/test/poller.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { createPoller } = await import("../poller.js");

/** 偽物の時計・タイマーと、手で応答を返せる load を持ったテスト用の一式。 */
function setup(options = {}) {
  let time = 0;
  let timerSeq = 0;
  const timers = new Map(); // id → { at, fn }
  const requests = [];      // 始めた順。{ resolve, reject }
  const applied = [];
  const errors = [];

  const poller = createPoller({
    load: () => new Promise((resolve, reject) => requests.push({ resolve, reject, at: time })),
    onSuccess: (value) => applied.push(value),
    onFailure: (error) => errors.push(error.message),
    intervalMs: 500,
    maxInFlight: 2,
    maxBackoffMs: 8000,
    now: () => time,
    setTimer: (fn, ms) => {
      timers.set(++timerSeq, { at: time + ms, fn });
      return timerSeq;
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });

  /** ms だけ時間を進め、その間に期限が来たタイマーを順に動かす。 */
  async function advance(ms) {
    const end = time + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      time = due[1].at;
      due[1].fn();
      await flush();
    }
    time = end;
  }
  /** いちばん早いタイマー1つだけを、その時刻まで進めて動かす。 */
  async function next() {
    const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(due, "予約されたタイマーがない");
    timers.delete(due[0]);
    time = Math.max(time, due[1].at);
    due[1].fn();
    await flush();
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const settle = async (index, value) => {
    if (value instanceof Error) requests[index].reject(value);
    else requests[index].resolve(value);
    await flush();
  };

  return { poller, requests, applied, errors, timers, advance, next, settle, now: () => time };
}

test("success: 応答を待たずに 500ms ごとに始め、同時に進めるのは2件まで", async () => {
  const t = setup();
  t.poller.kick();
  await t.advance(0);
  assert.equal(t.requests.length, 1);
  await t.advance(500);
  assert.equal(t.requests.length, 2);
  assert.equal(t.poller.inFlight, 2);

  // 2件とも返らない間は、いくら待っても増えない（タイマーも予約されない）
  await t.advance(60000);
  assert.equal(t.requests.length, 2);
  assert.equal(t.poller.inFlight, 2);
  assert.equal(t.timers.size, 0);

  // 1件返ると、間隔はとうに過ぎているので、すぐ次を始める
  await t.settle(0, "a");
  await t.advance(0);
  assert.equal(t.requests.length, 3);
  assert.equal(t.poller.inFlight, 2);
  assert.deepEqual(t.applied, ["a"]);
});

test("success: 応答が速いときは 500ms ごとに1件ずつ", async () => {
  const t = setup();
  t.poller.kick();
  await t.advance(0);
  await t.settle(0, "a");
  await t.advance(499);
  assert.equal(t.requests.length, 1);
  await t.advance(1);
  assert.equal(t.requests.length, 2);
  assert.equal(t.requests[1].at, 500);
});

test("success: 順番が入れ替わって届いた古い応答は捨てる", async () => {
  const t = setup();
  t.poller.kick();
  await t.advance(500);
  await t.settle(1, "new"); // 後から始めた取得が先に返る
  await t.settle(0, "old");
  assert.deepEqual(t.applied, ["new"]);

  // 古い取得の失敗も、新しい応答を反映済みなら知らせない
  await t.advance(1000);
  assert.equal(t.requests.length, 4);
  await t.settle(3, "newer");
  await t.settle(2, new Error("late failure"));
  assert.deepEqual(t.applied, ["new", "newer"]);
  assert.deepEqual(t.errors, []);
});

test("success: 順番どおりに届いた応答は、どちらも反映する", async () => {
  const t = setup();
  t.poller.kick();
  await t.advance(500);
  await t.settle(0, "first");
  await t.settle(1, "second");
  assert.deepEqual(t.applied, ["first", "second"]);
});

test("failed: 失敗が続くほど間隔をあけ、成功したら元に戻す", async () => {
  const t = setup({ maxInFlight: 1 });
  t.poller.kick();
  await t.advance(0);
  const waits = [];
  for (let i = 0; i < 6; i++) {
    const startedAt = t.requests[i].at;
    await t.settle(i, new Error("fail " + i));
    await t.next();
    waits.push(t.requests[i + 1].at - startedAt);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(t.errors.length, 6);

  const startedAt = t.requests[6].at;
  await t.settle(6, "ok");
  await t.next();
  assert.equal(t.requests[7].at - startedAt, 500);
  assert.deepEqual(t.applied, ["ok"]);
});

test("success: kick(true) は予定を待たずに始めるが、上限は超えない", async () => {
  const t = setup();
  t.poller.kick();
  await t.advance(0);
  t.poller.kick(true);
  await t.advance(0);
  assert.equal(t.requests.length, 2);
  t.poller.kick(true);
  t.poller.kick(true);
  await t.advance(0);
  assert.equal(t.requests.length, 2);
  assert.equal(t.poller.inFlight, 2);
});

test("success: onSuccess が例外を投げても、定期取得は止まらない", async () => {
  const t = setup({
    onSuccess: () => {
      throw new Error("render failed");
    },
  });
  t.poller.kick();
  await t.advance(0);
  const original = console.error;
  const logged = [];
  console.error = (e) => logged.push(e.message);
  try {
    await t.settle(0, "a");
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, ["render failed"]);
  await t.advance(500);
  assert.equal(t.requests.length, 2);
});
