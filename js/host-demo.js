/*
 * 司会画面のデモ（host.html?demo=1）。Apps Script なしで、当日の流れ全体を確認できる。
 *   - スライドは、その場で作った仮の画像（SVG）。本物のスライドは使わない
 *   - 受付状態は、このブラウザの localStorage に置く（index.html?demo=1 が同じものを読む）
 *   - 人数は、受付中の問題だけ、ダミーの数字が少しずつ増える
 *   - 正解もダミー
 * 返す形は本物（apps-script/Code.gs → js/host-api.js）と同じにしてある。
 */
import { ALL_TARGETS, EMPTY_GATE, parseTarget, readDemoGate, reduceGate, writeDemoGate } from "./gate.js";
import { placeholderImage, targetSlide } from "./host-panel.js";

const DEMO_GUESTS = 24;
const DEMO_ANSWERS = ["B", "D", "A", "C", "B", "A", "D", "C", "A", "B"];

const later = (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

function demoSlides() {
  const image = (title, sub) => ({ kind: "slide", imageUrl: placeholderImage(title, sub, "デモ用の仮スライド") });
  const question = (no) => targetSlide("q" + no, "", placeholderImage(`Q${no}`, `第${no}問の問題文と選択肢 A / B / C / D`, "デモ用の仮スライド"));
  const pages = [
    image("クイズ大会", "→ / クリックで次へ、← で前へ"),
    image("QRコード", "ここに回答ページの QR コードを貼ります"),
    image("ルール説明", "A・B・C・D から答えを選びます"),
    question(1),
    question(2),
    question(3),
    image("以心伝心ゲーム", "「せーの！」で答えをそろえよう"),
    targetSlide("pred", "", placeholderImage("予想タイム", "新郎新婦の答えは 5問中 何問そろいますか？", "デモ用の仮スライド")),
    image("お題 1", "せーの！"),
    image("Thank you!", "ご参加ありがとうございました"),
  ];
  return pages.map((page, i) => ({ ...page, objectId: "demo" + (i + 1) }));
}

/** 司会画面が使う「取得・切り替え」一式の、デモ用の実装。 */
export function createDemoBackend() {
  writeDemoGate(EMPTY_GATE); // デモを開くたびに最初から
  let gate = EMPTY_GATE;
  const totals = Object.fromEntries(ALL_TARGETS.map((target) => [target, 0]));

  return {
    loadStats() {
      // 受付中の問題だけ人数が増える（締め切ると止まる）
      if (gate.open) totals[gate.open] = Math.min(totals[gate.open] + Math.floor(Math.random() * 4), DEMO_GUESTS);
      const stats = { updatedAt: new Date().toISOString(), quiz: {}, pred: { total: totals.pred }, state: gate };
      ALL_TARGETS.forEach((target) => {
        const { section, index } = parseTarget(target);
        if (section.id === "quiz") stats.quiz[String(index + 1)] = { total: totals[target] };
      });
      return later(stats, 80);
    },
    loadSlides: () => later({ updatedAt: new Date().toISOString(), slides: demoSlides(), pending: 0 }, 80),
    loadAnswers: () => later(Object.fromEntries(DEMO_ANSWERS.map((answer, i) => [String(i + 1), answer])), 80),
    setOpen(target) {
      gate = reduceGate(gate, target);
      writeDemoGate(gate);
      return later(gate, 200);
    },
  };
}
