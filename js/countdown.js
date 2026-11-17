/*
 * 自動締め切りのカウントダウン（司会画面と回答ページで使う）。画面にも通信にも触らない部品で、node でテストできる。
 *
 * 司会画面: 受付を開けた操作のときに締め切りの時刻を決め、0 になったら「→ を1回押した」のと同じように締め切る。
 * 回答ページ: 受付を開けた時刻は届かないので、「この端末が、受付が開いたのを初めて見た時刻」から見積もる。
 *             目安の表示だけに使い、送信を止めるのには使わない（締め切りを決めるのは司会画面と Apps Script）。
 */

/** 自動で締め切るまでの秒数。0 なら自動では締め切らない。デモでは短い秒数（HOST.demoAutoCloseSec）を使う。 */
export function autoCloseSeconds(host, demo) {
  const sec = Number(demo && host.demoAutoCloseSec !== undefined ? host.demoAutoCloseSec : host.autoCloseSec);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

/**
 * 司会画面の残り時間の表示。deadline は締め切る時刻（ミリ秒）。
 * 返すもの: seconds = 残りの秒数（切り上げ。0 未満にはならない）/ text = "0:42" / urgent = 残りわずか / expired = 時間切れ
 */
export function countdownView(deadline, now, urgentSec = 10) {
  const seconds = Math.max(Math.ceil((deadline - now) / 1000), 0);
  return {
    seconds,
    text: Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0"),
    urgent: seconds <= urgentSec,
    expired: now >= deadline,
  };
}

/**
 * 回答ページ用: 受付が開いたのを「いつ見たか」を覚える。受付状態を読めるたびに呼ぶ。
 *   prev … 前回の戻り値。まだ一度も読めていない・長く読めなかったあとは null を渡す
 * 返すもの: { target, rev, since }。since は、その受付が開いたのを見た時刻。
 * 開く前の状態を見ていないとき（ページを開いたら、もう受付中だった）は、いつ開いたか分からないので since は null。
 * 同じ問題でも rev が変わっていれば、読んでいない間に締め切って開け直されたので、見た時刻を取り直す。
 */
export function trackOpen(prev, gate, now) {
  if (prev && prev.target === gate.open && prev.rev === gate.rev) return prev;
  return { target: gate.open, rev: gate.rev, since: prev && gate.open ? now : null };
}

/**
 * 回答ページ用: 残りのおよその秒数。分からないとき（since が null・自動締め切りなし）は null。
 * 受付が開いてからこの端末に届くまでの遅れ（lagMs）の分だけ、短く見積もる。0 未満にはならない。
 */
export function guestRemaining(since, now, durationSec, lagMs = 0) {
  if (since === null || since === undefined || !(durationSec > 0)) return null;
  return Math.max(Math.ceil(durationSec - (now - since + lagMs) / 1000), 0);
}
