/*
 * 司会画面の「ランキング」のスライド（kind: "ranking"）の進み方。画面にも通信にも触らない部品で、node でテストできる。
 *
 * クイズが終わったあと、正解数の多い順に上位の人を発表する。同じ正解数の人は同じ順位（1位, 2位, 2位, 4位, …）。
 *
 *   スライドに来る … スライドだけを映す（その間に、司会キーで Apps Script から順位を取得する。?action=ranking）
 *   →             … 順位の組を1つずつ映す。下の順位から始めて、1位が最後
 *   →（1位のあと） … 次のスライドへ（1位を映したあとは、上位の全員が並んだまま）
 *   ←             … 1つずつ戻る → 前のスライドへ
 *
 * 景品の数（limit）をまたぐ同点の組は「同点 3名 → じゃんけんで 2名」と映し、それより上の組には「入賞」と付ける。
 * 順位を取得できないとき（司会キーがない・Code.gs が古い・「正解」タブがない・通信エラー）は、
 * 司会者にだけ理由を知らせて、→ で次のスライドへ進める。
 */
/** 景品の数（limit）の既定値と上限（apps-script/Code.gs の RANKING_DEFAULT_LIMIT / RANKING_MAX_LIMIT と合わせる）。 */
export const RANK_DEFAULT_LIMIT = 5;
export const RANK_MAX_LIMIT = 30;

/** shown: いま映している組の数（0 = まだ何も映していない）。 */
export const RANK_START = Object.freeze({ shown: 0 });

/** 設定値（HOST.rankingLimit）を、1〜30 の整数にする。それ以外は既定値（5）。 */
export function rankLimitOf(value) {
  return Number.isInteger(value) && value >= 1 && value <= RANK_MAX_LIMIT ? value : RANK_DEFAULT_LIMIT;
}

const isCount = (value, min) => Number.isInteger(value) && value >= min;

/**
 * 順位を決める（apps-script/Code.gs の quizRanking_ と同じ決まり。デモ表示で使う）。
 * people: [{ name, score }]。返すのは { total, limit, groups: [{ place, score, names }], cutoff: { place, slots, names } | null }。
 *   - 順位 = 1 + 自分より正解数が多い人の数。同じ正解数の人は同じ組
 *   - 上から順に、人数の合計が limit に届くまでの組を入れる
 *   - limit をまたぐ組は cutoff にも入れる。slots はその組に残っている枠の数
 */
export function rankGroups(people, limit) {
  const byScore = new Map();
  for (const { name, score } of people) byScore.set(score, [...(byScore.get(score) || []), name]);
  const groups = [];
  let cutoff = null;
  let above = 0;
  for (const score of [...byScore.keys()].sort((a, b) => b - a)) {
    if (above >= limit) break;
    const names = byScore.get(score).sort((a, b) => a.localeCompare(b, "ja"));
    groups.push({ place: above + 1, score, names });
    if (above + names.length > limit) cutoff = { place: above + 1, slots: limit - above, names };
    above += names.length;
  }
  return { total: people.length, limit, groups, cutoff };
}

/**
 * Apps Script の応答（{ total, limit, answered, groups, cutoff }）を確かめて、画面で使う形にする。想定の形でなければ null。
 * 返すのは { total, limit, answered, rows }。rows は上の順位から並べた組:
 *   { place, score, names, cutoff, slots }  cutoff が true の組は、names の中から slots 人だけが入賞する（じゃんけん）
 * 名前は文字列だけを残し、前後の空白を除く。名前が1つもない組は捨てる。
 */
export function normalizeRanking(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.groups) || !isCount(data.limit, 1)) return null;
  const rows = [];
  for (const group of data.groups) {
    if (!group || typeof group !== "object" || !isCount(group.place, 1) || !isCount(group.score, 0) || !Array.isArray(group.names)) return null;
    const names = group.names.filter((name) => typeof name === "string").map((name) => name.trim()).filter(Boolean);
    if (names.length > 0) rows.push({ place: group.place, score: group.score, names, cutoff: false, slots: names.length });
  }
  rows.sort((a, b) => a.place - b.place);
  // 同点で全員は入れない組。枠の数が「1人以上・その組の人数未満」のときだけ、じゃんけんの組にする
  const cut = data.cutoff && typeof data.cutoff === "object" ? rows.find((row) => row.place === data.cutoff.place) : null;
  if (cut && isCount(data.cutoff.slots, 1) && data.cutoff.slots < cut.names.length) {
    cut.cutoff = true;
    cut.slots = data.cutoff.slots;
  }
  const answered = Array.isArray(data.answered) ? data.answered.filter((no) => isCount(no, 1)) : [];
  const count = rows.reduce((sum, row) => sum + row.names.length, 0);
  return { total: Math.max(isCount(data.total, 0) ? data.total : 0, count), limit: data.limit, answered, rows };
}

/*
 * 順位の取得状況（ranking）: { status: "loading" | "ok" | "nokey" | "unsupported" | "error" | "failed", data, message }
 * data は normalizeRanking の結果（status が "ok" のときだけ）。
 */

/** → を押す回数（映す段の数）。順位を映せないときは 0。誰も答えていないときは 1（その知らせを映す）。 */
export function rankSteps(ranking) {
  if (!ranking || ranking.status !== "ok") return 0;
  return Math.max(ranking.data.rows.length, 1);
}

/** いま映している組の数（0 = スライドだけ）。順位を映せなくなったら 0。 */
export function rankShown(rank, ranking) {
  return Math.min(Math.max(rank.shown, 0), rankSteps(ranking));
}

