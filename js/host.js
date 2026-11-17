/*
 * 司会画面（host.html）。会場のスクリーンに映す。
 *
 * Google スライドを1枚ずつ画像で映し、→ / クリックで進める。問題のスライド（第N問・予想）では、
 * 1枚のスライドの上で「受付 → 締め切り → 正解」の順に進む。
 *
 *   スライドに来る  … その問題の回答の受付を開ける（ゲストのスマホに回答ボタンが出る）。「回答 ◯人」と残り時間を重ねて映す
 *   → / 時間切れ   … 締め切る。「締め切り」と最終の人数を映す（HOST.autoCloseSec 秒たつと、→ を押さなくても締め切る）
 *   →              … 正解を重ねて映す（クイズだけ。予想には正解の表示はない）。ゲストのスマホは「お待ちください」に戻る
 *   →              … 次のスライドへ
 *   ←              … 正解を隠す → 前のスライドへ。締め切った問題に戻っても、受付は開け直さない
 *   O              … いまのスライドの問題の受付を開け直す（残り時間は最初から数え直す）
 *
 * 「予想結果」のスライド（kind: "predResult"）では、司会者が実際にそろった数を 0〜5 のキーで入れると
 * 「そろったのは 3問！」を映し、→ でその数を予想していた人の名前を映す（進み方は js/pred-result.js）。
 * このスライドでは受付を開けない（ゲストのスマホは「お待ちください」のまま）。
 *
 * 残り時間を数えるのは、受付を開ける操作をしたこの画面だけ。再読み込みしたり別の端末で開いたりした画面は、
 * 受付中の問題を映していても数えない（勝手に締め切らない）。
 *
 * どのスライドが問題かは Apps Script（apps-script/Code.gs）がスライド上の文字で判定して返す。
 * 受付状態は Apps Script が持つ。この画面は「→ を押した」などの操作のときだけ切り替えを頼み、
 * 開いただけ・再読み込みしただけでは何も切り替えない（別の端末で開いても本番の受付を壊さないように）。
 *
 * スライドを取得できないとき（司会キーがない / ?panel=1 / 取得に失敗）は、第1問〜第10問と予想を
 * 1枚ずつ並べた仮のスライドで同じように動く。司会キーがないときは受付を切り替えられず、人数を映すだけになる。
 *
 * 映すのは人数の合計だけ（選択肢ごとの人数は Apps Script からも届かない）。
 * 名前が届くのは「予想結果」のスライドで的中した人を取得するときだけ（司会キーが要る）。
 * 正解と名前は司会キーで取得して、この画面のメモリにだけ持つ。
 */
import { HOST } from "./config.js";
import { takeHostKey, fetchStats, fetchSlideList, fetchAnswers, fetchPredHits, sendSetOpen, isFatal } from "./host-api.js";
import { createDemoBackend } from "./host-demo.js";
import { panelSlides } from "./host-panel.js";
import { createPoller } from "./poller.js";
import { ALL_TARGETS, EMPTY_GATE, parseTarget, targetLabel, reduceGate, revealRequest } from "./gate.js";
import { autoCloseSeconds, countdownView } from "./countdown.js";
import { PRED_START, matchedCountOf, predStep, stepPred, predHint, namesLayout, nameScale } from "./pred-result.js";

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const DEMO = query.get("demo") === "1";
const PANEL_ONLY = query.get("panel") === "1" || query.get("chart") === "1";
const hostKey = takeHostKey(); // URL の ?key=… はここで保存して、アドレスバーから消す
const startHash = location.hash; // 再読み込み前の位置。"#s12" = 12枚目

const AUTO_CLOSE_SEC = autoCloseSeconds(HOST, DEMO); // 0 なら自動では締め切らない

const net = { timeoutMs: HOST.timeoutMs, transport: HOST.transport };

/*
 * Apps Script とのやり取り一式。null なら未設定。
 * loadSlides / loadAnswers / loadPredHits / setOpen は司会キーが要るので、キーがなければ null（表示のみになる）。
 */
