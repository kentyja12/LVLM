// バグ修正テスト
// バグ1: href="#" ボタンをヒントで押すとページトップにジャンプする
// バグ2: video auto-advance (zz) が動かない
const { test, chromium, expect } = require("@playwright/test");
const path = require("path");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const BUG1_PAGE = `file://${path.resolve(__dirname, "bug1-carousel.html")}`;
const BUG2_PAGE = `file://${path.resolve(__dirname, "bug2-reel.html")}`;

async function launch(width = 1280, height = 900) {
  return chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      `--window-size=${width},${height}`,
    ],
    viewport: { width, height },
  });
}

// ===== バグ1: href="#" でトップジャンプしない =====
test("bug1: href='#' carousel button does not jump to top", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(BUG1_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);

  // 200px スクロールして「スクロール位置がある」状態を作る
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForTimeout(200);

  const scrollBefore = await page.evaluate(() => window.scrollY);
  console.log(`\n=== 初期 scrollY: ${scrollBefore} ===`);
  expect(scrollBefore).toBeGreaterThan(100);

  // f でヒントモード
  await page.click("body");
  await page.waitForTimeout(100);
  await page.keyboard.press("f");
  await page.waitForTimeout(400);

  // next-btn に対応するヒントラベルを特定
  // bug1-carousel.html はヒント可能要素が next-btn のみなので、常に最初のヒントが next-btn
  const hintInfo = await page.evaluate(() => {
    const overlay = document.querySelector(".vimium-hint-overlay");
    if (!overlay) return null;
    const hints = overlay.querySelectorAll(".vimium-hint");
    if (hints.length === 0) return null;
    const allLabels = [...hints].map(h => h.dataset.label);
    // next-btn に最も近いヒントを返す
    const nextBtn = document.getElementById("next-btn");
    const btnRect = nextBtn.getBoundingClientRect();
    const btnCx = btnRect.left + btnRect.width / 2;
    const btnCy = btnRect.top + btnRect.height / 2;
    let bestLabel = null, bestDist = Infinity;
    for (const h of hints) {
      const hl = parseFloat(h.style.left);
      const ht = parseFloat(h.style.top) + 9;
      const dist = Math.hypot(hl - btnCx, ht - btnCy);
      if (dist < bestDist) { bestDist = dist; bestLabel = h.dataset.label; }
    }
    return { label: bestLabel, total: hints.length, all: allLabels };
  });
  console.log(`ヒント情報:`, hintInfo);
  expect(hintInfo).not.toBeNull();
  expect(hintInfo.total).toBe(1); // next-btn のみ hintable のはず
  const nextBtnLabel = hintInfo.label;

  // ラベルを1文字ずつ入力（小文字で直接送信）
  for (const ch of nextBtnLabel) {
    await page.keyboard.press(ch);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  const scrollAfter = await page.evaluate(() => window.scrollY);
  const clicked = await page.evaluate(() => window.__nextBtnClicked);
  console.log(`ヒント後 scrollY: ${scrollAfter}, clicked: ${clicked}`);

  expect(scrollAfter).toBeGreaterThan(50);
  console.log("✅ href='#' ボタンでトップジャンプしなかった");
  expect(clicked).toBe(true);
  console.log("✅ ボタンの click() が正しく呼ばれた");

  await context.close();
});

// ===== バグ2: zz で auto-advance ON → ended でスクロール =====
test("bug2: video auto-advance ON via zz, scroll on ended", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(BUG2_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(800);

  // zz を入力
  await page.click("body");
  await page.waitForTimeout(100);
  await page.keyboard.press("z");
  await page.waitForTimeout(100);
  await page.keyboard.press("z");
  await page.waitForTimeout(400);

  const hudText = await page.evaluate(() => document.getElementById("vimium-hud")?.textContent ?? "");
  console.log(`\n=== zz 後 HUD: "${hudText}" ===`);
  expect(hudText).toContain("ON");
  console.log("✅ zz で auto-advance ON");

  const scrollBefore = await page.evaluate(() => document.getElementById("reel").scrollTop);
  await page.evaluate(() => window.__fireVideoEnded("v1"));
  await page.waitForTimeout(500);

  const scrollAfter = await page.evaluate(() => document.getElementById("reel").scrollTop);
  console.log(`ended 後 scrollTop: ${scrollAfter} (変化: ${scrollAfter - scrollBefore})`);
  expect(scrollAfter).toBeGreaterThan(scrollBefore);
  console.log("✅ ended イベントでスクロール発生");

  await context.close();
});

// ===== バグ2: 1500ms デバウンス後に2回目の ended でも再スクロール =====
test("bug2: video auto-advance debounce resets after 1500ms", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(BUG2_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(800);

  await page.click("body");
  await page.waitForTimeout(100);
  await page.keyboard.press("z");
  await page.waitForTimeout(100);
  await page.keyboard.press("z");
  await page.waitForTimeout(400);

  // 1回目 ended
  await page.evaluate(() => window.__fireVideoEnded("v1"));
  await page.waitForTimeout(300);
  const scroll1 = await page.evaluate(() => document.getElementById("reel").scrollTop);

  // デバウンス内 (500ms) に2回目 → 無視されるはず
  await page.evaluate(() => window.__fireVideoEnded("v1"));
  await page.waitForTimeout(300);
  const scroll2 = await page.evaluate(() => document.getElementById("reel").scrollTop);

  // デバウンス (1500ms) 経過後に3回目 → スクロールされるはず
  await page.waitForTimeout(1500);
  // reel を先頭に戻す
  await page.evaluate(() => { document.getElementById("reel").scrollTop = 0; });
  await page.evaluate(() => window.__fireVideoEnded("v1"));
  await page.waitForTimeout(300);
  const scroll3 = await page.evaluate(() => document.getElementById("reel").scrollTop);

  console.log(`\n=== デバウンス確認 ===`);
  console.log(`1回目 ended → scrollTop: ${scroll1}`);
  console.log(`デバウンス内2回目 → scrollTop: ${scroll2} (変化なしのはず)`);
  console.log(`1500ms後3回目 → scrollTop: ${scroll3}`);

  expect(scroll1).toBeGreaterThan(0);
  expect(scroll2).toBe(scroll1); // デバウンス内は変化なし
  expect(scroll3).toBeGreaterThan(0);
  console.log("✅ 1回目スクロール、デバウンス内は無視、1500ms後に再スクロール");

  await context.close();
});
