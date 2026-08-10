// ヒントフィルター POC テスト
// 1. ポップアップ背後の要素にはヒントが出ない
// 2. 横スクロールで画面外の要素にはヒントが出ない
const { test, chromium, expect } = require("@playwright/test");
const path = require("path");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const TEST_PAGE = `file://${path.resolve(__dirname, "hint-filter-poc.html")}`;

async function launch() {
  return chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--window-size=900,700",
    ],
    viewport: { width: 900, height: 700 },
  });
}

async function getHintTexts(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector(".vimium-hint-overlay");
    if (!overlay) return [];
    return [...overlay.querySelectorAll(".vimium-hint")].map((h) => ({
      label: h.textContent.trim(),
      left: parseFloat(h.style.left),
      top: parseFloat(h.style.top),
    }));
  });
}

async function openHints(page) {
  await page.keyboard.press("f");
  await page.waitForTimeout(300);
}

async function closeHints(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
}

// ===== テスト1: ポップアップなし → 全リンクにヒント =====
test("no modal: all normal links get hints", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.click("body");
  await page.waitForTimeout(100);

  await openHints(page);
  const hints = await getHintTexts(page);
  console.log(`\n=== ポップアップなし: ヒント数=${hints.length} ===`);
  hints.forEach((h) => console.log(`  "${h.label}" @ left=${h.left.toFixed(0)}, top=${h.top.toFixed(0)}`));

  // Link A, B, C + open-btn + 横スクロール内の visible カード が対象
  expect(hints.length).toBeGreaterThanOrEqual(4);
  console.log("✅ 通常時: 複数ヒントが表示された");

  await closeHints(page);
  await context.close();
});

// ===== テスト2: ポップアップあり → ダイアログ内要素のみ =====
test("modal open: only dialog elements get hints", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);

  // ポップアップを開く
  await page.click("#open-btn");
  await page.waitForTimeout(300);

  const modalVisible = await page.evaluate(() =>
    document.getElementById("modal-backdrop").classList.contains("open")
  );
  expect(modalVisible).toBe(true);
  console.log("\n=== ポップアップ開 ===");

  await openHints(page);
  const hints = await getHintTexts(page);
  console.log(`ヒント数=${hints.length}`);
  hints.forEach((h) => console.log(`  "${h.label}" @ left=${h.left.toFixed(0)}, top=${h.top.toFixed(0)}`));

  // ダイアログ内の OK / キャンセル / 閉じる の3ボタンのみ
  expect(hints.length).toBe(3);
  console.log("✅ ダイアログ内3要素のみにヒントが表示された");

  // 背後の Link A/B/C が含まれていないことを確認（ヒントの y 座標がダイアログ内）
  const modalRect = await page.evaluate(() => {
    const r = document.getElementById("modal").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  console.log(`ダイアログ矩形: top=${modalRect.top.toFixed(0)}, bottom=${modalRect.bottom.toFixed(0)}`);

  for (const h of hints) {
    // ヒントの top はボタンより少し上に表示される (top - 18px)
    const hintBottom = h.top + 18;
    expect(hintBottom).toBeGreaterThanOrEqual(modalRect.top - 20);
    expect(h.left).toBeGreaterThanOrEqual(modalRect.left - 4);
  }
  console.log("✅ 全ヒントがダイアログ矩形内に収まっている");

  await closeHints(page);
  await context.close();
});

