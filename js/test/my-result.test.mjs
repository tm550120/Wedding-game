/*
 * ゲストのスマホに出す「自分のクイズの成績」（js/my-result.js）と、受付状態の results（js/gate.js）のテスト。
 *
 *   node --test js/test/my-result.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { normalizeMyResult, resultLines, resultRetryDelay, fetchMyResult, RESULT_JITTER_MS } = await import("../my-result.js");
const { normalizeGate, reduceGate, revealGate, guestMode, EMPTY_GATE } = await import("../gate.js");

const FOUND = { ok: true, ready: true, found: true, correct: 7, total: 10, rank: 8, tied: 3, participants: 23 };

test("success: 成績の文言（「10問中 7問正解」「23人中 8位」「（同率 3人）」）", () => {
  assert.deepEqual(resultLines(normalizeMyResult(FOUND)), {
    heading: "あなたの結果",
    score: "10問中 7問正解",
    rank: "23人中 8位",
    tied: "（同率 3人）",
  });
});

test("success: 同じ正解数の人がほかにいなければ、同率は出さない", () => {
  const lines = resultLines(normalizeMyResult({ ...FOUND, correct: 10, rank: 1, tied: 1 }));
  assert.deepEqual(lines, { heading: "あなたの結果", score: "10問中 10問正解", rank: "23人中 1位", tied: "" });
  // 0問正解・1人だけ・全員同点でも出せる
  assert.equal(resultLines(normalizeMyResult({ ...FOUND, correct: 0, rank: 23, tied: 1 })).score, "10問中 0問正解");
  assert.equal(resultLines(normalizeMyResult({ ...FOUND, rank: 1, tied: 1, participants: 1 })).rank, "1人中 1位");
  assert.equal(resultLines(normalizeMyResult({ ...FOUND, rank: 1, tied: 23 })).tied, "（同率 23人）");
});

test("success: まだ読めていない・公開前・その名前の回答が無いときは、何も出さない", () => {
  assert.equal(resultLines(null), null);
  assert.equal(resultLines(undefined), null);
  assert.deepEqual(normalizeMyResult({ ok: true, ready: false }), { ready: false });
  assert.equal(resultLines(normalizeMyResult({ ok: true, ready: false })), null);
  const missing = normalizeMyResult({ ok: true, ready: true, found: false, total: 10, participants: 23 });
  assert.deepEqual(missing, { ready: true, found: false });
  assert.equal(resultLines(missing), null);
});

test("success: 応答の余分な値は持ち込まない", () => {
  assert.deepEqual(normalizeMyResult({ ...FOUND, name: "だれか", extra: 1 }), {
    ready: true, found: true, correct: 7, total: 10, rank: 8, tied: 3, participants: 23,
  });
});

test("failed: 想定の形でない応答（Code.gs が古い・エラー・数字がおかしい）は例外にする", () => {
  const oldServer = { updatedAt: "…", quiz: { 1: { total: 3 } }, pred: { total: 3 }, state: { open: null, lastClosed: null, done: [], rev: 3 } };
  const bad = [
    null,
    undefined,
    "text",
    oldServer, // 古い Code.gs は知らない action に人数の JSON を返す
    { error: "result_error", message: "成績を集計できません" },
    { ok: true },
    { ok: true, ready: "yes" },
    { ...FOUND, ok: false },
    { ...FOUND, correct: "7" },
    { ...FOUND, correct: -1 },
    { ...FOUND, correct: 11 },
    { ...FOUND, correct: 7.5 },
    { ...FOUND, total: 0 },
    { ...FOUND, rank: 0 },
    { ...FOUND, rank: 24 },
    { ...FOUND, tied: 0 },
    { ...FOUND, tied: 24 },
    { ...FOUND, participants: 0 },
    { ...FOUND, participants: undefined },
  ];
  for (const raw of bad) assert.throws(() => normalizeMyResult(raw), /unexpected result/, JSON.stringify(raw));
});

test("success: 読み直しの間隔は 1秒 → 2秒 → 4秒 → 8秒 → 10秒（上限）。最初に待つ時間の上限は 4秒", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(resultRetryDelay), [1000, 2000, 4000, 8000, 10000, 10000]);
  assert.equal(resultRetryDelay(0), 1000);
  assert.equal(RESULT_JITTER_MS, 4000);
});

test("success: fetchMyResult は action=myResult と名前を付けて読む / 失敗: 古い Code.gs の応答は例外", async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  let body = FOUND;
  globalThis.fetch = async (url, init) => {
    urls.push(new URL(url));
    assert.equal(init.credentials, "omit");
    return { ok: true, json: async () => body };
  };
  try {
    const result = await fetchMyResult("https://example.test/exec", "山田 太郎", { timeoutMs: 1000, transport: "fetch" });
    assert.deepEqual(result, { ready: true, found: true, correct: 7, total: 10, rank: 8, tied: 3, participants: 23 });
    assert.equal(urls[0].searchParams.get("action"), "myResult");
    assert.equal(urls[0].searchParams.get("name"), "山田 太郎");
    assert.equal(urls[0].searchParams.has("key"), false); // 司会キーは要らない（付けない）
    body = { updatedAt: "…", quiz: {}, pred: { total: 0 } };
    await assert.rejects(fetchMyResult("https://example.test/exec", "山田 太郎", { timeoutMs: 1000, transport: "fetch" }), /unexpected result/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ===== 受付状態の results ===== */

test("success: 古い Code.gs の受付状態（results なし）は results: false になり、これまでどおり動く", () => {
  const old = normalizeGate({ open: null, lastClosed: null, done: ["q1", "pred"], rev: 30, updatedAt: "…" });
  assert.deepEqual(old, { open: null, lastClosed: null, done: ["q1", "pred"], rev: 30, results: false });
  assert.equal(guestMode(old), "finished");
  assert.equal(EMPTY_GATE.results, false);
});

test("success: results は true のときだけ true（それ以外の値は false）", () => {
  const base = { open: null, lastClosed: null, done: ["pred"], rev: 31 };
  assert.equal(normalizeGate({ ...base, results: true }).results, true);
  for (const value of [false, "true", 1, null, undefined, {}]) assert.equal(normalizeGate({ ...base, results: value }).results, false);
  assert.equal(guestMode(normalizeGate({ ...base, results: true })), "finished"); // 表示の種類は変わらない
});

test("success: revealGate は公開済みにして rev を進める（すでに公開済みなら、そのまま）", () => {
  const closed = reduceGate(reduceGate(EMPTY_GATE, "pred"), "none");
  const revealed = revealGate(closed);
  assert.deepEqual(revealed, { open: null, lastClosed: "pred", done: ["pred"], rev: 3, results: true });
  assert.equal(revealGate(revealed), revealed);
});

test("success: 締め切る・待ち受けに戻すだけでは公開のまま。受付を開けると取り消される（Code.gs と同じ決まり）", () => {
  const revealed = revealGate(reduceGate(reduceGate(EMPTY_GATE, "pred"), "none"));
  const idle = reduceGate(revealed, "idle");
  assert.deepEqual([idle.lastClosed, idle.results], [null, true]);
  assert.equal(reduceGate(idle, "none"), idle); // 変わらなければ同じもの
  const reopened = reduceGate(idle, "q3");
  assert.deepEqual([reopened.open, reopened.results], ["q3", false]);
  assert.equal(reduceGate(reopened, "none").results, false);
});
