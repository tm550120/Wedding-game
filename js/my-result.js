/*
 * ゲストのスマホに出す「自分のクイズの成績」。画面には触らない部品で、node でテストできる。
 *
 * 司会画面が「ランキング」のスライドに来ると、受付状態の results が true になる（js/gate.js）。
 * 回答ページはそれを見て、自分の名前の成績を Apps Script から読む（…/exec?action=myResult&name=名前。誰でも読める）。
 *   公開する前        { "ok": true, "ready": false }
 *   公開したあと      { "ok": true, "ready": true, "found": true, "correct": 7, "total": 10, "rank": 8, "tied": 3, "participants": 23 }
 *   その名前の回答なし { "ok": true, "ready": true, "found": false, … }
 * 数字の決まりは、司会画面のランキングと同じ（apps-script/Code.gs の quizScores_）。
 *   correct = 正解数 / total = 採点した問題の数 / rank = 1 + 自分より正解数が多い人の数 /
 *   tied = 自分と同じ正解数の人の数（自分を含む） / participants = クイズに答えた人の数
 */
import { loadJson } from "./net.js";

/** 成績を読みに行く前に待つ時間の上限（ミリ秒）。全員が同時に読みに行かないよう、0〜この時間をランダムに待つ。 */
export const RESULT_JITTER_MS = 4000;

/**
 * 続けて failures 回失敗したあと、次に読むまで待つ時間（ミリ秒）。1秒 → 2秒 → 4秒 → 8秒 → 10秒（上限）。
 * Apps Script への読み取りは、ときどき応答が返らないまま止まる（GATE.resultTimeoutMs で時間切れ）ので、最初はすぐ読み直す。
 */
export function resultRetryDelay(failures) {
  return Math.min(1000 * 2 ** Math.min(Math.max(failures, 1) - 1, 10), 10000);
}

const isCount = (value, min) => Number.isInteger(value) && value >= min;

/**
 * Apps Script の応答を確かめて、画面で使う形にする。想定の形でなければ（Code.gs が古い・エラーの応答など）例外にする。
 * 返すのは { ready: false } / { ready: true, found: false } / { ready: true, found: true, correct, total, rank, tied, participants }。
 */
export function normalizeMyResult(raw) {
  if (!raw || typeof raw !== "object" || raw.ok !== true || typeof raw.ready !== "boolean") throw new Error("unexpected result");
  if (!raw.ready) return { ready: false };
  if (raw.found !== true) return { ready: true, found: false };
  const { correct, total, rank, tied, participants } = raw;
  const valid =
    isCount(correct, 0) && isCount(total, 1) && correct <= total && isCount(participants, 1) && isCount(rank, 1) && rank <= participants && isCount(tied, 1) && tied <= participants;
  if (!valid) throw new Error("unexpected result");
  return { ready: true, found: true, correct, total, rank, tied, participants };
}

/**
 * 画面に出す文言。出すものが無ければ（まだ読めていない・公開前・その名前の回答が無い）null。
 *   { heading: "あなたの結果", score: "10問中 7問正解", rank: "23人中 8位", tied: "（同率 3人）" }
 * tied は、同じ正解数の人がほかにいるときだけ（いなければ ""）。
 */
export function resultLines(result) {
  if (!result || result.ready !== true || result.found !== true) return null;
  return {
    heading: "あなたの結果",
    score: result.total + "問中 " + result.correct + "問正解",
    rank: result.participants + "人中 " + result.rank + "位",
    tied: result.tied > 1 ? "（同率 " + result.tied + "人）" : "",
  };
}

/** 回答ページ用: name の人の成績を読む（…/exec?action=myResult&name=名前）。 */
export async function fetchMyResult(url, name, options) {
  return normalizeMyResult(await loadJson(url, { action: "myResult", name }, options));
}