const backend = DEMO
  ? createDemoBackend()
  : !HOST.statsUrl
    ? null
    : {
        loadStats: () => fetchStats(HOST.statsUrl, net),
        loadSlides: hostKey ? (refresh) => fetchSlideList(HOST.statsUrl, hostKey, refresh, { ...net, timeoutMs: HOST.slidesTimeoutMs }) : null,
        loadAnswers: hostKey ? () => fetchAnswers(HOST.statsUrl, hostKey, net) : null,
        loadPredHits: hostKey ? (n) => fetchPredHits(HOST.statsUrl, hostKey, n, net) : null,
        setOpen: hostKey ? (target) => sendSetOpen(HOST.statsUrl, hostKey, target, net) : null,
      };
const loadSlides = PANEL_ONLY ? null : backend?.loadSlides || null;

const state = {
  slides: [],        // { objectId, kind, question, el, imageUrl, loaded, failed }
  slide: 0,          // slides の添字
  panel: false,      // 仮のスライド（第1問〜予想）で動いているか
  waitingForSlides: false,
  gate: EMPTY_GATE,  // 受付状態（切り替えを頼んだ直後は、応答を待たずに先に変えてある）
  gateKnown: false,  // Apps Script から受付状態を一度でも受け取ったか
  stats: null,       // 最後に取得できた人数（取得に失敗しても消さない）
  answers: null,     // 正解 { "1": "B", … }。まだ取得できていなければ null
  revealed: false,   // いまのスライドで正解を映しているか
  pred: PRED_START,  // 「予想結果」のスライドの段 { n: そろった数 | null, step: "input" | "count" | "names" }
  hits: null,        // 的中した人の取得状況 { n, status, count, names, message }（js/pred-result.js の namesReady を参照）
  missing: "",       // スライドに目印が見つからない問題（1枚目でだけ知らせる）
  errors: {},
};

/* ===== 受付の対象と状態 ===== */

/** そのスライドが受け付ける対象（"q5" / "pred"）。普通のスライドなら null。 */
function targetOf(slide) {
  if (!slide) return null;
  const target = slide.kind === "question" ? "q" + slide.question : slide.kind === "prediction" ? "pred" : null;
  return parseTarget(target) ? target : null;
}

const currentTarget = () => targetOf(state.slides[state.slide]);
const isPredResult = (slide) => slide?.kind === "predResult";
const isQuestion = (target) => target !== "pred";

/** その対象の受付の状態。"open" = 受付中 / "closed" = 締め切り済み / "ready" = まだ開けていない */
function viewOf(target) {
  if (state.gate.open === target) return "open";
  return state.gate.done.includes(target) ? "closed" : "ready";
}

/** 受付を切り替えられるか（司会キーがあり、いまの受付状態が分かっている）。 */
const writable = () => Boolean(backend?.setOpen) && state.gateKnown;

function totalOf(target) {
  const { section, index } = parseTarget(target);
  const counts = section.id === "quiz" ? state.stats?.quiz?.[String(index + 1)] : state.stats?.pred;
  return Math.max(Number(counts?.total) || 0, 0);
}

/*
 * 受付の切り替え。表示は応答を待たずに先に変え、Apps Script へは「いちばん新しい望み」だけを送る
 * （続けて操作したときに、途中の状態を1つずつ送らない）。失敗したら間隔をあけて送り直す。
 */
let desired = null; // まだ Apps Script に伝わっていない切り替え先
let writing = false;
let gateEpoch = 0; // 切り替えの前後で増える。切り替えをまたいだ取得結果（古い受付状態）を捨てるために使う

function requestGate(target) {
  if (!writable()) return;
  desired = target;
  state.gate = reduceGate(state.gate, target);
  gateEpoch++;
  // 受付を開ける操作のたびに、残り時間を最初から数える。締め切る・ほかへ切り替える操作なら、数えるのをやめる
  if (parseTarget(target)) startCountdown(target);
  else stopCountdown();
  pumpGate();
}

