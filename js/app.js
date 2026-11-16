/*
 * 画面と状態の管理。
 *
 * 画面の流れ:
 *   name → menu → question（1問ごとに「選ぶ → 送信する」）→ 全問送信で done → menu
 *
 * クイズも予想も「セクション」（config.js の SECTIONS の1要素）として同じコードで動く。
 * 予想は「1問だけのセクション」という扱い。
 *
 * 回答は1問ごとに送信し、送信できた問題はロックする（送り直しはできない）。
 * 問題はスライドで1問ずつ出るので、全問そろうのを待たずにその場で送るため。
 */
import { SECTIONS, SUBMIT } from "./config.js";
import { submitAnswer } from "./submit.js";
import { loadName, saveName, loadSent, saveSent } from "./storage.js";

const $ = (id) => document.getElementById(id);

const SCREENS = ["name", "menu", "question", "done"];

const state = {
  name: "",
  sent: {},        // セクションid → { 問題番号: 送信した回答 }。送信済み＝ロック。localStorage にも保存
  drafts: {},      // セクションid → { 問題番号: 選んだだけでまだ送っていない回答 }
  section: null,   // いま回答中のセクション（SECTIONS の要素）
  index: 0,        // セクション内の何問目か（0始まり）
  submitting: false,
};

/* ===== 状態の読み取り ===== */
const questionCount = (section) => section.form.answerEntries.length;
// 保存データは外から書き換えられうるので、選択肢にある値だけを「送信済み」と認める
const sentAnswer = (section, index) => {
  const answer = (state.sent[section.id] || {})[index];
  return section.choices.includes(answer) ? answer : null;
};
const isSent = (section, index) => sentAnswer(section, index) !== null;
const sentCount = (section) =>
  Array.from({ length: questionCount(section) }, (_, i) => i).filter((i) => isSent(section, i)).length;

/** from の次から順に（末尾まで行ったら先頭に戻って）未送信の問題を探す。無ければ -1。 */
function nextUnsent(section, from) {
  const total = questionCount(section);
  for (let step = 1; step <= total; step++) {
    const i = (from + step) % total;
    if (!isSent(section, i)) return i;
  }
  return -1;
}

/* ===== 表示の部品 ===== */
function show(screen) {
  SCREENS.forEach((s) => $("screen-" + s).classList.toggle("hidden", s !== screen));
  window.scrollTo(0, 0);
}

/** 文字列の配列を <br> 区切りで要素に入れる（innerHTML を使わないため）。 */
function setLines(el, lines) {
  el.replaceChildren();
  lines.forEach((line, i) => {
    if (i > 0) el.appendChild(document.createElement("br"));
    el.appendChild(document.createTextNode(line));
  });
}

