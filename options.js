// options.js

const DEFAULT_SETTINGS = {
  scrollStep: 60,
  smoothScroll: true,
  halfPageRatio: 0.45,
  repeatDelay: 150,
  repeatInterval: 40,
  hintChars: "asdfghjklqwertyuiopzxcvbnm",
  vomnibarMaxResults: 30,
  vomnibarIncludeHistory: true,
  vomnibarIncludeBookmarks: true,
  hudTimeout: 1500,
  keyMappings: "",
  excludedSites: "",
  // グリッドクリック
  gridBgAlpha:       7,
  gridLineColor:     "#a0a0a0",
  gridLineAlpha:     40,
  gridLabelColor:    "#c8c8c8",
  gridHlBgColor:     "#b4b4b4",
  gridHlBgAlpha:     18,
  gridHlLabelColor:  "#d2d2d2",
  gridFontSize:      13,
  gridHlFontSize:    16,
  gridCellSize:      50,
};

// ===== 要素参照 =====
const els = {
  scrollStep:         document.getElementById("scroll-step"),
  scrollStepVal:      document.getElementById("scroll-step-val"),
  halfPageRatio:      document.getElementById("half-page-ratio"),
  halfPageRatioVal:   document.getElementById("half-page-ratio-val"),
  smoothScroll:       document.getElementById("smooth-scroll"),
  smoothScrollLabel:  document.getElementById("smooth-scroll-label"),
  repeatDelay:        document.getElementById("repeat-delay"),
  repeatDelayVal:     document.getElementById("repeat-delay-val"),
  repeatInterval:     document.getElementById("repeat-interval"),
  repeatIntervalVal:  document.getElementById("repeat-interval-val"),
  hintChars:          document.getElementById("hint-chars"),
  hintCharsError:     document.getElementById("hint-chars-error"),
  vomnibarMax:        document.getElementById("vomnibar-max"),
  vomnibarMaxVal:     document.getElementById("vomnibar-max-val"),
  vomnibarHistory:    document.getElementById("vomnibar-history"),
  vomnibarHistoryLbl: document.getElementById("vomnibar-history-label"),
  vomnibarBookmarks:  document.getElementById("vomnibar-bookmarks"),
  vomnibarBookLbl:    document.getElementById("vomnibar-bookmarks-label"),
  hudTimeout:         document.getElementById("hud-timeout"),
  hudTimeoutVal:      document.getElementById("hud-timeout-val"),
  keyMappings:        document.getElementById("key-mappings"),
  excludedSites:      document.getElementById("excluded-sites"),
  // グリッドクリック
  gridBgAlpha:        document.getElementById("grid-bg-alpha"),
  gridBgAlphaVal:     document.getElementById("grid-bg-alpha-val"),
  gridLineColor:      document.getElementById("grid-line-color"),
  gridLineAlpha:      document.getElementById("grid-line-alpha"),
  gridLineAlphaVal:   document.getElementById("grid-line-alpha-val"),
  gridLabelColor:     document.getElementById("grid-label-color"),
  gridHlBgColor:      document.getElementById("grid-hl-bg-color"),
  gridHlBgAlpha:      document.getElementById("grid-hl-bg-alpha"),
  gridHlBgAlphaVal:   document.getElementById("grid-hl-bg-alpha-val"),
  gridHlLabelColor:   document.getElementById("grid-hl-label-color"),
  gridFontSize:       document.getElementById("grid-font-size"),
  gridFontSizeVal:    document.getElementById("grid-font-size-val"),
  gridHlFontSize:     document.getElementById("grid-hl-font-size"),
  gridHlFontSizeVal:  document.getElementById("grid-hl-font-size-val"),
  gridCellSize:       document.getElementById("grid-cell-size"),
  gridCellSizeVal:    document.getElementById("grid-cell-size-val"),
  btnSave:            document.getElementById("btn-save"),
  btnDiscard:         document.getElementById("btn-discard"),
  btnReset:           document.getElementById("btn-reset"),
  status:             document.getElementById("status"),
};

// ===== スライダー同期ヘルパー =====
function bindSlider(sliderEl, labelEl, format) {
  const update = () => { labelEl.textContent = format(sliderEl.value); };
  sliderEl.addEventListener("input", update);
  return update;
}

const syncFns = [
  bindSlider(els.scrollStep,    els.scrollStepVal,    v => `${v} px`),
  bindSlider(els.halfPageRatio, els.halfPageRatioVal,  v => `${v} %`),
  bindSlider(els.repeatDelay,   els.repeatDelayVal,    v => `${v} ms`),
  bindSlider(els.repeatInterval,els.repeatIntervalVal, v => `${v} ms`),
  bindSlider(els.vomnibarMax,   els.vomnibarMaxVal,    v => `${v} 件`),
  bindSlider(els.hudTimeout,    els.hudTimeoutVal,     v => `${v} ms`),
  bindSlider(els.gridBgAlpha,    els.gridBgAlphaVal,    v => `${v} %`),
  bindSlider(els.gridLineAlpha,  els.gridLineAlphaVal,  v => `${v} %`),
  bindSlider(els.gridHlBgAlpha,  els.gridHlBgAlphaVal,  v => `${v} %`),
  bindSlider(els.gridFontSize,   els.gridFontSizeVal,   v => `${v} px`),
  bindSlider(els.gridHlFontSize, els.gridHlFontSizeVal, v => `${v} px`),
  bindSlider(els.gridCellSize,   els.gridCellSizeVal,   v => `${v} px`),
];

// ===== トグルラベル同期 =====
function bindToggle(checkEl, labelEl) {
  const update = () => { labelEl.textContent = checkEl.checked ? "ON" : "OFF"; };
  checkEl.addEventListener("change", update);
  return update;
}

