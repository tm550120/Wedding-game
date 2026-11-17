/*
 * 応答が返らないときの見切りと読み直し（js/retry.js、js/gate.js の gatePollDelay、js/net.js の時間切れ、js/config.js の値）のテスト。
 *
 *   node --test js/test/retry.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { ACTION_ATTEMPTS, actionTimeout, actionRetryDelay } = await import("../retry.js");
const { gatePollDelay } = await import("../gate.js");
const { loadJson } = await import("../net.js");
const { GATE, HOST } = await import("../config.js");
const { sendSetOpen } = await import("../host-api.js");

test("success: 司会の操作は 3回目までは基本の時間、4回目からは 2倍の時間まで応答を待つ", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((attempt) => actionTimeout(attempt, 5000)), [5000, 5000, 5000, 10000, 10000, 10000]);
  assert.equal(ACTION_ATTEMPTS, 5);
});

test("success: 司会の操作の送り直しは 0.5秒 → 1秒 → 2秒 → 3秒（上限）", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(actionRetryDelay), [500, 1000, 2000, 3000, 3000, 3000]);
  assert.equal(actionRetryDelay(0), 500);
});

test("success: 受付状態の読み直しは、1回の失敗ならいつもの間隔のまま。続いたら 2倍・4倍、上限まで", () => {
  assert.equal(gatePollDelay(1200, 0, 5000), 1200);
  assert.equal(gatePollDelay(1200, 1, 5000), 1200);
  assert.equal(gatePollDelay(1200, 2, 5000), 2400);
  assert.equal(gatePollDelay(1200, 3, 5000), 4800);
  assert.equal(gatePollDelay(1200, 4, 5000), 5000);
  assert.equal(gatePollDelay(1200, 100, 5000), 5000);
  // 上限がいつもの間隔より短くても、いつもの間隔より詰めない
  assert.equal(gatePollDelay(1200, 3, 500), 1200);
});

test("success: 設定値。応答が返らない読み取りは 4〜5秒で見切り、1回失敗したあとは 1.5秒以内に読み直す", () => {
  assert.equal(GATE.timeoutMs, 4000);
  assert.equal(GATE.resultTimeoutMs, 5000);
  assert.equal(GATE.staleMs, 20000);
  assert.equal(HOST.timeoutMs, 4000);
  assert.equal(HOST.actionTimeoutMs, 5000);
  assert.equal(HOST.slidesTimeoutMs, 60000);
  assert.ok(gatePollDelay(GATE.pollMs + GATE.jitterMs, 1, GATE.maxBackoffMs) <= 1500);
  // 時間切れが続いても、GATE.staleMs までに 3回は読みに行ける
  const third = GATE.timeoutMs * 3 + gatePollDelay(1500, 1, GATE.maxBackoffMs) + gatePollDelay(1500, 2, GATE.maxBackoffMs);
  assert.ok(third < GATE.staleMs);
});

/** 応答を返さず、中断（abort）されるまで止まったままの fetch。 */
function hangingFetch(calls) {
  return (url, init) => {
    calls.push(new URL(url));
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
}

test("failed: 応答が返らない読み取りは、timeoutMs で中断されて失敗になる", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = hangingFetch(calls);
  try {
    const started = Date.now();
    await assert.rejects(loadJson("https://example.test/exec", { action: "state" }, { timeoutMs: 30, transport: "fetch" }), /aborted/);
    assert.ok(Date.now() - started < 1000);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("failed: 応答が返らない受付の切り替えは、code の無い例外になる（司会画面が送り直す対象）/ success: 送り直しは同じ内容", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = hangingFetch(calls);
  try {
    const error = await sendSetOpen("https://example.test/exec", "host-key", "q5", { timeoutMs: 30, transport: "fetch" }).catch((e) => e);
    assert.ok(error instanceof Error);
    assert.equal(error.code, undefined);
    globalThis.fetch = async (url) => {
      calls.push(new URL(url));
      return { ok: true, json: async () => ({ ok: true, state: { open: "q5", lastClosed: null, done: [], rev: 3, results: false } }) };
    };
    const gate = await sendSetOpen("https://example.test/exec", "host-key", "q5", { timeoutMs: 30, transport: "fetch" });
    assert.equal(gate.open, "q5");
    assert.equal(gate.rev, 3);
    assert.equal(calls.length, 2);
    for (const name of ["action", "target", "key"]) assert.equal(calls[0].searchParams.get(name), calls[1].searchParams.get(name));
    assert.equal(calls[1].searchParams.get("action"), "setOpen");
  } finally {
    globalThis.fetch = realFetch;
  }
});