/**
 * 1つ操作したあとの状態を返す。action: "advance"（→）/ "retreat"（←）/ "return"（次のスライドから ← で戻ってきた）
 * 返すもの: { rank, leave }。leave が "next" / "prev" なら、このスライドを離れて次・前のスライドへ。
 */
export function stepRank(rank, action, ranking) {
  const steps = rankSteps(ranking);
  const shown = rankShown(rank, ranking);
  if (action === "advance") {
    // 取得中は進めない（押し間違いで発表を飛ばさないように）。取得できなければ、そのまま次のスライドへ
    if (ranking?.status === "loading") return { rank, leave: null };
    return shown < steps ? { rank: { shown: shown + 1 }, leave: null } : { rank, leave: "next" };
  }
  if (action === "retreat") {
    return shown > 0 ? { rank: { shown: shown - 1 }, leave: null } : { rank, leave: "prev" };
  }
  if (action === "return") return { rank: { shown: steps }, leave: null }; // 全員を映した続きから
  return { rank, leave: null };
}

/**
 * 司会者への知らせ（右下に小さく出す）。順位を映せない理由と、正解が未設定で採点していない問題。知らせることがなければ ""。
 * questionCount: クイズの問題数。
 */
export function rankNote(ranking, questionCount) {
  if (!ranking) return "";
  switch (ranking.status) {
    case "loading":
      return "ランキングを集計中…";
    case "nokey":
      return "ランキングを表示するには司会キーが必要です";
    case "unsupported":
      return "ランキングを表示するには Apps Script を更新してください";
    case "error":
      return "ランキングを取得できません（R キーでもう一度試します）";
    case "failed":
      return "ランキングを表示できません: " + (ranking.message || "不明なエラー");
    case "ok": {
      const missing = [];
      for (let no = 1; no <= questionCount; no++) if (!ranking.data.answered.includes(no)) missing.push("第" + no + "問");
      return missing.length > 0 ? "正解が未設定の問題は採点していません: " + missing.join("・") : "";
    }
    default:
      return "";
  }
}

export const placeLabel = (place) => place + "位";
export const scoreLabel = (score) => score + "問正解";
/** 同点で全員は入れない組の説明。「同点 3名 → じゃんけんで 2名」 */
export const cutoffLabel = (row) => "同点 " + row.names.length + "名 → じゃんけんで " + row.slots + "名";

/*
 * 並べ方。組の数と人数に合わせて、名前の列の数と文字の大きさを決める（1920×1080 に収める）。
 * 大きさはすべて画面の高さ（vh）基準で、css/host.css の .rank-* と合わせてある。
 */
const TIERS = [
  { columns: 3, font: 5.6 },
  { columns: 4, font: 4.6 },
  { columns: 5, font: 3.8 },
  { columns: 6, font: 3.1 },
  { columns: 8, font: 2.4 },
];
const NAMES_WIDTH = 108; // 名前を並べる領域の幅
const NAME_GAP = 1.4; // 名前の枠どうしの横の間隔
const NAME_ROW_GAP = 1; // 〃 縦の間隔
const NAME_PADDING = 0.9; // 名前の枠の内側の余白（上下左右）
const NAME_SPACING = 0.06; // 字間（em）
const HEAD_HEIGHT = 8; // 「1位 8問正解」の高さ
const CUTOFF_HEIGHT = 5.6; // 「同点 3名 → じゃんけんで 2名」の行の高さ（下の間隔を含む）
const ROW_PADDING = 2.4; // 1つの組の上下の余白の合計
const ROW_GAP = 1.4; // 組どうしの間隔
export const RANK_LIST_HEIGHT = 72; // 一覧に使える高さ

/** その並べ方（tier）で、一覧全体が使う高さ。 */
function listHeight(rows, tier) {
  const chip = tier.font * 1.3 + NAME_PADDING * 2;
  const total = rows.reduce((sum, row) => {
    const lines = Math.ceil(row.names.length / tier.columns);
    const names = lines * chip + (lines - 1) * NAME_ROW_GAP + (row.cutoff ? CUTOFF_HEIGHT : 0);
    return sum + Math.max(HEAD_HEIGHT, names) + ROW_PADDING;
  }, 0);
  return total + Math.max(rows.length - 1, 0) * ROW_GAP;
}

/**
 * 返すもの: { columns, font, width, fit, height }。width は名前1つの枠の幅、fit はその枠に縮めずに収まる全角の文字数、
 * height は一覧全体の高さの見積もり。大きい文字から順に試して、最初に収まった並べ方を使う。
 * 長い名前は、js/pred-result.js の nameScale(name, fit) でその枠だけ縮める。
 */
export function rankLayout(rows) {
  // どれも収まらないとき（組がとても多い）は、いちばん低い並べ方と高さがほぼ同じ（1割増しまで）もののうち、
  // 文字が大きいものにする（そのうえで、画面側が全体を縮めて収める）
  const lowest = Math.min(...TIERS.map((t) => listHeight(rows, t)));
  const tier = TIERS.find((t) => listHeight(rows, t) <= Math.max(RANK_LIST_HEIGHT, lowest * 1.1));
  const width = (NAMES_WIDTH - (tier.columns - 1) * NAME_GAP) / tier.columns;
  const fit = (width - NAME_PADDING * 2) / (tier.font * (1 + NAME_SPACING));
  return { columns: tier.columns, font: tier.font, width, fit, height: listHeight(rows, tier) };
}
