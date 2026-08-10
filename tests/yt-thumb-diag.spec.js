/**
 * YouTube サムネイル：S3 フィルタ診断 + ヒント表示確認
 */
const { test, chromium } = require("@playwright/test");
const path = require("path");
const EXTENSION_PATH = path.resolve(__dirname, "..");
test.setTimeout(90000);

async function launch() {
  return chromium.launchPersistentContext("", {
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, "--window-size=1280,900"],
    viewport: { width: 1280, height: 900 },
  });
}

// ① a[href*='/watch'] の S3 フィルタ診断（ブラウザ操作なし）
test("yt-thumb S3: watch-link filter diagnosis on search page", async () => {
  const ctx = await launch();
  const page = await ctx.newPage();
  await page.goto("https://www.youtube.com/results?search_query=javascript+tutorial", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const diag = await page.evaluate(() => {
    // content.js と同じ getEffectiveVisibleRect（fix 適用済み）
    function getEffectiveVisibleRect(el) {
      const r = el.getBoundingClientRect();
      let left = Math.max(r.left, 0), top = Math.max(r.top, 0);
      let right = Math.min(r.right, window.innerWidth), bottom = Math.min(r.bottom, window.innerHeight);
      if (left >= right || top >= bottom) return null;
      let node = el.parentElement;
      while (node && node !== document.documentElement) {
        const s = window.getComputedStyle(node);
        const ox = s.overflowX, oy = s.overflowY;
        // hidden/clip は常にクリップ。auto/scroll はコンテナ実寸 > 0 の場合のみ（YouTube の height:0 body を除外）
        const clipsX = /hidden|clip/.test(ox) || (/auto|scroll/.test(ox) && node.clientWidth > 0);
        const clipsY = /hidden|clip/.test(oy) || (/auto|scroll/.test(oy) && node.clientHeight > 0);
        if (clipsX || clipsY) {
          const nr = node.getBoundingClientRect();
          if (clipsX) { left = Math.max(left, nr.left); right = Math.min(right, nr.right); }
          if (clipsY) { top = Math.max(top, nr.top); bottom = Math.min(bottom, nr.bottom); }
          if (left >= right || top >= bottom) {
            return { _clip: node.tagName + "#" + node.id + "(" + ox + "/" + oy + ")", width: 0, height: 0 };
          }
        }
        if (s.position === "fixed") break;
        node = node.parentElement;
      }
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }

    // body の clientHeight を確認
    const bodyInfo = {
      clientHeight: document.body.clientHeight,
      clientWidth: document.body.clientWidth,
      overflowX: window.getComputedStyle(document.body).overflowX,
      overflowY: window.getComputedStyle(document.body).overflowY,
      rect: (() => { const r = document.body.getBoundingClientRect(); return {t:Math.round(r.top),b:Math.round(r.bottom),h:Math.round(r.height),w:Math.round(r.width)}; })(),
    };

    const watchLinks = [...document.querySelectorAll("a[href]")].filter(el => {
      const href = el.getAttribute("href") || "";
      return href.includes("/watch");
    });
    const inViewport = watchLinks.filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
    });

    const s3results = inViewport.slice(0, 30).map(el => {
      const r = el.getBoundingClientRect();
      const rect = getEffectiveVisibleRect(el);
      return {
        id: el.id,
        href: el.getAttribute("href")?.slice(0, 40),
        raw: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
        pass: rect !== null && !rect._clip && rect.width >= 4 && rect.height >= 4,
        clip: rect?._clip ?? (rect === null ? "(null)" : "ok"),
        resultRect: rect ? { t: Math.round(rect.top||0), w: Math.round(rect.width||0), h: Math.round(rect.height||0) } : null,
      };
    });

    const passing = s3results.filter(r => r.pass);
    const failing = s3results.filter(r => !r.pass);

    return {
      watchLinks: watchLinks.length,
      inViewport: inViewport.length,
      passing: passing.length,
      failingSamples: failing.slice(0, 3),
      passingSamples: passing.slice(0, 3),
      bodyInfo,
    };
  });

  console.log(`\n=== a[href*='/watch'] S3 診断 (search page) ===`);
  console.log(`watch links: ${diag.watchLinks}, in viewport: ${diag.inViewport}`);
  console.log(`S3 通過: ${diag.passing}/${diag.inViewport}`);
  console.log("body info:", JSON.stringify(diag.bodyInfo));
  if (diag.failingSamples.length > 0) {
    console.log("失敗サンプル:");
    diag.failingSamples.forEach((x, i) => console.log(`  [${i}]`, JSON.stringify(x)));
  }
  if (diag.passingSamples.length > 0) {
    console.log("通過サンプル:");
    diag.passingSamples.forEach((x, i) => console.log(`  [${i}]`, JSON.stringify(x)));
  }

  await ctx.close();
});

// ② 実際に f キーでヒントを開き件数を確認
test("yt-thumb HINT: press f on search page and count hints", async () => {
  const ctx = await launch();
  const page = await ctx.newPage();
  await page.goto("https://www.youtube.com/results?search_query=javascript+tutorial", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // body をクリック（フォーカスをページに移す）
  await page.mouse.click(640, 400);
  await page.waitForTimeout(300);
  await page.keyboard.press("f");
  await page.waitForTimeout(800);

  const result = await page.evaluate(() => {
    const overlay = document.querySelector(".vimium-hint-overlay");
    const hud = document.getElementById("vimium-hud")?.textContent ?? "";
    if (!overlay) return { found: false, hud };
    const hints = [...overlay.querySelectorAll(".vimium-hint")];
    // ytd-thumbnail の rect と重なるヒントを thumb ヒントとしてカウント
    const thumbRects = [...document.querySelectorAll("ytd-thumbnail")].map(t => {
      const r = t.getBoundingClientRect();
      return { t: r.top, l: r.left, r: r.right, b: r.bottom };
    });
    const thumbHints = hints.filter(h => {
      const hl = parseFloat(h.style.left), ht = parseFloat(h.style.top) + 9;
      return thumbRects.some(tr => hl >= tr.l - 10 && hl <= tr.r + 10 && ht >= tr.t - 10 && ht <= tr.b + 10);
    });
    return {
      found: true, hud,
      total: hints.length,
      thumbHints: thumbHints.length,
      sample: hints.slice(0, 5).map(h => ({ label: h.dataset.label, left: h.style.left, top: h.style.top })),
    };
  });

  console.log("\n=== f キーヒントモード確認 ===");
  console.log(JSON.stringify(result, null, 2));

  await page.keyboard.press("Escape");
  await ctx.close();
});
