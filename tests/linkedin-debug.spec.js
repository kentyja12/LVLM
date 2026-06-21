// LinkedIn スクロールバグ診断テスト
const { test, chromium } = require("@playwright/test");
const path = require("path");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const TEST_PAGE = `file://${path.resolve(__dirname, "linkedin-like.html")}`;

async function launchWithExtension() {
  return chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--window-size=1280,900",
    ],
    viewport: { width: 1280, height: 900 },
  });
}

test("diagnosis: what does firstScrollableElement() return?", async () => {
  const context = await launchWithExtension();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);

  // content.js の firstScrollableElement と同じロジックをページ世界で実行
  const result = await page.evaluate(() => {
    function getScrollingElement() {
      return document.scrollingElement || document.body;
    }
    function performScroll(el, direction, amount) {
      const prop = direction === "y" ? "scrollTop" : "scrollLeft";
      const before = el[prop];
      if (el.scrollBy) {
        const arg = { behavior: "instant" };
        arg[direction === "x" ? "left" : "top"] = amount;
        el.scrollBy(arg);
      } else {
        el[prop] += amount;
      }
      return el[prop] !== before;
    }
    function doesScroll(el, direction, amount) {
      const delta = Math.sign(amount) || -1;
      return performScroll(el, direction, delta) && performScroll(el, direction, -delta);
    }
    function firstScrollableElement() {
      const scrollingEl = getScrollingElement();
      if (doesScroll(scrollingEl, "y", 1) || doesScroll(scrollingEl, "y", -1)) return scrollingEl;
      function search(el) {
        if (!el) return null;
        if (doesScroll(el, "y", 1) || doesScroll(el, "y", -1)) return el;
        const children = [...el.children]
          .map((c) => { const r = c.getBoundingClientRect(); return { el: c, area: r.width * r.height }; })
          .filter((c) => c.area > 0)
          .sort((a, b) => b.area - a.area);
        for (const child of children) { const found = search(child.el); if (found) return found; }
        return null;
      }
      return search(document.body || scrollingEl) || scrollingEl;
    }

    const scrollingEl = getScrollingElement();
    const firstScroll = firstScrollableElement();
    const activeEl = document.activeElement;

    return {
      scrollingEl: {
        tag: scrollingEl.tagName,
        id: scrollingEl.id,
        canScrollY: doesScroll(scrollingEl, "y", 1) || doesScroll(scrollingEl, "y", -1),
        scrollHeight: scrollingEl.scrollHeight,
        clientHeight: scrollingEl.clientHeight,
      },
      firstScrollableEl: {
        tag: firstScroll?.tagName,
        id: firstScroll?.id,
        className: firstScroll?.className?.slice(0, 60),
        scrollHeight: firstScroll?.scrollHeight,
        clientHeight: firstScroll?.clientHeight,
        canScrollY: firstScroll ? (doesScroll(firstScroll, "y", 1) || doesScroll(firstScroll, "y", -1)) : false,
      },
      activeElement: {
        tag: activeEl?.tagName,
        id: activeEl?.id,
        textContent: activeEl?.textContent?.slice(0, 40),
      },
      jobDetailPanel: {
        scrollHeight: document.getElementById("job-detail-panel")?.scrollHeight,
        clientHeight: document.getElementById("job-detail-panel")?.clientHeight,
        overflowY: window.getComputedStyle(document.getElementById("job-detail-panel")).overflowY,
      },
      bodyOverflow: window.getComputedStyle(document.body).overflow,
    };
  });

  console.log("\n=== DOM 診断結果 ===");
  console.log("scrollingElement:", JSON.stringify(result.scrollingEl, null, 2));
  console.log("firstScrollableElement():", JSON.stringify(result.firstScrollableEl, null, 2));
  console.log("document.activeElement:", JSON.stringify(result.activeElement, null, 2));
  console.log("job-detail-panel:", JSON.stringify(result.jobDetailPanel, null, 2));
  console.log("body.overflow:", result.bodyOverflow);

  await context.close();
});

