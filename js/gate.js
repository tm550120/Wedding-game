/*
 * 受付状態（いま、どの問題の回答を受け付けているか）。回答ページと司会画面の両方で使う。
 *
 * 受付の対象（target）: "q1"〜"q10" = クイズの第1問〜第10問、"pred" = 以心伝心ゲーム予想
 * 受付状態（gate）: { open, lastClosed, done, rev, results }
 *   open       … いま受け付けている対象。無ければ null
 *   lastClosed … 直前に締め切った対象（回答ページに「締め切りました」と出す）。待ち受け中は null
 *   done       … 一度受付を開けて、いまは閉じている対象の一覧
 *   rev        … 状態が変わるたびに 1 増える番号
 *   results    … 各自のクイズの成績を公開しているか（司会画面が「ランキング」のスライドに来ると true。
 *                回答ページは、これを見て自分の成績を読みに行く）。Code.gs が古くてこの値を返さないときは false
 * 本物の状態は Apps Script（apps-script/Code.gs）が持ち、司会画面だけが切り替えられる。
 */
import { SECTIONS } from "./config.js";
import { loadJson } from "./net.js";

export const EMPTY_GATE = Object.freeze({ open: null, lastClosed: null, done: [], rev: 0, results: false });

/** 対象の文字列を { target, section, index } にする（index は 0 始まり）。対象でなければ null。 */
export function parseTarget(target) {
  const m = /^q(\d{1,2})$/.exec(String(target));
  if (!m && target !== "pred") return null;
  const section = SECTIONS.find((s) => s.id === (m ? "quiz" : "pred"));
  const index = m ? Number(m[1]) - 1 : 0;
  if (!section || index < 0 || index >= section.form.answerEntries.length) return null;
  return { target, section, index };
}

/** すべての対象（"q1", …, "q10", "pred"）。 */
export const ALL_TARGETS = SECTIONS.flatMap((section) =>
  section.id === "quiz" ? section.form.answerEntries.map((_, i) => "q" + (i + 1)) : section.id === "pred" ? ["pred"] : []
);

/** 「第5問」「予想」のような短い呼び名。 */
export function targetLabel(target) {
  const parsed = parseTarget(target);
  return parsed ? parsed.section.answerLabel(parsed.index) : "";
}

/**
 * 送信済みロック（{ セクションid: { 問題番号(0始まり): 回答 } }）から、受付状態に合わないものを外して返す。
 * ロックが正しいのは、その対象がいま受付中か、締め切り済み（done）のときだけ。
 * リハーサルのあとに受付の記録を消す（resetGame）と done が空に戻るので、端末に残ったリハーサルの
 * ロックがここで外れ、本番で同じ問題に答えられるようになる。
 * 外すものが無ければ、渡された sent をそのまま返す（呼び出し側が「変わったか」を === で見分けられる）。
 * gate には、サーバーから実際に読めた状態だけを渡すこと（読めなかったときの仮の状態を渡すとロックが消える）。
 */
export function pruneSent(sent, gate) {
  if (!sent || typeof sent !== "object") return sent;
  const live = new Set([gate.open, gate.lastClosed, ...gate.done]);
  const targetOf = (sectionId, index) => (sectionId === "quiz" ? "q" + (Number(index) + 1) : sectionId);
  let changed = false;
  const kept = {};
  for (const [sectionId, answers] of Object.entries(sent)) {
    // 知らないセクションや壊れた値には触らない（どのみち表示には使われない）
    if (!SECTIONS.some((s) => s.id === sectionId) || !answers || typeof answers !== "object") {
      kept[sectionId] = answers;
      continue;
    }
    const entries = Object.entries(answers).filter(([index]) => live.has(targetOf(sectionId, index)));
    if (entries.length !== Object.keys(answers).length) changed = true;
    if (entries.length > 0) kept[sectionId] = Object.fromEntries(entries);
  }
  return changed ? kept : sent;
}

/** Apps Script から届いた受付状態を確かめる。想定の形でなければ（古い Code.gs など）例外にする。 */
export function normalizeGate(raw) {
  if (!raw || typeof raw !== "object" || !("open" in raw)) throw new Error("unexpected state");
  const valid = (target) => (parseTarget(target) ? target : null);
  return {
    open: valid(raw.open),
    lastClosed: valid(raw.lastClosed),
    done: Array.isArray(raw.done) ? raw.done.filter(parseTarget) : [],
    rev: Number(raw.rev) || 0,
    results: raw.results === true,
  };
}

