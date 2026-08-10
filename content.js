// content.js - Vimium Homemade メインロジック

(() => {
  "use strict";

  // サンドボックス iframe や無効化されたコンテキストでは chrome.runtime が存在しないため即終了
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return;

  // ===== デフォルト設定 =====
  const DEFAULT_SETTINGS = {
    // スクロール
    scrollStep: 60,
    smoothScroll: true,
    halfPageRatio: 0.45,
    // キーリピート
    repeatDelay: 150,
    repeatInterval: 40,
    // リンクヒント
    hintChars: "asdfghjklqwertyuiopzxcvbnm",
    // Vomnibar
    vomnibarMaxResults: 30,
    vomnibarIncludeHistory: true,
    vomnibarIncludeBookmarks: true,
    // HUD
    hudTimeout: 1500,
    // キーバインド・除外
    keyMappings: "",
    excludedSites: "",
  };

  let settings = { ...DEFAULT_SETTINGS };

  // ===== 状態管理 =====
  let mode = "normal"; // normal | insert | hint | find | vomnibar | help
  let keyBuffer = "";
  let keyBufferTimer = null;
  let hintMode = "open";
  let hintElements = [];
  let hintOverlay = null;

  // Find Mode
  let findQuery = "";
  let findMatches = [];
  let findIndex = -1;

  // Vomnibar
  let vomnibarNewTab = false;
  let vomnibarTabMode = false; // true = タブ切り替えモード (T キー)
  let vomnibarItems = [];
  let vomnibarSelected = 0;
  let vomnibarDebounceTimer = null;

  // Video Auto-Advance (動画終了後に次の動画へ自動スクロール)
  let videoAutoAdvanceEnabled = false;
  let videoListeners = []; // { el, fn } pairs for cleanup
  let lastAutoAdvanceTime = 0;

  // ===== スクロールコマンド定義（repeat判定用）=====
  const SCROLL_COMMANDS = new Set([
    "scrollDown", "scrollUp", "scrollLeft", "scrollRight", "scrollPageDown", "scrollPageUp",
    "scrollFullLeft", "scrollFullRight",
  ]);

  // ===== Vimium スクローラー =====
  // 参考実装: https://github.com/philc/vimium (content_scripts/scroller.js)

  const getScrollingElement = () => document.scrollingElement || document.body;

  // element を amount だけスクロールし、実際に動いたか返す（behavior: instant で即時適用）
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

  // Chrome bug #110149 対策: CSS の overflow 値ではなく実際に 1px 動かして可否を確認する
  function doesScroll(el, direction, amount) {
    const delta = Math.sign(amount) || -1;
    return performScroll(el, direction, delta) && performScroll(el, direction, -delta);
  }

  function shouldScroll(el, direction) {
    const style = window.getComputedStyle(el);
    if (style.getPropertyValue(`overflow-${direction}`) === "hidden") return false;
    if (["hidden", "collapse"].includes(style.visibility)) return false;
    if (style.display === "none") return false;
    return true;
  }

  function isScrollableElement(el, direction = "y", amount = 1) {
    return doesScroll(el, direction, amount) && shouldScroll(el, direction);
  }

  // activatedElement から上へ辿り、実際にスクロールできる要素を返す
  function findScrollableElement(element, direction, amount) {
    const scrollingEl = getScrollingElement();
    while (element !== scrollingEl && !isScrollableElement(element, direction, Math.sign(amount) || 1)) {
      element = element.parentElement || scrollingEl;
    }
    return element;
  }

  // ページ初期化時: 最大面積の可視スクロール可能要素を探索する
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
    // <main> / role="main" 内を優先探索（LinkedIn 等で sidebar より main content を正しく選択するため）
    const mainEl = document.querySelector("main, [role='main']");
    if (mainEl) {
      const inMain = search(mainEl);
      if (inMain) return inMain;
    }
    return search(document.body || scrollingEl) || scrollingEl;
  }

  // 先祖の overflow コンテナを考慮した実際の可視矩形を返す。完全に隠れている場合は null
  function getEffectiveVisibleRect(el) {
    const r = el.getBoundingClientRect();
    let left = Math.max(r.left, 0), top = Math.max(r.top, 0);
    let right = Math.min(r.right, window.innerWidth), bottom = Math.min(r.bottom, window.innerHeight);
    if (left >= right || top >= bottom) return null;

    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const s = window.getComputedStyle(node);
      const ox = s.overflowX, oy = s.overflowY;
      // hidden/clip は常にクリップ。auto/scroll はコンテナ実寸 > 0 の場合のみ（高さ0の body を除外）
      const clipsX = /hidden|clip/.test(ox) || (/auto|scroll/.test(ox) && node.clientWidth > 0);
      const clipsY = /hidden|clip/.test(oy) || (/auto|scroll/.test(oy) && node.clientHeight > 0);
      if (clipsX || clipsY) {
        const nr = node.getBoundingClientRect();
        if (clipsX) { left = Math.max(left, nr.left); right  = Math.min(right,  nr.right); }
        if (clipsY) { top  = Math.max(top,  nr.top);  bottom = Math.min(bottom, nr.bottom); }
        if (left >= right || top >= bottom) return null;
      }
      // position:fixed の祖先はビューポート基準で描画されるため、
      // それより上の祖先の overflow クリッピングは el に影響しない
      if (s.position === "fixed") break;
      node = node.parentElement;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  // 最後にクリック/DOMActivate された要素を追跡（findScrollableElement の起点）
  let activatedElement = null;
  document.addEventListener("DOMActivate", (e) => { activatedElement = e.target; }, true);
  document.addEventListener("click",       (e) => { activatedElement = e.target; }, true);

  // SPA ナビゲーション時に activatedElement をリセット（LinkedIn 等のシングルページアプリ対応）
  const _origPushState = history.pushState.bind(history);
  history.pushState = (...args) => { _origPushState(...args); activatedElement = null; };
  const _origReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => { _origReplaceState(...args); activatedElement = null; };
  window.addEventListener("popstate", () => { activatedElement = null; });

  // CoreScroller: Vimium の calibration ベースアニメーター
  //   - 各キー押下で独立したアニメーターを起動
  //   - repeat 中は新アニメーターを作らず、既存アニメーターが myKeyIsStillDown() で継続
  //   - calibration で長押し時の速度を calibrationBoundary px/duration に自動収束させる
  const CoreScroller = {
    time: 0,
    lastEvent: null,
    keyDownKey: null,
    minCalibration: 0.5,
    maxCalibration: 1.6,
    calibrationBoundary: 150,

    onKeydown(event) {
      this.keyDownKey = event.code;
      if (!event.repeat) this.time++;
      this.lastEvent = event;
    },

    onKeyup(event) {
      if (event.code === this.keyDownKey) {
        this.keyDownKey = null;
        this.time++;
      }
    },

    scroll(element, direction, amount) {
      if (!amount) return;

      if (!settings.smoothScroll) {
        performScroll(element, direction, amount);
        return;
      }

      // repeat 中は新アニメーターを起動しない（既存アニメーターが継続スクロールする）
      if (this.lastEvent?.repeat) return;

      const activationTime = ++this.time;
      // time が変わっていない かつ キーが押されている → まだキーが離れていない
      const myKeyIsStillDown = () => this.time === activationTime && this.keyDownKey != null;

      const sign = Math.sign(amount);
      amount = Math.abs(amount);
      const duration = Math.max(100, 20 * Math.log(amount));

      let totalDelta = 0;
      let totalElapsed = 0;
      let calibration = 1.0;
      let previousTimestamp = null;

      const animate = (timestamp) => {
        // 初回フレームはタイムスタンプ記録のみ（elapsed=0 を避ける）
        if (previousTimestamp == null) {
          previousTimestamp = timestamp;
          return requestAnimationFrame(animate);
        }
        if (timestamp === previousTimestamp) return requestAnimationFrame(animate);

        const elapsed = timestamp - previousTimestamp;
        totalElapsed += elapsed;
        previousTimestamp = timestamp;

        // 長押し 75ms 以降: 速度を calibrationBoundary に向けて自動調整
        if (myKeyIsStillDown() && totalElapsed >= 75 &&
            calibration >= this.minCalibration && calibration <= this.maxCalibration) {
          if (1.05 * calibration * amount < this.calibrationBoundary) calibration *= 1.05;
          if (this.calibrationBoundary < 0.95 * calibration * amount) calibration *= 0.95;
        }

        let delta = Math.ceil(amount * (elapsed / duration) * calibration);
        // キーが離されたら残量を上限としてフィニッシュ
        delta = myKeyIsStillDown()
          ? delta
          : Math.max(0, Math.min(delta, amount - totalDelta));

        if (delta && performScroll(element, direction, sign * delta)) {
          totalDelta += delta;
          return requestAnimationFrame(animate);
        }
        // performScroll が false（要素が動かなかった）または delta=0 → アニメーション終了
      };

      requestAnimationFrame(animate);
    },
  };

  // フォーカス要素から最近傍のスクロールコンテナを取得する
  // スクロール不可能な scrollingEl にしか辿り着けない場合は null を返す
  function scrollContainerFromFocus(direction, sign) {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return null;
    const scrollingEl = getScrollingElement();
    const candidate = findScrollableElement(active, direction, sign);
    if (candidate === scrollingEl &&
        !doesScroll(scrollingEl, direction, 1) && !doesScroll(scrollingEl, direction, -1)) {
      return null; // スクロール不能な scrollingEl へのフォールバックは採用しない
    }
    return candidate;
  }

  function doScroll(dx, dy, count = 1) {
    // DOM から切り離された stale な要素はリセット（SPA でのナビゲーション後に発生する）
    if (activatedElement && !activatedElement.isConnected) activatedElement = null;
    if (!activatedElement) {
      activatedElement = firstScrollableElement() || getScrollingElement();
    }

    if (dy !== 0) {
      const amount = dy * count;
      const fromActivated = findScrollableElement(activatedElement, "y", amount);
      // document.activeElement が別のスクロールコンテナを指す場合は優先する
      // （LinkedIn等SPAで左パネルクリック後も右パネルの詳細をスクロールするため）
      const fromFocus = scrollContainerFromFocus("y", Math.sign(dy));
      CoreScroller.scroll(
        (fromFocus && fromFocus !== fromActivated) ? fromFocus : fromActivated,
        "y", amount,
      );
    }
    if (dx !== 0) {
      const amount = dx * count;
      const fromActivated = findScrollableElement(activatedElement, "x", amount);
      const fromFocus = scrollContainerFromFocus("x", Math.sign(dx));
      CoreScroller.scroll(
        (fromFocus && fromFocus !== fromActivated) ? fromFocus : fromActivated,
        "x", amount,
      );
    }
  }

  function scrollToTop() {
    getScrollingElement().scrollTo({ top: 0, behavior: settings.smoothScroll ? "smooth" : "instant" });
  }

  function scrollToBottom() {
    const el = getScrollingElement();
    el.scrollTo({ top: el.scrollHeight, behavior: settings.smoothScroll ? "smooth" : "instant" });
  }

  // ===== UI要素の生成 =====
  function createHud() {
    const el = document.createElement("div");
    el.id = "vimium-hud";
    document.documentElement.appendChild(el);
    return el;
  }

  function createFindBar() {
    const bar = document.createElement("div");
    bar.id = "vimium-find-bar";
    bar.innerHTML = `<label>/</label><input id="vimium-find-input" autocomplete="off" spellcheck="false"><span id="vimium-find-count"></span>`;
    document.documentElement.appendChild(bar);
    return bar;
  }

  function createVomnibar() {
    const backdrop = document.createElement("div");
    backdrop.id = "vimium-vomnibar-backdrop";
    const box = document.createElement("div");
    box.id = "vimium-vomnibar";
    box.innerHTML = `
      <div id="vimium-vomnibar-input-wrap">
        <label>Open:</label>
        <input id="vimium-vomnibar-input" autocomplete="off" spellcheck="false" placeholder="Search history, bookmarks, tabs...">
      </div>
      <ul id="vimium-vomnibar-list"></ul>`;
    document.documentElement.appendChild(backdrop);
    document.documentElement.appendChild(box);
    return { backdrop, box };
  }

  function createHelp() {
    const backdrop = document.createElement("div");
    backdrop.id = "vimium-help-backdrop";
    const box = document.createElement("div");
    box.id = "vimium-help";
    document.documentElement.appendChild(backdrop);
    document.documentElement.appendChild(box);
    return { backdrop, box };
  }

  const hud = createHud();
  const findBar = createFindBar();
  const findInput = document.getElementById("vimium-find-input");
  const findCount = document.getElementById("vimium-find-count");
  const { backdrop: vomnibarBackdrop, box: vomnibarBox } = createVomnibar();
  const vomnibarInput = document.getElementById("vimium-vomnibar-input");
  const vomnibarList = document.getElementById("vimium-vomnibar-list");
  const { backdrop: helpBackdrop, box: helpBox } = createHelp();

  // ===== HUD =====
  let hudTimer = null;
  function showHud(text, duration = -1) {
    if (duration === -1) duration = settings.hudTimeout;
    hud.textContent = text;
    hud.classList.add("visible");
    clearTimeout(hudTimer);
    if (duration > 0) hudTimer = setTimeout(() => hud.classList.remove("visible"), duration);
  }
  function hideHud() { clearTimeout(hudTimer); hud.classList.remove("visible"); }

  // ===== モード切替 =====
  function setMode(newMode) {
    mode = newMode;
    keyBuffer = "";
    clearTimeout(keyBufferTimer);
    hideHud();
  }

  // ===== Video Auto-Advance =====
  const videoObserver = new MutationObserver((mutations) => {
    if (!videoAutoAdvanceEnabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "VIDEO") attachVideoListener(node);
        node.querySelectorAll?.("video").forEach(attachVideoListener);
      }
    }
  });

  function onVideoEnded(video) {
    if (!videoAutoAdvanceEnabled) return;
    const now = Date.now();
    if (now - lastAutoAdvanceTime < 1500) return;
    lastAutoAdvanceTime = now;
    showHud("Auto-advance: 次の動画へ");
    // video 要素から最近傍の scroll コンテナを探す（YouTube Shorts の #shorts-container 等対応）。
    // firstScrollableElement() は document.scrollingElement を優先するため Shorts では外れることがある。
    const scrollEl = findScrollableElement(video, "y", 1);
    const isDocScrollEl = scrollEl === getScrollingElement();
    const target = (!isDocScrollEl && scrollEl) ? scrollEl : (firstScrollableElement() || getScrollingElement());
    performScroll(target, "y", target.clientHeight || window.innerHeight);
  }

  function attachVideoListener(video) {
    if (videoListeners.some((v) => v.el === video)) return;
    const onEnded = () => onVideoEnded(video);
    // timeupdate: 残り 0.3 秒以下かつ duration が有効な場合に発火（リール等 ended が遅れるケース対策）
    const onTimeUpdate = () => {
      if (video.duration > 0 && video.currentTime >= video.duration - 0.3) onVideoEnded(video);
    };
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", onTimeUpdate);
    videoListeners.push({ el: video, fn: onEnded, fn2: onTimeUpdate });
  }

  function enableVideoAutoAdvance() {
    videoAutoAdvanceEnabled = true;
    document.querySelectorAll("video").forEach(attachVideoListener);
    // document.body が存在しない場合（document_start 直後の iframe 等）は observe をスキップ
    if (document.body) {
      videoObserver.observe(document.body, { childList: true, subtree: true });
    }
    showHud("Auto-advance: ON (動画終了→次へスクロール)", 0);
  }

  function disableVideoAutoAdvance() {
    videoAutoAdvanceEnabled = false;
    videoListeners.forEach(({ el, fn, fn2 }) => {
      el.removeEventListener("ended", fn);
      el.removeEventListener("timeupdate", fn2);
    });
    videoListeners = [];
    lastAutoAdvanceTime = 0;
    videoObserver.disconnect();
    showHud("Auto-advance: OFF");
  }

  function toggleVideoAutoAdvance() {
    if (videoAutoAdvanceEnabled) disableVideoAutoAdvance();
    else enableVideoAutoAdvance();
  }

  // ===== コマンド定義 =====
  const COMMAND_MAP = {
    scrollDown:       (n) => doScroll(0, settings.scrollStep, n),
    scrollUp:         (n) => doScroll(0, -settings.scrollStep, n),
    scrollLeft:       (n) => doScroll(-settings.scrollStep, 0, n),
    scrollRight:      (n) => doScroll(settings.scrollStep, 0, n),
    scrollPageDown:   (n) => doScroll(0, window.innerHeight * settings.halfPageRatio, n),
    scrollPageUp:     (n) => doScroll(0, -window.innerHeight * settings.halfPageRatio, n),
    scrollToTop:         () => scrollToTop(),
    scrollToBottom:      () => scrollToBottom(),
    scrollFullLeft:      () => {
      if (!activatedElement) activatedElement = firstScrollableElement() || getScrollingElement();
      findScrollableElement(activatedElement, "x", -1)
        .scrollTo({ left: 0, behavior: settings.smoothScroll ? "smooth" : "instant" });
    },
    scrollFullRight:     () => {
      if (!activatedElement) activatedElement = firstScrollableElement() || getScrollingElement();
      const el = findScrollableElement(activatedElement, "x", 1);
      el.scrollTo({ left: el.scrollWidth, behavior: settings.smoothScroll ? "smooth" : "instant" });
    },
    reload:              () => window.location.reload(),
    goBack:              (n) => history.go(-n),
    goForward:           (n) => history.go(n),
    tabPrev:             () => chrome.runtime.sendMessage({ type: "TAB_PREV" }),
    tabNext:             () => chrome.runtime.sendMessage({ type: "TAB_NEXT" }),
    tabFirst:            () => chrome.runtime.sendMessage({ type: "TAB_FIRST" }),
    tabLast:             () => chrome.runtime.sendMessage({ type: "TAB_LAST" }),
    tabMoveLeft:         () => chrome.runtime.sendMessage({ type: "TAB_MOVE", delta: -1 }),
    tabMoveRight:        () => chrome.runtime.sendMessage({ type: "TAB_MOVE", delta:  1 }),
    newTab:              () => chrome.runtime.sendMessage({ type: "TAB_NEW" }),
    closeTab:            () => chrome.runtime.sendMessage({ type: "TAB_CLOSE" }),
    restoreTab:          () => chrome.runtime.sendMessage({ type: "TAB_RESTORE" }),
    moveTabToWindow:     () => chrome.runtime.sendMessage({ type: "TAB_WINDOW" }),
    hintOpen:            () => enterHintMode("open"),
    hintTab:             () => enterHintMode("tab"),
    hintYank:            () => enterHintMode("yank"),
    vomnibarOpen:        () => enterVomnibar(false),
    vomnibarTab:         () => enterVomnibar(true),
    switchTab:           () => enterVomnibar(false, true),
    findMode:            () => enterFindMode(),
    findNext:            () => findNext(1),
    findPrev:            () => findNext(-1),
    insertMode:          () => { setMode("insert"); showHud("-- INSERT --", 0); },
    showHelp:            () => enterHelp(),
    goUpUrl:             () => navigateUpUrl(),
    goRootUrl:           () => navigateRootUrl(),
    focusInput:          () => focusFirstInput(),
    yankUrl:             () => navigator.clipboard.writeText(window.location.href)
                                 .then(() => showHud(`Copied: ${window.location.href}`)),
    openClipboard:       () => navigator.clipboard.readText().then((text) => {
      if (!text) return;
      window.location.href = /^https?:\/\//.test(text)
        ? text : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    }),
    openClipboardNewTab: () => navigator.clipboard.readText().then((text) => {
      if (!text) return;
      const url = /^https?:\/\//.test(text)
        ? text : `https://www.google.com/search?q=${encodeURIComponent(text)}`;
      chrome.runtime.sendMessage({ type: "TAB_NEW", url });
    }),
    viewSource:          () => chrome.runtime.sendMessage({
      type: "TAB_NEW", url: `view-source:${window.location.href}`,
    }),
    yankContainingBlock: () => yankContainingBlock(),
    visualMode:          () => enterVisualMode("char"),
    visualLineMode:      () => enterVisualMode("line"),
    toggleVideoAutoAdvance: () => toggleVideoAutoAdvance(),
  };

  // ===== デフォルトキーマップ =====
  // キー文字列 → コマンド名
  const DEFAULT_KEY_MAP = {
    // スクロール
    "j": "scrollDown",
    "k": "scrollUp",
    "h": "scrollLeft",
    "l": "scrollRight",
    "d": "scrollPageDown",
    "u": "scrollPageUp",
    "G": "scrollToBottom",
    // ナビゲーション
    "r": "reload",
    "H": "goBack",
    "L": "goForward",
    // タブ操作
    "J": "tabPrev",
    "K": "tabNext",
    "t": "newTab",
    "x": "closeTab",
    "X": "restoreTab",
    "W": "moveTabToWindow",
    "T": "switchTab",
    // リンクヒント
    "f": "hintOpen",
    "F": "hintTab",
    // Vomnibar
    "o": "vomnibarOpen",
    "O": "vomnibarTab",
    // 検索
    "/": "findMode",
    "n": "findNext",
    "N": "findPrev",
    // モード
    "i": "insertMode",
    "?": "showHelp",
    // クリップボード
    "p": "openClipboard",
    "P": "openClipboardNewTab",
    // 2ストロークキー
    "gg": "scrollToTop",
    "gu": "goUpUrl",
    "gU": "goRootUrl",
    "gi": "focusInput",
    "gs": "viewSource",
    "gt": "tabNext",
    "gT": "tabPrev",
    "g0": "tabFirst",
    "g$": "tabLast",
    "yy": "yankUrl",
    "yc": "yankContainingBlock",
    "yf": "hintYank",
    // ビジュアルモード
    "v":  "visualMode",
    "V":  "visualLineMode",
    "<<": "tabMoveLeft",
    ">>": "tabMoveRight",
    "zH": "scrollFullLeft",
    "zL": "scrollFullRight",
    "zz": "toggleVideoAutoAdvance",
  };

  let keyMap = { ...DEFAULT_KEY_MAP };

  // ===== キーマッピングのパース =====
  function parseKeyMappings(text) {
    const map = { ...DEFAULT_KEY_MAP };
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("\"") || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts[0] === "map" && parts.length >= 3) {
        const key = normalizeKey(parts[1]);
        const command = parts[2];
        if (command in COMMAND_MAP) map[key] = command;
      } else if (parts[0] === "unmap" && parts.length >= 2) {
        const key = normalizeKey(parts[1]);
        delete map[key];
      } else if (parts[0] === "unmapAll") {
        Object.keys(map).forEach((k) => delete map[k]);
      }
    }
    return map;
  }

  function normalizeKey(raw) {
    // <c-x> → Ctrl+x などは今後の拡張ポイント。現時点は文字列そのまま
    return raw;
  }

  // ===== 除外サイト判定 =====
  function isExcludedSite() {
    const hostname = window.location.hostname;
    const href = window.location.href;
    return settings.excludedSites
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((pattern) => {
        try {
          // ワイルドカードを正規表現に変換
          const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
          return re.test(hostname) || re.test(href);
        } catch {
          return hostname.includes(pattern) || href.includes(pattern);
        }
      });
  }

  // ===== Link Hints =====
  function generateHintLabels(count) {
    const labels = [];
    let len = 1;
    while (Math.pow(settings.hintChars.length, len) < count) len++;
    function gen(prefix, remaining) {
      if (labels.length >= count) return;
      if (remaining === 0) { labels.push(prefix); return; }
      for (const ch of settings.hintChars) {
        gen(prefix + ch, remaining - 1);
        if (labels.length >= count) return;
      }
    }
    gen("", len);
    return labels.slice(0, count);
  }

  // 要素が rect 内のサンプリング点で実際に最前面に描画されているか判定する
  // DOM/CSS の祖先ツリーではなく document.elementsFromPoint でブラウザの実描画を直接確認するため
  // z-index・transform・任意のポップアップバックドロップ・CSSの書き方に依らず正確に判定できる
  function isTopmostAtPoint(el, rect) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const points = [
      [cx, cy],
      [rect.left + 2, rect.top + 2],
      [rect.right - 2, rect.top + 2],
      [rect.left + 2, rect.bottom - 2],
      [rect.right - 2, rect.bottom - 2],
    ];
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      const stack = document.elementsFromPoint(x, y);
      if (stack.length === 0) continue;
      const top = stack[0];
      // top が el 自身・el の子孫（span 内 a 等）・el の祖先のいずれかなら可視と判定
      if (top === el || el.contains(top) || top.contains(el)) return true;
    }
    return false;
  }

  function getHintableElements() {
    const selector = [
      "a[href]", "button:not([disabled])",
      "input:not([disabled]):not([type=hidden])",
      "select:not([disabled])", "textarea:not([disabled])",
      "[role=button]", "[role=link]", "[role=menuitem]",
      "[role=checkbox]", "[role=tab]", "[onclick]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    return [...document.querySelectorAll(selector)].filter((el) => {
      if (!el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
      // 先祖 overflow クリッピングとビューポートの交差矩形を取得（高コストな elementsFromPoint の前段フィルタ）
      const rect = getEffectiveVisibleRect(el);
      if (rect === null || rect.width < 4 || rect.height < 4) return false;
      // ブラウザ実描画ベースの最前面チェック（z-index・transform・ポップアップ等をすべて包括）
      return isTopmostAtPoint(el, rect);
    });
  }

  function enterHintMode(mode_) {
    hintMode = mode_;
    hintElements = getHintableElements();
    if (hintElements.length === 0) { showHud("No links found"); return; }

    const labels = generateHintLabels(hintElements.length);
    hintOverlay = document.createElement("div");
    hintOverlay.className = "vimium-hint-overlay";

    hintElements.forEach((el, i) => {
      const rect = getEffectiveVisibleRect(el) || el.getBoundingClientRect();
      const hint = document.createElement("div");
      hint.className = "vimium-hint";
      hint.dataset.label = labels[i];
      hint.textContent = labels[i].toUpperCase();
      hint.style.left = `${Math.max(0, rect.left)}px`;
      hint.style.top  = `${Math.max(0, rect.top - 18)}px`;
      hintOverlay.appendChild(hint);
    });

    document.documentElement.appendChild(hintOverlay);
    setMode("hint");
    keyBuffer = "";
    const action = hintMode === "tab" ? "open in new tab" : hintMode === "yank" ? "copy URL" : "follow";
    showHud(`HINT: type label to ${action}`, 0);
  }

  function filterHints(typed) {
    if (!hintOverlay) return null;
    let matched = null;
    hintOverlay.querySelectorAll(".vimium-hint").forEach((hintEl, i) => {
      const label = hintEl.dataset.label;
      if (!label.startsWith(typed)) {
        hintEl.style.display = "none";
      } else if (label === typed) {
        matched = hintElements[i];
      } else {
        hintEl.style.display = "";
        hintEl.innerHTML =
          `<span class="vimium-hint-matched">${label.slice(0, typed.length).toUpperCase()}</span>` +
          label.slice(typed.length).toUpperCase();
      }
    });
    return matched;
  }

  function exitHintMode() {
    hintOverlay?.remove();
    hintOverlay = null;
    hintElements = [];
    setMode("normal");
  }

  function activateHint(el) {
    exitHintMode();
    if (hintMode === "yank") {
      const url = el.href || el.getAttribute("href") || "";
      navigator.clipboard.writeText(url).then(() => showHud(`Copied: ${url}`));
      return;
    }
    if (hintMode === "tab") {
      if (el.href) { chrome.runtime.sendMessage({ type: "TAB_NEW", url: el.href }); }
      else { el.click(); }
      return;
    }
    if (el.tagName === "A" && el.href) {
      const rawHref = el.getAttribute("href") || "";
      if (rawHref === "#" || (rawHref.startsWith("#") && rawHref.length > 0 && !rawHref.includes("/"))) {
        // fragment-only href: el.click() でクリックハンドラを経由させる。
        // ページ側で e.preventDefault() を呼べば navigation が止まる（Amazon carousel など）。
        // window.location.href 直接書き換えではクリックハンドラが発火しないため使わない。
        el.click();
      } else {
        window.location.href = el.href;
      }
    } else { el.click(); el.focus(); }
  }

  // ===== Find Mode =====
  function enterFindMode() {
    setMode("find");
    findBar.classList.add("visible");
    findInput.value = findQuery;
    findInput.focus();
    findInput.select();
  }

  function exitFindMode() {
    findBar.classList.remove("visible");
    findBar.classList.remove("no-match");
    setMode("normal");
  }

  function execFind(query) {
    findQuery = query;
    findMatches = [];
    findIndex = -1;
    clearFindHighlights();

    if (!query) { findCount.textContent = ""; findBar.classList.remove("no-match"); return; }

    const caseSensitive = /[A-Z]/.test(query);
    const flags = caseSensitive ? "g" : "gi";
    let regex;
    try { regex = new RegExp(escapeRegExp(query), flags); } catch { return; }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const ranges = [];
    let node;
    while ((node = walker.nextNode())) {
      if (isHiddenNode(node)) continue;
      const text = node.nodeValue;
      let m;
      regex.lastIndex = 0;
      while ((m = regex.exec(text)) !== null) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        ranges.push(range);
      }
    }

    findMatches = ranges;
    if (ranges.length === 0) {
      findBar.classList.add("no-match");
      findCount.textContent = "0 matches";
      return;
    }

    findBar.classList.remove("no-match");
    highlightFindMatches(ranges);
    findIndex = 0;
    scrollToMatch(0);
    findCount.textContent = `1 / ${ranges.length}`;
  }

  function escapeRegExp(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function isHiddenNode(node) {
    let el = node.parentElement;
    while (el) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return true;
      el = el.parentElement;
    }
    return false;
  }

  let useHighlightAPI = typeof CSS !== "undefined" && !!CSS.highlights;
  let markElements = [];

  function highlightFindMatches(ranges) {
    if (useHighlightAPI) {
      try { CSS.highlights.set("vimium-find-highlight", new Highlight(...ranges)); return; }
      catch { useHighlightAPI = false; }
    }
    markElements = ranges.flatMap((range) => {
      const mark = document.createElement("mark");
      mark.style.cssText = "background:orange;color:black;";
      try { range.surroundContents(mark); return [mark]; }
      catch { return []; }
    });
  }

  function clearFindHighlights() {
    if (useHighlightAPI) {
      CSS.highlights?.delete("vimium-find-highlight");
      CSS.highlights?.delete("vimium-find-current");
    }
    markElements.forEach((m) => {
      const parent = m.parentNode;
      if (parent) { parent.replaceChild(document.createTextNode(m.textContent), m); parent.normalize(); }
    });
    markElements = [];
  }

  function scrollToMatch(index) {
    if (findMatches.length === 0) return;
    const range = findMatches[index];
    range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (useHighlightAPI) {
      try { CSS.highlights.set("vimium-find-current", new Highlight(range)); } catch {}
    }
  }

  function findNext(direction) {
    if (findMatches.length === 0) return;
    findIndex = (findIndex + direction + findMatches.length) % findMatches.length;
    scrollToMatch(findIndex);
    findCount.textContent = `${findIndex + 1} / ${findMatches.length}`;
  }

  // ===== Vomnibar =====
  function enterVomnibar(newTab, tabMode = false) {
    vomnibarNewTab = newTab;
    vomnibarTabMode = tabMode;
    setMode("vomnibar");
    vomnibarBackdrop.classList.add("visible");
    vomnibarBox.classList.add("visible");
    const label = vomnibarBox.querySelector("label");
    if (label) label.textContent = tabMode ? "Tab:" : (newTab ? "Open (new tab):" : "Open:");
    vomnibarInput.value = "";
    vomnibarInput.focus();
    vomnibarSelected = 0;
    loadVomnibarItems("");
  }

  function exitVomnibar() {
    vomnibarBackdrop.classList.remove("visible");
    vomnibarBox.classList.remove("visible");
    clearTimeout(vomnibarDebounceTimer);
    setMode("normal");
  }

  function loadVomnibarItems(query) {
    // タブ切り替えモード: 開いているタブを検索・表示
    if (vomnibarTabMode) {
      chrome.runtime.sendMessage({ type: "GET_TABS" }, (tabs) => {
        if (!tabs) { vomnibarItems = []; renderVomnibarList(); return; }
        const q = query.toLowerCase();
        const filtered = q
          ? tabs.filter((t) =>
              (t.title || "").toLowerCase().includes(q) || (t.url || "").toLowerCase().includes(q))
          : tabs;
        vomnibarItems = filtered.slice(0, settings.vomnibarMaxResults)
          .map((t) => ({ ...t, _isTab: true }));
        renderVomnibarList();
      });
      return;
    }
    // 通常モード: 履歴・ブックマーク
    const results = [];
    let pending = (settings.vomnibarIncludeHistory ? 1 : 0) + (settings.vomnibarIncludeBookmarks ? 1 : 0);
    if (pending === 0) { vomnibarItems = []; renderVomnibarList(); return; }
    function done() {
      pending--;
      if (pending === 0) { vomnibarItems = results.slice(0, settings.vomnibarMaxResults); renderVomnibarList(); }
    }
    if (settings.vomnibarIncludeHistory) {
      chrome.runtime.sendMessage({ type: "GET_HISTORY", query }, (items) => { if (items) results.push(...items); done(); });
    }
    if (settings.vomnibarIncludeBookmarks) {
      chrome.runtime.sendMessage({ type: "GET_BOOKMARKS", query }, (items) => { if (items) results.push(...items); done(); });
    }
  }

  function renderVomnibarList() {
    vomnibarList.innerHTML = "";
    vomnibarItems.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = i === vomnibarSelected ? "selected" : "";
      li.innerHTML = `<span class="item-title">${escapeHtml(item.title || item.url || "")}</span><span class="item-url">${escapeHtml(item.url || "")}</span>`;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); openVomnibarItem(item); });
      vomnibarList.appendChild(li);
    });
  }

  function updateVomnibarSelection(delta) {
    vomnibarSelected = Math.max(0, Math.min(vomnibarItems.length - 1, vomnibarSelected + delta));
    renderVomnibarList();
    vomnibarList.children[vomnibarSelected]?.scrollIntoView({ block: "nearest" });
  }

  function openVomnibarItem(item) {
    // タブ切り替えモード
    if (item?._isTab) {
      exitVomnibar();
      chrome.runtime.sendMessage({ type: "SWITCH_TAB", tabId: item.id });
      return;
    }
    const raw = item?.url || vomnibarInput.value;
    if (!raw) return;
    const url = raw.startsWith("http") ? raw : `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    exitVomnibar();
    if (vomnibarNewTab) { chrome.runtime.sendMessage({ type: "TAB_NEW", url }); }
    else { window.location.href = url; }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ===== Help =====
  function buildHelpContent() {
    const rows = Object.entries(keyMap)
      .map(([key, cmd]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(cmd)}</td></tr>`)
      .join("");
    helpBox.innerHTML = `
      <h2>Vimium Homemade — キーバインド一覧</h2>
      <p style="color:#888;font-size:12px;margin:0 0 12px">Esc / q / ? で閉じる</p>
      <table><thead><tr><th>キー</th><th>コマンド</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function enterHelp() {
    buildHelpContent();
    setMode("help");
    helpBackdrop.classList.add("visible");
    helpBox.classList.add("visible");
  }

  function exitHelp() {
    helpBackdrop.classList.remove("visible");
    helpBox.classList.remove("visible");
    setMode("normal");
  }

  // ===== URL操作 =====
  function navigateUpUrl() {
    const url = new URL(window.location.href);
    const parts = url.pathname.replace(/\/$/, "").split("/");
    parts.pop();
    url.pathname = parts.join("/") + "/";
    url.search = "";
    url.hash = "";
    window.location.href = url.toString();
  }

  function navigateRootUrl() {
    window.location.href = new URL(window.location.href).origin + "/";
  }

  function focusFirstInput() {
    const el = document.querySelector("input:not([type=hidden]):not([disabled]), textarea:not([disabled])");
    el?.focus();
  }

  // ===== 入力判定 =====
  // テキストを受け付ける input type のみブロック対象とする
  // type="submit" / "button" / "checkbox" 等はボタンなのでスクロールを妨げない
  const TEXT_INPUT_TYPES = new Set([
    "text", "search", "email", "url", "password", "number", "tel",
    "date", "time", "datetime-local", "month", "week",
  ]);

  function isTypingContext() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") return TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
    if (el.isContentEditable) return true;
    return false;
  }

  function claimEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // ===== キー処理：Normal Mode =====
  function handleNormalKey(key, event) {
    // 数字カウントプレフィックス
    if (/^[1-9]$/.test(key) && keyBuffer === "") {
      keyBuffer += key;
      clearTimeout(keyBufferTimer);
      keyBufferTimer = setTimeout(() => { keyBuffer = ""; }, 1500);
      return;
    }
    if (/^[0-9]$/.test(key) && keyBuffer !== "" && /^[0-9]+$/.test(keyBuffer)) {
      keyBuffer += key;
      return;
    }

    const count = parseInt(keyBuffer) || 1;
    const prefix = keyBuffer.replace(/^[0-9]*/, ""); // 数字を除いたバッファ
    const candidate2 = prefix + key; // 2ストローク候補

    // 2ストローク完成チェック
    if (prefix && keyMap[candidate2]) {
      clearTimeout(keyBufferTimer);
      keyBuffer = "";
      claimEvent(event);
      COMMAND_MAP[keyMap[candidate2]]?.(count);
      return;
    }

    // プレフィックス待機中（gやyなど）
    if (prefix) {
      // どのキーマップとも一致しない → バッファクリア
      clearTimeout(keyBufferTimer);
      keyBuffer = "";
      return;
    }

    // 2ストロークのプレフィックスになりうるか確認
    const isPrefix = Object.keys(keyMap).some((k) => k.length === 2 && k[0] === key);
    if (isPrefix) {
      claimEvent(event);
      keyBuffer = key;
      clearTimeout(keyBufferTimer);
      keyBufferTimer = setTimeout(() => { keyBuffer = ""; }, 1500);
      return;
    }

    // 1ストロークコマンド
    const command = keyMap[key];
    if (command) {
      claimEvent(event);
      COMMAND_MAP[command]?.(count);
    }
    keyBuffer = "";
    clearTimeout(keyBufferTimer);
  }

  // ===== Visual Mode =====

  // yc コマンド用: semantic block を検索する（div/body/html は対象外）
  const BLOCK_TAGS = new Set([
    "p", "li", "td", "th", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "figcaption", "summary",
  ]);

  function findBlockAncestor(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && !BLOCK_TAGS.has(el.tagName?.toLowerCase())) {
      el = el.parentElement;
    }
    return el; // div / body / html 等の場合は null
  }

  // submode: "char" | "line"
  // initialRange: Selection の初期 Range（省略時は現在の find match を使用）
  function enterVisualMode(submode, initialRange = null) {
    const sel = window.getSelection();
    const range = initialRange
      || (findMatches.length > 0 && findIndex >= 0 ? findMatches[findIndex] : null);

    if (range) {
      sel.removeAllRanges();
      sel.addRange(range.cloneRange());
    }

    if (submode === "line") {
      if (sel.rangeCount) {
        // カーソル行全体を選択
        sel.modify("move",   "backward", "lineboundary");
        sel.modify("extend", "forward",  "lineboundary");
      }
      setMode("visualLine");
      showHud("-- VISUAL LINE -- (y: copy, v: char mode, Esc: cancel)", 0);
    } else {
      setMode("visual");
      showHud("-- VISUAL -- (y: copy, V: line mode, Esc: cancel)", 0);
    }
  }

  // yc: / 検索後に押すと、マッチを含む semantic block をコピー
  //     div の場合はビジュアルモードへ移行
  function yankContainingBlock() {
    if (findMatches.length === 0 || findIndex < 0) {
      showHud("先に / で検索してください");
      return;
    }
    const range  = findMatches[findIndex];
    const block  = findBlockAncestor(range.startContainer);

    if (block) {
      const text = (block.innerText || block.textContent || "").trim();
      navigator.clipboard.writeText(text).then(() =>
        showHud(`Copied (${text.length}): "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`)
      );
    } else {
      // div 等: マッチ箇所を選択した状態でビジュアルモードへ
      enterVisualMode("char", range);
    }
  }

  // ビジュアルモードのキーハンドラ
  // Selection.modify() で選択を拡張: h/l(char), w/b(word), j/k(line), $/$0(lineboundary)
  function handleVisualKey(key) {
    const sel    = window.getSelection();
    const isLine = mode === "visualLine";

    switch (key) {
      case "h": sel.modify("extend", "backward", "character");      break;
      case "l": sel.modify("extend", "forward",  "character");      break;
      case "b": sel.modify("extend", "backward", "word");           break;
      case "w": sel.modify("extend", "forward",  "word");           break;
      case "k": sel.modify("extend", "backward", "line");           break;
      case "j": sel.modify("extend", "forward",  "line");           break;
      case "0": sel.modify("extend", "backward", "lineboundary");   break;
      case "$": sel.modify("extend", "forward",  "lineboundary");   break;
      case "G": sel.modify("extend", "forward",  "documentboundary"); break;
      // v/V でサブモード切替
      case "v":
        if (isLine) { setMode("visual");     showHud("-- VISUAL -- (y: copy, V: line mode, Esc: cancel)", 0); }
        else        { setMode("visualLine"); showHud("-- VISUAL LINE -- (y: copy, v: char mode, Esc: cancel)", 0); }
        break;
      case "V":
        if (!isLine) { setMode("visualLine"); showHud("-- VISUAL LINE -- (y: copy, v: char mode, Esc: cancel)", 0); }
        break;
      case "y": {
        const text = sel.toString();
        sel.removeAllRanges();
        setMode("normal");
        if (text) navigator.clipboard.writeText(text).then(() =>
          showHud(`Copied (${text.length}): "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`)
        );
        break;
      }
      case "Escape":
        sel.removeAllRanges();
        setMode("normal");
        break;
    }
  }

  // ===== キー処理：Hint Mode =====
  function handleHintKey(key) {
    if (key === "Escape") { exitHintMode(); return; }
    if (key === "Backspace") {
      keyBuffer = keyBuffer.slice(0, -1);
      hintOverlay?.querySelectorAll(".vimium-hint").forEach((el) => {
        el.style.display = "";
        el.textContent = el.dataset.label.toUpperCase();
      });
      if (keyBuffer) filterHints(keyBuffer);
      return;
    }
    if (settings.hintChars.includes(key.toLowerCase())) {
      keyBuffer += key.toLowerCase();
      const matched = filterHints(keyBuffer);
      if (matched) activateHint(matched);
    }
  }

  // ===== イベントリスナー =====
  vomnibarInput.addEventListener("input", () => {
    clearTimeout(vomnibarDebounceTimer);
    vomnibarSelected = 0;
    vomnibarDebounceTimer = setTimeout(() => loadVomnibarItems(vomnibarInput.value), 200);
  });

  vomnibarInput.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "Escape": exitVomnibar(); e.preventDefault(); break;
      case "ArrowDown": case "Tab": updateVomnibarSelection(1); e.preventDefault(); break;
      case "ArrowUp": updateVomnibarSelection(-1); e.preventDefault(); break;
      case "Enter": openVomnibarItem(vomnibarItems[vomnibarSelected]); e.preventDefault(); break;
    }
  });

  vomnibarBackdrop.addEventListener("mousedown", () => exitVomnibar());

  findInput.addEventListener("input", () => execFind(findInput.value));
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { findNext(e.shiftKey ? -1 : 1); e.preventDefault(); }
    else if (e.key === "Escape") { exitFindMode(); }
  });

  helpBackdrop.addEventListener("mousedown", () => exitHelp());

  // ===== メインキーハンドラ =====
  window.addEventListener("keydown", (event) => {
    if (event.key === "F5") return; // ブラウザリロードは常に許可
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;

    const key = event.key;

    switch (mode) {
      case "insert":
        if (key === "Escape") { setMode("normal"); document.activeElement?.blur(); showHud("-- NORMAL --"); }
        return;
      case "hint":
        claimEvent(event);
        handleHintKey(key);
        return;
      case "find": case "vomnibar":
        return;
      case "help":
        if (key === "Escape" || key === "?" || key === "q") exitHelp();
        return;
      case "visual":
      case "visualLine":
        claimEvent(event);
        handleVisualKey(key);
        return;
      default: {
        // テキスト入力中（input/textarea/select/contenteditable）のみブロック
        // ボタン・リンク等のフォーカスはスクロールを妨げない
        if (isTypingContext()) {
          if (key === "Escape") document.activeElement?.blur();
          return;
        }
        if (key === "Escape") {
          keyBuffer = "";
          clearTimeout(keyBufferTimer);
          clearFindHighlights();
          findMatches = [];
          return;
        }

        // スクロールキー: CoreScroller に通知してネイティブリピートを抑制
        // repeat 中は myKeyIsStillDown() が true を返し、既存アニメーターが継続する
        const prePrefix = keyBuffer.replace(/^[0-9]*/, "");
        const isDirectScrollKey = prePrefix === "" && SCROLL_COMMANDS.has(keyMap[key]);
        if (isDirectScrollKey) CoreScroller.onKeydown(event);
        if (event.repeat && isDirectScrollKey) {
          event.preventDefault();
          return;
        }

        handleNormalKey(key, event);
        break;
      }
    }
  }, true);

  window.addEventListener("keyup", (event) => {
    CoreScroller.onKeyup(event);
  }, true);

  // ===== 設定読み込みと初期化 =====
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    settings = { ...DEFAULT_SETTINGS, ...items };
    keyMap = settings.keyMappings ? parseKeyMappings(settings.keyMappings) : { ...DEFAULT_KEY_MAP };

    if (isExcludedSite()) return; // 除外サイトでは何もしない
  });

  // 設定変更をリアルタイム反映
  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
    keyMap = settings.keyMappings ? parseKeyMappings(settings.keyMappings) : { ...DEFAULT_KEY_MAP };
  });

})();
