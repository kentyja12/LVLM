// LinkedIn XPath 構造テスト
// ターゲット: /html/body/div[1]/div[2]/div[2]/div[2]/div/main/div/div
const { test, chromium } = require("@playwright/test");
const path = require("path");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const TEST_PAGE = `file://${path.resolve(__dirname, "linkedin-xpath.html")}`;

async function launch() {
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

test("diagnosis: firstScrollableElement picks sidebar or target?", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    function getScrollingElement() { return document.scrollingElement || document.body; }
    function performScroll(el, dir, amount) {
      const prop = dir === "y" ? "scrollTop" : "scrollLeft";
      const before = el[prop];
      if (el.scrollBy) { const a = { behavior: "instant" }; a[dir === "x" ? "left" : "top"] = amount; el.scrollBy(a); }
      else el[prop] += amount;
      return el[prop] !== before;
    }
    function doesScroll(el, dir, amount) {
      const d = Math.sign(amount) || -1;
      return performScroll(el, dir, d) && performScroll(el, dir, -d);
    }
    function firstScrollableElement() {
      const scrollingEl = getScrollingElement();
      if (doesScroll(scrollingEl, "y", 1) || doesScroll(scrollingEl, "y", -1)) return scrollingEl;
      function search(el) {
        if (!el) return null;
        if (doesScroll(el, "y", 1) || doesScroll(el, "y", -1)) return el;
        const children = [...el.children]
          .map(c => { const r = c.getBoundingClientRect(); return { el: c, area: r.width * r.height }; })
          .filter(c => c.area > 0).sort((a, b) => b.area - a.area);
        for (const child of children) { const f = search(child.el); if (f) return f; }
        return null;
      }
      return search(document.body || scrollingEl) || scrollingEl;
    }

    const found = firstScrollableElement();
    return {
      foundId: found?.id,
      foundTag: found?.tagName,
      sidebarScrollable: doesScroll(document.getElementById("sidebar"), "y", 1),
      targetScrollable: doesScroll(document.getElementById("target-scroll"), "y", 1),
      sidebarArea: (() => { const r = document.getElementById("sidebar")?.getBoundingClientRect(); return r ? r.width * r.height : 0; })(),
      targetArea: (() => { const r = document.getElementById("target-scroll")?.getBoundingClientRect(); return r ? r.width * r.height : 0; })(),
      activeEl: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
    };
  });

  console.log("\n=== firstScrollableElement 診断 ===");
  console.log(`sidebar scrollable: ${result.sidebarScrollable}, area: ${result.sidebarArea.toFixed(0)}`);
  console.log(`target-scroll scrollable: ${result.targetScrollable}, area: ${result.targetArea.toFixed(0)}`);
  console.log(`firstScrollableElement() returned: <${result.foundTag}> id="${result.foundId}"`);
  console.log(`document.activeElement: <${result.activeEl.tag}> id="${result.activeEl.id}"`);

  if (result.foundId === "sidebar") {
    console.log("\n❌ バグ: sidebar が選ばれた (面積が大きいため)");
  } else if (result.foundId === "target-scroll") {
    console.log("\n✅ target-scroll が選ばれた");
  } else {
    console.log(`\n⚠️ 不明な要素が選ばれた: ${result.foundId}`);
  }

  await context.close();
});

test("fix verification: j key scrolls target-scroll (XPath element)", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(800);

  await page.evaluate(() => { window.__scrollLog = []; });
  await page.evaluate(() => {
    ["target-scroll", "sidebar"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("scroll", () => {
        window.__scrollLog.push({ id, scrollTop: el.scrollTop });
      }, { passive: true });
    });
  });

  const before = await page.evaluate(() => ({
    target: document.getElementById("target-scroll").scrollTop,
    sidebar: document.getElementById("sidebar").scrollTop,
    activeEl: document.activeElement?.id,
  }));
  console.log("\n=== j キー前 ===", JSON.stringify(before));

  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("j");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    target: document.getElementById("target-scroll").scrollTop,
    sidebar: document.getElementById("sidebar").scrollTop,
    scrollLog: window.__scrollLog,
  }));

  console.log("\n=== j キー5回後 ===");
  console.log(`target-scroll: ${after.target} (変化: ${after.target - before.target})`);
  console.log(`sidebar: ${after.sidebar} (変化: ${after.sidebar - before.sidebar})`);

  if (after.target > before.target) {
    console.log("\n✅ target-scroll (XPath要素) がスクロールした");
  } else if (after.sidebar > before.sidebar) {
    console.log("\n❌ sidebar がスクロールした (誤り)");
  } else {
    console.log("\n❌ どこもスクロールしなかった");
  }

  await context.close();
});

test("fix verification: no focus (body active) → j scrolls target-scroll via <main> priority", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(800);

  // 意図的に body にフォーカスを戻す（activeElement = body = scrollContainerFromFocus が null を返す状態）
  await page.evaluate(() => {
    if (document.activeElement) document.activeElement.blur();
  });
  await page.waitForTimeout(100);

  await page.evaluate(() => { window.__scrollLog = []; });
  await page.evaluate(() => {
    ["target-scroll", "sidebar"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("scroll", () => {
        window.__scrollLog.push({ id, scrollTop: el.scrollTop });
      }, { passive: true });
    });
  });

  const before = await page.evaluate(() => ({
    target: document.getElementById("target-scroll").scrollTop,
    sidebar: document.getElementById("sidebar").scrollTop,
    activeEl: document.activeElement?.tagName,
  }));
  console.log("\n=== フォーカスなし: j キー前 ===", JSON.stringify(before));

  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("j");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    target: document.getElementById("target-scroll").scrollTop,
    sidebar: document.getElementById("sidebar").scrollTop,
  }));

  console.log("target-scroll変化:", after.target - before.target);
  console.log("sidebar変化:", after.sidebar - before.sidebar);

  if (after.target > before.target) {
    console.log("\n✅ <main>優先 firstScrollableElement が target-scroll を選択");
  } else if (after.sidebar > before.sidebar) {
    console.log("\n❌ sidebar がスクロールした (<main>優先が機能していない)");
  } else {
    console.log("\n❌ どこもスクロールしなかった");
  }

  await context.close();
});

test("fix verification: click sidebar item then j scrolls target-scroll", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(TEST_PAGE, { waitUntil: "load" });
  await page.waitForTimeout(800);

  // サイドバーアイテムをクリック (→ LinkedInがjob-titleに再フォーカス)
  await page.click(".sidebar-item");
  await page.waitForTimeout(300); // re-focus を待つ

  await page.evaluate(() => { window.__scrollLog = []; });
  await page.evaluate(() => {
    ["target-scroll", "sidebar"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("scroll", () => {
        window.__scrollLog.push({ id, scrollTop: el.scrollTop });
      }, { passive: true });
    });
  });

  const state = await page.evaluate(() => ({
    activeEl: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
    target: document.getElementById("target-scroll").scrollTop,
    sidebar: document.getElementById("sidebar").scrollTop,
  }));
  console.log("\n=== サイドバークリック後の状態 ===", JSON.stringify(state));

  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("j");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({
    target: document.getElementById("target-scroll").scrollTop,
    sidebar: document.getElementById("sidebar").scrollTop,
  }));

  console.log("target-scroll変化:", after.target - state.target);
  console.log("sidebar変化:", after.sidebar - state.sidebar);

  if (after.target > state.target) {
    console.log("\n✅ target-scroll がスクロールした");
  } else if (after.sidebar > state.sidebar) {
    console.log("\n❌ sidebar がスクロールした");
  } else {
    console.log("\n❌ どこもスクロールしなかった");
  }

  await context.close();
});