/** 回答ページ用: 受付状態だけを読む（…/exec?action=state）。 */
export async function fetchGate(url, options) {
  return normalizeGate(await loadJson(url, { action: "state" }, options));
}

/**
 * 回答ページ用: 次に受付状態を読むまで待つ時間（ミリ秒）。base はいつもの間隔、failures は続けて失敗した回数。
 * 1回失敗しただけなら、いつもの間隔のまま読み直す（Apps Script への読み取りは、ときどき応答が返らないまま止まる。
 * そのたびに間隔をあけると、受付が開いたのに気づくのが遅れる）。2回以上続いたら 2倍・4倍…とあける（上限 maxBackoffMs）。
 */
export function gatePollDelay(base, failures, maxBackoffMs) {
  if (!(failures > 1)) return base;
  return Math.min(base * 2 ** Math.min(failures - 1, 5), Math.max(maxBackoffMs, base));
}

/**
 * 受付を切り替えたあとの状態を返す（Code.gs の setOpen_ と同じ決まり）。
 * 司会画面が、応答を待たずに表示を先に変えるためと、デモ表示のために使う。
 *   target: 対象 = その受付を開ける / "none" = 締め切る / "idle" = 締め切って待ち受けに戻す
 */
export function reduceGate(gate, target) {
  const wanted = parseTarget(target) ? target : null;
  let { open, lastClosed } = gate;
  let done = gate.done;
  if (open && open !== wanted) {
    done = done.includes(open) ? done : [...done, open];
    lastClosed = open;
    open = null;
  }
  let results = gate.results === true;
  if (wanted && open !== wanted) {
    done = done.filter((t) => t !== wanted);
    open = wanted;
    lastClosed = null;
    results = false; // 受付を開けたら、成績の公開は取り消す
  }
  if (target === "idle") lastClosed = null;
  const same = open === gate.open && lastClosed === gate.lastClosed;
  return same ? gate : { open, lastClosed, done, rev: gate.rev + 1, results };
}

/** 各自の成績を公開したあとの状態を返す（Code.gs の revealResults_ と同じ決まり。デモ表示で使う）。すでに公開していれば、そのまま。 */
export function revealGate(gate) {
  return gate.results === true ? gate : { ...gate, rev: gate.rev + 1, results: true };
}

/**
 * 司会画面が正解を映す段に入るときに頼む切り替え先。
 * 正解を映している間、回答ページは「締め切りました」ではなく「次の問題をお待ちください」にする。
 * "idle" は open と lastClosed を消すが done は残すので、送信済みロック（pruneSent）は外れない。
 * すでに待ち受けなら、頼むことはない（null）。
 */
export function revealRequest(gate) {
  return gate.open || gate.lastClosed ? "idle" : null;
}

/**
 * 回答ページがいま出す表示の種類（受付状態が読めているとき）。
 *   "question" … 受付中の問題がある（gate.open）
 *   "finished" … 何も受け付けておらず、予想（"pred"）が締め切り済み。予想のあとはスマホを使わないので、
 *                「お待ちください」の代わりに終了の画面を出す（予想を締め切った直後もここ）
 *   "closed"   … 直前の問題を締め切った（gate.lastClosed）
 *   "waiting"  … 何も受け付けていない
 * 終了のあとに司会が受付を開け直せば "question" に、記録を消せば（done が空）"waiting" に戻る。
 * finishedEnabled が false（終了の文言が空）なら "finished" にはしない。
 */
export function guestMode(gate, finishedEnabled = true) {
  if (parseTarget(gate.open)) return "question";
  if (finishedEnabled && gate.done.includes("pred")) return "finished";
  if (parseTarget(gate.lastClosed)) return "closed";
  return "waiting";
}

/*
 * デモ表示（?demo=1）用の受付状態。Apps Script の代わりに、このブラウザの localStorage に置く。
 * 同じブラウザで host.html?demo=1 と index.html?demo=1 を開くと、司会画面の操作が回答ページに伝わる。
 */
const DEMO_KEY = "wg-demo-gate";

export function readDemoGate() {
  try {
    return normalizeGate(JSON.parse(localStorage.getItem(DEMO_KEY)));
  } catch (e) {
    return EMPTY_GATE;
  }
}

export function writeDemoGate(gate) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(gate));
  } catch (e) {
    /* 保存できない環境では、司会画面のデモだけが動く */
  }
}
