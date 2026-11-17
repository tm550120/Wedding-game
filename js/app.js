/*
 * 回答ページの画面と状態の管理。
 *
 * 画面の流れ:
 *   name（名前入力）→ live（司会画面がいま受け付けている問題だけが自動で出る）
 *
 * live の表示は、Apps Script から数秒ごとに読む受付状態（応答のあと 1〜1.5秒おいて次を読む）（js/gate.js）で決まる。
 *   question   … 受付中の問題。「選ぶ → 送信する」で1回だけ送れる（送信済みならロック表示）
 *   closed     … 直前の問題が締め切られた（「締め切りました」）。司会画面が正解を映すと waiting に変わる
 *   waiting    … 何も受け付けていない（「次の問題をお待ちください」）
 *   finished   … 予想を締め切ったあと、何も受け付けていない（「ご参加ありがとうございました！」。文言は config.js の GATE）
 *   connecting … 受付状態が分からない（まだ読めていない / しばらく読めていない）。回答ボタンは出さない
 * ゲストが自分で問題を選ぶことはできない。クイズも予想も、config.js の SECTIONS の定義で同じコードが動く。
 *
 * 受付状態を読めなくなったとき:
 *   - GATE.staleMs までは、最後に読めた状態のまま動かす（一瞬の電波切れで回答を止めない）
 *   - それを過ぎたら connecting にして回答ボタンを隠す（締め切られたことに気づかず答えてしまわないように）
 * 締め切りを最終的に守るのは Apps Script 側（受付時間外に届いた回答は人数に数えない）。
 *
 * ?demo=1 を付けると、同じブラウザで開いた host.html?demo=1 の受付状態で動く（回答は送信しない）。
 */
import { SUBMIT, GATE, HOST } from "./config.js";
import { submitAnswer } from "./submit.js";
import { loadName, saveName, loadSent, saveSent, updateAllSent } from "./storage.js";
import { fetchGate, guestMode, parseTarget, pruneSent, readDemoGate } from "./gate.js";
import { autoCloseSeconds, guestRemaining, trackOpen } from "./countdown.js";

const $ = (id) => document.getElementById(id);

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

const AUTO_CLOSE_SEC = autoCloseSeconds(HOST, DEMO); // 司会画面が自動で締め切るまでの秒数。0 なら残り時間を出さない

/** 終了の画面の文言（"\n" で改行）。空なら null。両方とも空なら、終了の画面は出さない。 */
const lines = (text) => (text ? String(text).split("\n") : null);
const FINISHED = { title: lines(GATE.finishedTitle), message: lines(GATE.finishedMessage) };

/** 受付状態の取得方法。null なら未設定（Apps Script の URL がない）。 */
const loadGate = DEMO
  ? async () => readDemoGate()
  : HOST.statsUrl
    ? () => fetchGate(HOST.statsUrl, { timeoutMs: GATE.timeoutMs, transport: HOST.transport })
    : null;

/** 回答の送信。デモでは Google フォームへ送らず、少し待って成功したことにする。 */
const send = DEMO
  ? () => new Promise((resolve) => setTimeout(resolve, 400))
  : (section, index, answer) => submitAnswer(section.form, state.name, index, answer, SUBMIT);

const state = {
  name: "",
  started: false,     // 名前を入れて live 画面に進んだか
  sent: {},           // セクションid → { 問題番号(0始まり): 送信した回答 }。送信済み＝ロック。localStorage にも保存
  drafts: {},         // 対象（"q5" など）→ 選んだだけでまだ送っていない回答
  sending: new Set(), // 送信中の対象
  failed: new Set(),  // 送信に失敗した対象（「もう一度送信する」を出す）
  gate: null,         // 最後に読めた受付状態
  gateAt: 0,          // それを読めた時刻
  failures: 0,        // 受付状態の取得に続けて失敗した回数
  openSeen: null,     // 受付が開いたのをいつ見たか（js/countdown.js の trackOpen）。残り時間の目安に使う
};

/* ===== 状態の読み取り ===== */

// 保存データは外から書き換えられうるので、選択肢にある値だけを「送信済み」と認める
function sentAnswer(section, index) {
  const answer = (state.sent[section.id] || {})[index];
  return section.choices.includes(answer) ? answer : null;
}

/** いま出すべき表示。{ mode, target?, section?, index? } */
function currentView() {
  const fresh = state.gate && Date.now() - state.gateAt < GATE.staleMs;
  if (!fresh) return { mode: "connecting" };
  const mode = guestMode(state.gate, Boolean(FINISHED.title || FINISHED.message));
  if (mode === "question") return { mode, ...parseTarget(state.gate.open) };
  if (mode === "closed") return { mode, ...parseTarget(state.gate.lastClosed) };
  return { mode }; // "waiting" / "finished"
}

/* ===== 表示 ===== */

