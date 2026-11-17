/*
 * 定期取得の進め方（司会画面の人数の取得で使う）。画面にも通信にも触らない部品で、node でテストできる。
 *
 *   - intervalMs ごとに新しい取得を始める。前の取得の応答は待たない（応答が遅くても表示の遅れを増やさない）
 *   - 同時に進める取得は maxInFlight 件まで。応答が返らない取得があっても、それ以上は増えない
 *     （上限に達している間は始めず、どれかが終わった時点で次を始める）
 *   - 取得には始めた順に番号を付け、すでに反映したものより古い番号の応答は捨てる（順番が入れ替わって届いたとき）
 *   - 失敗が続くほど間隔をあける（intervalMs × 2^回数、上限 maxBackoffMs）。成功したら元に戻す
 *
 * load は必ず終わること（タイムアウト付きにすること）。終わらない取得は、枠を1つふさいだままになる。
 */
export function createPoller({
  load,              // () => Promise。1回の取得
  onSuccess,         // (value) => void。捨てなかった応答だけが届く
  onFailure,         // (error) => void。すでに新しい応答を反映済みなら呼ばれない
  intervalMs,
  maxInFlight = 2,
  maxBackoffMs = intervalMs,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  let seq = 0;        // 最後に始めた取得の番号
  let applied = 0;    // 最後に反映した取得の番号
  let inFlight = 0;
  let failures = 0;   // 続けて失敗した回数
  let lastStart = null;
  let timer = null;

  const delay = () => (failures > 0 ? Math.min(intervalMs * 2 ** Math.min(failures, 10), Math.max(maxBackoffMs, intervalMs)) : intervalMs);

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  /** 次の取得を予約する。上限に達している間は予約しない（取得が終わったときに呼び直される）。 */
  function schedule() {
    if (timer !== null || inFlight >= maxInFlight) return;
    const wait = lastStart === null ? 0 : Math.max(lastStart + delay() - now(), 0);
    timer = setTimer(() => {
      timer = null;
      start();
    }, wait);
  }

  async function start() {
    if (inFlight >= maxInFlight) return;
    cancelTimer();
    const mine = ++seq;
    inFlight++;
    lastStart = now();
    schedule();
    let result;
    try {
      result = { value: await load() };
    } catch (error) {
      result = { error };
    }
    inFlight--;
    try {
      if (mine > applied) {
        if ("error" in result) {
          failures++;
          onFailure?.(result.error);
        } else {
          applied = mine;
          failures = 0;
          onSuccess(result.value);
        }
      }
    } catch (e) {
      console.error(e); // 反映する側の不具合。定期取得は止めない
    }
    // 間隔が変わったかもしれないので（失敗 → 成功など）、予約し直す
    cancelTimer();
    schedule();
  }

  return {
    /** 止まっていれば動かす。immediate が true なら、次の予定を待たずにすぐ始める（上限に達していれば何もしない）。 */
    kick(immediate) {
      if (immediate) start();
      else schedule();
    },
    get inFlight() {
      return inFlight;
    },
  };
}