/*
 * 自動締め切り。受付を開ける操作をしたときだけ数え始める（requestGate からしか始まらない）ので、
 * 再読み込みやスライドの読み直しでは始まらない。
 */
let countdown = null; // { target, deadline }。数えていなければ null
let countdownTimer = null;

function startCountdown(target) {
  stopCountdown();
  if (!AUTO_CLOSE_SEC) return;
  countdown = { target, deadline: Date.now() + AUTO_CLOSE_SEC * 1000 };
  countdownTimer = setInterval(tickCountdown, 200);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  countdown = null;
}

function tickCountdown() {
  if (!countdown) return;
  if (state.gate.open !== countdown.target) {
    stopCountdown(); // ほかの画面から締め切られた・切り替えに失敗した
  } else if (countdownView(countdown.deadline, Date.now()).expired) {
    requestGate("none"); // 時間切れ。→ を1回押したのと同じ（数えるのもここで止まる）
    render();
    return;
  }
  renderCountdown();
}

/** 残り時間の表示だけを更新する（人数の数字のアニメーションを止めないよう、render とは分けてある）。 */
function renderCountdown() {
  const showing = Boolean(countdown) && countdown.target === currentTarget() && state.gate.open === countdown.target;
  $("gate-timer").classList.toggle("hidden", !showing);
  if (!showing) return;
  const view = countdownView(countdown.deadline, Date.now());
  $("gate-time").textContent = view.text;
  $("gate-timer").dataset.urgent = String(view.urgent);
}