/** 文字列の配列を <br> 区切りで要素に入れる（innerHTML を使わないため）。 */
function setLines(el, lines) {
  el.replaceChildren();
  lines.forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement("br"));
    el.appendChild(document.createTextNode(line));
  });
}

/*
 * 締め切りまでのおよその残り時間（「残り約 42秒」）。受付が開く瞬間をこの端末が見ていたときだけ出す。
 * あくまで目安で、0 になっても回答ボタンと送信はそのまま使える（締め切るのは司会画面。早めに締め切ることも、
 * 開け直すこともある）。
 */
function renderCountdown() {
  const view = state.started ? currentView() : { mode: "connecting" };
  const seen = state.openSeen;
  const left =
    view.mode === "question" && seen && seen.target === view.target
      ? guestRemaining(seen.since, Date.now(), AUTO_CLOSE_SEC, GATE.openLagMs)
      : null;
  $("live-countdown").classList.toggle("hidden", left === null);
  if (left !== null) $("live-countdown").textContent = left > 0 ? "残り約 " + left + "秒" : "まもなく締め切ります";
}

/** お題1つ分の表示（「お題1 旅行に行くならどこ？」＋ A〜D の選択肢を 2×2）。 */
function topicItem(topic, i) {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const li = el("li", "topic");
  const title = el("p", "topic-title");
  title.append(el("span", "topic-no", "お題" + (i + 1)), document.createTextNode(topic.text));
  const options = el("ul", "topic-options");
  (topic.choices || []).forEach((choice, n) => {
    const option = el("li", "topic-option");
    option.append(el("span", "topic-letter", String.fromCharCode(65 + n)), document.createTextNode(choice));
    options.appendChild(option);
  });
  li.append(title, options);
  return li;
}

let lastSignature = "";