const toggleSyncFns = [
  bindToggle(els.smoothScroll,    els.smoothScrollLabel),
  bindToggle(els.vomnibarHistory, els.vomnibarHistoryLbl),
  bindToggle(els.vomnibarBookmarks, els.vomnibarBookLbl),
];

// ===== バリデーション =====
function validateHintChars(value) {
  if (value.length < 2) return "2文字以上必要です";
  if (new Set(value).size !== value.length) return "重複する文字があります";
  return null;
}

els.hintChars.addEventListener("input", () => {
  const err = validateHintChars(els.hintChars.value);
  if (err) {
    els.hintCharsError.textContent = err;
    els.hintCharsError.style.display = "block";
    els.hintChars.classList.add("invalid");
  } else {
    els.hintCharsError.style.display = "none";
    els.hintChars.classList.remove("invalid");
  }
});

// ===== UI → 設定オブジェクトに変換 =====
function readFromUI() {
  return {
    scrollStep:              parseInt(els.scrollStep.value, 10),
    smoothScroll:            els.smoothScroll.checked,
    halfPageRatio:           parseInt(els.halfPageRatio.value, 10) / 100,
    repeatDelay:             parseInt(els.repeatDelay.value, 10),
    repeatInterval:          parseInt(els.repeatInterval.value, 10),
    hintChars:               els.hintChars.value.trim() || DEFAULT_SETTINGS.hintChars,
    vomnibarMaxResults:      parseInt(els.vomnibarMax.value, 10),
    vomnibarIncludeHistory:  els.vomnibarHistory.checked,
    vomnibarIncludeBookmarks:els.vomnibarBookmarks.checked,
    hudTimeout:              parseInt(els.hudTimeout.value, 10),
    keyMappings:             els.keyMappings.value.trim(),
    excludedSites:           els.excludedSites.value.trim(),
    gridBgAlpha:             parseInt(els.gridBgAlpha.value, 10),
    gridLineColor:           els.gridLineColor.value,
    gridLineAlpha:           parseInt(els.gridLineAlpha.value, 10),
    gridLabelColor:          els.gridLabelColor.value,
    gridHlBgColor:           els.gridHlBgColor.value,
    gridHlBgAlpha:           parseInt(els.gridHlBgAlpha.value, 10),
    gridHlLabelColor:        els.gridHlLabelColor.value,
    gridFontSize:            parseInt(els.gridFontSize.value, 10),
    gridHlFontSize:          parseInt(els.gridHlFontSize.value, 10),
    gridCellSize:            parseInt(els.gridCellSize.value, 10),
  };
}

// ===== 設定オブジェクト → UI に反映 =====
function applyToUI(s) {
  els.scrollStep.value        = s.scrollStep;
  els.halfPageRatio.value     = Math.round(s.halfPageRatio * 100);
  els.smoothScroll.checked    = s.smoothScroll;
  els.repeatDelay.value       = s.repeatDelay;
  els.repeatInterval.value    = s.repeatInterval;
  els.hintChars.value         = s.hintChars;
  els.vomnibarMax.value       = s.vomnibarMaxResults;
  els.vomnibarHistory.checked    = s.vomnibarIncludeHistory;
  els.vomnibarBookmarks.checked  = s.vomnibarIncludeBookmarks;
  els.hudTimeout.value        = s.hudTimeout;
  els.keyMappings.value       = s.keyMappings;
  els.excludedSites.value     = s.excludedSites;
  els.gridBgAlpha.value       = s.gridBgAlpha;
  els.gridLineColor.value     = s.gridLineColor;
  els.gridLineAlpha.value     = s.gridLineAlpha;
  els.gridLabelColor.value    = s.gridLabelColor;
  els.gridHlBgColor.value     = s.gridHlBgColor;
  els.gridHlBgAlpha.value     = s.gridHlBgAlpha;
  els.gridHlLabelColor.value  = s.gridHlLabelColor;
  els.gridFontSize.value      = s.gridFontSize;
  els.gridHlFontSize.value    = s.gridHlFontSize;
  els.gridCellSize.value      = s.gridCellSize;

  // ラベル・バッジを全て更新
  syncFns.forEach(fn => fn());
  toggleSyncFns.forEach(fn => fn());
}

// ===== ステータス表示 =====
let statusTimer = null;
function showStatus(msg, color = "var(--green)") {
  els.status.textContent = `✓ ${msg}`;
  els.status.style.color = color;
  els.status.classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.status.classList.remove("visible"), 2500);
}

// ===== 保存 =====
els.btnSave.addEventListener("click", () => {
  const hintErr = validateHintChars(els.hintChars.value);
  if (hintErr) {
    els.hintCharsError.textContent = hintErr;
    els.hintCharsError.style.display = "block";
    els.hintChars.classList.add("invalid");
    els.hintChars.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const values = readFromUI();
  chrome.storage.sync.set(values, () => {
    showStatus("保存しました");
  });
});

// ===== 変更を破棄 =====
els.btnDiscard.addEventListener("click", () => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    applyToUI({ ...DEFAULT_SETTINGS, ...items });
    showStatus("変更を破棄しました");
  });
});

// ===== リセット =====
els.btnReset.addEventListener("click", () => {
  if (!confirm("すべての設定をデフォルトに戻しますか？この操作は取り消せません。")) return;
  chrome.storage.sync.set(DEFAULT_SETTINGS, () => {
    applyToUI(DEFAULT_SETTINGS);
    showStatus("デフォルトに戻しました");
  });
});

// ===== 初期ロード =====
chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
  applyToUI({ ...DEFAULT_SETTINGS, ...items });
});
