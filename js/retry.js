/*
 * 司会画面の操作（受付の切り替え・成績の公開・正解・的中者・順位の取得）を送り直すときの決まり。
 * 画面にも通信にも触らない部品で、node でテストできる。
 *
 * Apps Script への GET は、ときどき応答が返らないまま止まる（接続はできるが、スクリプトまで届かない）。
 * 届いたものは 1〜2秒（まれに 4〜5秒）で返るので、短い時間で見切って、すぐ送り直す。
 * どの操作も、同じ呼び出しを繰り返して構わない（apps-script/Code.gs の setOpen_ / revealResults_ は
 * 「すでにその状態なら何も変えない」。ほかは読むだけ）。
 */

/** 読むだけの操作（正解・的中者・順位）を、通信エラーのときに試す回数。 */
export const ACTION_ATTEMPTS = 5;

/**
 * attempt 回目（1〜）の呼び出しで応答を待つ時間（ミリ秒）。3回目までは baseMs、それ以降は 2倍。
 * 本当に応答が遅いだけ（シートの読み取りに時間がかかっている）のときに、短い時間で切り続けて
 * いつまでも成功しない、ということがないようにする。
 */
export function actionTimeout(attempt, baseMs) {
  return attempt > 3 ? baseMs * 2 : baseMs;
}

/** 続けて failures 回（1〜）失敗したあと、送り直すまで待つ時間（ミリ秒）。0.5秒 → 1秒 → 2秒 → 3秒（上限）。 */
export function actionRetryDelay(failures) {
  return Math.min(500 * 2 ** Math.min(Math.max(failures, 1) - 1, 10), 3000);
}
