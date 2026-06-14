// auto-advance.spec.js
// Video Auto-Advance のバグ再現・修正検証テスト

const { test, expect, chromium } = require("@playwright/test");
const path = require("path");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const TEST_PAGE = `file://${path.resolve(__dirname, "test-page.html").replace(/\\/g, "/")}`;

let context;
let page;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--window-size=1280,900",
    ],
    viewport: { width: 1280, height: 900 },
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

// ページ移動 + Vimium が読み込まれるまで待機
async function openTestPage() {
  await page.goto(TEST_PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800); // content script 注入待ち
  await page.click("body"); // フォーカス確保
  await page.waitForTimeout(200);
}

// zz で auto-advance を ON にする
async function enableAutoAdvance() {
  await page.keyboard.press("z");
  await page.waitForTimeout(50);
  await page.keyboard.press("z");
  await page.waitForTimeout(300); // HUD 確認
}

// ============================
// シナリオ 1: 動画が画面内で正常終了 → 1ページ分スクロール
// ============================
test("scenario 1: ended while fully in viewport → scroll by innerHeight", async () => {
  await openTestPage();
  await enableAutoAdvance();

  const before = await page.evaluate(() => window.scrollY);
  const innerH = await page.evaluate(() => window.innerHeight);

  // video-0 は画面内（scrollY=0 なので top=0, bottom=innerHeight）
  await page.evaluate(() => window.__fireEnded(0));
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => window.scrollY);
  console.log(`[S1] before=${before} after=${after} innerHeight=${innerH}`);
  console.log(`[S1] scrolled by: ${after - before}`);

  expect(after - before).toBeCloseTo(innerH, -1); // ±10px 許容
});

// ============================
// シナリオ 2: j キー(60px)の直後に ended → 手動スクロール検出で auto-advance をブロック
// ============================
test("scenario 2: ended immediately after j press → manual scroll detected, no auto-advance", async () => {
  await openTestPage();
  await enableAutoAdvance();

  await page.keyboard.press("j");
  await page.waitForTimeout(100); // j 直後（800ms 以内）

  const scrollAfterJ = await page.evaluate(() => window.scrollY);
  const innerH = await page.evaluate(() => window.innerHeight);

  const rect0 = await page.evaluate(() => {
    const v = document.querySelector("video");
    return v.getBoundingClientRect();
  });
  console.log(`[S2] after j: scrollY=${scrollAfterJ}, video-0 rect: top=${rect0.top.toFixed(0)}, bottom=${rect0.bottom.toFixed(0)}`);

  await page.evaluate(() => window.__fireEnded(0));
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => window.scrollY);
  console.log(`[S2] after ended: scrollY=${after} (expect ~${scrollAfterJ}, no extra advance)`);
  // 手動スクロール検出により auto-advance がブロックされるので scrollY は変わらない
  expect(after).toBeLessThan(innerH); // innerHeight 未満（auto-advance が発動していない）
});

// ============================
// シナリオ 3: ended 連鎖 (video-0 終了 → スクロール → video-1 も即終了)
// ============================
test("scenario 3: cascade ended events → should only advance once", async () => {
  await openTestPage();
  await enableAutoAdvance();

  const innerH = await page.evaluate(() => window.innerHeight);
  let logs = [];

  // scroll イベントを監視
  await page.evaluate(() => {
    window.__scrollCount = 0;
    window.addEventListener("scroll", () => { window.__scrollCount++; }, { passive: true });
  });

  // video-0 終了 → その後すぐ video-1 も終了（連鎖シミュレーション）
  await page.evaluate(async () => {
    window.__fireEnded(0);
    // 50ms 後に video-1 も ended（スクロールアニメーション中に次の動画が即終了するケース）
    await new Promise(r => setTimeout(r, 50));
    window.__fireEnded(1);
  });

  await page.waitForTimeout(1000);

  const scrollY = await page.evaluate(() => window.scrollY);
  const scrollCount = await page.evaluate(() => window.__scrollCount);
  console.log(`[S3] scrollY=${scrollY} innerHeight=${innerH} scrollCount=${scrollCount}`);
  console.log(`[S3] jumped ${(scrollY / innerH).toFixed(1)} videos`);
  // cooldown により2回目の ended は無視され、1動画分だけスクロール
  expect(scrollY).toBeLessThan(innerH * 1.5); // 2動画分(1800)には達しない
});

// ============================
// シナリオ 4: j を複数回押してから ended → 完全に画面外なら無視
// ============================
test("scenario 4: ended after many j presses (video off-screen) → no advance", async () => {
  await openTestPage();
  await enableAutoAdvance();

  const innerH = await page.evaluate(() => window.innerHeight);

  // j を20回押して video-0 を完全に画面外へ
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("j");
    await page.waitForTimeout(30);
  }

  const scrollAfterJ = await page.evaluate(() => window.scrollY);
  const rect0 = await page.evaluate(() => {
    const v = document.querySelector("video");
    return v.getBoundingClientRect();
  });
  console.log(`[S4] after 20×j: scrollY=${scrollAfterJ}`);
  console.log(`[S4] video-0 rect: top=${rect0.top.toFixed(0)}, bottom=${rect0.bottom.toFixed(0)}`);

  // video-0 は完全に画面外のはず → ended を発火しても無視される
  await page.evaluate(() => window.__fireEnded(0));
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => window.scrollY);
  console.log(`[S4] after ended: scrollY=${after}`);
  // auto-advance が発動していれば +innerHeight(900)、smooth scroll 残りなら +数十px
  expect(after - scrollAfterJ).toBeLessThan(innerH * 0.5); // 450px 未満（auto-advance は発動していない）
});