async function pumpGate() {
  if (writing) return;
  writing = true;
  let wait = 0;
  while (desired !== null) {
    const target = desired;
    try {
      const gate = await backend.setOpen(target);
      if (desired === target) {
        desired = null;
        state.gate = gate;
      }
      wait = 0;
      setError("gate", "");
    } catch (e) {
      if (isFatal(e)) {
        desired = null; // 待っても直らない。受付状態は次の取得で実際の値に戻る
        setError("gate", "受付を切り替えられません: " + e.message);
      } else {
        setError("gate", "受付の切り替えに失敗（再試行中）");
        wait = Math.min((wait || 500) * 2, 8000);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  writing = false;
  gateEpoch++;
  render();
  kickPoll(true);
}

/* ===== 表示 ===== */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 数字を前の値から新しい値へなめらかに動かす。 */
function tweenNumber(node, to) {
  const from = Number(node.dataset.value || 0);
  node.dataset.value = String(to);
  cancelAnimationFrame(Number(node.dataset.raf || 0));
  if (from === to) {
    node.textContent = String(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / 600, 1);
    node.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
    if (t < 1) node.dataset.raf = String(requestAnimationFrame(step));
  };
  node.dataset.raf = String(requestAnimationFrame(step));
}

const STATUS_TEXT = { ready: "受付前", open: "回答受付中", closed: "締め切り" };

/** 司会者向けの、次の操作の案内（左下に小さく出す）。 */
function hintFor(target, view) {
  if (!target) return "";
  if (!backend?.setOpen) return "表示のみ（司会キーがないので、受付は切り替えられません）";
  if (!state.gateKnown) return "受付状態を確認中…";
  if (view === "ready") return "→ 受付開始";
  if (view === "open") return "→ 締め切る" + (countdown ? "（時間切れで自動的に締め切り）" : "");
  if (state.revealed) return "→ 次へ ／ ← 正解を隠す";
  return (isQuestion(target) ? "→ 正解を表示" : "→ 次へ") + " ／ O 受付を再開";
}

/** 「予想結果」のスライドの表示。step: いま映す段（"input" / "count" / "names"）。このスライドでなければ null。 */
function renderPredResult(step) {
  $("pred-prompt").classList.toggle("hidden", step !== "input");
  $("pred-names").classList.toggle("hidden", step !== "names");
  if (step !== "names") return;

  const { n } = state.pred;
  const loaded = state.hits.status === "ok";
  const names = loaded ? state.hits.names : [];
  const count = loaded ? state.hits.count : 0;
  $("pred-names-kicker").textContent = "✦ そろったのは " + n + "問 ✦";
  $("pred-names-count").textContent = loaded ? String(count) : "…";

  // 名前の一覧は、中身が変わったときだけ作り直す（定期更新のたびにアニメーションをやり直さない）
  const grid = $("pred-names-grid");
  const signature = n + "\n" + names.join("\n");
  if (grid.dataset.signature !== signature) {
    grid.dataset.signature = signature;
    const layout = namesLayout(names.length);
    grid.style.setProperty("--cols", String(layout.columns));
    grid.style.setProperty("--name-width", layout.width + "vh");
    grid.style.setProperty("--name-font", layout.font + "vh");
    grid.replaceChildren(
      ...names.map((name, i) => {
        const item = el("li", "", name);
        item.style.setProperty("--scale", String(nameScale(name, layout.fit)));
        item.style.setProperty("--i", String(i));
        return item;
      })
    );
  }
  grid.classList.toggle("hidden", names.length === 0);

  // 名前を出せないとき: 読み込み中 / 的中した人がいない / 名前のない回答だけ
  const message = !loaded ? "読み込み中…" : count === 0 ? "ぴったり当てた人はいませんでした…！\nみなさん、惜しかったです" : "";
  $("pred-names-message").textContent = message;
  $("pred-names-message").classList.toggle("hidden", names.length > 0);
}

/** 画面全体を、いまの状態に合わせる。 */
function render() {
  const current = state.slides[state.slide];
  const target = targetOf(current);
  const view = target ? viewOf(target) : null;
  const predView = isPredResult(current) ? predStep(state.pred, state.hits) : null;

  // スライド
  state.slides.forEach((slide) => slide.el.classList.toggle("current", slide === current));
  const showMessage = current ? !current.loaded : state.waitingForSlides;
  $("stage-message").classList.toggle("hidden", !showMessage);
  $("stage-message").textContent = current?.failed ? "スライドの画像を読み込めません（再試行中）" : "スライドを読み込み中…";
  $("slide-pos").textContent = current ? state.slide + 1 + " / " + state.slides.length : "";
  $("hint").textContent = predView ? predHint(state.pred, state.hits) : hintFor(target, view);

  // 受付の状態と人数（問題のスライドのときだけ）
  $("gate").classList.toggle("hidden", !target);
  if (target) {
    $("gate").dataset.view = view;
    $("gate-status").textContent = STATUS_TEXT[view];
    $("gate-count").classList.toggle("hidden", view === "ready");
    tweenNumber($("gate-total"), view === "ready" ? 0 : totalOf(target));
  }
  renderCountdown();

  // 予想結果（そろった数は、正解の発表と同じ札で映す）
  renderPredResult(predView);
  $("reveal").classList.toggle("pred", predView === "count");
  if (predView === "count") {
    $("reveal").classList.remove("missing");
    $("reveal-kicker").textContent = "✦ 以心伝心ゲーム ✦";
    $("reveal-label").textContent = "そろったのは";
    $("reveal-answer").textContent = state.pred.n + "問！";
  }

  // 正解
  const revealing = Boolean(target) && state.revealed;
  $("reveal").classList.toggle("hidden", !revealing && predView !== "count");
  if (revealing) {
    const answer = state.answers?.[String(parseTarget(target).index + 1)];
    $("reveal").classList.toggle("missing", !answer);
    $("reveal-kicker").textContent = "✦ " + targetLabel(target) + " ✦";
    $("reveal-label").textContent = answer ? "正解は" : state.answers ? "正解が未設定です" : "正解を読み込み中…";
    $("reveal-answer").textContent = answer || (state.answers ? "スプレッドシートの「正解」タブを確認してください" : "");
  }

  // スライドの目印の不足は、1枚目でだけ知らせる（本番の途中で出しっぱなしにしない）
  setError("deck", state.slide === 0 ? state.missing : "");
}

/** 右下のエラー表示。種類ごとに持ち、まとめて出す。 */
function setError(source, message) {
  state.errors[source] = message || "";
  const text = Object.values(state.errors).filter(Boolean).join(" / ");
  $("badge-error").textContent = text;
  $("badge-error").classList.toggle("hidden", !text);
}

/* ===== スライドの移動と、1枚の中の段階 ===== */

/**
 * スライドを移動する。how: "forward"（→ で1枚進んだ）/ "back"（← で1枚戻った）/ "jump"（Home・数字キーなど）/
 * "init"（開いた直後・スライド一覧の読み直し。受付は切り替えない）
 */
function goTo(index, how) {
  const next = Math.min(Math.max(index, 0), state.slides.length - 1);
  if (how !== "init" && next === state.slide) return;
  // 「予想結果」のスライドは、来るたびに数の入力から。次のスライドから ← で戻ってきたときだけ、発表した続きから
  //（そのために、ほかのスライドにいる間も state.pred は消さない）。
  // スライド一覧の読み直し（"init"）で同じスライドに留まるときは、発表の途中の段をそのまま保つ
  if (isPredResult(state.slides[next]) && !(how === "init" && next === state.slide)) {
    state.pred = how === "back" ? stepPred(state.pred, "return", state.hits).pred : PRED_START;
  }
  state.slide = next;
  state.revealed = false;

  const target = currentTarget();
  if (how !== "init" && writable()) {
    const view = target && viewOf(target);
    if (view === "ready" && how === "forward") {
      requestGate(target); // 問題のスライドに進んできたら、その問題の受付を開ける
    } else if (target) {
      // 戻ってきた・飛んできた問題は、勝手に開けない。ほかの問題が開いたままなら閉じる
      if (view === "closed" && how === "back" && isQuestion(target)) {
        state.revealed = true; // ← で「正解 → 締め切り」と戻れるように
        requestReveal();
      } else if (view !== "open" && state.gate.open) {
        requestGate("none");
      }
    } else if (state.gate.open || state.gate.lastClosed) {
      requestGate("idle"); // 普通のスライドでは何も受け付けない（ゲストは「お待ちください」になる）
    }
  }

  history.replaceState(null, "", "#s" + (next + 1)); // 再読み込みしても同じスライドに戻る
  // 次の2枚は先に展開しておき、切り替えた瞬間に映るようにする
  state.slides.slice(next + 1, next + 3).forEach((slide) => {
    if (slide.loaded) slide.el.decode?.().catch(() => {});
  });
  render();
}

/** 正解を映す段に入った。ゲストのスマホを「お待ちください」に戻す（ほかの問題が開いたままなら、それも閉じる）。 */
function requestReveal() {
  const request = revealRequest(state.gate);
  if (request) requestGate(request);
}

/** → / クリック。問題のスライドでは「受付 → 締め切り → 正解」と1段ずつ進み、最後に次のスライドへ。 */
function advance() {
  if (isPredResult(state.slides[state.slide])) {
    const { pred, leave } = stepPred(state.pred, "advance", state.hits);
    if (!leave) {
      state.pred = pred;
      render();
      return;
    }
  }
  const target = currentTarget();
  if (target) {
    const view = viewOf(target);
    if (writable() && view !== "closed") {
      requestGate(view === "ready" ? target : "none");
      render();
      return;
    }
    if (view === "closed" && !state.revealed && isQuestion(target) && backend?.loadAnswers) {
      state.revealed = true;
      requestReveal();
      if (!state.answers) refreshAnswers();
      render();
      return;
    }
  }
  goTo(state.slide + 1, "forward");
}

/**
 * ←。正解を映していれば隠し、そうでなければ前のスライドへ（受付は開け直さない）。
 * 正解を隠しても、ゲストのスマホは「お待ちください」のまま（「締め切りました」には戻さない）。
 * Apps Script の setOpen には「開け直さずに lastClosed だけを戻す」切り替えがないため。
 */
function retreat() {
  if (isPredResult(state.slides[state.slide])) {
    const { pred, leave } = stepPred(state.pred, "retreat", state.hits);
    if (!leave) {
      state.pred = pred;
      render();
      return;
    }
  }
  if (state.revealed) {
    state.revealed = false;
    render();
  } else {
    goTo(state.slide - 1, "back");
  }
}

/** O キー。いまのスライドの問題の受付を開け直す（締め切ったあとで、もう一度受け付けたいとき）。 */
function reopen() {
  const target = currentTarget();
  if (!target || !writable() || viewOf(target) === "open") return;
  state.revealed = false;
  requestGate(target);
  render();
}

/** 「予想結果」のスライドで 0〜5 のキー。実際にそろった数を入れて（入れ直して）、その数を予想していた人を取得する。 */
function enterMatchedCount(n) {
  state.pred = stepPred(state.pred, n, state.hits).pred;
  loadPredHits(n);
  render();
}

let hitsSeq = 0; // 取得のたびに増える。数を入れ直したあとに届いた、前の数の結果を捨てるために使う

/** 的中した人の名前を取得する（司会キーが要る）。通信エラーは3回まで試す。失敗しても「そろったのは」は映せる。 */
async function loadPredHits(n) {
  const seq = ++hitsSeq;
  if (!backend?.loadPredHits) {
    state.hits = { n, status: "nokey" };
    return;
  }
  state.hits = { n, status: "loading" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await backend.loadPredHits(n);
      if (seq !== hitsSeq) return;
      state.hits = { n, status: "ok", count: res.count, names: res.names };
      break;
    } catch (e) {
      if (seq !== hitsSeq) return;
      if (e.code) {
        // 待っても直らない（Code.gs が古い・キー違い・予想のシートを読めない など）
        const status = e.code === "unsupported" ? "unsupported" : e.code === "unauthorized" ? "nokey" : "failed";
        state.hits = { n, status, message: e.message };
        break;
      }
      if (attempt === 3) {
        state.hits = { n, status: "error" };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      if (seq !== hitsSeq) return;
    }
  }
  render();
}

function jumpToTarget(target) {
  const index = state.slides.findIndex((slide) => targetOf(slide) === target);
  if (index >= 0) goTo(index, "jump");
}

/* ===== スライドの読み込み ===== */

/**
 * スライド1枚の画像を読み込む。読み終わるまでは前の画像（あれば）を出したままにし、読めたら差し替える。
 * 読み込んだ <img> は画面に置いたままにするので、あとで画像の URL が期限切れになっても表示は消えない。
 */
function loadImage(slide, url) {
  slide.imageUrl = url;
  slide.failed = false;
  const img = el("img");
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.onload = () => {
    if (slide.imageUrl !== url) return; // その後さらに新しい URL に変わっていた
    img.className = slide.el.className;
    slide.el.replaceWith(img);
    slide.el = img;
    slide.loaded = true;
    render();
  };
  img.onerror = () => {
    if (slide.imageUrl !== url) return;
    // URL の期限切れなど。そのスライドの画像だけ作り直してもらう
    slide.failed = true;
    render();
    scheduleSlides("", nextBackoff());
  };
  img.src = url;
}

/** 取得したスライド一覧を画面に反映する。スライドの増減・並べ替えがあっても、いまのスライドに留まる。 */
function applySlides(list, panel) {
  const first = state.slides.length === 0;
  const current = state.slides[state.slide];
  const known = new Map(state.slides.map((slide) => [slide.objectId, slide]));
  const urls = new Map(list.map((item) => [item.objectId, item.imageUrl]));

  state.panel = panel;
  state.slides = list.map((item) => {
    const slide = known.get(item.objectId) || { objectId: item.objectId, el: Object.assign(el("img"), { alt: "" }), imageUrl: null, loaded: false, failed: false };
    slide.kind = item.kind;
    slide.question = item.question;
    return slide;
  });
  $("stage").replaceChildren($("stage-message"), ...state.slides.map((slide) => slide.el));

  // 同じスライド → （仮のスライドから本物に替わったときは）同じ問題のスライド → 開いたときの位置、の順で探す
  let index = state.slides.findIndex((slide) => slide.objectId === current?.objectId);
  if (index < 0 && targetOf(current)) index = state.slides.findIndex((slide) => targetOf(slide) === targetOf(current));
  if (index < 0) index = first ? (Number.parseInt(startHash.replace(/^#s/, ""), 10) || 1) - 1 : state.slide;
  index = Math.min(Math.max(index, 0), state.slides.length - 1);

  // いまのスライドから順に読み込みを始める（全部を先読みする）
  state.slides.forEach((_, i) => {
    const slide = state.slides[(index + i) % state.slides.length];
    const url = urls.get(slide.objectId);
    if (url && url !== slide.imageUrl) loadImage(slide, url);
  });

  const found = new Set(state.slides.map(targetOf));
  const missing = ALL_TARGETS.filter((target) => !found.has(target)).map(targetLabel);
  // 仮のスライド・デモでは知らせない（本物のスライドの作り忘れに気づくための表示）
  state.missing = !panel && !DEMO && missing.length > 0 ? "スライドに目印が見つかりません: " + missing.join("・") : "";
  goTo(index, "init");
}

/** Google スライドを映せないときは、第1問〜第10問と予想の仮のスライドで動かす。 */
function usePanelSlides() {
  if (state.slides.length === 0) applySlides(panelSlides(), true);
}

let slidesTimer = null;
let slidesBusy = false;
let slidesBackoff = 0;

/** 失敗が続くほど間隔をあける（5秒 → 10秒 → 20秒 → 30秒）。画像作りには回数制限があるため。 */
function nextBackoff() {
  slidesBackoff = Math.min((slidesBackoff || 2500) * 2, 30000);
  return slidesBackoff;
}

function scheduleSlides(mode, delay) {
  if (slidesTimer || slidesBusy) return; // 取得中なら、その取得が終わったときに改めて判断する
  slidesTimer = setTimeout(() => {
    slidesTimer = null;
    refreshSlides(mode);
  }, delay);
}

/**
 * スライド一覧を取得して反映する。mode が "all" なら Google 側のキャッシュも捨てて作り直す（R キー）。
 * それ以外は、読み込めなかった画像だけ作り直しを頼む。
 */
async function refreshSlides(mode) {
  if (!loadSlides || slidesBusy) return;
  clearTimeout(slidesTimer);
  slidesTimer = null;
  slidesBusy = true;
  let retry = null; // [mode, 待つミリ秒]
  try {
    const failedIds = state.panel ? [] : state.slides.filter((slide) => slide.failed).map((slide) => slide.objectId);
    const res = await loadSlides(mode === "all" ? "all" : failedIds.join(","));
    if (res.slides.length === 0) throw Object.assign(new Error("スライドが1枚もありません"), { code: "empty" });
    applySlides(res.slides, false);
    const problems = Array.isArray(res.errors) ? res.errors : [];
    setError("slides", problems.join(" / "));
    // pending: Google 側でまだ画像を作れていないスライドがある。続きを取りに行く
    if (res.pending > 0) retry = ["", problems.length > 0 ? nextBackoff() : 1000];
  } catch (e) {
    // キー違い・未設定は、待っても直らないので再試行しない。それ以外（通信エラーなど）は間隔をあけて再試行する
    setError("slides", e.code ? "スライド: " + e.message : "スライドを取得できません（再試行中）");
    if (!isFatal(e)) retry = [mode, nextBackoff()];
    usePanelSlides(); // スライドが出せない間も、問題の受付と人数の表示はできるようにする
  } finally {
    slidesBusy = false;
    state.waitingForSlides = false;
    render();
  }
  if (!retry) {
    // 取得中に読み込みに失敗した画像が残っていれば、もう一度頼む
    if (!state.panel && state.slides.some((slide) => slide.failed)) retry = ["", nextBackoff()];
    else slidesBackoff = 0;
  }
  if (retry) scheduleSlides(...retry);
}

/** 正解を取得する（司会キーが要る）。失敗しても、正解を映すときにもう一度試す。 */
async function refreshAnswers() {
  if (!backend?.loadAnswers) return;
  try {
    state.answers = await backend.loadAnswers();
    setError("answers", "");
  } catch (e) {
    setError("answers", e.code ? "正解: " + e.message : "正解を取得できません");
  }
  render();
}

/* ===== 人数と受付状態の定期更新 ===== */

function formatTime(value) {
  const d = new Date(value);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** 取得できた人数と受付状態を画面に反映する。epoch は、その取得を始めたときの gateEpoch。 */
function applyStats({ stats, epoch }) {
  state.stats = stats;
  $("updated").textContent = "最終更新 " + formatTime(stats.updatedAt);
  // Code.gs 側の設定ミス（タブ名の間違いなど）は errors で届く。名前は含まれない
  setError("stats", Array.isArray(stats.errors) && stats.errors.length > 0 ? "設定エラー: " + stats.errors.join(" / ") : "");
  setError("gateApi", stats.state ? "" : "Apps Script が古いままです（受付の切り替えには Code.gs の更新と再デプロイが必要）");
  // 取得している間に受付を切り替えていたら、この受付状態は古いので使わない
  if (stats.state && epoch === gateEpoch && !writing) {
    state.gate = stats.state;
    state.gateKnown = true;
  }
  render();
}

/*
 * 応答を待たずに HOST.pollMs ごとに次の取得を始める（同時に HOST.maxInFlight 件まで）。
 * 順番が入れ替わって届いた古い応答は捨てる。進め方は js/poller.js。
 */
const poller = backend
  ? createPoller({
      load: async () => {
        const epoch = gateEpoch;
        return { stats: await backend.loadStats(), epoch };
      },
      onSuccess: applyStats,
      // 失敗しても前回の数字は表示したままにして、次の回でまた試す（失敗が続くほど間隔をあける）
      onFailure: () => setError("stats", "通信エラー（再試行中）"),
      intervalMs: HOST.pollMs,
      maxInFlight: HOST.maxInFlight,
      maxBackoffMs: HOST.maxBackoffMs,
    })
  : null;

/** 定期更新が止まっていれば動かす。now が true なら、次の予定を待たずにすぐ取りに行く。 */
function kickPoll(now) {
  poller?.kick(now);
}

/* ===== キーボード・クリック ===== */

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function initControls() {
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (key === "f" || key === "F") toggleFullscreen();
    else if (state.slides.length === 0) return;
    // プレゼン用リモコン（クリッカー）は PageDown / PageUp や → / ← を送る
    else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) advance();
    else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(key)) retreat();
    else if (key === "Home") goTo(0, "jump");
    else if (key === "End") goTo(state.slides.length - 1, "jump");
    else if (key === "o" || key === "O") reopen();
    else if (key === "r" || key === "R") {
      refreshSlides("all");
      refreshAnswers();
    } else if (/^[0-9]$/.test(key)) {
      // 「予想結果」のスライドでは、数字キーは「そろった数」の入力（6〜9 は何もしない）。問題へは飛ばない
      if (isPredResult(state.slides[state.slide])) {
        const n = matchedCountOf(key);
        if (n !== null) enterMatchedCount(n);
      } else jumpToTarget("q" + (key === "0" ? 10 : key));
    } else if (key === "p" || key === "P") jumpToTarget("pred");
    else return;
    e.preventDefault();
  });

  // 画面のどこをクリックしても次へ進む
  document.addEventListener("click", (e) => {
    if (state.slides.length === 0 || e.target.closest("a, button")) return;
    advance();
  });
}

/* ===== 起動 ===== */

if (DEMO) $("badge-demo").classList.remove("hidden");

if (!backend) {
  $("setup").classList.remove("hidden");
} else {
  initControls();
  kickPoll();
  refreshAnswers();
  if (loadSlides) {
    state.waitingForSlides = true;
    render();
    refreshSlides("");
  } else {
    usePanelSlides();
  }
}
