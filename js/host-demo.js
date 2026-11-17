/*
 * 司会画面のデモ（host.html?demo=1）。Apps Script なしで、当日の流れ全体を確認できる。
 *   - スライドは、その場で作った仮の画像（SVG）。本物のスライドは使わない
 *   - 受付状態は、このブラウザの localStorage に置く（index.html?demo=1 が同じものを読む）
 *   - 人数は、受付中の問題だけ、ダミーの数字が少しずつ増える
 *   - 正解もダミー。「予想結果」のスライドに出る名前も架空のもの
 * 返す形は本物（apps-script/Code.gs → js/host-api.js）と同じにしてある。
 */
import { ALL_TARGETS, EMPTY_GATE, parseTarget, readDemoGate, reduceGate, writeDemoGate } from "./gate.js";
import { placeholderImage, predResultSlide, targetSlide } from "./host-panel.js";
import { PRED_MAX } from "./pred-result.js";

const DEMO_GUESTS = 24;
const DEMO_ANSWERS = ["B", "D", "A", "C", "B", "A", "D", "C", "A", "B"];

/*
 * 「予想結果」のスライドで映す、架空の名前（実在のゲストではない）。そろった数ごとの人数は、
 * 表示の確認用に偏らせてある: 3問 = 30人（いちばん混む並び）/ 0問 = 0人（的中なしの表示）。
 */
const DEMO_NAMES = [
  "相川 あおい", "井上 一郎", "上田 うみ", "江口 英二", "小川 おとは", "加藤 かずき",
  "木村 きよみ", "久保 邦彦", "剣持 けい", "小林 こはる", "斎藤 さくら", "清水 しんじ",
  "鈴木 すみれ", "関 誠一郎", "園田 そら", "高橋 たくみ", "千葉 ちひろ", "辻 つばさ",
  "寺田 てつや", "戸田 ともえ", "中村 なつき", "西村 にいな", "沼田 ぬい", "根本 ねね",
  "野口 のぞみ", "長谷川 はるか", "平野 ひろし", "藤原 ふみ", "Alex Morgan", "ほしの",
  "前田 まこと", "三浦 みさき", "村上 むつみ", "目黒 めぐみ", "森 もとき", "矢野 やすし",
  "勅使河原 ゆきのじょう", "吉田 よしえ", "和田 わたる", "りん", "渡辺 れいな", "ろく",
  "山田 太郎", "佐藤 花子", "田中 健", "伊藤 美咲",
];
const DEMO_HIT_COUNTS = [0, 2, 8, 30, 5, 1]; // 添字 = そろった数（0〜5）

function demoPredHits(n) {
  const start = DEMO_HIT_COUNTS.slice(0, n).reduce((sum, count) => sum + count, 0);
  const names = DEMO_NAMES.slice(start, start + DEMO_HIT_COUNTS[n]).sort((a, b) => a.localeCompare(b, "ja"));
  return { n, count: names.length, names };
}

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
    predResultSlide("", "デモ用の仮スライド"),
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
    loadPredHits: (n) =>
      Number.isInteger(n) && n >= 0 && n <= PRED_MAX ? later(demoPredHits(n), 300) : Promise.reject(Object.assign(new Error("n は 0〜5 の整数です"), { code: "bad_request" })),
    setOpen(target) {
      gate = reduceGate(gate, target);
      writeDemoGate(gate);
      return later(gate, 200);
    },
  };
}
