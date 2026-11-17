/*
 * 司会画面の「予想結果」のスライド（kind: "predResult"）の進み方。画面にも通信にも触らない部品で、node でテストできる。
 *
 * 以心伝心ゲームが終わったあと、司会者が「実際にそろった数」をキーで入れて発表する。
 *
 *   input … スライドだけを映す。司会者にだけ「一致数を入力（0〜5キー）」と小さく出す
 *   count … 「そろったのは 3問！」を大きく映す
 *   names … 「予想的中 ◯人」と、その数を予想していた人の名前を映す
 *
 *   0〜5 のキー … その数で count へ（どの段からでも入れ直せる）
 *   →           … input → 次のスライド（入力せずに通り過ぎる）/ count → names / names → 次のスライド
 *   ←           … names → count → input → 前のスライド
 *
 * 名前は司会キーで Apps Script から取得する（?action=predHits）。取得できないとき（司会キーがない・
 * Code.gs が古い・通信エラー）は names の段を飛ばし、count の段で司会者にだけ理由を知らせる。
 */

/** そろう数の上限（予想の選択肢は 0問〜5問。apps-script/Code.gs の PRED_CHOICES と合わせる）。 */
export const PRED_MAX = 5;

export const PRED_START = Object.freeze({ n: null, step: "input" });

/** キーの文字（KeyboardEvent.key）を、そろった数（0〜5）にする。それ以外のキーは null。 */
export function matchedCountOf(key) {
  if (typeof key !== "string" || !/^[0-9]$/.test(key)) return null;
  const n = Number(key);
  return n <= PRED_MAX ? n : null;
}

/**
 * 名前の取得状況（hits）が、いま入力されている数 n のもので、名前を映せる（取得済み・取得中）か。
 * hits: { n, status: "loading" | "ok" | "nokey" | "unsupported" | "error" | "failed", count, names, message }
 */
export function namesReady(hits, n) {
  return Boolean(hits) && hits.n === n && (hits.status === "ok" || hits.status === "loading");
}

/** いま画面に映す段。names の段にいても、名前を映せなくなったら count を映す。 */
export function predStep(pred, hits) {
  if (pred.n === null) return "input";
  if (pred.step === "names" && !namesReady(hits, pred.n)) return "count";
  return pred.step;
}

/**
 * 1つ操作したあとの状態を返す。action: 0〜5 の数（数字キー）/ "advance"（→）/ "retreat"（←）/ "return"（次のスライドから ← で戻ってきた）
 * 返すもの: { pred, leave }。leave が "next" / "prev" なら、このスライドを離れて次・前のスライドへ。
 */
export function stepPred(pred, action, hits) {
  if (typeof action === "number") {
    const valid = Number.isInteger(action) && action >= 0 && action <= PRED_MAX;
    return { pred: valid ? { n: action, step: "count" } : pred, leave: null };
  }
  const step = predStep(pred, hits);
  if (action === "advance") {
    if (step === "count" && namesReady(hits, pred.n)) return { pred: { n: pred.n, step: "names" }, leave: null };
    return { pred, leave: "next" };
  }
  if (action === "retreat") {
    if (step === "names") return { pred: { n: pred.n, step: "count" }, leave: null };
    if (step === "count") return { pred: PRED_START, leave: null };
    return { pred, leave: "prev" };
  }
  if (action === "return") {
    // 発表を終えて進んだあとで戻ってきたら、最後の段（名前。映せなければ「そろったのは」）から
    return { pred: pred.n === null ? PRED_START : { n: pred.n, step: "names" }, leave: null };
  }
  return { pred, leave: null };
}

/** 名前を映せない理由（司会者向けに、右下に小さく出す）。映せるとき・まだ数を入れていないときは ""。 */
export function hitsNote(hits, n) {
  if (n === null || !hits || hits.n !== n) return "";
  switch (hits.status) {
    case "nokey":
      return "名前を表示するには司会キーが必要です";
    case "unsupported":
      return "名前を表示するには Apps Script を更新してください";
    case "error":
      return "名前を取得できません（数字キーを押し直すと、もう一度試します）";
    case "failed":
      return "名前を表示できません: " + (hits.message || "不明なエラー");
    default:
      return "";
  }
}

/**
 * Apps Script の応答（{ n, count, names }）を確かめて、画面で使う形にする。想定の形でなければ null。
 * names は文字列だけを残し、前後の空白を除く。count は名前の数より小さくならない。
 */
export function normalizePredHits(data, n) {
  if (!data || typeof data !== "object" || !Array.isArray(data.names) || Number(data.n) !== n) return null;
  const names = data.names.filter((name) => typeof name === "string").map((name) => name.trim()).filter(Boolean);
  const count = Math.max(Math.floor(Number(data.count)) || 0, names.length);
  return { n, count, names };
}

/*
 * 名前の並べ方。人数に合わせて列の数と文字の大きさを決める（1920×1080 で 30人が 5列×6段に収まる）。
 * 大きさはすべて画面の高さ（vh）基準: font = 文字の大きさ、width = 名前1つの枠の幅。
 */
const LAYOUTS = [
  { upTo: 6, columns: 3, font: 6.4, width: 48 },
  { upTo: 12, columns: 4, font: 5.4, width: 37 },
  { upTo: 20, columns: 5, font: 4.6, width: 30 },
  { upTo: 30, columns: 5, font: 4, width: 30 },
  { upTo: 42, columns: 6, font: 3.4, width: 25 },
  { upTo: Infinity, columns: 7, font: 2.8, width: 21.5 },
];
const NAME_PADDING = 1.2; // 枠の左右の余白（vh）。css/host.css の .pred-names-grid li と合わせる
const NAME_SPACING = 0.06; // 字間（em）。同上

/** 返すもの: { columns, font, width, fit }。fit は、その枠に縮めずに収まる全角の文字数。 */
export function namesLayout(count) {
  const tier = LAYOUTS.find((layout) => count <= layout.upTo);
  const fit = (tier.width - NAME_PADDING * 2) / (tier.font * (1 + NAME_SPACING));
  return { columns: Math.max(Math.min(tier.columns, count), 1), font: tier.font, width: tier.width, fit };
}

/** 名前の幅を、全角の文字数で見積もる（半角は約半分）。 */
export function nameWidth(name) {
  let width = 0;
  for (const ch of String(name)) {
    const code = ch.codePointAt(0);
    if (ch === " ") width += 0.35;
    else if (code <= 0x7f || (code >= 0xff61 && code <= 0xff9f)) width += 0.6;
    else width += 1;
  }
  return width;
}

/** 長い名前を枠に収めるための縮小率（0.45〜1）。fit は namesLayout の fit。 */
export function nameScale(name, fit) {
  const width = nameWidth(name);
  if (width <= fit) return 1;
  return Math.max(Math.round((fit / width) * 100) / 100, 0.45);
}