test("reproduction: j key scrolls which element?", async () => {
  const context = await launchWithExtension();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(800); // 拡張機能初期化待ち

  // ページ内のスクロール監視
  await page.evaluate(() => {
    window.__scrollLog = [];
    ["job-detail-panel", "job-list-panel"].forEach(id => {
      document.getElementById(id).addEventListener("scroll", () => {
        window.__scrollLog.push({ id, scrollTop: document.getElementById(id).scrollTop });
      }, { passive: true });
    });
    window.addEventListener("scroll", () => {
      window.__scrollLog.push({ id: "window", scrollY: window.scrollY });
    }, { passive: true });
  });

  // ページ本文をクリックして focus を確保（クリックなし版のテスト）
  // LinkedInのケース: ページロード後にh1がfocusされる→ユーザーはクリックせずにjを押す
  const beforeScrolls = await page.evaluate(() => ({
    detail: document.getElementById("job-detail-panel").scrollTop,
    list: document.getElementById("job-list-panel").scrollTop,
    windowY: window.scrollY,
    activeEl: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
  }));
  console.log("\n=== j キー押下前 ===");
  console.log(JSON.stringify(beforeScrolls, null, 2));

  // j を5回押す（クリックなし）
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("j");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  const afterScrolls = await page.evaluate(() => ({
    detail: document.getElementById("job-detail-panel").scrollTop,
    list: document.getElementById("job-list-panel").scrollTop,
    windowY: window.scrollY,
    scrollLog: window.__scrollLog,
  }));
  console.log("\n=== j キー5回後 ===");
  console.log("job-detail-panel scrollTop:", afterScrolls.detail, "(変化:", afterScrolls.detail - beforeScrolls.detail, ")");
  console.log("job-list-panel scrollTop:", afterScrolls.list, "(変化:", afterScrolls.list - beforeScrolls.list, ")");
  console.log("window scrollY:", afterScrolls.windowY);
  console.log("scrollLog:", JSON.stringify(afterScrolls.scrollLog, null, 2));

  if (afterScrolls.detail === beforeScrolls.detail && afterScrolls.list === beforeScrolls.list) {
    console.log("\n❌ バグ再現: j キーで何もスクロールしない");
  } else if (afterScrolls.detail > beforeScrolls.detail) {
    console.log("\n✅ job-detail-panel がスクロールした (期待通り)");
  } else {
    console.log("\n⚠️ job-list-panel がスクロールした (誤ったパネル)");
  }

  await context.close();
});

test("reproduction: click job item then press j (SPA simulation)", async () => {
  const context = await launchWithExtension();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(800);

  // ジョブ一覧パネルのアイテムをクリック（LinkedIn でのジョブ選択をシミュレート）
  await page.click(".job-item");
  await page.waitForTimeout(200);

  // スクロール監視
  await page.evaluate(() => {
    window.__scrollLog = [];
    ["job-detail-panel", "job-list-panel"].forEach(id => {
      document.getElementById(id).addEventListener("scroll", () => {
        window.__scrollLog.push({ id, scrollTop: document.getElementById(id).scrollTop });
      }, { passive: true });
    });
  });

  const beforeScrolls = await page.evaluate(() => ({
    detail: document.getElementById("job-detail-panel").scrollTop,
    list: document.getElementById("job-list-panel").scrollTop,
    activatedElTag: document.activeElement?.tagName,
    activatedElClass: document.activeElement?.className?.slice(0, 40),
  }));
  console.log("\n=== ジョブアイテムクリック後の状態 ===");
  console.log(JSON.stringify(beforeScrolls, null, 2));

  // j を5回押す
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("j");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  const afterScrolls = await page.evaluate(() => ({
    detail: document.getElementById("job-detail-panel").scrollTop,
    list: document.getElementById("job-list-panel").scrollTop,
    scrollLog: window.__scrollLog,
  }));

  console.log("\n=== クリック後に j キー5回 ===");
  console.log("job-detail-panel scrollTop:", afterScrolls.detail, "(変化:", afterScrolls.detail - beforeScrolls.detail, ")");
  console.log("job-list-panel scrollTop:", afterScrolls.list, "(変化:", afterScrolls.list - beforeScrolls.list, ")");
  console.log("scrollLog:", JSON.stringify(afterScrolls.scrollLog, null, 2));

  if (afterScrolls.list > beforeScrolls.list && afterScrolls.detail === beforeScrolls.detail) {
    console.log("\n❌ バグ再現: クリック後、job-list-panel (左パネル) がスクロールした");
  } else if (afterScrolls.detail > beforeScrolls.detail) {
    console.log("\n✅ job-detail-panel がスクロールした");
  } else {
    console.log("\n❌ どこもスクロールしなかった");
  }

  await context.close();
});