// ===== テスト3: 横スクロール画面外要素にはヒントが出ない =====
test("hscroll: off-screen cards get no hints", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.click("body");
  await page.waitForTimeout(100);

  // 横スクロールカードの可視状況を確認
  const cardVisibility = await page.evaluate(() => {
    const container = document.getElementById("hscroll");
    const cRect = container.getBoundingClientRect();
    return [...container.querySelectorAll("a")].map((a, i) => {
      const r = a.getBoundingClientRect();
      const visibleLeft = Math.max(r.left, cRect.left);
      const visibleRight = Math.min(r.right, cRect.right);
      return {
        index: i + 1,
        visible: visibleRight > visibleLeft,
        left: r.left.toFixed(0),
        right: r.right.toFixed(0),
      };
    });
  });
  const visibleCards = cardVisibility.filter((c) => c.visible);
  const hiddenCards = cardVisibility.filter((c) => !c.visible);
  console.log(`\n=== 横スクロールカード ===`);
  console.log(`可視: ${visibleCards.map((c) => c.index).join(", ")}`);
  console.log(`非表示(右): ${hiddenCards.map((c) => c.index).join(", ")}`);

  await openHints(page);
  const hints = await getHintTexts(page);

  // 横スクロール内のヒント位置を確認
  const containerRect = await page.evaluate(() => {
    const r = document.getElementById("hscroll").getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  console.log(`コンテナ right=${containerRect.right.toFixed(0)}`);

  const hscrollHints = hints.filter((h) => {
    // 横スクロールコンテナ内の高さ帯にあるヒント
    return h.left >= containerRect.left - 10;
  });
  const outOfViewHints = hscrollHints.filter((h) => h.left > containerRect.right);
  console.log(`横スクロール内ヒント: ${hscrollHints.length}, 画面外ヒント: ${outOfViewHints.length}`);
  hscrollHints.forEach((h) =>
    console.log(`  "${h.label}" left=${h.left.toFixed(0)} ${h.left > containerRect.right ? "❌画面外" : "✅可視"}`)
  );

  expect(outOfViewHints.length).toBe(0);
  console.log("✅ 横スクロール画面外のカードにはヒントが表示されなかった");

  await closeHints(page);
  await context.close();
});

// ===== テスト3b: transformカルーセル → 画面外スライドにはヒントが出ない =====
test("transform carousel: off-screen slides get no hints", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.click("body");
  await page.waitForTimeout(100);

  // Slide 1 が visible、Slide 2/3 は translateX で右に隠れている
  const slideRects = await page.evaluate(() =>
    ["c1", "c2", "c3"].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { id, left: r.left.toFixed(0), right: r.right.toFixed(0) };
    })
  );
  console.log("\n=== カルーセルスライド位置 ===");
  slideRects.forEach((s) => console.log(`  ${s.id}: left=${s.left}, right=${s.right}`));

  await openHints(page);
  const hints = await getHintTexts(page);

  // 各スライドにヒントが出ているか直接確認（ラッパー内の要素に elementsFromPoint が正しく機能しているか）
  const slideHintStatus = await page.evaluate(() => {
    const overlay = document.querySelector(".vimium-hint-overlay");
    if (!overlay) return {};
    const hintEls = [...overlay.querySelectorAll(".vimium-hint")];
    // 各スライドの中心座標にヒントが配置されているか
    const results = {};
    ["c1", "c2", "c3"].forEach((id) => {
      const slide = document.getElementById(id);
      const r = slide.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // ヒントはボタン左上付近 (left≒r.left, top≒r.top-18) に配置される
      results[id] = hintEls.some((h) => {
        const hl = parseFloat(h.style.left);
        const ht = parseFloat(h.style.top);
        return Math.abs(hl - r.left) < 100 && ht >= r.top - 25 && ht <= r.bottom;
      });
    });
    return results;
  });
  console.log(`\n=== 各スライドのヒント有無 ===`);
  Object.entries(slideHintStatus).forEach(([id, has]) =>
    console.log(`  ${id}: ${has ? "✅ ヒントあり" : "❌ ヒントなし"}`)
  );

  // Slide 1 のみヒントあり、Slide 2/3 はなし
  expect(slideHintStatus.c1).toBe(true);
  expect(slideHintStatus.c2).toBe(false);
  expect(slideHintStatus.c3).toBe(false);
  console.log("✅ transformカルーセル: Slide 1 のみヒント、Slide 2/3 は除外された");

  await closeHints(page);
  await context.close();
});

// ===== テスト4: ポップアップ閉じた後 → 通常に戻る =====
test("modal close: normal hints restored", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);

  // ポップアップを開いて閉じる
  await page.click("#open-btn");
  await page.waitForTimeout(200);
  await page.click("#modal-close");
  await page.waitForTimeout(200);

  await page.click("body");
  await page.waitForTimeout(100);

  await openHints(page);
  const hints = await getHintTexts(page);
  console.log(`\n=== ポップアップ閉後: ヒント数=${hints.length} ===`);

  expect(hints.length).toBeGreaterThanOrEqual(4);
  console.log("✅ ポップアップ閉後は通常のヒント数に戻った");

  await closeHints(page);
  await context.close();
});
