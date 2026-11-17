/*
 * 司会画面の「ランキング」のスライドと「景品」のスライド（kind: "prize"）を行き来する進み方。
 * 画面にも通信にも触らない部品で、node でテストできる。
 *
 * ランキングのスライドのすぐ後ろに「2位の景品」「1位の景品」のスライドを続けて並べておくと、
 * 順位の発表の途中に、その順位の景品のスライドをはさんで映す:
 *
 *   ランキング（スライドだけ）→ 4位 → 2位 →【2位の景品】→ ランキングに戻って 1位 →【1位の景品】→ 景品のスライドの次のスライド
 *
 * 決まり:
 *   - 使うのは、ランキングのスライドの「すぐ後ろに続けて並んだ」景品のスライドだけ（並び順は問わない）。
 *     同じ順位の景品が2枚続いていたら最初の1枚。それ以外の景品のスライドは、普通のスライドとして並び順どおりに映す
 *   - N位の景品は、N位以下（数字が N 以上）の組をすべて映したあと、N位より上の組を映す前に映す。
 *       N位の組があれば、その組を映した直後（同点で N位が何人いても同じ）
 *       N位の組がなければ（上の順位が同点で、N位が空いた）、その上の組を映す直前
 *       例: 1位が同点2人で 2位がいない → 3位以下 →【2位の景品】→ 1位（2人）→【1位の景品】
 *   - 順位を映せないとき（取得できない・誰も答えていない）や、景品のスライドが無いときは、この進み方を使わない
 *     （prizeFlow が null を返す。スライドは並び順どおり: ランキング → 2位の景品 → 1位の景品 → …）
 *   - ← は、同じ順番を1つずつ逆にたどる
 */

/** 景品のスライドとして扱う順位の上限（js/ranking.js の RANK_MAX_LIMIT、apps-script/Code.gs の RANKING_MAX_LIMIT と同じ）。 */
export const PRIZE_MAX_PLACE = 30;

/** そのスライドが「N位の景品」のスライドなら N。そうでなければ null。 */
export function prizePlaceOf(slide) {
  const place = slide?.kind === "prize" ? slide.place : null;
  return Number.isInteger(place) && place >= 1 && place <= PRIZE_MAX_PLACE ? place : null;
}

/**
 * ランキングのスライド（slides[rankingIndex]）のすぐ後ろに続く景品のスライド。[{ index, place }]（並び順のまま）。
 * 同じ順位の2枚目以降は入れない（そのスライドは普通のスライドとして映る）。
 */
export function prizeRun(slides, rankingIndex) {
  const run = [];
  const seen = new Set();
  for (let index = rankingIndex + 1; index < slides.length; index++) {
    const place = prizePlaceOf(slides[index]);
    if (place === null) break;
    if (!seen.has(place)) run.push({ index, place });
    seen.add(place);
  }
  return run;
}

/**
 * → を押すたびに映すものの並び。[{ shown, prize }]
 *   shown: ランキングで映している組の数（下の順位から数える。0 = スライドだけ）
 *   prize: null ならランキングのスライド。{ index, place } なら、その景品のスライド
 * rows: 順位の組（上の順位から。js/ranking.js の normalizeRanking の rows）。prizes: prizeRun の結果。
 */
export function prizeSteps(rows, prizes) {
  const pending = [...prizes].sort((a, b) => b.place - a.place); // 下の順位の景品から
  const steps = [{ shown: 0, prize: null }];
  for (let i = rows.length - 1; i >= 0; i--) {
    const shown = rows.length - i;
    // この組より下の順位の景品が残っていれば、この組を映す前に映す
    while (pending.length > 0 && pending[0].place > rows[i].place) steps.push({ shown: shown - 1, prize: pending.shift() });
    steps.push({ shown, prize: null });
  }
  for (const prize of pending) steps.push({ shown: rows.length, prize });
  return steps;
}

/**
 * いまのスライド一覧と順位の取得状況から、進み方を作る。使わないときは null。
 * 返すもの: { rankingIndex, steps }。ranking は js/ranking.js の取得状況（{ status, data }）。
 */
export function prizeFlow(slides, ranking) {
  if (!ranking || ranking.status !== "ok" || ranking.data.rows.length === 0) return null;
  const rankingIndex = slides.findIndex((slide) => slide?.kind === "ranking");
  if (rankingIndex < 0) return null;
  const prizes = prizeRun(slides, rankingIndex);
  return prizes.length > 0 ? { rankingIndex, steps: prizeSteps(ranking.data.rows, prizes) } : null;
}

/**
 * いま映しているものが、進み方の何番目か。進み方の外（ほかのスライド）なら -1。
 * slideIndex: いまのスライドの添字。shown: ランキングで映している組の数。
 */
export function flowPos(flow, slideIndex, shown) {
  if (slideIndex === flow.rankingIndex) return flow.steps.findIndex((step) => !step.prize && step.shown === shown);
  return flow.steps.findIndex((step) => step.prize?.index === slideIndex);
}

/**
 * 1つ操作したあとの位置を返す。action: "advance"（→）/ "retreat"（←）/ "return"（次のスライドから ← で戻ってきた）
 * 返すもの: { pos, leave }。leave が "next" / "prev" なら、この進み方を離れて次・前のスライドへ。
 */
export function stepFlow(flow, pos, action) {
  const last = flow.steps.length - 1;
  if (action === "advance") return pos < last ? { pos: pos + 1, leave: null } : { pos, leave: "next" };
  if (action === "retreat") return pos > 0 ? { pos: pos - 1, leave: null } : { pos, leave: "prev" };
  if (action === "return") return { pos: last, leave: null };
  return { pos, leave: null };
}

/** 進み方を終えたあとに進むスライドの添字（進み方で映した景品のスライドは飛ばす）。なければ -1。 */
export function flowExit(flow, slideCount) {
  const used = new Set(flow.steps.filter((step) => step.prize).map((step) => step.prize.index));
  for (let index = flow.rankingIndex + 1; index < slideCount; index++) if (!used.has(index)) return index;
  return -1;
}

/** そのスライドが、進み方の中で映す景品のスライドか（並び順どおりの移動では飛ばす）。 */
export function inFlow(flow, slideIndex) {
  return flow.steps.some((step) => step.prize?.index === slideIndex);
}
