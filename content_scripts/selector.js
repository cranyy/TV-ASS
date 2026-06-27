// selectors updated for TradingView Jan 2026 UI changes
const selStatus = {
  isNewVersion: true,
  userDoNotHaveDeepBacktest: null
}


const SEL = {
  // Jun 2026 TV UI stripped data-name off the chart legend; use hashed-class prefixes
  tvLegendIndicatorItem: 'div[class^="legend-"] div[class^="sourcesWrapper-"] div[class^="sources-"] div[class*="item-"][class*="study-"]',
  tvLegendIndicatorItemTitle: 'div[class*="titleWrapper-"][class*="mainTitle-"] [class*="title-"]',
  // Jun 2026 TV UI: locate the active backtested strategy's legend row + its Settings gear
  legendActiveStrategyMarker: '[title="Active strategy"]',
  legendItemSettingsButton: 'button[aria-label="Settings"]',
  tvDialogRoot: '#overlap-manager-root',
  indicatorTitle: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="container"] div[class^="title"]',
  tabInput: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#inputs',
  tabInputActive: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#inputs[class*="selected"]',
  tabProperties: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#properties',
  // tabPropertiesActive for Properties-tab detection
  tabPropertiesActive: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#properties[class*="selected"]',
  // ticker changed from div to span for Jan 2026 TV UI (used by tv.dialogHandler)
  ticker: '#header-toolbar-symbol-search > span',
  timeFrame: '#header-toolbar-intervals div[data-role^="button"]',
  timeFrameActive: '#header-toolbar-intervals div[data-role^="button"][class*="isActive"]',
  indicatorScroll: 'div[data-name="indicator-properties-dialog"] div[class^="scrollable-"]',
  indicatorProperty: 'div[data-name="indicator-properties-dialog"] div[class^="content-"] div[class^="cell-"]',
  okBtn: 'div[data-name="indicator-properties-dialog"] div[class^="footer-"] button[name="submit"]',
  // Jun 2026 TV UI removed the dialog header close; use the footer Cancel button (closes without saving)
  cancelBtn: 'div[data-name="indicator-properties-dialog"] div[class^="footer-"] button[name="cancel"]',
  strategyTesterTab: '[data-name="backtesting"]', // 2023-10-19 #footer-chart-panel  or #bottom-area
  strategyTesterTabActive: '[data-name="backtesting"][data-active="true"]', // 2023-10-19 #footer-chart-panel  or #bottom-area
  // "backtesting report panel is already open" signal for Jun 2026 TV UI (the [data-name="backtesting"] tab selectors above are stale); openStrategyTab uses this to skip the stale ~10s tab-activation
  strategyReportContainer: '#bottom-area [class^="reportContainer-"]',
  // bottom-panel show/hide toggle. aria-label is "Open panel" when the Strategy Tester panel is collapsed and "Collapse panel" when open. Used by tv._ensureReportPanelOpen to expand a user-collapsed panel before reading the report (collapsed => report DOM not rendered => every settle times out).
  bottomPanelToggle: '[data-name="toggle-visibility-button"]',
  strategyCaption: '#bottom-area [class^="strategyGroup"] [data-strategy-title]',
  strategyMenuItemSettings: '[role="menu"] [role="menuitem"][aria-label^="Settings"]',
  strategyDialogParam: '#bottom-area div[class^="backtesting"] [class^="strategyGroup"] > div:nth-child(2) > button:nth-child(1)',

  // unified metrics tab selectors (Jan 2026 TV UI)
  metricsTab: '[id="Strategy report"]',
  metricsTabActive: '[id="Strategy report"][class*="selected"]',
  tradesTab: '[id="List of Trades"]',
  tradesTabActive: '[id="List of Trades"][class*="selected"]',

  goproPopupCloseButton: '[data-dialog-name="gopro"][class^="dialog"] button[class*="close"]',

  // data-qa-id based metric group selectors
  metricPerformanceGroup: '[data-qa-id="Performance-button"]',
  metricPerformanceGroupExpanded: '[data-qa-id="Performance-button"][aria-expanded="true"]',
  metricTradeAnalysisGroup: '[data-qa-id="Trades analysis-button"]',
  metricTradeAnalysisGroupExpanded: '[data-qa-id="Trades analysis-button"][aria-expanded="true"]',
  metricCapitalEfficiencyGroup: '[data-qa-id="Capital efficiency-button"]',
  metricCapitalEfficiencyGroupExpanded: '[data-qa-id="Capital efficiency-button"][aria-expanded="true"]',
  metricRunUpsGroup: '[data-qa-id="Run-ups and drawdowns-button"]',
  metricRunUpsGroupExpanded: '[data-qa-id="Run-ups and drawdowns-button"][aria-expanded="true"]',

  // data-qa-id based metric table selectors
  metricPerformanceReturnsTable: '[data-qa-id="returns-summary-table"]',
  metricBenchmarkingTable: '[data-qa-id="benchmarking-table"]',
  metricRatiosTable: '[data-qa-id="ratios-table"]',
  metricTradeAnalysisTable: '[data-qa-id="trades-analysis-table"]',
  metricCapitalEfficiencyTable: '[data-qa-id="capital-efficiency-table"]',
  metricMarginEfficiencyTable: '[data-qa-id="margin-efficiency-table"]',
  metricRunUpsTable: '[data-qa-id="run-ups-table"]',
  metricDrawdownsTable: '[data-qa-id="drawdowns-table"]',
  metricsValueCell: '[class^="reportContainer-"] [class^="containerCell"]',

  reportSectionRoot: '[class^="backtestingReport"]',
  metricSectionSubTab: '[class^="backtestingReport"] button[id][aria-selected]',
  metricSectionTable: '[class^="backtestingReport"] table',

  // Legacy performance tab selectors (kept for backwards compatibility)
  get strategyPerformanceTab() {
    return selStatus.isNewVersion ? '[id="Performance"]' : '[id="Performance Summary"]'
  },
  get strategyPerformanceTabActive() {
    return selStatus.isNewVersion ? '[id="Performance"][class*="selected"]' : '[id="Performance Summary"][class*="selected"]'
  },
  get strategyTradeAnalysisTab() {
    return selStatus.isNewVersion ? '[id="Trades Analysis"]' : '[id="Trade Analysis"]'
  },
  get strategyTradeAnalysisTabActive() {
    return selStatus.isNewVersion ? '[id="Trades Analysis"][class*="selected"]' : '[id="Trade Analysis"][class*="selected"]'
  },
  get strategyRatiosTab() {
    return selStatus.isNewVersion ? '[id="Ratios"]' : '[id="Ratios"]'
  },
  get strategyRatiosTabActive() {
    return selStatus.isNewVersion ? '[id="Ratios"][class*="selected"]' : '[id="Ratios"][class*="selected"]'
  },
  get strategyReportObserveArea() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="wrapper-"]' :
      '#bottom-area div[class^="backtesting"] div[class^="widgetContainer"]'
  },
  // broadened snackbar selectors to match loading/updating variants
  get strategyReportInProcess() {
    return selStatus.isNewVersion ?
      '[id="snackbar-container"] [data-qa-id*="backtesting"][data-qa-id*="loading-report-snackbar"], [id="snackbar-container"] [data-qa-id*="backtesting"][data-qa-id*="updating-report-snackbar"]' :
      '#bottom-area div[class^="backtesting"] div[class^="widgetContainer"]  div[role="progressbar"]'
  },
  get strategyReportReady() {
    return selStatus.isNewVersion ?
      '[id="snackbar-container"] [data-qa-id*="backtesting"][data-qa-id*="success-report-snackbar"], [id="snackbar-container"] [data-qa-id*="backtesting"][data-qa-id*="updated-report-snackbar"]' :
      '#bottom-area div[class^="backtesting"] div[class^="widgetContainer"] div[class^="reportContainer"] [class*="root"]'
  },
  get strategyReportUpdate() {
    return selStatus.isNewVersion ?
      '[id="snackbar-container"] [data-qa-id*="backtesting"][data-qa-id*="updated-report-snackbar"] button' :
      '#bottom-area div[class^="backtesting"] div[class^="widgetContainer"] div[class^="reportContainer"] [class*="root"]'
  },
  // strategyReportTransitionReady: '#bottom-area div.backtesting-content-wrapper > div:not(.opacity-transition).reports-content',
  // strategyReportError selector for the new TV UI
  get strategyReportError() {
    return selStatus.isNewVersion ?
      '#bottom-area div[class*="backtesting"] div[class^="wrapper-"] [class*=emptyStateIcon]' :
      '#bottom-area div[class^="backtesting"] div[class^="container"] [class*=emptyStateIcon]'
  },
  // base selectors for table parsing in the new UI
  strategyReportHeaderBase: 'div[class^="wrapper-"] div[class^="ka root"] table thead > tr > th',
  strategyReportRowBase: 'div[class^="wrapper-"] div[class^="ka root"] table tbody > tr',

  get strategyReportHeader() {
    return selStatus.isNewVersion ?
      '#bottom-area div[class*="backtesting"] div[class^="wrapper-"] div[class^="ka root"] table thead > tr > th' :
      '#bottom-area div[class^="backtesting"] div[class^="widgetContainer"] div[class^="reportContainer"] table thead > tr > th'
  },
  get strategyReportRow() {
    return selStatus.isNewVersion ?
      '#bottom-area div[class*="backtesting"] div[class^="wrapper-"] div[class^="ka root"] table tbody > tr' :
      '#bottom-area div[class^="backtesting"] div[class^="widgetContainer"] div[class^="reportContainer"] table tbody > tr'
  },

  // fallback selectors for .ka-table-wrapper (when data-qa-id tables are missing)
  strategyReportTableFallback: '#bottom-area .ka-table-wrapper table, #bottom-area [class*="tableWrapper"] table',
  strategyReportHeaderFallback: '#bottom-area .ka-table-wrapper table thead > tr > th, #bottom-area [class*="tableWrapper"] table thead > tr > th',
  strategyReportRowFallback: '#bottom-area .ka-table-wrapper table tbody > tr, #bottom-area [class*="tableWrapper"] table tbody > tr',

  get strategyDeepTestCheckbox() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"] [class^="switchGroup"] [class^="switcher"] input' :
      '#bottom-area div[class^="backtesting"]  [class^="deepHistoryContainer"]  [class^="switcher"] input'
  },
    get strategyDeepTestCheckboxUnchecked() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"] [class^="switchGroup"] [class^="switcher"] input:not([aria-checked="true"])' :
      '#bottom-area div[class^="backtesting"]  [class^="deepHistoryContainer"]  [class^="switcher"] input'
  },
  get strategyDeepTestCheckboxChecked() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"] [class^="switchGroup"] [class^="switcher"] input[aria-checked="true"]' :
      '#bottom-area div[class^="backtesting"]  [class^="deepHistoryContainer"]  [class^="switcher"] input'
  },
  get strategyDeepTestStartDate() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"] [class^="historyParams"] [class^="container"] div:nth-child(1) [class^="pickerInput"] input' :
      '#bottom-area div[class^="backtesting"]  [class^="historyParams"]  [class^="container" ]> div:nth-child(1) div[class^="pickerInput"] input'
  },
  get strategyDeepTestGenerateBtn() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"] [class^="historyParams"] button[class^="generateReportBtn"]:not([aria-disabled="true"])' :
      '#bottom-area div[class^="backtesting"]  [class^="historyParams"] button[class^="generateReportBtn"]:not([disabled])'
  },
  get strategyDeepTestGenerateBtnDisabled() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"] [class^="historyParams"] button[class^="generateReportBtn"][aria-disabled="true"]' :
      '#bottom-area div[class^="backtesting"]  [class^="historyParams"] button[class^="generateReportBtn"][disabled]'
  },
  get strategyReportDeepTestObserveArea() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"]' :
      '#bottom-area div[class^="backtesting"] div[class^="backtesting-content-wrapper"]'
  },
  get strategyReportDeepTestInProcess() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="deepHistory-"] div[role="progressbar"]' :
      '#bottom-area div[class^="backtesting"] div[class^="backtesting-content-wrapper"] div[role="progressbar"]'
  },
  get strategyReportDeepTestReady() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="wrapper-"] div[class^="ka root"]' :
      '#bottom-area div[class^="backtesting"] div[class^="backtesting-content-wrapper"] div[class^="reportContainer"] [class*="root"]'
  },
  get strategyReportDeepTestHeader() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="wrapper-"] div[class^="ka root"] table thead > tr > th' :
      '#bottom-area div[class^="backtesting"] div[class^="backtesting-content-wrapper"] div[class^="reportContainer"] table thead > tr > th'
  },
  get strategyReportDeepTestRow() {
    return selStatus.isNewVersion ?
      '.bottom-widgetbar-content.backtesting div[class^="wrapper-"] div[class^="ka root"] table tbody > tr' :
      '#bottom-area  div[class^="backtesting"] div[class^="backtesting-content-wrapper"] div[class^="reportContainer"] table tbody > tr'
  },

  strategyTabPeriodDD: '[class^="dateRangeMenuWrapper"] button',
  strategyTabPeriodEntyreHistory: '[class^="eventWrapper"] [role="group"] > div:nth-child(5) > div[aria-checked="true"]',

  // Jun-2026 TV UI Strategy-dialog Style & Visibility tabs: button#style + button#visibilities (note 'visibilities', NOT 'visibility'), each role="tab" inside [class^="tab"]; the active tab carries a class containing "selected" (same pattern as tabInputActive). The control cells live under the same div[class^="content-"] div[class^="cell-"] container the Inputs/Properties scrapers use (SEL.indicatorProperty).
  tabStyle: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#style',
  tabStyleActive: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#style[class*="selected"]',
  tabVisibilities: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#visibilities',
  tabVisibilitiesActive: '#overlap-manager-root div[data-name="indicator-properties-dialog"] [class^="tab"] button#visibilities[class*="selected"]',
  // Style swatch color carrier: the swatch button's inner div[class*="swatch-"] backgroundColor is the rgba color+alpha (live: rgba(5, 255, 155, 0)). Read-only capture only.
  styleSwatchColor: 'div[class*="swatch-"]',

  // Jun-2026 symbol-search dialog (for the new ticker setter): #header-toolbar-symbol-search opens [data-name="symbol-search-items-dialog"] with input[placeholder="Symbol, ISIN, or CUSIP"] prefilled, and result rows [data-name="symbol-search-dialog-content-item"] whose text includes EXCHANGE:SYMBOL. Escape dispatched on the input closes it.
  symbolSearchButton: '#header-toolbar-symbol-search',
  symbolSearchDialog: '[data-name="symbol-search-items-dialog"]',
  symbolSearchInput: '[data-name="symbol-search-items-dialog"] input',
  symbolSearchItem: '[data-name="symbol-search-dialog-content-item"]',

  // chart LAYOUT switch (capture name + restore-FIRST): active name in #header-toolbar-save-load [class*="textWrap-"] span:first-child; the "Manage layouts" caret button[data-name="save-load-menu"] opens the menu; recently-used rows [data-qa-id="save-load-menu-item-recent"] (row text = layout name); "Open layout…" row [data-qa-id="save-load-menu-item-load"] opens [data-name="load-layout-dialog"] listing all layouts as [data-name="load-chart-dialog-item"] rows + input[placeholder="Search"]. Toolbar name flips instantly; chart content load is slow (~1min) and is handled by tv._waitLayoutSettled. Load only — restore never calls Save/Autosave.
  layoutToolbarName: '#header-toolbar-save-load [class*="textWrap-"] span:first-child',
  layoutMenuButton: 'button[data-name="save-load-menu"]',
  layoutMenuRecentItem: '[data-qa-id="save-load-menu-item-recent"]',
  layoutMenuLoadItem: '[data-qa-id="save-load-menu-item-load"]',
  layoutLoadDialog: '[data-name="load-layout-dialog"]',
  layoutLoadDialogItem: '[data-name="load-chart-dialog-item"]',
  layoutLoadDialogSearch: '[data-name="load-layout-dialog"] input[placeholder="Search"]',

  // Jun-2026 "Testing period" path replacing the dead strategyTabPeriodDD/deepHistory-* family. The report-header date-range button has hashed classes (activeArea-*) and no data-name, so it is located by visible text (tv._findTestingPeriodButton). The menu rows are div[class*="button-"] addressed by text; "Custom date range" opens [data-name="custom-date-range-dialog"] with two input[placeholder="YYYY-MM-DD"] and footer button[name="cancel"]/button[name="submit"]. Old strategyTabPeriodDD is kept above for the legacy deep-test path.
  testingPeriodMenuRow: '#overlap-manager-root div[class*="button-"]',
  customDateRangeDialog: '[data-name="custom-date-range-dialog"]',
  customDateRangeInput: '[data-name="custom-date-range-dialog"] input[placeholder="YYYY-MM-DD"]',
  customDateRangeCancel: '[data-name="custom-date-range-dialog"] button[name="cancel"]',
  customDateRangeSubmit: '[data-name="custom-date-range-dialog"] button[name="submit"]',

  strategyListOptions: 'div[role="listbox"] [role="option"]',
  strategyDefaultElement: '#property-actions',

  strategyImportExport: '#iondvImportExport',

  // chartTicker changed from div to span in Jan 2026 TV UI
  chartTicker: '#header-toolbar-symbol-search > span',
  chartTimeframeFavorite: '#header-toolbar-intervals button[data-value]',
  chartTimeframeActive: '#header-toolbar-intervals button[data-value][aria-checked="true"]',
  chartTimeframeMenuOrSingle: '#header-toolbar-intervals button[class^="menu"]',

  // chartTimeframeMenuItem for the Jun-2026 TV UI: the timeframe menu lost the popup-menu-container/dropdown wrappers, so it renders div[data-value] rows with hashed button-* classes (data-values "1","3","5","60","240","1S","1D"… — the semantics selectTimeFrameMenuItem normalization expects). This menu has NO input, so the custom-TF "add" path (chartTimeframeMenuInput/Type/Add below) is dead on this UI; non-listed TFs abort cleanly.
  chartTimeframeMenuItem: '#overlap-manager-root div[class*="button-"][data-value]',
  chartTimeframeMenuInput: "#overlap-manager-root div[data-name=\"menu-inner\"] div[class^=\"dropdown\"] div[class^=\"form\"] > input",
  chartTimeframeMenuType: "#overlap-manager-root div[data-name=\"menu-inner\"] div[class^=\"dropdown\"] div[class^=\"form\"] > div[class^=\"menu\"]",
  chartTimeframeMenuAdd: "#overlap-manager-root div[data-name=\"menu-inner\"] div[class^=\"dropdown\"] div[class^=\"form\"] > div[class^=\"add\"]",
  chartTimeframeMenuTypeItems: "#overlap-manager-root div[data-name=\"menu-inner\"] > div[class^=\"item\"]",
  chartTimeframeMenuTypeItemsMin: "#overlap-manager-root div[data-name=\"menu-inner\"] > div[class^=\"item\"]:nth-child(1)",
  chartTimeframeMenuTypeItemsHours: "#overlap-manager-root div[data-name=\"menu-inner\"] > div[class^=\"item\"]:nth-child(2)",
  chartTimeframeMenuTypeItemsDays: "#overlap-manager-root div[data-name=\"menu-inner\"] > div[class^=\"item\"]:nth-child(3)",
  chartTimeframeMenuTypeItemsWeeks: "#overlap-manager-root div[data-name=\"menu-inner\"] > div[class^=\"item\"]:nth-child(4)",
  chartTimeframeMenuTypeItemsMonth: "#overlap-manager-root div[data-name=\"menu-inner\"] > div[class^=\"item\"]:nth-child(5)",
  chartTimeframeMenuTypeItemsRange: "#overlap-manager-root div[data-name=\"menu-inner\"] > div[class^=\"item\"]:nth-child(6)",

}