function choiceButton(label, selected, onClick) {
  const b = document.createElement("button");
  b.className = "choice" + (selected ? " selected" : "");
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

/* ===== 名前 ===== */
function initNameScreen() {
  state.name = loadName();
  $("guest-name").value = state.name;
  $("btn-start").disabled = state.name.length === 0;

  $("guest-name").addEventListener("input", (e) => {
    state.name = e.target.value.trim();
    $("btn-start").disabled = state.name.length === 0;
  });
  $("btn-start").addEventListener("click", () => {
    saveName(state.name);
    state.sent = loadSent(state.name); // 送信済み（ロック）は名前ごとに覚えている
    state.drafts = {};
    renderMenu();
  });
}

/* ===== メニュー ===== */
function badgeText(section) {
  const done = sentCount(section);
  const total = questionCount(section);
  if (done === 0) return "";
  return done === total ? "　✓ 送信済み" : `　${done}/${total} 送信済み`;
}

function renderMenu() {
  $("menu-who").textContent = state.name + " さん";

  const buttons = SECTIONS.map((section) => {
    const b = choiceButton(section.menuLabel, false, () => startSection(section));
    const badge = document.createElement("span");
    badge.className = "done-badge";
    badge.textContent = badgeText(section);
    b.appendChild(badge);
    return b;
  });
  $("menu-choices").replaceChildren(...buttons);
  show("menu");
}

function initFallbackLinks() {
  const box = $("fallback-links");
  SECTIONS.forEach((section, i) => {
    if (i > 0) box.appendChild(document.createTextNode("／"));
    const a = document.createElement("a");
    a.href = section.fallback.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = section.fallback.label;
    box.appendChild(a);
  });
}

/* ===== 質問 ===== */
function startSection(section) {
  state.section = section;
  // 最初の未送信の問題から始める。全部送信済みなら第1問（ロック表示）を見せる
  state.index = Math.max(nextUnsent(section, -1), 0);
  renderQuestion();
}

function goToQuestion(index) {
  state.index = index;
  renderQuestion();
}

/** 問題番号のナビ（複数問あるセクションだけ）。送信済みの問題は色が付く。 */
function renderQuestionNav(section, total) {
  const nav = $("question-nav");
  nav.classList.toggle("hidden", total <= 1);
  nav.replaceChildren(
    ...Array.from({ length: total }, (_, i) => {
      const b = document.createElement("button");
      b.textContent = String(i + 1);
      b.className = [isSent(section, i) ? "sent" : "", i === state.index ? "current" : ""].join(" ").trim();
      b.setAttribute("aria-label", section.answerLabel(i) + (isSent(section, i) ? "（送信済み）" : ""));
      b.addEventListener("click", () => goToQuestion(i));
      return b;
    })
  );
}

function renderQuestion() {
  const { section, index } = state;
  const total = questionCount(section);
  const locked = isSent(section, index);
  const drafts = (state.drafts[section.id] ||= {});
  const current = locked ? sentAnswer(section, index) : drafts[index];

  $("question-progress").textContent = section.progressLabel(index, total);
  renderQuestionNav(section, total);
  setLines($("question-prompt"), locked ? [section.answerLabel(index) + "は", "送信済みです"] : section.promptLines);

  // 送信済みの問題は、送った回答を表示したまま選択肢を押せなくする
  $("question-choices").classList.toggle("cols-2", section.choiceColumns === 2);
  $("question-choices").replaceChildren(
    ...section.choices.map((choice) => {
      const b = choiceButton(choice, current === choice, () => {
        drafts[index] = choice;
        renderQuestion();
      });
      b.disabled = locked;
      return b;
    })
  );

  $("submit-error").classList.add("hidden");
  $("submit-error-link").href = section.fallback.url;

  $("btn-submit").classList.toggle("hidden", locked);
  $("btn-submit").textContent = "送信する";
  $("btn-submit").disabled = !current;

  // 送信済みの問題では「送信する」の代わりに、次の未送信の問題へ進むボタンを出す
  $("btn-next").classList.toggle("hidden", !locked || nextUnsent(section, index) === -1);
  show("question");
}

/* ===== 送信 ===== */
function setSubmitting(on) {
  state.submitting = on;
  // 送信中に別の問題へ移ったり回答を変えたりすると、送った内容と表示が食い違うので全部止める
  $("screen-question").querySelectorAll("button").forEach((b) => (b.disabled = on));
  if (on) $("btn-submit").textContent = "送信中…";
}

async function handleSubmit() {
  if (state.submitting) return; // 二重送信防止（ボタンの disabled と二段構え）
  const { section, index } = state;
  const answer = (state.drafts[section.id] || {})[index];
  if (!answer || isSent(section, index)) return;

  setSubmitting(true);
  $("submit-error").classList.add("hidden");
  try {
    await submitAnswer(section.form, state.name, index, answer, SUBMIT);
  } catch (e) {
    // タイムアウトのように「実は届いていた」可能性がある失敗も含む。その場合にもう一度送ると
    // 同じ問題の行が2つできるので、集計では名前×問題ごとに最新の行を使ってもらう（README 参照）
    setSubmitting(false);
    $("btn-submit").textContent = "もう一度送信する";
    $("submit-error").classList.remove("hidden");
    return;
  }
  setSubmitting(false);

  // 送信できた問題をロックして保存する
  state.sent[section.id] = { ...state.sent[section.id], [index]: answer };
  saveSent(state.name, state.sent);

  if (nextUnsent(section, index) === -1) {
    // このセクションは全問送信済み
    $("done-note").textContent = section.doneMessage;
    show("done");
  } else {
    renderQuestion(); // 同じ問題をロック表示にして「つぎの問題へ」を出す
  }
}

/* ===== 起動 ===== */
initNameScreen();
initFallbackLinks();
$("btn-question-back").addEventListener("click", renderMenu);
$("btn-next").addEventListener("click", () => goToQuestion(nextUnsent(state.section, state.index)));
$("btn-submit").addEventListener("click", handleSubmit);
$("btn-to-menu").addEventListener("click", renderMenu);