/** live 画面を、いまの状態に合わせる。見た目が変わらないときは作り直さない（押している途中のボタンを消さないため）。 */
function render() {
  if (!state.started) return;
  renderCountdown();
  const view = currentView();
  const { mode, target, section, index } = view;
  const sent = section ? sentAnswer(section, index) : null;
  const draft = target ? state.drafts[target] || null : null;
  const sending = state.sending.has(target);
  const failed = mode === "question" && !sent && state.failed.has(target);
  const trouble = !loadGate || state.failures >= (mode === "connecting" ? 1 : 2);

  const signature = JSON.stringify([mode, target, sent, draft, sending, failed, trouble]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const answering = mode === "question" && !sent;
  let prompt;
  let note = [];
  if (mode === "question") {
    prompt = sent ? [section.answerLabel(index) + "は", "送信済みです"] : section.promptLines;
    if (sent) note = ["締め切りまで、そのままお待ちください"];
  } else if (mode === "closed") {
    prompt = [section.answerLabel(index) + "は", "締め切りました"];
    note = sent ? ["あなたの回答: " + sent, "次の問題をお待ちください"] : ["次の問題をお待ちください"];
  } else if (mode === "waiting" || mode === "finished") {
    prompt = ["次の問題を", "お待ちください"];
    note = ["スクリーンに問題が出ると、", "ここに回答ボタンが出ます"];
    if (mode === "finished") {
      prompt = FINISHED.title || prompt;
      note = FINISHED.message || note;
    }
  } else {
    prompt = ["接続しています…"];
    note = ["しばらく待っても変わらない場合は、", "ページを開き直してください"];
  }

  $("screen-live").dataset.mode = mode;
  $("live-kicker").textContent = section ? section.progressLabel(index, section.form.answerEntries.length) : "✦";
  setLines($("live-prompt"), prompt);
  setLines($("live-note"), note);
  $("live-note").classList.toggle("hidden", note.length === 0);

  // お題の一覧（予想だけ。config.js の topics）。受付中だけ出す。空・未定義なら何も出さない
  const topics = mode === "question" && Array.isArray(section.topics) ? section.topics : [];
  $("screen-live").classList.toggle("with-topics", topics.length > 0);
  $("live-topics").classList.toggle("hidden", topics.length === 0);
  $("live-topics").replaceChildren(...topics.map(topicItem));

  // 選択肢は受付中だけ出す。送信済みの問題は、送った回答を表示したまま押せなくする
  const choices = $("live-choices");
  choices.classList.toggle("hidden", mode !== "question");
  choices.classList.toggle("cols-2", Boolean(section) && section.choiceColumns === 2);
  choices.replaceChildren(
    ...(mode === "question" ? section.choices : []).map((choice) => {
      const b = document.createElement("button");
      b.className = "choice" + ((sent || draft) === choice ? " selected" : "");
      b.textContent = choice;
      b.disabled = Boolean(sent) || sending;
      b.addEventListener("click", () => {
        state.drafts[target] = choice;
        render();
      });
      return b;
    })
  );

  $("btn-submit").classList.toggle("hidden", !answering);
  $("btn-submit").disabled = !draft || sending;
  $("btn-submit").textContent = sending ? "送信中…" : failed ? "もう一度送信する" : "送信する";
  $("submit-error").classList.toggle("hidden", !failed || sending);
  if (section) $("submit-error-link").href = section.fallback.url;
  $("live-notice").classList.toggle("hidden", !trouble);
}

/* ===== 送信 ===== */

async function handleSubmit() {
  const { mode, target, section, index } = currentView();
  if (mode !== "question") return; // 押す直前に締め切られた
  const answer = state.drafts[target];
  if (!answer || sentAnswer(section, index) || state.sending.has(target)) return; // 二重送信防止

  state.sending.add(target);
  state.failed.delete(target);
  render();
  try {
    await send(section, index, answer);
    // 送信できた問題をロックして保存する（締め切り間際に送った分を数えるかどうかは Apps Script が決める）
    state.sent[section.id] = { ...state.sent[section.id], [index]: answer };
    if (!DEMO) saveSent(state.name, state.sent);
  } catch (e) {
    // タイムアウトのように「実は届いていた」可能性がある失敗も含む。その場合にもう一度送ると
    // 同じ問題の行が2つできるが、集計は名前×問題ごとに最新の行だけを数える
    state.failed.add(target);
  } finally {
    state.sending.delete(target);
    render();
  }
}

/* ===== 受付状態の定期取得 ===== */

/**
 * いま読めた受付状態に合わない「送信済み」を外す。
 * リハーサルのあとに受付の記録を消しても（resetGame）、端末にはリハーサルのロックが残っていて、
 * 本番で同じ問題が「送信済み」になり答えられなかった。受付中でも締め切り済みでもない問題のロックは
 * 古いものなので、ここで外す（保存してある全員分。理由は storage.js の updateAllSent を参照）。
 * rev が 0 の状態では直さない: Apps Script は受付状態を読めなかったときに「空・rev 0」を返すので、
 * それを信じると本番中のロックが消えてしまう（記録を消しても rev は 0 に戻らない）。
 * デモの受付状態はこのブラウザの中にあり、司会画面のデモを開き直すと rev 0 から始まるので、そのまま合わせる。
 */
function reconcileSent(gate) {
  if (!DEMO && !(gate.rev > 0)) return;
  state.sent = pruneSent(state.sent, gate);
  if (!DEMO) updateAllSent((sent) => pruneSent(sent, gate));
}

let pollTimer = null;
let pollBusy = false;

async function poll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (pollBusy || !loadGate || document.hidden) return; // 画面を閉じている間は読まない（戻ったときに再開する）
  pollBusy = true;
  try {
    const gate = await loadGate();
    const now = Date.now();
    // 長く読めなかったあとは、その間に何があったか分からないので、見た時刻を覚え直す
    state.openSeen = trackOpen(now - state.gateAt < GATE.staleMs ? state.openSeen : null, gate, now);
    state.gate = gate;
    state.gateAt = now;
    state.failures = 0;
    reconcileSent(state.gate); // 読めたときだけ。失敗したときに残してある古い状態では直さない
  } catch (e) {
    state.failures += 1; // つながらない・Apps Script が古い など。間隔をあけて読み直す
  } finally {
    pollBusy = false;
  }
  render();
  // 全員が同時に読まないよう、毎回すこしずらす。失敗が続くほど間隔をあける
  const base = DEMO ? 600 : GATE.pollMs + Math.random() * GATE.jitterMs;
  pollTimer = setTimeout(poll, Math.min(base * 2 ** Math.min(state.failures, 5), Math.max(GATE.maxBackoffMs, base)));
}

/* ===== 起動 ===== */

function start() {
  if (!DEMO) saveName(state.name);
  state.sent = DEMO ? {} : loadSent(state.name); // 送信済み（ロック）は名前ごとに覚えている
  state.started = true;
  $("live-who").textContent = state.name + " さん";
  $("screen-name").classList.add("hidden");
  $("screen-live").classList.remove("hidden");
  window.scrollTo(0, 0);
  render();
  poll();
}

state.name = loadName();
$("guest-name").value = state.name;
$("btn-start").disabled = state.name.length === 0;
$("guest-name").addEventListener("input", (e) => {
  state.name = e.target.value.trim();
  $("btn-start").disabled = state.name.length === 0;
});
$("btn-start").addEventListener("click", start);
$("btn-submit").addEventListener("click", handleSubmit);
if (DEMO) $("badge-demo").classList.remove("hidden");
if (AUTO_CLOSE_SEC) setInterval(renderCountdown, 500);

// 画面に戻ってきたら、すぐ読み直す（閉じている間に進んだ分を取り戻す）
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !state.started) return;
  render();
  poll();
});
