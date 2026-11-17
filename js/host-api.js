/*
 * 司会画面（host.html）が Apps Script ウェブアプリ（apps-script/Code.gs）とやり取りするもの。
 *
 *   人数と受付状態 …/exec                                        誰でも読める（人数の合計だけ）
 *   スライド一覧   …/exec?action=slides&key=司会キー              司会キーが合うときだけ返る
 *   正解           …/exec?action=answers&key=司会キー             〃
 *   受付の切り替え …/exec?action=setOpen&key=司会キー&target=q5   〃
 *   予想の的中者   …/exec?action=predHits&key=司会キー&n=3        〃（名前が返るのは、これと下の ranking だけ）
 *   クイズの順位   …/exec?action=ranking&key=司会キー&limit=5     〃
 *
 * 司会キーは URL（host.html?key=…）で一度だけ受け取り、この端末の localStorage に保存する。
 * リポジトリや config.js には書かない（正解とスライドを読めて、受付を切り替えられるキーなので）。
 * 正解と名前は画面を開いている間だけメモリに持ち、どこにも保存しない。
 */
import { loadJson } from "./net.js";
import { normalizeGate } from "./gate.js";
import { normalizePredHits } from "./pred-result.js";
import { normalizeRanking } from "./ranking.js";

const KEY_STORAGE = "wg-host-key";

/**
 * 司会キーを取り出す。URL に ?key=… があればそれを保存し、アドレスバーからは消す
 * （画面を映したときにキーが見えないように）。?key= と空で渡すと、保存したキーを消す。
 */
export function takeHostKey() {
  const url = new URL(location.href);
  if (url.searchParams.has("key")) {
    const key = url.searchParams.get("key").trim();
    try {
      if (key) localStorage.setItem(KEY_STORAGE, key);
      else localStorage.removeItem(KEY_STORAGE);
    } catch (e) {
      /* 保存できない環境（プライベートブラウズなど）では、このページを開いている間だけ使う */
    }
    url.searchParams.delete("key");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return key;
  }
  try {
    return localStorage.getItem(KEY_STORAGE) || "";
  } catch (e) {
    return "";
  }
}

/**
 * 人数の JSON を取得する。想定の形でなければ（HTML のエラーページなど）例外にする。
 * 受付状態は stats.state に入れて返す。Code.gs が古くて受付状態を返さないときは null。
 */
export async function fetchStats(url, options) {
  const stats = await loadJson(url, {}, options);
  if (!stats || typeof stats !== "object" || typeof stats.quiz !== "object" || typeof stats.pred !== "object") {
    throw new Error("unexpected response");
  }
  try {
    stats.state = normalizeGate(stats.state);
  } catch (e) {
    stats.state = null;
  }
  return stats;
}

/**
 * 司会キーが要る呼び出し。Code.gs が { error } を返したときは、error.code にその種類を入れた例外にする
 * （"unauthorized" = キー違い、"not_configured" = Google 側が未設定、"deck_error" = スライドを開けない など）。
 * Code.gs が古くてその action を知らない場合は人数の JSON が返るので、code: "unsupported" にする。
 */
async function callWithKey(url, key, params, options, isValid) {
  const data = await loadJson(url, { ...params, key }, options);
  if (data && typeof data.error === "string") {
    throw Object.assign(new Error(data.message || data.error), { code: data.error });
  }
  if (!data || !isValid(data)) {
    throw Object.assign(new Error("Apps Script が古いままです（Code.gs の更新と再デプロイが必要）"), { code: "unsupported" });
  }
  return data;
}

/** 待っても直らない失敗か（キー違い・未設定・Code.gs が古い）。 */
export const isFatal = (error) => ["unauthorized", "not_configured", "unsupported", "bad_target"].includes(error?.code);

/**
 * スライド一覧を取得する。
 * refresh: "all"（全部作り直す）または objectId のカンマ区切り（その画像だけ作り直す）。
 */
export function fetchSlideList(url, key, refresh, options) {
  const params = refresh ? { action: "slides", refresh } : { action: "slides" };
  return callWithKey(url, key, params, options, (data) => Array.isArray(data.slides));
}

/** 正解の一覧 { "1": "B", … } を取得する。 */
export async function fetchAnswers(url, key, options) {
  const data = await callWithKey(url, key, { action: "answers" }, options, (d) => d.answers && typeof d.answers === "object");
  return data.answers;
}

/**
 * 予想が的中した人（そろった数 n を予想していた人）の名前を取得する。返すのは { n, count, names }。
 * Code.gs が古いときは人数の JSON が返るので、code: "unsupported" の例外になる。
 */
export async function fetchPredHits(url, key, n, options) {
  const data = await callWithKey(url, key, { action: "predHits", n: String(n) }, options, (d) => normalizePredHits(d, n) !== null);
  return normalizePredHits(data, n);
}

/**
 * クイズの成績の順位（正解数の多い順。上位 limit 人ぶん）を取得する。返すのは js/ranking.js の normalizeRanking の形。
 * Code.gs が古いときは人数の JSON が返るので、code: "unsupported" の例外になる。
 */
export async function fetchRanking(url, key, limit, options) {
  const data = await callWithKey(url, key, { action: "ranking", limit: String(limit) }, options, (d) => normalizeRanking(d) !== null);
  return normalizeRanking(data);
}

/** 受付を切り替えて、切り替えたあとの受付状態を返す。target: "q1"〜"q10" / "pred" / "none" / "idle" */
export async function sendSetOpen(url, key, target, options) {
  const data = await callWithKey(url, key, { action: "setOpen", target }, options, (d) => d.ok === true);
  return normalizeGate(data.state);
}
