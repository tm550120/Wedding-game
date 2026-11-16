/*
 * 司会画面のデモ（host.html?demo=1）。Apps Script なしで、スライドショーの流れ全体を確認できる。
 *   - スライドは、その場で作った仮の画像（SVG）。本物のスライドは使わない
 *   - 人数は、ダミーの数字が少しずつ増える
 * 返す形は本物（apps-script/Code.gs）と同じにしてある。
 */
import { SECTIONS } from "./config.js";

/* ===== 人数 ===== */

const DEMO_GUESTS = 60;

// 本物と同じ形の集計を 0 人から作っておく。各ビューの人数（counts）は demoCounts からも参照する
const demoStats = {};
const demoCounts = SECTIONS.flatMap((section) => {
  const count = section.form.answerEntries.length;
  const blank = () => Object.fromEntries([...section.choices.map((c) => [c, 0]), ["total", 0]]);
  if (count === 1) return [{ choices: section.choices, counts: (demoStats[section.id] = blank()) }];
  demoStats[section.id] = {};
  return Array.from({ length: count }, (_, i) => ({
    choices: section.choices,
    counts: (demoStats[section.id][String(i + 1)] = blank()),
  }));
});

export function loadDemoStats() {
  demoCounts.forEach(({ choices, counts }, seed) => {
    // 問題ごとに選ばれやすさを変えて、棒の長さに差が出るようにする
    const weights = choices.map((_, i) => 1 + ((seed * 7 + i * 5) % 6));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const add = Math.min(Math.floor(Math.random() * 4), DEMO_GUESTS - counts.total);
    for (let n = 0; n < add; n++) {
      let r = Math.random() * weightSum;
      const i = weights.findIndex((w) => (r -= w) < 0);
      counts[choices[Math.max(i, 0)]] += 1;
      counts.total += 1;
    }
  });
  return Promise.resolve({ updatedAt: new Date().toISOString(), ...structuredClone(demoStats) });
}

/* ===== スライド ===== */

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 題名と説明だけの仮のスライド画像（16:9）を data URL で作る。 */
function placeholderImage(title, sub, page) {
  const font = `font-family="'Hiragino Mincho ProN','Yu Mincho',serif" text-anchor="middle"`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">` +
    `<rect width="1600" height="900" fill="#123528"/>` +
    `<rect x="36" y="36" width="1528" height="828" fill="none" stroke="#c9a227" stroke-width="3"/>` +
    `<text x="800" y="440" ${font} font-size="120" fill="#f7f3e8">${escapeXml(title)}</text>` +
    `<text x="800" y="560" ${font} font-size="48" fill="#e8cf7a">${escapeXml(sub)}</text>` +
    `<text x="800" y="810" ${font} font-size="30" fill="#e8cf7a" opacity=".7">デモ用の仮スライド ${page}</text>` +
    `</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/** 本番のスライドと同じ並び方（問題 → 回答数 → 正解）を、最初の3問分だけ作る。 */
export function loadDemoSlides() {
  const pages = [
    ["クイズ大会", "→ / クリックで次へ、← で前へ"],
    ["QRコード", "ここに回答ページの QR コードを貼ります"],
    ["ルール説明", "A・B・C・D から答えを選びます"],
  ];
  for (let no = 1; no <= 3; no++) {
    pages.push([`Q${no}`, `第${no}問の問題文と選択肢 A / B / C / D`]);
    pages.push({ kind: "quizCounts", question: no }); // 「第N問 回答数」のスライド → グラフに置き換わる
    pages.push([`第${no}問 正解`, "正解は …"]);
  }
  pages.push(["以心伝心ゲーム", "5問中 何問そろうか予想しよう"]);
  pages.push({ kind: "predCounts" }); // 「予想 回答数」のスライド → グラフに置き換わる
  pages.push(["Thank you!", "ご参加ありがとうございました"]);

  const slides = pages.map((page, i) =>
    Array.isArray(page)
      ? { objectId: "demo" + (i + 1), kind: "slide", imageUrl: placeholderImage(page[0], page[1], i + 1) }
      : { objectId: "demo" + (i + 1), imageUrl: null, ...page }
  );
  return Promise.resolve({ updatedAt: new Date().toISOString(), slides, pending: 0 });
}
