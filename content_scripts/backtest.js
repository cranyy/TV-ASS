const backtest = {
  DEF_MAX_PARAM_NAME: 'Net profit: All'
}

// eager offload threshold: keeps the per-cycle persisted testResults payload bounded (~50 rows) instead of climbing to ~2.6 MB and serializing it every cycle. Export reconstruction (model.buildExportSummaries) concatenates chunks-in-order + in-memory, so it is chunk-size agnostic and output is unchanged.
const RESULT_MAX_IN_MEMORY = 50
// uniform small write-once chunks matching the eager threshold so in-memory stays ~50 rows.
const RESULT_CHUNK_SIZE = 50
const RESULT_PERSIST_BATCH = 20 // write testResults to storage every N updates
// at live cycle times (≫5 s) a 5 s time trigger would fire on every call, defeating batch=20 and serializing the whole growing testResults each cycle. 60 s lets the count trigger gate; eager chunking (above) bounds any flush that still fires on slow/deep cycles. Forced final flush + batch count are unchanged.
const RESULT_PERSIST_MAX_INTERVAL_MS = 60000 // or at least every 60s
// GA mutation is scaled to dimensionality — target ~MUT_EXPECTED_GENES changed genes per child (capped at MUT_MAX_GENES under the plateau boost) regardless of strategy input count, replacing a flat 25%/gene that changed ~15 genes on a 60-param strategy and destroyed feasibility.
const MUT_EXPECTED_GENES = 2
const MUT_MAX_GENES = 6
// default share of CEM candidates drawn NEAR the feasible-first
// best-ever anchor (re-rolling only k=1..3 params) instead of a full independent-marginal scatter. Mirrors GA's
// NEAR_ANCHOR_SHARE (0.8) which fixed the same "candidates sit ~N params from the incumbent → infeasible" failure.
const CEM_NEAR_ANCHOR_SHARE = 0.8
// consecutive POPULATED reports missing the optimization target (and never once found) before aborting with the "target not in report" error. >1 so a transient parse miss on a VALID metric can't false-abort the run (upstream issues #355/#356 are exactly that false abort). The init baseline miss seeds this streak at 1, so a genuinely-absent target still aborts within ~2 more cycles.
const METRIC_MISS_ABORT = 3
// ANTI-DETECTION human pacing. The param setter applies values in ~0.3s, which is robotic; this adds an always-on randomized pause before each setter so there is no fixed machine cadence (randomisation matters as much as duration for looking human). This is the floor even when the popup's backtestDelay option is 0; setting backtestDelay adds further randomized spacing on top (applied per cycle in backtest.delay). This reduces — it does NOT eliminate — TradingView automation-detection risk; nothing can guarantee that.
// PACING: raise the per-setter human band floor so a few-field edit no longer snaps open/apply/close at robotic speed; add a BOUNDED changed-count term (PER_EDIT × extra fields, capped at EDIT_CAP) so the dwell correlates with how many fields are actually applied without ever growing into late-cycle slug. The cap bounds the changed-count contribution ONLY; the backtestDelay-scaled base stays uncapped so a user's larger backtestDelay is still honored. No term depends on cycle index / population / persisted results / GA history.
const SETTER_HUMAN_MIN_MS = 900
const SETTER_HUMAN_MAX_MS = 2600
const SETTER_HUMAN_PER_EDIT_MS = 180
const SETTER_HUMAN_EDIT_CAP_MS = 2000

function cloneSingleValue(value) {
  if (Array.isArray(value))
    return value.map(item => cloneSingleValue(item))
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      const out = {}
      Object.keys(value).forEach(key => {
        out[key] = cloneSingleValue(value[key])
      })
      return out
    }
  }
  return value
}

function hasAnyKeys(obj) {
  return !!(obj && typeof obj === 'object' && Object.keys(obj).length)
}

function clonePropValues(source) {
  if (!hasAnyKeys(source))
    return {}
  const out = {}
  Object.keys(source).forEach(key => {
    out[key] = cloneSingleValue(source[key])
  })
  return out
}

function mergePropValues(base, overrides) {
  const result = clonePropValues(base)
  if (overrides && typeof overrides === 'object') {
    Object.keys(overrides).forEach(key => {
      result[key] = cloneSingleValue(overrides[key])
    })
  }
  return result
}

function cloneStrategyProperties(properties) {
  if (!properties || typeof properties !== 'object')
    return {}
  const out = {}
  Object.keys(properties).forEach(key => {
    const value = properties[key]
    if (Array.isArray(value)) {
      out[key] = value.length ? cloneSingleValue(value[0]) : ''
    } else if (typeof value === 'string' && value.includes(';')) {
      out[key] = value.split(';')[0]
    } else {
      out[key] = cloneSingleValue(value)
    }
  })
  return out
}

function extractBaseline(strategyData, testResults) {
  if (testResults && testResults.startParams && hasAnyKeys(testResults.startParams.current))
    return clonePropValues(testResults.startParams.current)
  if (strategyData && strategyData.properties)
    return cloneStrategyProperties(strategyData.properties)
  return {}
}

function ensureBaselineCache(testResults, strategyData) {
  if (!testResults)
    return
  if (!hasAnyKeys(testResults.fullBaseline))
    testResults.fullBaseline = extractBaseline(strategyData, testResults)
  if (!hasAnyKeys(testResults.fullBestParams))
    testResults.fullBestParams = clonePropValues(testResults.fullBaseline)
}

function prepareFullBestPropVal(testResults, candidate = {}, strategyData = null) {
  if (!testResults)
    return mergePropValues({}, candidate)
  ensureBaselineCache(testResults, strategyData)
  const baseline = hasAnyKeys(testResults.fullBaseline) ? testResults.fullBaseline : {}
  const merged = mergePropValues(baseline, candidate && typeof candidate === 'object' ? candidate : {})
  testResults.fullBestParams = merged
  testResults.bestPropVal = merged
  return merged
}

backtest._prepareFullBestPropVal = (testResults, candidate = {}, strategyData = null) => prepareFullBestPropVal(testResults, candidate, strategyData)
backtest._clonePropValues = clonePropValues

async function _batchedPersistTestResults(testResults, force = false) {
  // flush dirty test results to chrome storage instead of recursively calling the batching helper
  if (!testResults)
    return 0
  if (!testResults._persist)
    testResults._persist = { dirty: 0, last: Date.now(), batch: RESULT_PERSIST_BATCH, maxMs: RESULT_PERSIST_MAX_INTERVAL_MS }
  const p = testResults._persist
  if (!force) {
    p.dirty += 1
    const dueByBatch = p.dirty >= (p.batch || RESULT_PERSIST_BATCH)
    const dueByTime = (Date.now() - (p.last || 0)) >= (p.maxMs || RESULT_PERSIST_MAX_INTERVAL_MS)
    if (!dueByBatch && !dueByTime)
      return 0
  }
  const persistStart = Date.now()
  let persistTime = 0
  try {
    await storage.setKeys(storage.STRATEGY_KEY_RESULTS, testResults)
    persistTime = Math.round((Date.now() - persistStart) / 1000 * 10) / 10
    testResults._lastPersistTime_ = persistTime
    testResults._persist.flushes = (testResults._persist.flushes || 0) + 1
    testResults._persist.totalTime = Math.round(((testResults._persist.totalTime || 0) + persistTime) * 10) / 10
  } catch (err) {
    console.warn('Persist testResults failed', err)
  } finally {
    testResults._persist.last = Date.now()
    testResults._persist.dirty = 0
  }
  return persistTime
}

/*
 * Helper to automatically persist the current best strategy configuration. When a new
 * best value is discovered during strategy optimisation, this function collects
 * several key performance metrics from the current report and writes a small
 * text file to the user's device using the existing `file.saveAs` mechanism.
 *
 * The filename uses a concise format: `<TICKER>_<net>net_<wr>wr_<dd>dd.txt` where
 * `net`, `wr` and `dd` are rounded numbers representing Net Profit, Win Rate
 * (percent profitable) and Maximum Drawdown respectively. The first line of
 * the file echoes these values in a comma‑separated format, followed by a JSON
 * payload containing the full set of best parameters and metrics for future
 * reference. This allows a user to quickly identify and re‑use the best
 * parameter set found during optimisation without exporting the full CSV.
 */
backtest._autosaveOnBest = (testResults, res, options = {}) => {
  try {
    const forceDownload = options && options.force === true
    if (!testResults || (!forceDownload && testResults.autoBestDownload === false))
      return
    // Ensure all necessary data is present before proceeding.
    if (!res || !res.data || !res.bestPropVal) return;

    const filterFailure = _getFilterFailure(testResults, res.data)
    if (filterFailure) {
      console.log('AutoSave skipped by filter:', filterFailure)
      return
    }

    const data = res.data;

    // DEBUG: Capture DD value immediately after filter check
    const ddKeyDebug1 = Object.keys(data).find(k => k.toLowerCase().includes('max') && k.toLowerCase().includes('drawdown'))
    console.log('🔍 [DEBUG 1] DD right after filter check:', {
      key: ddKeyDebug1,
      rawValue: data[ddKeyDebug1],
      dataObjectId: res.data === data ? 'SAME' : 'DIFFERENT',
      timestamp: Date.now()
    })

    // DEBUG: Freeze the data object to detect mutations
    const frozenSnapshot = { ...data }
    Object.freeze(frozenSnapshot)
    let diag = null
    try {
      diag = _inspectFilters(testResults, data)
      if (typeof window !== 'undefined') {
        window.iondvLastAutoSaveFilters = diag
        window.iondvLastAutoSaveSample = { ...data }
      }
      console.log('AutoSave filter diagnostics', diag)
    } catch (err) {
      console.warn('Failed to capture filter diagnostics', err)
    }
    if (!diag || !Array.isArray(diag) || diag.some(item => item.passes !== true)) {
      console.warn('AutoSave blocked: filter diagnostics not satisfied', diag)
      return
    }

    // Helper to parse metrics for the filename.
    function parseMetric(val, metricName) {
      const originalVal = val
      if (val === null || typeof val === 'undefined') return null;
      let str = String(val).replace(/[,\s]/g, '');
      const hasPercent = /%/.test(str);
      str = str.replace(/[^0-9.+\-]/g, '');
      let num = parseFloat(str);
      if (isNaN(num)) return null;

      // Check if metric name indicates percentage (not just the value)
      const isPercentMetric = metricName && (metricName.includes('%') || metricName.toLowerCase().includes('percent') || metricName.toLowerCase().includes('profitable'))
      const willMultiply = hasPercent || Math.abs(num) < 2 || isPercentMetric

      if (willMultiply) {
        num = num * 100;
      }
      const result = Math.round(num);

      // DEBUG: Log parseMetric transformation
      if (metricName && metricName.toLowerCase().includes('drawdown')) {
        console.log('🔍 [DEBUG parseMetric] DD transformation:', {
          metricName,
          input: originalVal,
          inputType: typeof originalVal,
          hasPercent,
          willMultiply,
          beforeRound: num,
          result,
          timestamp: Date.now()
        })
      }

      return result;
    }

    // Find the required metric keys to build the filename.
    const findKey = (candidates) => {
      const keys = Object.keys(data);
      const lowerKeys = keys.map(k => k.toLowerCase());
      for (let cand of candidates) {
        const idx = lowerKeys.findIndex(k => k.includes(cand));
        if (idx !== -1) return keys[idx];
      }
      return null;
    };

    // prioritize the % variant for net profit to avoid using the dollar value
    const netKey = findKey(['net profit %', 'net profit']);
    const wrKey = findKey(['percent profitable', 'win rate']);
    // CRITICAL: Search for percentage metric FIRST, before dollar metric
    const ddKey = findKey(['max equity drawdown %', 'max drawdown %', 'max equity drawdown', 'max drawdown']);

    // DEBUG: Log DD value before parseMetric
    console.log('🔍 [DEBUG 2] DD before parseMetric:', {
      key: ddKey,
      rawValue: data[ddKey],
      dataKeys: Object.keys(data).filter(k => k.toLowerCase().includes('drawdown')),
      timestamp: Date.now()
    })

    const netVal = parseMetric(netKey ? data[netKey] : null, netKey);
    const wrVal = parseMetric(wrKey ? data[wrKey] : null, wrKey);
    const ddVal = parseMetric(ddKey ? data[ddKey] : null, ddKey);

    // DEBUG: Log final filename components
    console.log('🔍 [DEBUG 3] Final filename DD:', {
      ddKey,
      ddRaw: data[ddKey],
      ddParsed: ddVal,
      ddFilename: Math.abs(ddVal !== null ? ddVal : 0),
      timestamp: Date.now()
    })

    // If no metrics are found, do not save a file.
    if (netVal === null && wrVal === null && ddVal === null) return;

    // use cached timeFrame and rangeText for the autodownload filename (from tv.js getPerformance)
    const ticker = testResults && (testResults.ticker || testResults.symbol || 'unknown');
    const netStr = netVal !== null ? netVal : 0;
    const wrStr = wrVal !== null ? wrVal : 0;
    const ddStr = ddVal !== null ? Math.abs(ddVal) : 0;
    const suffixRaw = options && options.suffix != null ? String(options.suffix) : '';
    const safeSuffix = suffixRaw.replace(/[^a-z0-9_-]+/gi, '').trim();

    // Use cached timeFrame and rangeText from testResults (populated by tv.getPerformance)
    const timeFrame = testResults && testResults.timeFrame ? testResults.timeFrame : '';
    let rangeText = testResults && testResults.rangeText ? testResults.rangeText : '';
    // a PRESET run scrapes no "Mon DD, YYYY — Mon DD, YYYY" string from the report (the area shows the label, e.g. "Last 7 days"), so testResults.rangeText is empty and the winner FILENAME lost its _RANGE segment. FALLBACK ONLY: when the scrape is empty AND the run-start resolved dateRange has BOTH concrete dates, synthesize the same mon-d-yyyy--mon-d-yyyy text so preset winners get the same _RANGE… naming as custom ranges. Never overwrites a real scraped rangeText; organizer/import _RANGE contract unchanged.
    if (!rangeText) {
      const dr = testResults && testResults.runContext ? testResults.runContext.dateRange : null;
      if (dr && dr.from && dr.to && typeof tv !== 'undefined' && typeof tv._isoRangeToFilenameText === 'function')
        rangeText = tv._isoRangeToFilenameText(dr.from, dr.to);
    }

    let filenameBase = `${ticker}_${netStr}net_${wrStr}wr_${ddStr}dd`;
    if (timeFrame) filenameBase += `_TF${timeFrame}`;
    if (rangeText) filenameBase += `_RANGE${rangeText}`;
    const optParamForToken = (testResults && testResults.optParamName) ? testResults.optParamName : backtest.DEF_MAX_PARAM_NAME;
    let optValueStr = '';
    const rawOptVal = (res.data && typeof res.data[optParamForToken] !== 'undefined') ? res.data[optParamForToken]
      : (res && typeof res.bestValue !== 'undefined' ? res.bestValue : undefined);
    const numOptVal = (typeof rawOptVal === 'number') ? rawOptVal : parseFloat(String(rawOptVal));
    if (rawOptVal !== null && typeof rawOptVal !== 'undefined' && isFinite(numOptVal)) {
      const onLower = String(optParamForToken).toLowerCase();
      const isPercentMetric = /%/.test(String(optParamForToken)) || onLower.includes('percent') || onLower.includes('profitable');
      optValueStr = `${backtest.convertValue(numOptVal)}${isPercentMetric ? '%' : ''}`;
    }
    const optToken = backtest._optTargetFilenameToken(testResults && testResults.optParamName, testResults && testResults.isMaximizing, optValueStr);
    if (optToken) filenameBase += `_${optToken}`;
    if (safeSuffix)
      filenameBase += `_${safeSuffix}`;

    // Construct the correct filename with the .csv extension.
    const filename = sanitizeFilename(`${filenameBase}.csv`);

    // DEBUG: Final filename about to be saved
    console.log('🔍 [DEBUG 4] About to save file:', {
      filename,
      filenameBase,
      netStr,
      wrStr,
      ddStr,
      timestamp: Date.now()
    })

    // Helper function to safely quote text values for CSV format.
    const _csvQuote = (val) => {
      const str = String(val)
      const escaped = str.replace(/"/g, '""')
      return `"${escaped}"`
    }

    const _csvFormatValue = (val) => {
      if (val === null || typeof val === 'undefined')
        return ''
      if (typeof val === 'boolean')
        return val ? 'true' : 'false'
      if (typeof val === 'number')
        return Number.isFinite(val) ? String(val) : _csvQuote(val)
      if (Array.isArray(val))
        return _csvQuote(val.join(';'))
      const asString = String(val)
      if (/^\s*(true|false)\s*$/i.test(asString))
        return asString.trim().toLowerCase()
      return _csvQuote(asString)
    }

    // Build the CSV content string.
    let csvContent = '"Name","Value"\n';
    const indicatorName = testResults && testResults.shortName ? testResults.shortName : 'unknown';
    csvContent += `${_csvQuote('__indicatorName')},${_csvQuote(indicatorName)}\n`;

    // embed the run context as one Base64 cell right after __indicatorName. SYNC refresh of the volatile fields (date range can drift with "Range from chart" as bars arrive; optimizer block from the now-complete testResults) — both reads are synchronous so _autosaveOnBest stays sync and its non-awaiting callers are unaffected. A missing runContext (e.g. older run) simply omits the row, leaving the params-only CSV untouched.
    try {
      const rc = testResults && testResults.runContext ? testResults.runContext : null;
      if (rc && typeof rc === 'object') {
        // refresh timeframe from testResults before encoding. In the multi-timeframe loop (action.testStrategy shouldTestTF) testParams.timeFrame is reassigned per TF and the winner FILENAME uses the updated testResults.timeFrame, but runContext.timeframe was built once at run start — so a _TF5m file could embed a stale runContext.timeframe and restore the wrong timeframe. Refresh it here from the same source the filename uses.
        try {
          if (testResults.timeFrame)
            rc.timeframe = testResults.timeFrame;
        } catch (err) { console.warn('AutoSave: timeframe refresh failed', err); }
        try {
          // this per-save read is SYNCHRONOUS (cannot open the resolver dialog), so for a preset it returns label-only {from:null,to:null}. Without a guard it would clobber the concrete {from,to} that _buildRunContextV3 resolved at run start, re-introducing the bug. Keep a run-start resolved preset when fresh is the SAME label with no concrete dates; otherwise update. Require BOTH stored.from AND stored.to so a partially-populated range is never preserved/reported as concrete.
          // "otherwise update" fires when fresh shows a DIFFERENT label (period genuinely changed mid-run) or a concrete date-range string (whose date-text label differs once the window drifts). This sync read CANNOT detect a same-label preset like "Range from chart" whose chart window moves mid-run — the button still shows only the label — so the run-start resolution is intentionally kept in that case.
          const fresh = (typeof tv !== 'undefined' && typeof tv._readTestingPeriod === 'function') ? tv._readTestingPeriod() : null;
          if (fresh) {
            const stored = rc.dateRange;
            const keepResolved = !!(stored && stored.from && stored.to && stored.label &&
              fresh.label && !fresh.from &&
              typeof normalizeTitle === 'function' &&
              normalizeTitle(stored.label) === normalizeTitle(fresh.label));
            if (!keepResolved)
              rc.dateRange = fresh;
          }
        } catch (err) { console.warn('AutoSave: date-range refresh failed', err); }
        try {
          if (typeof action !== 'undefined' && typeof action._extractOptimizerFields === 'function')
            rc.optimizer = action._extractOptimizerFields(testResults);
        } catch (err) { console.warn('AutoSave: optimizer refresh failed', err); }
        if (typeof file !== 'undefined' && typeof file.encodeRunContextMeta === 'function') {
          const metaB64 = file.encodeRunContextMeta(rc);
          if (metaB64)
            csvContent += `${_csvQuote('__tvassMeta')},${_csvQuote(metaB64)}\n`;
        }
      }
    } catch (err) {
      console.warn('AutoSave: __tvassMeta embed failed (non-fatal)', err);
    }

    // Get only the best parameters for the CSV body.
    const params = prepareFullBestPropVal(testResults, res.bestPropVal);
    res.bestPropVal = params
    const sortedKeys = Object.keys(params).sort();
    
    for (const key of sortedKeys) {
        csvContent += `${_csvQuote(key)},${_csvFormatValue(params[key])}\n`;
    }

    // Use the file.saveAs function to download the CSV file.
    if (typeof file !== 'undefined' && typeof file.saveAs === 'function') {
      file.saveAs(csvContent, filename);
    } else {
      console.warn('file.saveAs is not available');
    }
  } catch (err) {
    console.error('AutoSave error', err);
  }
};

backtest._optTargetFilenameToken = (optParamName, isMaximizing, optValueStr) => {
  const prefix = isMaximizing === false ? 'minvalue' : 'maxvalue'
  let name = String(optParamName || backtest.DEF_MAX_PARAM_NAME)
    .replace(/\s*\/\s*/g, ' - ')   // "a / b"  -> "a - b"
    .replace(/\s*:\s*/g, ' ')      // ": All"  -> " All"
    .replace(/[\\*?"<>|]/g, '')    // drop any other reserved char (none in current vocab, defensive)
    .replace(/\s+/g, ' ')
    .trim()
  if (optValueStr != null && String(optValueStr).length) {
    const v = String(optValueStr).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()
    if (v) name += ` - ${v}`
  }
  return `${prefix}-${name}`
}

function sanitizeFilename(name) {
  if (!name)
    return 'result.csv'
  return name.replace(/[\\/:*?"<>|]+/g, '_')
}

// ---------- GA Feasibility and Metrics Helpers ----------

function _getHorizonDays(testResults) {
  try {
    if (testResults && testResults.deepStartDate) {
      const start = new Date(testResults.deepStartDate)
      const now = new Date()
      const ms = Math.max(1, now - start)
      return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)))
    }
  } catch {}
  // Approximate trading days in one year if no deep start date
  return 252
}

// gate GA min-trades checks behind explicit user opt-in so GA defaults match random-improvement feasibility
// keep shared min-trades calculation behavior stable so non-GA methods are not impacted
function _shouldApplyGAMinTradesGate(testResults) {
  if (!testResults || testResults.method !== 'genetic')
    return false
  if (typeof testResults.minTradesTotal === 'number' && Number.isFinite(testResults.minTradesTotal))
    return true
  return testResults.gaTradesGateEnabled === true
}

function _computeMinTrades(testResults) {
  // If an explicit total threshold is provided, prefer it.
  if (testResults && typeof testResults.minTradesTotal === 'number' && Number.isFinite(testResults.minTradesTotal))
    return Math.max(1, Math.ceil(testResults.minTradesTotal))
  const targetPerDay = (testResults && typeof testResults.targetTradesPerDay === 'number' && Number.isFinite(testResults.targetTradesPerDay))
    ? testResults.targetTradesPerDay
    : 0.4
  const days = _getHorizonDays(testResults)
  return Math.max(1, Math.ceil(targetPerDay * days))
}

function _findMetricKey(data, candidates) {
  if (!data) return null
  const keys = Object.keys(data)
  const lower = keys.map(k => k.toLowerCase())
  for (const cand of candidates) {
    const idx = lower.findIndex(k => k.includes(cand))
    if (idx !== -1) return keys[idx]
  }
  return null
}

function _getSecondaryMetrics(data) {
  const tradesKey = _findMetricKey(data, ['total trades: all', 'total closed trades: all', 'total trades'])
  const wrKey = _findMetricKey(data, ['percent profitable: all', 'percent profitable', 'win rate'])
  const ddKey = _findMetricKey(data, ['max equity drawdown', 'max drawdown'])
  const trades = tradesKey && typeof data[tradesKey] === 'number' ? data[tradesKey] : null
  const winRate = wrKey && typeof data[wrKey] === 'number' ? data[wrKey] : null
  const maxDD = ddKey && typeof data[ddKey] === 'number' ? data[ddKey] : null
  return { trades, winRate, maxDD }
}

function _getDrawdownPercent(data) {
  if (!data) return null
  const keyPct = _findMetricKey(data, ['max equity drawdown %', 'max drawdown %'])
  if (keyPct && typeof data[keyPct] === 'number')
    return data[keyPct]
  // Fallback: if only absolute DD present, cannot reliably convert; return null
  return null
}

function _coerceFilterDirection(value) {
  if (value === true || value === false)
    return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (!normalized)
      return null
    if (['true', '1', 'asc', 'ascending', 'more', '>=', 'max', 'increase'].includes(normalized))
      return true
    if (['false', '0', 'desc', 'descending', 'less', '<=', 'min', 'decrease'].includes(normalized))
      return false
  } else if (typeof value === 'number') {
    if (value === 1)
      return true
    if (value === 0 || value === -1)
      return false
  }
  return null
}

function _coerceNumber(value) {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '.').replace(/[^0-9.+\-]/g, '')
    if (!normalized.length)
      return NaN
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : NaN
  }
  return NaN
}

function _getFilterConfigs(testResults) {
  const filters = []
  if (!testResults)
    return filters
  const rawFilters = [
    { ascending: testResults.filterAscending, value: testResults.filterValue, paramName: testResults.filterParamName },
    { ascending: testResults.filter2Ascending, value: testResults.filterValue2, paramName: testResults.filterParamName2 }
  ]
  for (const rawFilter of rawFilters) {
    const name = typeof rawFilter.paramName === 'string' ? rawFilter.paramName.trim() : ''
    if (!name)
      continue
    const direction = _coerceFilterDirection(rawFilter.ascending)
    if (direction === null)
      continue
    const threshold = _coerceNumber(rawFilter.value)
    if (!Number.isFinite(threshold))
      continue
    filters.push({
      ascending: direction,
      value: threshold,
      paramName: name
    })
  }
  if (testResults)
    testResults.activeFilters = filters.map(filter => ({ ...filter }))
  return filters
}

function _formatFilterThreshold(value) {
  const num = Number(value)
  if (Number.isFinite(num))
    return backtest.convertValue(num)
  if (typeof value === 'string' && value.trim().length)
    return value
  return 'N/A'
}

function _describeFilters(testResults) {
  const filters = _getFilterConfigs(testResults)
  if (!filters.length)
    return ''
  return filters.map(filter => {
    const requirement = filter.ascending ? '>=' : '<='
    const threshold = _formatFilterThreshold(filter.value)
    return `${filter.paramName} ${requirement} ${threshold}`
  }).join(' & ')
}

function _resolveMetricKey(data, filterName) {
  if (!data || !filterName)
    return null
  const keys = Object.keys(data)
  const trimmed = String(filterName).trim()
  const lowered = trimmed.toLowerCase()
  const normalized = lowered.replace(/[^a-z0-9%]/g, '')

  let index = keys.findIndex(key => key === trimmed)
  if (index !== -1)
    return keys[index]

  const loweredKeys = keys.map(key => key.trim().toLowerCase())
  index = loweredKeys.findIndex(key => key === lowered)
  if (index !== -1)
    return keys[index]

  const normalizedKeys = loweredKeys.map(key => key.replace(/[^a-z0-9%]/g, ''))
  index = normalizedKeys.findIndex(key => key === normalized)
  if (index !== -1)
    return keys[index]

  const aliasMap = {
    'maxequitydrawdown%': ['maxdrawdown%', 'maxdrawdownpct', 'maxdrawdownpercent'],
    'maxequitydrawdown': ['maxdrawdown'],
    'maxdrawdown%': ['maxequitydrawdown%', 'maxequitydrawdownpct', 'maxequitydrawdownpercent'],
    'maxdrawdown': ['maxequitydrawdown']
  }
  const aliases = aliasMap[normalized]
  if (aliases) {
    for (const alias of aliases) {
      const aliasIndex = normalizedKeys.findIndex(key => key === alias)
      if (aliasIndex !== -1)
        return keys[aliasIndex]
    }
  }

  return null
}

function _normalizeThreshold(metric, threshold, filter) {
  if (!Number.isFinite(threshold))
    return threshold
  const absThreshold = Math.abs(threshold)
  const name = filter && typeof filter.paramName === 'string' ? filter.paramName.toLowerCase() : ''
  const looksPercent = name.includes('%') || name.includes('percent') || name.includes('profitable')
  // For percentage metrics, if user entered a whole number (like 10 for 10%), convert to decimal (0.10)
  if (looksPercent && absThreshold > 1.5)
    return threshold / 100
  return threshold
}

function _normalizeMetric(metric, paramName) {
  if (typeof metric !== 'number' || !Number.isFinite(metric))
    return metric
  const name = typeof paramName === 'string' ? paramName.toLowerCase() : ''
  const looksPercent = name.includes('%') || name.includes('percent') || name.includes('profitable')
  const absMetric = Math.abs(metric)
  // If it's a percentage metric but TV returned it as a whole number (>2), convert to decimal
  if (looksPercent && absMetric > 2)
    return metric / 100
  return metric
}

function _evaluateSingleFilter(data, filter) {
  if (!filter || !filter.paramName)
    return null
  if (!data)
    return null
  const rawKey = String(filter.paramName)
  const matchedKey = _resolveMetricKey(data, rawKey)
  if (!matchedKey)
    return `Skipped for "${rawKey}": metric not available.`
  const metricRaw = data[matchedKey]
  const metricCoerced = _coerceNumber(metricRaw)
  if (!Number.isFinite(metricCoerced))
    return `Skipped for "${matchedKey}": ${String(metricRaw)} (metric not numeric).`
  // Normalize the metric (convert whole-number percentages to decimals if needed)
  const metric = _normalizeMetric(metricCoerced, matchedKey)
  const inputThreshold = _coerceNumber(filter.value)
  if (!Number.isFinite(inputThreshold))
    return `Skipped for "${matchedKey}": ${backtest.convertValue(metric)} (threshold invalid).`
  const normalizedThreshold = _normalizeThreshold(metric, inputThreshold, filter)
  if (!Number.isFinite(normalizedThreshold))
    return `Skipped for "${matchedKey}": ${backtest.convertValue(metric)} (threshold invalid).`
  let comparisonMetric = metric
  let comparisonThreshold = normalizedThreshold
  const suffixParts = []
  const shouldUseMagnitude = !filter.ascending && metric < 0 && normalizedThreshold >= 0
  if (shouldUseMagnitude) {
    comparisonMetric = Math.abs(metric)
    comparisonThreshold = Math.abs(normalizedThreshold)
    suffixParts.push('compared by absolute value')
  }
  const passes = filter.ascending ? (comparisonMetric >= comparisonThreshold) : (comparisonMetric <= comparisonThreshold)
  if (passes)
    return null
  const requirement = filter.ascending ? '>=' : '<='
  if (normalizedThreshold !== inputThreshold)
    suffixParts.unshift('interpreted from input')
  const suffix = suffixParts.length ? ` (${suffixParts.join('; ')})` : ''

  // Format for display: show percentages as "10.26%" instead of "0.1026"
  const isPercentMetric = matchedKey.includes('%') || matchedKey.toLowerCase().includes('percent') || matchedKey.toLowerCase().includes('profitable')
  const displayMetric = isPercentMetric ? (comparisonMetric * 100) : comparisonMetric
  const displayThreshold = isPercentMetric ? (comparisonThreshold * 100) : comparisonThreshold
  const metricText = backtest.convertValue(displayMetric) + (isPercentMetric ? '%' : '')
  const thresholdText = backtest.convertValue(displayThreshold) + (isPercentMetric ? '%' : '')

  return `Skipped for "${matchedKey}": ${metricText} (requires ${requirement} ${thresholdText})${suffix}.`
}

function _getFilterFailure(testResults, data) {
  const filters = _getFilterConfigs(testResults)
  for (const filter of filters) {
    const failure = _evaluateSingleFilter(data, filter)
    if (failure)
      return failure
  }
  return null
}

function _inspectFilters(testResults, data) {
  const filters = _getFilterConfigs(testResults)
  return filters.map(filter => {
    const rawKey = String(filter.paramName)
    const matchedKey = _resolveMetricKey(data, rawKey)
    const metricRaw = matchedKey ? data[matchedKey] : undefined
    const metricCoerced = matchedKey ? _coerceNumber(metricRaw) : NaN
    const metric = Number.isFinite(metricCoerced) && matchedKey ? _normalizeMetric(metricCoerced, matchedKey) : metricCoerced
    const thresholdRaw = filter.value
    const normalizedThreshold = Number.isFinite(metric) ? _normalizeThreshold(metric, _coerceNumber(thresholdRaw), filter) : NaN

    // Apply the same absolute value logic as _evaluateSingleFilter
    let comparisonMetric = metric
    let comparisonThreshold = normalizedThreshold
    const useMagnitude = !filter.ascending && metric < 0 && normalizedThreshold >= 0
    if (useMagnitude) {
      comparisonMetric = Math.abs(metric)
      comparisonThreshold = Math.abs(normalizedThreshold)
    }

    const passes = Number.isFinite(comparisonMetric) && Number.isFinite(comparisonThreshold)
      ? (filter.ascending ? comparisonMetric >= comparisonThreshold : comparisonMetric <= comparisonThreshold)
      : null
    return {
      displayName: rawKey,
      matchedKey,
      metricRaw,
      metric,
      threshold: thresholdRaw,
      normalizedThreshold,
      comparison: filter.ascending ? '>=' : '<=',
      usedAbsoluteValue: useMagnitude,
      passes
    }
  })
}

function _passesUserFilter(testResults, data) {
  if (!testResults)
    return true
  return _getFilterFailure(testResults, data) === null
}

function _isFeasibleForGA(testResults, data) {
  // enforce GA feasibility parity by applying min-trades checks only when GA gating is explicitly enabled
  if (!data) return false
  // Enforce user filter first
  if (!_passesUserFilter(testResults, data)) return false
  if (!_shouldApplyGAMinTradesGate(testResults))
    return true
  // Enforce min trades threshold
  const { trades } = _getSecondaryMetrics(data)
  if (typeof trades !== 'number') return false
  const minTrades = _computeMinTrades(testResults)
  return trades >= minTrades
}

async function flushResultsToChunks(testResults, arrayName, chunkListName, chunkType) {
  if (!testResults || !Array.isArray(testResults[arrayName]))
    return
  if (!testResults[chunkListName])
    testResults[chunkListName] = []
  const targetArray = testResults[arrayName]
  while (targetArray.length > RESULT_MAX_IN_MEMORY) {
    const chunk = targetArray.splice(0, RESULT_CHUNK_SIZE)
    if (!chunk.length)
      break
    const chunkKey = storage.generateChunkKey(chunkType)
    await storage.saveChunk(chunkKey, chunk)
    testResults[chunkListName].push(chunkKey)
  }
}

async function ensureSummaryBudget(testResults) {
  await flushResultsToChunks(testResults, 'perfomanceSummary', 'summaryChunks', 'summary')
}

async function ensureFilteredBudget(testResults) {
  await flushResultsToChunks(testResults, 'filteredSummary', 'filteredChunks', 'filtered')
}

backtest.delay = async (backtestDelay = 0, isRandom = true) => {
  const minimalDelay = 0.2 // 20%
  if (backtestDelay) {
    let delay = backtestDelay * 1000
    if (isRandom) {
      const delay10percent = delay * minimalDelay
      delay = randomInteger(delay10percent, (delay - delay10percent) * 2) // fro, 0.1 value to 2x value - in average ~ delay == value
    }
    await page.waitForTimeout(delay)
  }
}

backtest.testStrategy = async (testResults, strategyData, allRangeParams) => {
  if (testResults.summaryChunks && testResults.summaryChunks.length)
    await storage.removeChunks(testResults.summaryChunks)
  if (testResults.filteredChunks && testResults.filteredChunks.length)
    await storage.removeChunks(testResults.filteredChunks)
  testResults.perfomanceSummary = []
  testResults.filteredSummary = []
  testResults.summaryChunks = []
  testResults.filteredChunks = []
  delete testResults.bestResultRow
  testResults.bestValue = null
  testResults.bestPropVal = null
  testResults.shortName = strategyData.name
  testResults.autoBestDownload = testResults.hasOwnProperty('autoBestDownload') ? Boolean(testResults.autoBestDownload) : true
  const filterSummary = _describeFilters(testResults)
  testResults.filterSummary = filterSummary
  const filterLog = filterSummary ? `filters: ${filterSummary}` : 'filters off'
  testResults.lastAppliedParams = null
  console.log('testStrategy', testResults.shortName, testResults.isMaximizing ? 'max' : 'min', 'value of', testResults.optParamName,
    'by', testResults.method,
    filterLog,
    testResults.cycles, 'times')
  testResults.paramsNames = Object.keys(allRangeParams)
  // init batched persistence state
  testResults._persist = { dirty: 0, last: Date.now(), batch: RESULT_PERSIST_BATCH, maxMs: RESULT_PERSIST_MAX_INTERVAL_MS }

  ensureBaselineCache(testResults, strategyData)
  const seededBest = hasAnyKeys(testResults.bestPropVal) ? testResults.bestPropVal : {}
  prepareFullBestPropVal(testResults, seededBest, strategyData)

  // Get best init value and properties values
  ui.statusMessage('Get the best initial values.')


  // display baseline (current) separately from best initial value
  const initRes = await getInitBestValues(testResults) // allRangeParams

  // Store baseline from current config (fixed, never changes)
  if (initRes && initRes.baselineValue !== null && initRes.baselineValue !== undefined) {
    testResults.initBaselineValue = initRes.baselineValue
    testResults.initBaselinePropVal = initRes.baselinePropVal
  }

  if (initRes && initRes.hasOwnProperty('bestValue') && initRes.bestValue !== null && initRes.hasOwnProperty('bestPropVal') && initRes.hasOwnProperty('data') && initRes.data) {
    testResults.initBestValue = initRes.bestValue
    testResults.bestValue = initRes.bestValue
    testResults.bestPropVal = prepareFullBestPropVal(testResults, initRes.bestPropVal)
    try {
      const baselineStr = testResults.initBaselineValue !== null && testResults.initBaselineValue !== undefined
        ? `Baseline (current): ${backtest.convertValue(testResults.initBaselineValue)}`
        : ''
      const bestStr = `Best initial: ${backtest.convertValue(testResults.bestValue)}`
      ui.statusMessage(`<p>${baselineStr}${baselineStr ? ' | ' : ''}${bestStr}</p>`)
      console.log('Init baseline value', testResults.initBaselineValue, '| Init best value', testResults.bestValue)
    } catch {
    }
  }
  // console.log('bestValue', testResults.bestValue)
  // console.log('bestPropVal', testResults.bestPropVal)

  // the chart ALREADY has the current params applied, so seed lastAppliedParams from the current baseline before cycle 1. Otherwise (lastAppliedParams===null) the genetic diff is skipped on the first iteration and a candidate that equals current re-applies the current values via tv.setStrategyParams — a no-op "mutation" on the very first run. With this seed, an unchanged-current candidate diffs to zero -> shouldCallSetter=false -> no setter, no spurious report-update/fallback.
  if (!hasAnyKeys(testResults.lastAppliedParams)) {
    const baselineApplied = (testResults.startParams && hasAnyKeys(testResults.startParams.current))
      ? testResults.startParams.current
      : (hasAnyKeys(testResults.fullBaseline) ? testResults.fullBaseline : null)
    if (baselineApplied)
      testResults.lastAppliedParams = gaClonePlainObject(baselineApplied)
  }

  // Test strategy
  const optimizationState = {}
  let isEnd = false
  let avgTime = 0

  for (let i = 0; i < testResults.cycles; i++) {
    if (action.workerStatus === null) {
      console.log('Stop command detected')
      break
    }
    // if (page.$(SEL.goproPopupCloseButton)) {
    //   page.mouseClickSelector(SEL.goproPopupCloseButton)
    //   console.log('GoPro popup was closed')
    // }
    // emit cycle status BEFORE the iteration runs. The post-iteration ui.statusMessage only fires AFTER opt*Iteration returns, so during cycle 1's setStrategyParams + getPerformance the popup still read "Get the best initial values" — a running first cycle looked like a stuck init. This immediate line reflects that cycling has begun; the post-iteration message then overwrites it with the result.
    // render the running hint ABOVE the previous cycle's full detail: the bare "running…" line was wiping the detailed post-iteration block (durations, set/parse/persist times, current value, filter/skip message) for the whole length of each (~15-20s) iteration, so the detail was only visible for a blink. Now the previous cycle's full detail (testResults._lastCycleStatus, captured below) stays on screen while the next cycle computes.
    try {
      ui.statusMessage(`<p>▶ Running cycle ${i + 1}/${testResults.cycles}…</p>${testResults._lastCycleStatus || ''}`)
      // clear the previous cycle's apply line at the start of each cycle so a "✓ Applied …" can't linger into a no-op cycle (setter skipped). The setter re-shows "⚙ Applying …" via ui.statusApplyLine when it actually applies. Guarded; replace-path ui.statusMessage above does not touch #iondvApplyLine.
      if (typeof ui.statusApplyLine === 'function') ui.statusApplyLine('')
    } catch {}
    let startTime = new Date()
    await backtest.delay(testResults.backtestDelay, testResults.randomDelay)
    const delayTime = Math.round((new Date() - startTime) / 1000 * 10) / 10
    startTime = new Date()
    let optRes = {}
    switch (testResults.method) {
      case 'annealing':
        optRes = await optAnnealingIteration(allRangeParams, testResults, testResults.bestValue, testResults.bestPropVal, optimizationState)
        break
      case 'sequential':
        optRes = await optSequentialIteration(allRangeParams, testResults, testResults.bestValue, testResults.bestPropVal, optimizationState)
        if (optRes === null)
          isEnd = true
        break
      case 'random':
        optRes = await optAllRandomIteration(allRangeParams, testResults, testResults.bestValue, testResults.bestPropVal, optimizationState)
        if (optRes === null)
          isEnd = true
        break
      case 'genetic':
        optRes = await optGeneticIteration(allRangeParams, testResults, testResults.bestValue, testResults.bestPropVal, optimizationState)
        break
      case 'cem':
        optRes = await optCEMIteration(allRangeParams, testResults, testResults.bestValue, testResults.bestPropVal, optimizationState)
        break
      case 'brute force':
        optRes = await optBruteForce(allRangeParams, testResults, testResults.bestValue, testResults.bestPropVal, optimizationState)
        if (optRes === null)
          isEnd = true
        break
      case 'random improvement':
      default:
        optRes = await optRandomIteration(allRangeParams, testResults, testResults.bestValue, testResults.bestPropVal, optimizationState)
        if (optRes === null)
          isEnd = true
    }
    if (isEnd)
      break
    // FAIL-FAST on an unavailable optimization target. A fully-settled POPULATED report (real metric keys present) that lacks testResults.optParamName means the target name is simply not in this report's metric SCHEMA — and that schema is identical across cycles, so one such report is conclusive. (Root cause: e.g. optParamName "Net profit %: Long" while the Jun-2026 TV report exposes overall ": All" metrics only — zero Long/Short cells in #bottom-area — so the metric is NEVER captured, every cycle "updates successfully" yet records nothing, and the run grinds all cycles fruitlessly.) Abort here with an actionable error listing available targets instead of wasting the whole run.
    // TRANSIENT-TOLERANT (per upstream issues #355/#356: the identical "missing optimization parameter" error is usually a TRANSIENT parse miss, not an absent metric). Upstream's getResWithBestValue sets forceStop on the FIRST populated miss (no tolerance) → false aborts; this version requires METRIC_MISS_ABORT consecutive POPULATED reads missing the target AND the target never once found, so a one-off render/settle hiccup on a VALID metric can't kill the run, while a genuinely-absent target (e.g. "Net profit %: Long" — zero Long/Short cells in this report) still aborts within a few cycles. Any single read that DOES contain the target resets the streak and marks it found (never aborts thereafter).
    if (optRes && optRes.data && typeof optRes.data === 'object') {
      if (typeof optRes.data[testResults.optParamName] !== 'undefined') {
        testResults._metricEverFound = true
        testResults._metricMissStreak = 0
      } else if (!testResults._metricEverFound) {
        const dataKeys = Object.keys(optRes.data).filter(k => k && k !== 'comment' && !k.startsWith('_'))
        if (dataKeys.length) {  // POPULATED report (real metric keys) lacking the target — count it; empty/no-trade reports don't count
          testResults._metricMissStreak = (testResults._metricMissStreak || 0) + 1
          if (testResults._metricMissStreak >= METRIC_MISS_ABORT) {
            const available = dataKeys.filter(k => /:\s*All$/.test(k))
            const availList = (available.length ? available : dataKeys).slice(0, 12).join(', ')
            await ui.showErrorPopup(`Optimization target "${testResults.optParamName}" was not found in the strategy report across ${testResults._metricMissStreak} populated reports. The parser reads every report sub-tab, so this metric is genuinely absent (TradingView may have removed it — e.g. "Max contracts held"). Available targets include: ${availList}. Set one of these as the optimization parameter in the popup and run again.`)
            break
          }
        }
      }
    }
    const durationTime = Math.round((new Date() - startTime) / 1000 * 10) / 10
    avgTime = Math.round((avgTime - avgTime / (i + 1) + durationTime / (i + 1)) * 10) / 10
    let setTime = 0
    let parseTime = 0
    // display storage persistence time separately from setter/report parsing time
    let persistTime = 0
    try {
      if (Object.hasOwn(optRes, 'data')) {
        setTime = optRes.data['_setTime_']
        parseTime = optRes.data['_parseTime_']
        persistTime = optRes.data['_persistTime_'] || 0
        optRes['data']['_duration_'] = durationTime
      }
    } catch {
    }
    if (optRes.hasOwnProperty('data') && optRes.hasOwnProperty('bestValue') && optRes.bestValue !== null && optRes.hasOwnProperty('bestPropVal')) {
      testResults.bestValue = optRes.bestValue
      testResults.bestPropVal = optRes.bestPropVal
      try {
        let text = `<p>Cycle: ${i + 1}/${testResults.cycles} (${durationTime}[${setTime}/${parseTime}/${persistTime}]/${avgTime} sec). Best "${testResults.optParamName}": ${backtest.convertValue(testResults.bestValue)}</p>`
        text += optRes.hasOwnProperty('currentValue') ? `<p>Current "${testResults.optParamName}": ${backtest.convertValue(optRes.currentValue)}</p>` : ''
        text += optRes.error !== null ? `<p style="color: red">${optRes.message}</p>` : optRes.message ? `<p>${optRes.message}</p>` : ''
        testResults._lastCycleStatus = text   // keep this detail visible while the NEXT cycle runs (see running-hint above)
        ui.statusMessage(text)
      } catch {
      }
    } else {
      try {
        let text = `<p>Cycle: ${i + 1}/${testResults.cycles}. Best "${testResults.optParamName}": ${backtest.convertValue(testResults.bestValue)}</p>`
        text += optRes.currentValue ? `<p>Current "${testResults.optParamName}": ${backtest.convertValue(optRes.currentValue)}</p>` : `<p>Current "${testResults.optParamName}": error</p>`
        text += optRes.error !== null ? `<p style="color: red">${optRes.message}</p>` : optRes.message ? `<p>${optRes.message}</p>` : ''
        testResults._lastCycleStatus = text   // keep this detail visible while the NEXT cycle runs (see running-hint above)
        ui.statusMessage(text)
      } catch {
      }
    }
  }
  // Final flush to persist any buffered changes
  await _batchedPersistTestResults(testResults, true)
  return testResults
}

backtest.convertValue = (value) => {
  if (!value)
    return 0
  let s = String(value)                          // FULL shortest round-trip precision (1.192391239139131 stays whole)
  if (/e/i.test(s))                              // defensive: expand any scientific notation (out-of-range tiny/huge; never in normal metric range)
    s = Number(value).toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
  const dot = s.indexOf('.')
  if (dot === -1)
    s += '.00'                                   // integer -> 2 dp (e.g. "100" -> "100.00")
  else if (s.length - dot - 1 === 1)
    s += '0'                                      // 1 dp -> 2 dp (e.g. "2.3" -> "2.30")
  return s
}


async function getInitBestValues(testResults) {
  let resVal = null
  let resPropVal = testResults.startParams.current
  let resData = null

  function setBestVal(newVal, newPropVal, newResData) {
    const isBetter = resVal === null || resPropVal === null ? true : testResults.isMaximizing ? newVal > resVal : newVal < resVal
    if (isBetter) {
      resVal = newVal
      resPropVal = newPropVal
      resData = newResData
    }
  }

  function ensureSummaryArray(field) {
    if (!Array.isArray(testResults[field]))
      testResults[field] = []
  }

  function annotatePropValues(data, propVal) {
    if (data && propVal) {
      Object.keys(propVal).forEach(key => data[`__${key}`] = propVal[key])
    }
  }

  function formatLabel(label) {
    if (!label) return ''
    const trimmed = label.trim()
    if (!trimmed) return ''
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
  }

  // skip filter for "Current parameters" to match upstream baseline behavior
  function handleInitialResult(label, result, propVal) {
    if (!result || !result.data || !result.data.hasOwnProperty(testResults.optParamName))
      return false
    const data = result.data
    annotatePropValues(data, propVal)
    const existing = data['comment'] ? String(data['comment']).trim() : ''
    const baseLabel = formatLabel(label)
    data['comment'] = baseLabel
    if (existing)
      data['comment'] = data['comment'] ? `${data['comment']} ${existing}` : existing
    // Skip filter check for "Current parameters" to match upstream - always use current config as baseline
    const isCurrentParams = label === 'Current parameters'
    const failure = isCurrentParams ? null : _getFilterFailure(testResults, data)
    if (failure) {
      const reason = failure.trim().replace(/[.]*$/, '')
      data['comment'] = data['comment'] ? `${data['comment']} ${reason}.` : `${reason}.`
      ensureSummaryArray('filteredSummary')
      testResults.filteredSummary.push(data)
      return false
    }
    if (data['comment'] && !/[.!?]$/.test(data['comment']))
      data['comment'] += '.'
    ensureSummaryArray('perfomanceSummary')
    setBestVal(data[testResults.optParamName], propVal, data)
    testResults.perfomanceSummary.push(data)
    return true
  }

  // store current config as fixed baseline, return it for display
  await backtest.delay(testResults.backtestDelay, testResults.randomDelay)
  const startTime = new Date()
  // baseline "Current parameters" read mutates nothing, so pass expectChange=false: tv._waitReportSettled settles on the stable current report instead of hanging the full wait window and returning error 3 (the "stuck on Get the best initial values" root cause). Only post-mutation reads require an observed update.
  const currentRes = await tv.getPerformance(testResults, false, false)
  let baselineValue = null
  let baselinePropVal = null
  if (currentRes && currentRes.data) {
    currentRes.data['_setTime_'] = 0
    currentRes.data['_parseTime_'] = Math.round((new Date() - startTime) / 1000 * 10) / 10
    currentRes.data['_duration_'] = 0
    if (currentRes.error === null)
      currentRes.data = calculateAdditionValuesToReport(currentRes.data)
    const currentPropVal = testResults.startParams && testResults.startParams.current ? expandPropVal(testResults.startParams.current, testResults.startParams.current) : {}

    // Store current config as fixed baseline (set once, never overwritten)
    if (currentRes.data.hasOwnProperty(testResults.optParamName)) {
      baselineValue = currentRes.data[testResults.optParamName]
      baselinePropVal = currentPropVal
      console.log(`Init baseline from current "${testResults.optParamName}":`, baselineValue)
    }

    handleInitialResult('Current parameters', currentRes, currentPropVal)

    // fast abort for the init baseline only (not the cycle loop): this baseline read uses expectChange=false so the report is stable and fully rendered, making a populated-but-missing-target read conclusive — abort with a clear error instead of grinding many empty cycles. An empty (no-trade) baseline can't validate here and falls through to the transient-tolerant cycle counter.
    if (currentRes.error === null) {
      const baseKeys = Object.keys(currentRes.data).filter(k => k && k !== 'comment' && !k.startsWith('_'))
      if (baseKeys.length) {
        if (typeof currentRes.data[testResults.optParamName] !== 'undefined') {
          testResults._metricEverFound = true
        } else {
          const available = baseKeys.filter(k => /:\s*All$/.test(k))
          const availList = (available.length ? available : baseKeys).slice(0, 12).join(', ')
          throw new Error(`Optimization target "${testResults.optParamName}" is not present in the strategy report. The parser reads every report sub-tab, so this metric is genuinely absent (TradingView may have removed it — e.g. "Max contracts held"). Available targets include: ${availList}. Set one of these as the optimization parameter in the popup and run again.`)
        }
      }
    }
  }

  // "Get the best initial values" must NOT change the strategy settings: it measures the current (already-loaded) params and does NOT evaluate the CSV's default/best columns (each would call setStrategyParams and mutate the strategy on the first run). Both probe blocks below are gated on EVAL_INIT_DEFAULT_BEST (default false); flip to true to restore current-vs-default-vs-best seeding.
  const EVAL_INIT_DEFAULT_BEST = false
  if (EVAL_INIT_DEFAULT_BEST && testResults.startParams.hasOwnProperty('default') && testResults.startParams.default) {
    const basePropVal = resPropVal || (testResults.startParams && testResults.startParams.current ? testResults.startParams.current : {})
    const defPropVal = expandPropVal(testResults.startParams.default, basePropVal)
    const hasDifference = !resPropVal || Object.keys(defPropVal).some(key => !resPropVal || resPropVal[key] !== defPropVal[key])
    if (hasDifference) {
      await backtest.delay(testResults.backtestDelay, testResults.randomDelay)
      const defRes = await backtest.getTestIterationResult(testResults, defPropVal, true)
      if (defRes && defRes.data) {
        handleInitialResult('Default parameters', defRes, defPropVal)
      }
    } else if (currentRes && currentRes.data) {
      console.log(`Default "${testResults.optParamName}" equal current:`, currentRes.data[testResults.optParamName])
    }
  }

  if (EVAL_INIT_DEFAULT_BEST && !testResults.shouldSkipInitBestResult && testResults.startParams.hasOwnProperty('best') && testResults.startParams.best) {
    const currentParams = testResults.startParams.current || {}
    const defaultParams = testResults.startParams.default || {}
    const bestParams = testResults.startParams.best
    const differsFromCurrent = Object.keys(bestParams).some(key => currentParams[key] !== bestParams[key])
    const differsFromDefault = Object.keys(bestParams).some(key => defaultParams[key] !== bestParams[key])
    if (resPropVal === null || (!differsFromCurrent && !differsFromDefault)) {
      const basePropVal = resPropVal || currentParams
      const bestPropVal = expandPropVal(bestParams, basePropVal)
      await backtest.delay(testResults.backtestDelay, testResults.randomDelay)
      const bestRes = await backtest.getTestIterationResult(testResults, bestPropVal, true)
      if (bestRes && bestRes.data) {
        handleInitialResult('Best value parameters', bestRes, bestPropVal)
      }
    } else if (currentRes && currentRes.data) {
      console.log(`Best "${testResults.optParamName}" equal previous (current or default):`, currentRes.data[testResults.optParamName])
    }
  }
  console.log(`For init "${testResults.optParamName}":`, resVal)

  if (resVal !== null && resPropVal !== null && resData !== null)
    return { bestValue: resVal, bestPropVal: resPropVal, data: resData, baselineValue, baselinePropVal }
  return { baselineValue, baselinePropVal }
}





backtest.getTestIterationResult = async (testResults, propVal, isIgnoreError = false, isIgnoreSetParam = false) => {
  try {
    tv.isReportChanged = false // Global value
    let startTime = new Date()
    let setterPayload = propVal
    let shouldCallSetter = !isIgnoreSetParam
    let setTime = 0

    if (!isIgnoreSetParam) {
      // a candidate value-equal to lastAppliedParams skips the setter (read with expectChange=false, settles sub-second instead of burning 3 × dataLoadingTime on a report that can never change)
      if (testResults && testResults.lastAppliedParams && typeof propVal === 'object' && propVal) {
        const diffInfo = gaDiffCandidate(testResults.lastAppliedParams, propVal)
        if (diffInfo.changed === 0) {
          shouldCallSetter = false
        } else {
          setterPayload = diffInfo.diff
        }
      }
      // no-op guard: never call setStrategyParams with an empty payload — it fakes a "mutation" that opens the strategy dialog and arms the report-update/settle fallback
      if (shouldCallSetter && (!setterPayload || typeof setterPayload !== 'object' || Object.keys(setterPayload).length === 0))
        shouldCallSetter = false
      if (shouldCallSetter) {
        // anti-detection: randomized human pause before applying params (scales with backtestDelay; ~0.6–2.2s floor even at 0, never the robotic 0.3s) plus a bounded work-correlated bonus capped so a large payload can't slug
        const _bd = (testResults.backtestDelay || 0) * 1000
        const _changed = (setterPayload && typeof setterPayload === 'object') ? Object.keys(setterPayload).length : 1
        const _editBonus = Math.min(Math.max(0, _changed - 1) * SETTER_HUMAN_PER_EDIT_MS, SETTER_HUMAN_EDIT_CAP_MS)
        const _lo = Math.max(SETTER_HUMAN_MIN_MS, Math.round(_bd * 0.4)) + _editBonus
        const _hi = Math.max(SETTER_HUMAN_MAX_MS, Math.round(_bd * 1.6)) + _editBonus
        await page.waitForTimeout(randomInteger(_lo, _hi))
        const paramsStart = new Date()
        const isParamsSet = await tv.setStrategyParams(testResults.shortName, setterPayload, testResults.isDeepTest, false)
        if (!isParamsSet) {
          const diag = tv.lastSetStrategyResult || {}
          const apiMissing = diag.response && Array.isArray(diag.response.missing) ? diag.response.missing.length : 0
          const apiErrors = diag.response && Array.isArray(diag.response.errors) ? diag.response.errors.length : 0
          const legacyMissing = diag.legacy && Array.isArray(diag.legacy.missing) ? diag.legacy.missing.length : 0
          const legacyApplied = diag.legacy && Array.isArray(diag.legacy.applied) ? diag.legacy.applied.length : 0
          let brief = `Params not set [${diag.method || '?'}]`
          if (apiMissing) brief += ` api-miss:${apiMissing}`
          if (apiErrors) brief += ` api-err:${apiErrors}`
          if (legacyApplied || legacyMissing) brief += ` legacy:${legacyApplied}ok/${legacyMissing}miss`
          else if (diag.legacy === null || diag.legacy === undefined) brief += ' legacy:not-reached'
          try { console.warn('[TV-ASS] Setter failure diagnostics:', JSON.stringify(diag, null, 2)) } catch { console.warn('[TV-ASS] Setter failure diagnostics:', String(diag)) }
          return { error: 1, message: brief, data: {} }
        }
        setTime = Math.round((new Date() - paramsStart) / 1000 * 10) / 10
        // refresh lastAppliedParams after every successful set (full post-apply chart state) so the no-op diff above never skips a genuine mutation
        testResults.lastAppliedParams = gaClonePlainObject(propVal)
      } else if (!testResults.lastAppliedParams) {
        testResults.lastAppliedParams = gaClonePlainObject(propVal)
      }
    }
    // only a real setter call changes the report; for a no-op candidate read with expectChange=false so the "Update report" fallback isn't armed for a mutation that never happened
    const expectReportChange = shouldCallSetter
    startTime = new Date()
    let res = null
    let parseTime = 0
    const maxRetries = 3
    const retryWaitMs = 200
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      startTime = new Date()
      res = await tv.getPerformance(testResults, isIgnoreError, expectReportChange)
      parseTime = Math.round((new Date() - startTime) / 1000 * 10) / 10
      const hasMetric = res && res.error === null && res.data && typeof res.data[testResults.optParamName] !== 'undefined'
      // don't retry a settled + populated report that just lacks the target metric: its metric set is conclusive (e.g. optParamName ": Long" but the report exposes only ": All" — zero Long/Short cells), so retrying re-parses the same schema for nothing. A terminal no-trade '__EMPTY__' is likewise definitive; an error-3 settle timeout still retries (its data is empty {}).
      const reportPopulated = res && res.error === null && res.data && Object.keys(res.data).some(k => k && k !== 'comment' && !k.startsWith('_'))
      const metricAbsentOnSettledReport = reportPopulated && !hasMetric
      // a structured error-3 settle timeout (idle-no-update / active-timeout / update-no-effect) is deterministic — retrying just multiplies the stall, so break immediately. A legacy error-3 without structured settle still retries as before.
      const deterministicSettleTimeout = res.error === 3 && res.settle &&
        (res.settle.reason === 'idle-no-update' || res.settle.reason === 'active-timeout' || res.settle.reason === 'update-no-effect')
      const shouldRetry = !hasMetric && !res.empty && !metricAbsentOnSettledReport && !deterministicSettleTimeout && !isIgnoreError && (res.error === 1 || res.error === 2 || res.error === 3 || res.error === null)
      if (!shouldRetry || attempt === maxRetries - 1)
        break
      await page.waitForTimeout(retryWaitMs)
    }

    if (!res || !res.data)
      res = { error: res && res.hasOwnProperty('error') ? res.error : 3, data: {} }

    if (res.empty && res.data && !res.data['comment']) {
      res.data['comment'] = 'No trades: the strategy report requires trade data for these parameter values.'
      if (!res.message) res.message = res.data['comment']
    }

    if (propVal && typeof propVal === 'object')
      Object.keys(propVal).forEach(key => res['data'][`__${key}`] = propVal[key])


    if (res.error === null || isIgnoreError) {
      res['data'] = calculateAdditionValuesToReport(res['data'])
    } else {
      res['data']['comment'] = res['error'] === 2 ? 'The tradingview error occurred when calculating the strategy based on these parameter values' :
        res['error'] === 1 ? 'The tradingview calculation process has not started for the strategy based on these parameter values' :
          res['error'] === 3 ? (res.settle
            ? `Report did not settle (${res.settle.reason}) after ${Math.round((res.settle.totalElapsed || 0) / 1000)}s for one combination. Testing of this combination is skipped.`
            : `The calculation of the strategy parameters took more than ${testResults.dataLoadingTime} seconds for one combination. Testing of this combination is skipped.`) : ''
    }
    res['data']['_setTime_'] = setTime
    res['data']['_parseTime_'] = parseTime
    return res
  } catch (err) {
    console.log('Error to getTestIterationResult ', err)
    return { error: 1, message: `Iteration failed: ${err && err.message ? err.message : String(err)}`, data: {} }
  }
  // return {error: isProcessError ? 2 : !isProcessEnd ? 3 : null, message: reportData['comment'], data: reportData}
}

async function getResWithBestValue(res, testResults, bestValue, bestPropVal, propVale, skipRecord = false) {
  let isFiltered = false
  if (Object.hasOwn(res.data, testResults.optParamName)) {
    const filterFailure = _getFilterFailure(testResults, res.data)
    if (filterFailure) {
      isFiltered = true
      const suffix = res.data['comment'] ? ' ' + res.data['comment'] : ''
      res.data['comment'] = `${filterFailure}${suffix}`
      res.message = res.data['comment']
      res.isFiltered = true
    }
    if (!isFiltered && _shouldApplyGAMinTradesGate(testResults)) {
      // Enforce min-trades feasibility as a hard gate (GA only)
      const minTrades = _computeMinTrades(testResults)
      const { trades } = _getSecondaryMetrics(res.data)
      if (typeof minTrades === 'number' && (typeof trades !== 'number' || trades < minTrades)) {
        isFiltered = true
        res.data['comment'] = `Skipped for min trades: ${typeof trades === 'number' ? trades : 'N/A'} < ${minTrades}.${res.data['comment'] ? ' ' + res.data['comment'] : ''}`
        res.message = res.data['comment']
        res.isFiltered = true
      }
    }
    if (isFiltered) {
      if (!skipRecord) {
        testResults.filteredSummary.push(res.data)
        await ensureFilteredBudget(testResults)
      }
    } else {
      if (!skipRecord) {
        testResults.perfomanceSummary.push(res.data)
        await ensureSummaryBudget(testResults)
      }
    }
    res.data['_persistTime_'] = skipRecord ? 0 : await _batchedPersistTestResults(testResults)

    res.currentValue = res.data[testResults.optParamName]
    if (!isFiltered) {
      if (bestValue === null || typeof bestValue === 'undefined') {
        res.bestValue = res.data[testResults.optParamName]
        res.bestPropVal = propVale
        res.bestPropVal = prepareFullBestPropVal(testResults, res.bestPropVal)
        console.log(`Best value (first): ${bestValue} => ${res.bestValue}`)
        testResults.bestResultRow = { ...res.data }
      } else if (!isFiltered && testResults.isMaximizing) {
        res.bestValue = bestValue < res.data[testResults.optParamName] ? res.data[testResults.optParamName] : bestValue
        res.bestPropVal = bestValue < res.data[testResults.optParamName] ? propVale : bestPropVal
        if (bestValue < res.data[testResults.optParamName]) {
          res.isBestChanged = true
          res.bestPropVal = prepareFullBestPropVal(testResults, res.bestPropVal)
          console.log(`Best value max: ${bestValue} => ${res.bestValue}`, res.bestPropVal)
          // Trigger autosave whenever a better maximum is found
          if (testResults.autoBestDownload && typeof backtest._autosaveOnBest === 'function') {
            backtest._autosaveOnBest(testResults, res)
          }
          testResults.bestResultRow = { ...res.data }
        } else {
          res.isBestChanged = false
        }

      } else {
        res.bestValue = bestValue > res.data[testResults.optParamName] ? res.data[testResults.optParamName] : bestValue
        res.bestPropVal = bestValue > res.data[testResults.optParamName] ? propVale : bestPropVal
        if (bestValue > res.data[testResults.optParamName]) {
          res.isBestChanged = true
          res.bestPropVal = prepareFullBestPropVal(testResults, res.bestPropVal)
          console.log(`Best value min: ${bestValue} => ${res.bestValue}`)
          // Trigger autosave whenever a better minimum is found
          if (testResults.autoBestDownload && typeof backtest._autosaveOnBest === 'function') {
            backtest._autosaveOnBest(testResults, res)
          }
          testResults.bestResultRow = { ...res.data }
        } else {
          res.isBestChanged = false
        }
      }
    } else {
      res.isFiltered = true
    }
  } else {
    res.bestValue = bestValue
    res.bestPropVal = bestPropVal
    res.currentValue = `${testResults.optParamName} missed in data`
  }
  return res
}

function calculateAdditionValuesToReport(report) {
  // TODO
  return report
}


function randomNormalDistribution(min, max) {
  let u = 0, v = 0;
  while (u === 0) u = crypto.getRandomValues(new Uint16Array(1))[0] / 65536 //Math.random(); //Converting [0,1) to (0,1)
  while (v === 0) v = crypto.getRandomValues(new Uint16Array(1))[0] / 65536 //Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5; // Translate to 0 -> 1
  if (num > 1 || num < 0)
    return randomNormalDistribution() // resample between 0 and 1
  else {
    num *= max - min // Stretch to fill range
    num += min // offset to min
  }
  return num
}

if (typeof window !== 'undefined') {
  window.iondvDebugBestFilters = async () => {
    try {
      const testResults = await storage.getKey(storage.STRATEGY_KEY_RESULTS)
      if (!testResults) {
        console.warn('No test results in storage.')
        return null
      }
      const bestRow = model.getBestResult(testResults)
      if (!bestRow || typeof bestRow !== 'object') {
        console.warn('No best result row located. Ensure a test run finished.')
        return null
      }
      const diagnostics = _inspectFilters(testResults, bestRow)
      console.group('iondvDebugBestFilters')
      console.log('Active filters:', diagnostics)
      console.log('Best row sample:', bestRow)
      console.groupEnd()
      return diagnostics
    } catch (err) {
      console.error('iondvDebugBestFilters failed', err)
      return null
    }
  }
}

function randomInteger(min = 0, max = 10) {
  let lo = Math.ceil(min)
  let hi = Math.floor(max)
  if (hi < lo) {
    const swap = lo
    lo = hi
    hi = swap
  }
  if (hi === lo)
    return lo
  // Math.random avoids crypto allocations; faster for heavy GA loops.
  return Math.floor(Math.random() * (hi - lo + 1)) + lo
}

// Random optimization
async function optAllRandomIteration(allRangeParams, testResults, bestValue, bestPropVal, optimizationState) {
  const propData = optRandomGetPropertiesValues(allRangeParams, null, testResults.paramConditions)
  let propVal = propData.data
  const changedParam = propData.hasOwnProperty('changedParam') ? propData.changedParam : null
  if (bestPropVal)
    propVal = expandPropVal(propVal, bestPropVal)

  const res = await backtest.getTestIterationResult(testResults, propVal, false, false, changedParam)
  if (!res || !res.data || res.error !== null)
    return res
  res.data['comment'] = res.data['comment'] ? res.data['comment'] + propData.message : propData.message
  if (!res.message)
    res.message = propData.message
  else
    res.message += propData.message
  return await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal)
}


async function optRandomIteration(allRangeParams, testResults, bestValue, bestPropVal, optimizationState) {
  const propData = optRandomGetPropertiesValues(allRangeParams, bestPropVal)
  let propVal = propData.data

  if (bestPropVal)
    propVal = expandPropVal(propVal, bestPropVal)

  const res = await backtest.getTestIterationResult(testResults, propVal)
  if (!res || !res.data || res.error !== null)
    return res
  res.data['comment'] = res.data['comment'] ? res.data['comment'] + propData.message : propData.message
  if (!res.message)
    res.message = propData.message
  else
    res.message += propData.message
  return await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal)
}

function optRandomGetPropertiesValues(allRangeParams, curPropVal) {
  const propVal = {}
  let msg = ''
  const allParamNames = Object.keys(allRangeParams)
  const validParamNames = allParamNames.filter(paramName => {
    const domain = allRangeParams[paramName]
    return Array.isArray(domain) && domain.some(value => typeof value !== 'undefined')
  })
  if (curPropVal) {
    allParamNames.forEach(paramName => {
      propVal[paramName] = curPropVal[paramName]
    })
    if (!validParamNames.length) {
      msg = 'No mutable parameters available: all candidate domains are empty.'
      return { message: msg, data: propVal }
    }
    const indexToChange = randomInteger(0, validParamNames.length - 1)
    const paramName = validParamNames[indexToChange]
    const curVal = propVal[paramName]
    const domain = allRangeParams[paramName].filter(paramVal => typeof paramVal !== 'undefined')
    const diffParams = domain.filter(paramVal => paramVal !== curVal)
    propVal[paramName] = diffParams.length === 0 ? curVal : diffParams.length === 1 ? diffParams[0] : diffParams[randomInteger(0, diffParams.length - 1)]
    msg = `Changed "${paramName}": ${curVal} => ${propVal[paramName]}.`
  } else {
    validParamNames.forEach(paramName => {
      const domain = allRangeParams[paramName].filter(paramVal => typeof paramVal !== 'undefined')
      propVal[paramName] = domain[randomInteger(0, domain.length - 1)]
    })
    const skippedCount = allParamNames.length - validParamNames.length
    msg = skippedCount > 0
      ? `All parameters are changed randomly. Skipped ${skippedCount} parameter(s) with empty domains.`
      : 'All parameters are changed randomly.'
  }
  return { message: msg, data: propVal }
}

function expandPropVal(propVal, basePropVal) {
  const newPropVal = {}
  Object.keys(basePropVal).forEach(key => {
    if (propVal.hasOwnProperty(key))
      newPropVal[key] = propVal[key]
    else
      newPropVal[key] = basePropVal[key]
  })
  return newPropVal
}


// Genetic algorithm optimisation
function gaNumericFitness(value) {
  if (value === null || typeof value === 'undefined')
    return null
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : null
  const cleaned = String(value).replace(/[^0-9.+\-eE]/g, '')
  if (!cleaned)
    return null
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

function gaHasMeaningfulImprovement(currentValue, bestValue, isMaximizing) {
  const current = gaNumericFitness(currentValue)
  const best = gaNumericFitness(bestValue)
  if (!Number.isFinite(current))
    return false
  if (!Number.isFinite(best))
    return true
  const diff = isMaximizing ? current - best : best - current
  const epsilon = Math.max(1, Math.abs(best)) * 0.0001
  return diff > epsilon
}

function gaBuildParamMetadata(allRangeParams, paramNames) {
  const metadata = {}
  paramNames.forEach(name => {
    const domain = (allRangeParams[name] || []).filter(value => typeof value !== 'undefined')
    const boolDomain = domain.length === 2 && domain.every(value => value === true || value === false || value === 'true' || value === 'false')
    const allNumeric = domain.length > 0 && domain.every(value => typeof value === 'number' && Number.isFinite(value))
    metadata[name] = {
      type: boolDomain ? 'boolean' : allNumeric ? 'ordinal' : 'categorical',
      domain: allNumeric ? domain.slice().sort((a, b) => a - b) : domain
    }
  })
  return metadata
}

function gaScaledMutationRate(paramCount, expectedGenes, maxRate) {
  const n = paramCount > 0 ? paramCount : 1
  return Math.min(maxRate, Math.max(1, expectedGenes) / n)
}

// GA-local sampler: copy the anchor (incumbent best, else baseline) and re-roll k=1..3 params, keeping candidates near a known-feasible region instead of full-space random (which sat far from the incumbent and got filtered/no-trade). Single-value/empty domains are skipped.
function gaSampleNearBest(allRangeParams, anchorParams, k, paramNames) {
  const names = (paramNames && paramNames.length) ? paramNames : Object.keys(allRangeParams)
  const candidate = {}
  names.forEach(name => {
    const domain = (allRangeParams[name] || []).filter(value => typeof value !== 'undefined')
    let value = anchorParams ? anchorParams[name] : undefined
    if (typeof value === 'undefined')
      value = domain.length ? domain[randomInteger(0, domain.length - 1)] : undefined
    candidate[name] = value
  })
  const mutable = names.filter(name => {
    const domain = (allRangeParams[name] || []).filter(value => typeof value !== 'undefined')
    return domain.some(value => value !== candidate[name])
  })
  if (!mutable.length)
    return candidate
  const count = Math.max(1, Math.min(k || 1, mutable.length))
  const pool = mutable.slice()
  for (let i = 0; i < count; i++) {
    const j = randomInteger(i, pool.length - 1)
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp
    const name = pool[i]
    const alts = (allRangeParams[name] || []).filter(value => typeof value !== 'undefined' && value !== candidate[name])
    if (alts.length)
      candidate[name] = alts[randomInteger(0, alts.length - 1)]
  }
  return candidate
}

function gaTrimCache(cache, maxSize) {
  if (!cache || !maxSize || cache.size <= maxSize)
    return
  for (const key of cache.keys()) {
    cache.delete(key)
    if (cache.size <= maxSize)
      break
  }
}

function gaTrimSeen(optimizationState) {
  if (!optimizationState || !optimizationState.seen || !optimizationState.seenLimit || optimizationState.seen.size <= optimizationState.seenLimit)
    return
  const eliteKeys = new Set((optimizationState.population || []).slice(0, optimizationState.eliteCount || 2).map(entry => gaEncodeKey(entry.params, optimizationState.paramNames)))
  for (const key of optimizationState.seen) {
    if (!eliteKeys.has(key))
      optimizationState.seen.delete(key)
    if (optimizationState.seen.size <= optimizationState.seenLimit)
      break
  }
}

async function optGeneticIteration(allRangeParams, testResults, bestValue, bestPropVal, optimizationState) {
  gaInitState(allRangeParams, testResults, optimizationState)
  const candidateData = gaGenerateCandidate(allRangeParams, testResults, optimizationState)
  if (!candidateData || !candidateData.candidate) {
    return { error: 1, message: 'Genetic algorithm failed to prepare a candidate.', data: {} }
  }
  const { candidate, key, meta } = candidateData
  const propVal = bestPropVal ? expandPropVal(candidate, bestPropVal) : candidate

  const cache = optimizationState.cache
  let res = null
  let cacheHit = false
  if (key && cache && cache.has(key)) {
    const cached = cache.get(key)
    if (cached && cached.error === null) {
      res = gaCloneResult(cached)
      cacheHit = true
    }
  }
  if (!res)
    res = await backtest.getTestIterationResult(testResults, propVal)
  if (!res || !res.data || res.error !== null) {
    if (key && optimizationState.seen)
      optimizationState.seen.delete(key)
    return res
  }
  if (key && cache && res.error === null) {
    cache.set(key, gaCloneResult(res))
    gaTrimCache(cache, optimizationState.cacheLimit)
  }

  const description = gaDescribeCandidate(meta, optimizationState)
  if (description) {
    res.data['comment'] = res.data['comment'] ? `${res.data['comment']} ${description}` : description
    res.message = res.message ? `${res.message} ${description}` : description
  }

  const objectiveValue = res.data.hasOwnProperty(testResults.optParamName) ? res.data[testResults.optParamName] : null
  // parse the objective once (0 is valid). Feasible candidates store normally; infeasible-but-scored ones store as penalized learning entries (feasible=false) so a wasted backtest still yields selection gradient. getResWithBestValue re-applies the user filter + min-trades gate, so a penalized entry can never become the reported best or autosave.
  const parsedObjective = gaNumericFitness(objectiveValue)
  const hasNumericObjective = res.error === null && parsedObjective !== null
  const feasible = hasNumericObjective && _isFeasibleForGA(testResults, res.data)
  if (feasible) {
    const metrics = _getSecondaryMetrics(res.data)
    gaStoreCandidate(optimizationState, propVal, parsedObjective, testResults.isMaximizing, metrics, true)
  } else if (hasNumericObjective) {
    const metrics = _getSecondaryMetrics(res.data)
    gaStoreCandidate(optimizationState, propVal, parsedObjective, testResults.isMaximizing, metrics, false)
  }

  optimizationState.evaluated = (optimizationState.evaluated || 0) + 1
  if (optimizationState.populationSize && optimizationState.evaluated % optimizationState.populationSize === 0)
    optimizationState.generation = (optimizationState.generation || 1) + 1

  let out = await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal, cacheHit)
  // Track generation-level improvement for stagnation logic
  if (out && out.isBestChanged && feasible && gaHasMeaningfulImprovement(parsedObjective, bestValue, testResults.isMaximizing)) {
    optimizationState.lastImprovementGeneration = optimizationState.generation || 1
    optimizationState.lastImprovementEval = optimizationState.evaluated || 0
  }
  return out
}

function gaInitState(allRangeParams, testResults, optimizationState) {
  if (optimizationState.isInit)
    return
  optimizationState.isInit = true
  optimizationState.paramNames = Object.keys(allRangeParams).filter(paramName => {
    const domain = allRangeParams[paramName]
    return Array.isArray(domain) && domain.some(value => typeof value !== 'undefined')
  })
  optimizationState.populationSize = Math.max(4, Math.min(12, Math.floor(testResults.cycles / 4)))
  if (optimizationState.populationSize > optimizationState.paramNames.length * 3)
    optimizationState.populationSize = Math.max(4, optimizationState.paramNames.length * 3)
  optimizationState.population = []
  optimizationState.mutationRate = gaScaledMutationRate(optimizationState.paramNames.length, MUT_EXPECTED_GENES, 0.25)
  optimizationState.randomRate = 0.1
  optimizationState.baseMutationRate = optimizationState.mutationRate
  optimizationState.baseRandomRate = optimizationState.randomRate
  optimizationState.eliteCount = Math.max(2, Math.floor(optimizationState.populationSize * 0.25))
  optimizationState.localSearchQueue = []
  optimizationState.seen = new Set()
  optimizationState.cache = new Map()
  optimizationState.paramMetadata = gaBuildParamMetadata(allRangeParams, optimizationState.paramNames)
  optimizationState.seenLimit = Math.max(1000, (Number(testResults.cycles) || 100) * 2)
  optimizationState.cacheLimit = Math.max(500, (Number(testResults.cycles) || 100))
  optimizationState.lastImprovementEval = 0
  optimizationState.plateauEvalThreshold = Math.max(10, optimizationState.populationSize * 2)
  optimizationState.restartEvalThreshold = Math.max(20, optimizationState.populationSize * 4)
  optimizationState.generation = 1
  optimizationState.evaluated = 0
  if (!optimizationState.paramNames.length)
    return

  const baselineSeed = gaDeriveBaselineSeed(testResults, optimizationState.paramNames)
  if (baselineSeed) {
    gaStoreCandidate(optimizationState, baselineSeed.params, baselineSeed.fitness, testResults.isMaximizing, null)
    if (baselineSeed.key)
      optimizationState.seen.add(baselineSeed.key)
  }
}

function gaGenerateCandidate(allRangeParams, testResults, optimizationState) {
  let population = optimizationState.population
  const paramNames = optimizationState.paramNames
  let seen = optimizationState.seen
  const maxAttempts = 5
  let attempt = 0
  let candidate = null
  let key = null
  let meta = null

  const gen = optimizationState.generation || 1
  const lastImp = optimizationState.lastImprovementGeneration || 0
  const noImpGens = Math.max(0, gen - lastImp)
  const noImpEvals = Math.max(0, (optimizationState.evaluated || 0) - (optimizationState.lastImprovementEval || 0))
  const plateauByEval = noImpEvals >= (optimizationState.plateauEvalThreshold || 10)
  const restartByEval = noImpEvals >= (optimizationState.restartEvalThreshold || 20)

  // Stagnation restart: keep top eliteCount, clear rest, force fresh exploration
  if ((noImpGens >= 5 || restartByEval) && population && population.length > 0 && optimizationState._restartedAtGen !== gen && optimizationState._restartedAtEval !== optimizationState.evaluated) {
    const eliteCount = optimizationState.eliteCount || 2
    const elites = population.slice(0, Math.min(eliteCount, population.length))
    optimizationState.population = elites
    optimizationState.seen = new Set()
    for (const elite of elites) {
      optimizationState.seen.add(gaEncodeKey(elite.params, paramNames))
    }
    optimizationState.mutationRate = optimizationState.baseMutationRate || 0.25
    optimizationState.randomRate = optimizationState.baseRandomRate || 0.1
    optimizationState.lastImprovementGeneration = gen
    optimizationState.lastImprovementEval = optimizationState.evaluated || 0
    optimizationState._restartedAtGen = gen
    optimizationState._restartedAtEval = optimizationState.evaluated || 0
    optimizationState.restartCount = (optimizationState.restartCount || 0) + 1
    optimizationState.localSearchQueue = []
    // Rebind locals to the fresh state
    population = optimizationState.population
    seen = optimizationState.seen
    console.log(`[TV-ASS GA] Stagnation restart at gen ${gen}: kept ${elites.length} elites`)
  } else if (noImpGens >= 3 || plateauByEval) {
    optimizationState.plateauBoostCount = (optimizationState.plateauBoostCount || 0) + 1
    optimizationState.mutationRate = gaScaledMutationRate(optimizationState.paramNames.length, Math.min(MUT_MAX_GENES, MUT_EXPECTED_GENES * 2), 0.6)
    optimizationState.randomRate = Math.min(0.6, (optimizationState.baseRandomRate || 0.1) * 2)
  } else {
    optimizationState.mutationRate = optimizationState.baseMutationRate || 0.25
    optimizationState.randomRate = optimizationState.baseRandomRate || 0.1
  }
  // Clear restart guard once a new generation starts
  if (optimizationState._restartedAtGen && optimizationState._restartedAtGen !== gen)
    optimizationState._restartedAtGen = null
  if (optimizationState._restartedAtEval && optimizationState._restartedAtEval !== optimizationState.evaluated)
    optimizationState._restartedAtEval = null

  // Local search: at generation boundary, queue single-param perturbations of the best individual
  const lsQueue = optimizationState.localSearchQueue
  if (lsQueue && lsQueue.length === 0 && population && population.length > 0 &&
      optimizationState.evaluated > 0 && optimizationState.evaluated % optimizationState.populationSize === 0) {
    const best = population[0]
    const shuffled = paramNames.slice().sort(() => Math.random() - 0.5)
    const lsCount = Math.min(5, shuffled.length)
    for (let li = 0; li < lsCount; li++) {
      const pName = shuffled[li]
      const domain = allRangeParams[pName]
      if (!domain || !domain.length) continue
      const altValues = domain.filter(v => v !== best.params[pName] && typeof v !== 'undefined')
      if (!altValues.length) continue
      const neighbor = gaCloneParams(paramNames, best.params)
      neighbor[pName] = altValues[randomInteger(0, altValues.length - 1)]
      const nKey = gaEncodeKey(neighbor, paramNames)
      if (!seen.has(nKey)) {
        lsQueue.push({ params: neighbor, key: nKey, param: pName })
      }
    }
  }

  // Service local search queue before crossover (already de-duped against seen on enqueue)
  while (lsQueue && lsQueue.length > 0) {
    const ls = lsQueue.shift()
    if (!seen.has(ls.key)) {
      seen.add(ls.key)
      gaTrimSeen(optimizationState)
      return { candidate: ls.params, key: ls.key, meta: { kind: 'local-search', param: ls.param } }
    }
    // Already seen (e.g. restart cleared+refilled seen), skip to next
  }

  const anchorParams = (population && population.length && population[0] && population[0].params)
    ? population[0].params
    : (testResults.bestPropVal && typeof testResults.bestPropVal === 'object' ? testResults.bestPropVal : null)
  const NEAR_ANCHOR_SHARE = 0.8

  while (attempt < maxAttempts) {
    meta = null
    if (!population || population.length < optimizationState.populationSize) {
      if (anchorParams && gaRandomFloat() < NEAR_ANCHOR_SHARE)
        candidate = gaSampleNearBest(allRangeParams, anchorParams, randomInteger(1, 3), paramNames)
      else
        candidate = optRandomGetPropertiesValues(allRangeParams, null).data
      meta = { kind: population && population.length ? 'seed-extend' : 'seed' }
    } else {
      const useRandom = gaRandomFloat() < optimizationState.randomRate
      if (useRandom) {
        if (anchorParams && gaRandomFloat() < NEAR_ANCHOR_SHARE)
          candidate = gaSampleNearBest(allRangeParams, anchorParams, randomInteger(1, 3), paramNames)
        else
          candidate = optRandomGetPropertiesValues(allRangeParams, null).data
        meta = { kind: 'random' }
      } else {
        const parentA = gaSelectParent(population, testResults.isMaximizing)
        const parentB = gaSelectParent(population, testResults.isMaximizing, parentA ? parentA.index : null)
        if (!parentA || !parentB) {
          candidate = optRandomGetPropertiesValues(allRangeParams, null).data
          meta = { kind: 'random' }
        } else {
          const crossRes = gaCrossover(parentA.entry.params, parentB.entry.params, paramNames)
          const mutationRes = gaMutate(crossRes.child, allRangeParams, optimizationState.mutationRate, optimizationState.paramMetadata)
          candidate = mutationRes.child
          meta = {
            kind: 'crossover',
            mix: crossRes.mix,
            mutated: mutationRes.mutated,
            parentFitness: [parentA.entry.fitness, parentB.entry.fitness]
          }
        }
        if (!meta)
          meta = { kind: 'random' }
      }
    }

    key = gaEncodeKey(candidate, paramNames)
    if (!seen.has(key)) {
      seen.add(key)
      gaTrimSeen(optimizationState)
      return { candidate: gaCloneParams(paramNames, candidate), key, meta }
    }
    attempt += 1
  }
  key = gaEncodeKey(candidate, optimizationState.paramNames)
  seen.add(key)
  gaTrimSeen(optimizationState)
  return { candidate: gaCloneParams(optimizationState.paramNames, candidate), key, meta }
}

function gaStoreCandidate(optimizationState, params, fitness, isMaximizing, metrics = null, feasible = true) {
  const clone = gaCloneParams(optimizationState.paramNames, params)
  const numericFitness = gaNumericFitness(fitness)
  const safeFitness = Number.isFinite(numericFitness) ? numericFitness : null
  const entry = { params: clone, fitness: safeFitness, metrics: metrics || {}, feasible: feasible !== false }
  optimizationState.population.push(entry)
  const cmp = (a, b) => {
    const aFeasible = a.feasible !== false, bFeasible = b.feasible !== false
    if (aFeasible !== bFeasible) return aFeasible ? -1 : 1
    // Primary objective
    const af = a.fitness, bf = b.fitness
    if (af === null && bf === null) return 0
    if (af === null) return 1
    if (bf === null) return -1
    if (af !== bf) return isMaximizing ? (bf - af) : (af - bf)
    // Tie-breakers: winRate desc, trades desc, maxDD asc
    const aw = (a.metrics && typeof a.metrics.winRate === 'number') ? a.metrics.winRate : null
    const bw = (b.metrics && typeof b.metrics.winRate === 'number') ? b.metrics.winRate : null
    if (aw !== null || bw !== null) {
      if (aw === null) return 1
      if (bw === null) return -1
      if (aw !== bw) return bw - aw
    }
    const at = (a.metrics && typeof a.metrics.trades === 'number') ? a.metrics.trades : null
    const bt = (b.metrics && typeof b.metrics.trades === 'number') ? b.metrics.trades : null
    if (at !== null || bt !== null) {
      if (at === null) return 1
      if (bt === null) return -1
      if (at !== bt) return bt - at
    }
    const ad = (a.metrics && typeof a.metrics.maxDD === 'number') ? a.metrics.maxDD : null
    const bd = (b.metrics && typeof b.metrics.maxDD === 'number') ? b.metrics.maxDD : null
    if (ad !== null || bd !== null) {
      if (ad === null) return 1
      if (bd === null) return -1
      if (ad !== bd) return ad - bd
    }
    return 0
  }
  optimizationState.population.sort(cmp)
  if (optimizationState.population.length > optimizationState.populationSize)
    optimizationState.population.pop()
}

function gaSelectParent(population, isMaximizing, excludeIndex = null) {
  if (!population || !population.length)
    return null
  const tournamentSize = Math.min(3, population.length)
  let winner = null
  for (let i = 0; i < tournamentSize; i++) {
    let idx = randomInteger(0, population.length - 1)
    if (excludeIndex !== null && population.length > 1) {
      let guard = 0
      while (idx === excludeIndex && guard < population.length * 2) {
        idx = randomInteger(0, population.length - 1)
        guard += 1
      }
    }
    const entry = population[idx]
    if (!winner) {
      winner = { entry, index: idx }
      continue
    }
    if (gaEntryBetter(entry, winner.entry, isMaximizing))
      winner = { entry, index: idx }
  }
  if (!winner)
    return { entry: population[0], index: 0 }
  return winner
}

function gaEntryBetter(a, b, isMaximizing) {
  if (!b) return true
  if (!a) return false
  const aFeasible = a.feasible !== false, bFeasible = b.feasible !== false
  if (aFeasible !== bFeasible) return aFeasible
  const af = a.fitness, bf = b.fitness
  if (af === null && bf === null) return false
  if (af === null) return false
  if (bf === null) return true
  if (af !== bf) return isMaximizing ? (af > bf) : (af < bf)
  const aw = a.metrics && typeof a.metrics.winRate === 'number' ? a.metrics.winRate : null
  const bw = b.metrics && typeof b.metrics.winRate === 'number' ? b.metrics.winRate : null
  if (aw !== null || bw !== null) {
    if (aw === null) return false
    if (bw === null) return true
    if (aw !== bw) return aw > bw
  }
  const at = a.metrics && typeof a.metrics.trades === 'number' ? a.metrics.trades : null
  const bt = b.metrics && typeof b.metrics.trades === 'number' ? b.metrics.trades : null
  if (at !== null || bt !== null) {
    if (at === null) return false
    if (bt === null) return true
    if (at !== bt) return at > bt
  }
  const ad = a.metrics && typeof a.metrics.maxDD === 'number' ? a.metrics.maxDD : null
  const bd = b.metrics && typeof b.metrics.maxDD === 'number' ? b.metrics.maxDD : null
  if (ad !== null || bd !== null) {
    if (ad === null) return false
    if (bd === null) return true
    if (ad !== bd) return ad < bd
  }
  return false
}

function gaCrossover(parentAParams, parentBParams, paramNames) {
  const child = {}
  let fromA = 0
  paramNames.forEach(name => {
    const pickFromA = randomInteger(0, 1) === 0
    child[name] = pickFromA ? parentAParams[name] : parentBParams[name]
    if (pickFromA)
      fromA += 1
  })
  return { child, mix: paramNames.length ? fromA / paramNames.length : 0.5 }
}

function gaMutate(child, allRangeParams, mutationRate, paramMetadata = null) {
  const mutated = []
  Object.keys(child).forEach(name => {
    const metadata = paramMetadata && paramMetadata[name] ? paramMetadata[name] : null
    const domain = metadata && metadata.domain ? metadata.domain : allRangeParams[name]
    if (!domain || !domain.length)
      return
    if (gaRandomFloat() < mutationRate) {
      const diff = domain.filter(val => val !== child[name])
      if (!diff.length)
        return
      let newVal = diff[randomInteger(0, diff.length - 1)]
      if (metadata && metadata.type === 'boolean') {
        const opposite = domain.find(val => val !== child[name])
        if (typeof opposite !== 'undefined')
          newVal = opposite
      } else if (metadata && metadata.type === 'ordinal') {
        const idx = domain.indexOf(child[name])
        if (idx >= 0) {
          const neighbors = []
          if (idx > 0) neighbors.push(domain[idx - 1])
          if (idx < domain.length - 1) neighbors.push(domain[idx + 1])
          if (neighbors.length)
            newVal = neighbors[randomInteger(0, neighbors.length - 1)]
        }
      }
      child[name] = newVal
      mutated.push({ name, value: newVal })
    }
  })
  return { child, mutated }
}

function gaEncodeKey(params, paramNames) {
  const keys = paramNames || Object.keys(params)
  return keys.map(name => `${name}:${params[name]}`).join('|')
}

function gaCloneParams(paramNames, params) {
  const clone = {}
  paramNames.forEach(name => {
    clone[name] = params[name]
  })
  return clone
}

function gaCloneResult(result) {
  if (!result)
    return result
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(result)
    } catch {
      // Fall back to JSON copy below.
    }
  }
  return JSON.parse(JSON.stringify(result))
}

function gaClonePlainObject(obj) {
  if (!obj || typeof obj !== 'object')
    return obj
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj)
    } catch {
    }
  }
  return JSON.parse(JSON.stringify(obj))
}

function gaDiffCandidate(previous, next) {
  const diff = {}
  let changed = 0
  if (!next || typeof next !== 'object')
    return { diff, changed }
  const prevObj = previous && typeof previous === 'object' ? previous : null
  Object.keys(next).forEach(key => {
    const nextVal = next[key]
    if (!prevObj || !gaValuesEqual(prevObj[key], nextVal)) {
      diff[key] = nextVal
      changed += 1
    }
  })
  return { diff, changed }
}

function gaValuesEqual(a, b) {
  if (a === b)
    return true
  if (a === undefined || b === undefined)
    return false
  const canCoerceNumber = value => {
    if (typeof value === 'number')
      return Number.isFinite(value)
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed.length)
        return false
      const parsed = Number(trimmed)
      return Number.isFinite(parsed)
    }
    return false
  }
  if (canCoerceNumber(a) && canCoerceNumber(b)) {
    const numA = Number(a)
    const numB = Number(b)
    return Math.abs(numA - numB) < 1e-9
  }
  return String(a) === String(b)
}

function gaRandomFloat() {
  return Math.random()
}

function gaDeriveBaselineSeed(testResults, paramNames) {
  if (!testResults || !paramNames || !paramNames.length)
    return null
  if (!testResults.bestPropVal || typeof testResults.bestValue === 'undefined' || testResults.bestValue === null)
    return null
  const fitness = Number(testResults.bestValue)
  if (!Number.isFinite(fitness))
    return null
  const params = {}
  for (const name of paramNames) {
    if (!Object.prototype.hasOwnProperty.call(testResults.bestPropVal, name))
      return null
    if (typeof testResults.bestPropVal[name] === 'undefined')
      return null
    params[name] = testResults.bestPropVal[name]
  }
  const key = gaEncodeKey(params, paramNames)
  return { params, fitness, key }
}

function gaDescribeCandidate(meta, optimizationState) {
  const generation = optimizationState.generation || 1
  if (!meta)
    return `Gen ${generation}: random candidate.`
  let message = `Gen ${generation}: `
  switch (meta.kind) {
    case 'seed':
      message += 'initial population candidate.'
      break
    case 'seed-extend':
      message += 'population warm-up candidate.'
      break
    case 'random':
      message += 'diversity random injection.'
      break
    case 'crossover':
      const share = Math.round((meta.mix || 0) * 100)
      message += `crossover child (${isNaN(share) ? 50 : share}% genes from parent A).`
      if (meta.parentFitness && meta.parentFitness.length === 2)
        message += ` Parents fitness: ${meta.parentFitness[0]} / ${meta.parentFitness[1]}.`
      break
    case 'local-search':
      message += `local search on "${meta.param || '?'}".`
      break
    default:
      message += 'genetic candidate.'
  }
  if (meta.mutated && meta.mutated.length) {
    const mutatedList = meta.mutated.slice(0, 3).map(item => `${item.name}=${item.value}`)
    message += ` Mutated ${mutatedList.join(', ')}${meta.mutated.length > 3 ? '…' : ''}.`
  }
  return message.trim()
}


// Cross-Entropy Method (CEM) optimisation (discrete-only via provided ranges)
// feasibility is a learning WEIGHT, not a storage gate: store every scored candidate (feasible + penalized-infeasible) in the persistent archive so low-feasibility runs still learn; count evaluated samples per round so the distribution always advances; cache evaluated tuples to skip re-spending a backtest on a duplicate. getResWithBestValue re-applies the user filter + min-trades gate, so a penalized entry can never become the reported best or autosave.
async function optCEMIteration(allRangeParams, testResults, bestValue, bestPropVal, optimizationState) {
  cemInitState(allRangeParams, testResults, optimizationState, bestPropVal)
  const sample = cemGenerateCandidate(allRangeParams, optimizationState)
  if (!sample || !sample.params) {
    return { error: 1, message: 'CEM failed to prepare a candidate.', data: {} }
  }
  const propVal = bestPropVal ? expandPropVal(sample.params, bestPropVal) : sample.params
  let res = await backtest.getTestIterationResult(testResults, propVal)
  if (!res || !res.data)
    return res

  // Run through standard filters/best-value update first so res.isFiltered is set
  const out = await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal)

  // Parse objective + feasibility flag (flag = learning WEIGHT now, not a storage GATE)
  const objectiveValue = out && out.data && Object.hasOwn(out.data, testResults.optParamName) ? out.data[testResults.optParamName] : null
  const metrics = _getSecondaryMetrics(out && out.data ? out.data : {})
  const { trades } = metrics
  const minTrades = _computeMinTrades(testResults)
  const hasTrades = typeof trades === 'number' && trades >= minTrades
  // Early relaxed drawdown gate for learning in first rounds
  let relaxedOK = false
  if (optimizationState.round <= (optimizationState.cemRelaxRounds || 2)) {
    const ddPct = _getDrawdownPercent(out && out.data ? out.data : null)
    const limit = Number(optimizationState.cemEarlyDDLimit || 20)
    if (Number.isFinite(ddPct) && ddPct <= limit)
      relaxedOK = true
  }
  const feasible = out && out.error === null && objectiveValue !== null && hasTrades && (!out.isFiltered || relaxedOK)
  // Store every candidate that produced a numeric objective (feasible-first ranking handles
  // the penalty); a null/missing objective stores nothing but STILL counts toward the round
  // budget below so a one-off parse miss can never stall adaptation.
  if (objectiveValue !== null) {
    cemStoreEntry(optimizationState, sample.params, objectiveValue, feasible, testResults.isMaximizing, sample.key, metrics)
  }
  // cache only tuples that yielded a numeric objective: a null/transient parse miss is deliberately not cached, so the same tuple stays retryable instead of being permanently suppressed (seen-dedup still applies but is bounded via cemTrimSeen)
  if (sample.key && objectiveValue !== null && optimizationState.cemCache) {
    optimizationState.cemCache.set(sample.key, objectiveValue)
    cemTrimCache(optimizationState)
  }
  optimizationState.cemRoundEvaluated = (optimizationState.cemRoundEvaluated || 0) + 1
  // Annotate iteration with CEM progress tag
  try {
    const tag = `CEM r${optimizationState.round || 1} s${(optimizationState.cemBatchCount || 0) + 1}/${optimizationState.cemBatchSize || '?'}`
    out.data['comment'] = out.data['comment'] ? `${out.data['comment']} ${tag}.` : `${tag}.`
    out.message = out.message ? `${out.message} ${tag}.` : `${tag}.`
  } catch {}
  optimizationState.cemBatchCount = (optimizationState.cemBatchCount || 0) + 1
  // Update distribution at the end of a batch
  const note = cemMaybeUpdateDistribution(optimizationState, testResults.isMaximizing)
  if (note) {
    try {
      out.data['comment'] = out.data['comment'] ? `${out.data['comment']} ${note}` : note
      out.message = out.message ? `${out.message} ${note}` : note
    } catch {}
  }

  return out
}

function cemInitState(allRangeParams, testResults, optimizationState, bestPropVal) {
  if (optimizationState.cemInit)
    return
  optimizationState.cemInit = true
  optimizationState.paramNames = Object.keys(allRangeParams)
  optimizationState.domains = {}
  optimizationState.prob = {}
  optimizationState.seen = new Set()
  optimizationState.round = 1
  optimizationState.cemBatchCount = 0
  // Persistent learning memory (replaces the throw-away per-round batch)
  optimizationState.cemArchive = []
  optimizationState.cemCache = new Map()
  optimizationState.cemLocalQueue = []
  optimizationState.cemBestEver = null
  optimizationState.cemRoundEvaluated = 0
  optimizationState.cemUpdates = 0
  // Defaults derived from cycles
  const cycles = Math.max(1, Number(testResults.cycles) || 100)
  const rounds = Math.max(2, Math.min(8, Number(testResults.cemRounds) || 4))
  let batchSize = Number(testResults.cemBatchSize)
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    // Smaller batches so adaptation is visible sooner
    batchSize = Math.min(100, Math.max(20, Math.floor(cycles / 4)))
  }
  // Guarantee >=1 update within budget even when cycles < batchSize (incl. cycles=1)
  batchSize = Math.min(batchSize, Math.max(1, Math.floor(cycles / 2)))
  const eliteFrac = Math.max(0.05, Math.min(0.5, Number(testResults.cemEliteFraction) || 0.2))
  optimizationState.cemRounds = rounds
  optimizationState.cemBatchSize = batchSize
  optimizationState.cemEliteFrac = eliteFrac
  // Gentler smoothing than the old fixed 0.7 (anti-collapse / genetic-drift); configurable
  let alpha = Number(testResults.cemAlpha)
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) alpha = 0.3
  optimizationState.cemAlpha = alpha
  // Per-domain probability floor fraction (eps = floorFrac / K) — replaces the ~zero 1e-6 floor
  let floorFrac = Number(testResults.cemProbFloor)
  if (!Number.isFinite(floorFrac) || floorFrac < 0 || floorFrac >= 1) floorFrac = 0.1
  optimizationState.cemProbFloorFrac = floorFrac
  optimizationState.cemRelaxRounds = 2
  // Early relaxed drawdown % cap for learning in the first rounds
  optimizationState.cemEarlyDDLimit = Number(testResults.cemEarlyDDLimit) || 20
  // Bounded growth (mirror GA bounds at gaInitState)
  optimizationState.cemArchiveLimit = Math.max(500, cycles * 2)
  optimizationState.seenLimit = Math.max(1000, cycles * 2)

  for (const name of optimizationState.paramNames) {
    const domain = Array.isArray(allRangeParams[name]) ? allRangeParams[name].slice() : []
    optimizationState.domains[name] = domain
    optimizationState.prob[name] = cemWarmStartProb(domain, bestPropVal ? bestPropVal[name] : undefined, floorFrac)
  }

  // Guaranteed incumbent sample: queue the exact incumbent as the FIRST candidate so it is
  // evaluated once up-front and anchors the archive. Bounded path — it is checked only against
  // cemCache (evaluated) / seen at service time and is NEVER pre-added to seen here, so warm-start
  // bookkeeping cannot swallow it before it has been evaluated.
  const incumbent = cemIncumbentCandidate(optimizationState, bestPropVal)
  optimizationState.cemIncumbent = incumbent || null
  if (incumbent)
    optimizationState.cemLocalQueue.push({ params: incumbent, kind: 'incumbent' })
  let nearShare = Number(testResults.cemNearShare)
  if (!Number.isFinite(nearShare) || nearShare < 0 || nearShare > 1) nearShare = CEM_NEAR_ANCHOR_SHARE
  optimizationState.cemNearShare = nearShare
}

function cemEncode(params, paramNames) {
  const keys = paramNames || Object.keys(params)
  return keys.map(k => `${k}:${params[k]}`).join('|')
}

function _cemSampleIndex(probArr) {
  if (!probArr || !probArr.length)
    return 0
  let r = Math.random()
  for (let i = 0; i < probArr.length; i++) {
    r -= probArr[i]
    if (r <= 0)
      return i
  }
  return probArr.length - 1
}

function _cemSampleIndexExcluding(probArr, excludeIdx, domainLen) {
  const n = domainLen || (probArr ? probArr.length : 0)
  if (n <= 1)
    return 0
  let sum = 0
  for (let i = 0; i < n; i++)
    if (i !== excludeIdx && probArr && typeof probArr[i] === 'number')
      sum += probArr[i]
  if (sum > 0) {
    let r = Math.random() * sum
    for (let i = 0; i < n; i++) {
      if (i === excludeIdx)
        continue
      r -= probArr[i]
      if (r <= 0)
        return i
    }
  }
  // Degenerate mass / rounding: return the last valid non-excluded index.
  for (let i = n - 1; i >= 0; i--)
    if (i !== excludeIdx)
      return i
  return 0
}

function cemSampleNearAnchor(optimizationState, anchor, k) {
  const names = optimizationState.paramNames
  const params = {}
  for (const name of names) {
    const domain = optimizationState.domains[name]
    if (!domain || !domain.length) { params[name] = null; continue }
    let v = anchor ? anchor[name] : undefined
    // Anchor value missing/undefined or absent from the domain -> learned draw; never carry undefined through.
    if (typeof v === 'undefined' || domain.indexOf(v) < 0)
      v = domain[_cemSampleIndex(optimizationState.prob[name])]
    if (typeof v === 'undefined') {
      const firstDefined = domain.find(val => typeof val !== 'undefined')
      v = typeof firstDefined !== 'undefined' ? firstDefined : null
    }
    params[name] = v
  }
  const mutable = names.filter(name => {
    const d = optimizationState.domains[name]
    return d && d.length >= 2 && d.some(val => val !== params[name] && typeof val !== 'undefined')
  })
  if (!mutable.length)
    return params
  const count = Math.max(1, Math.min(k || 1, mutable.length))
  const pool = mutable.slice()
  for (let i = 0; i < count; i++) {
    const j = randomInteger(i, pool.length - 1)
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t
    const name = pool[i]
    const domain = optimizationState.domains[name]
    const idxCur = domain.indexOf(params[name])
    const idx = _cemSampleIndexExcluding(optimizationState.prob[name], idxCur, domain.length)
    if (idx >= 0 && idx < domain.length && typeof domain[idx] !== 'undefined')
      params[name] = domain[idx]
  }
  return params
}

function cemGenerateCandidate(allRangeParams, optimizationState) {
  const names = optimizationState.paramNames
  const seen = optimizationState.seen
  const cache = optimizationState.cemCache
  const queue = optimizationState.cemLocalQueue

  // Guaranteed incumbent + local-refinement candidates take priority (bounded by queue length)
  while (queue && queue.length) {
    const item = queue.shift()
    if (!item || !item.params)
      continue
    const k = cemEncode(item.params, names)
    if ((cache && cache.has(k)) || seen.has(k))
      continue
    seen.add(k)
    cemTrimSeen(optimizationState)
    return { params: item.params, key: k, meta: item.kind || 'local' }
  }

  // near-anchor vs full-scatter sampling: with cemNearShare probability, copy the feasible-first best-ever anchor (else the warm-start incumbent) and re-roll k=1..3 params from their learned marginals (mirrors GA gaSampleNearBest), keeping candidates within k params of a known-feasible config; the rest stay a full independent-marginal draw for global exploration
  const anchor = (optimizationState.cemBestEver && optimizationState.cemBestEver.params)
    ? optimizationState.cemBestEver.params
    : optimizationState.cemIncumbent
  const nearShare = anchor ? (optimizationState.cemNearShare || 0) : 0
  let params = {}
  let attempts = 0
  let key = null
  let fresh = false
  let meta = 'sample'
  do {
    if (anchor && Math.random() < nearShare) {
      params = cemSampleNearAnchor(optimizationState, anchor, randomInteger(1, 3))
      meta = 'near'
    } else {
      params = {}
      for (const name of names) {
        const domain = optimizationState.domains[name]
        const p = optimizationState.prob[name]
        if (!domain || !domain.length) {
          params[name] = null
          continue
        }
        const idx = _cemSampleIndex(p)
        params[name] = domain[idx]
      }
      meta = 'sample'
    }
    key = cemEncode(params, names)
    attempts += 1
    fresh = !seen.has(key) && !(cache && cache.has(key))
    // Avoid re-spending a backtest on a duplicate (seen = generated, cache = evaluated)
    if (fresh || attempts > 8)
      break
  } while (true)

  if (!fresh) {
    // Random sampling kept hitting duplicates — deterministically locate an unevaluated tuple
    // rather than returning a known duplicate (which would waste a backtest, violating AC-6).
    const alt = cemFindFreshTuple(optimizationState)
    if (!alt)
      return { params: null, saturated: true } // finite CEM space saturated — caller spends NO backtest
    seen.add(alt.key)
    cemTrimSeen(optimizationState)
    return { params: alt.params, key: alt.key, meta: 'scan' }
  }
  seen.add(key)
  cemTrimSeen(optimizationState)
  return { params, key, meta }
}

function cemStoreEntry(optimizationState, params, fitness, feasible, isMaximizing, key, metrics) {
  const k = key || cemEncode(params, optimizationState.paramNames)
  const entry = { params: { ...params }, fitness, feasible: feasible !== false, key: k, metrics: metrics || {} }
  optimizationState.cemArchive.push(entry)
  cemTrimArchive(optimizationState, isMaximizing)
  if (cemIsBetter(entry, optimizationState.cemBestEver, isMaximizing))
    optimizationState.cemBestEver = entry
}

// gate the update on the EVALUATED count (not feasible batch length) so low-feasibility runs always advance; the round counter resets before any early return so an all-miss round can't poison probabilities. After cemRounds updates, stop adapting and exploit the incumbent. The model is fitted from the whole archive (feasible-first) via a TPE-style good/bad density ratio with Laplace smoothing, an alpha blend, a per-K floor and renormalisation (no category ever pinned to 0 or 1).
function cemMaybeUpdateDistribution(optimizationState, isMaximizing) {
  const size = optimizationState.cemBatchSize || 20
  if ((optimizationState.cemRoundEvaluated || 0) < size)
    return ''
  // Round boundary reached — reset counters / advance round FIRST (never throw, never poison)
  optimizationState.cemRoundEvaluated = 0
  optimizationState.round = (optimizationState.round || 1) + 1
  optimizationState.cemBatchCount = 0

  // cemRounds adaptation cap: stop adapting after N updates; exploit the incumbent thereafter
  if ((optimizationState.cemUpdates || 0) >= (optimizationState.cemRounds || 4)) {
    cemQueueIncumbentRefinement(optimizationState)
    return `CEM exploit r${optimizationState.round - 1} (adaptation cap ${optimizationState.cemRounds} reached).`
  }

  const pool = optimizationState.cemArchive.slice()
  if (!pool.length)
    return '' // nothing learned yet this round (e.g. all objective parse-misses) — counters already reset
  pool.sort((a, b) => cemCmp(a, b, isMaximizing)) // feasible-first, best objective first
  const eliteCount = Math.max(1, Math.floor((optimizationState.cemEliteFrac || 0.2) * pool.length))
  const good = pool.slice(0, eliteCount)
  const bad = pool.slice(eliteCount)
  const names = optimizationState.paramNames
  const alpha = optimizationState.cemAlpha || 0.3
  const floorFrac = optimizationState.cemProbFloorFrac || 0.1

  for (const name of names) {
    const domain = optimizationState.domains[name]
    const n = domain ? domain.length : 0
    if (!n || n <= 1)
      continue // single-value / empty domain: nothing to learn, leave prob untouched
    const oldP = optimizationState.prob[name]
    // Good (elite) and bad (rest) per-category histograms
    const gCount = new Array(n).fill(0)
    const bCount = new Array(n).fill(0)
    for (const e of good) {
      const idx = domain.indexOf(e.params[name])
      if (idx >= 0) gCount[idx] += 1
    }
    for (const e of bad) {
      const idx = domain.indexOf(e.params[name])
      if (idx >= 0) bCount[idx] += 1
    }
    const gTot = good.length, bTot = bad.length
    // TPE-style density ratio target with Laplace prior (handles empty bins, no div-by-zero)
    const target = new Array(n)
    let tSum = 0
    for (let i = 0; i < n; i++) {
      const gFreq = (gCount[i] + 1) / (gTot + n)
      const bFreq = (bCount[i] + 1) / (bTot + n)
      const ratio = gFreq / bFreq
      target[i] = ratio
      tSum += ratio
    }
    // Blend with the old marginal, floor per-K, renormalize -> Σ=1 and every category ≥ eps
    const eps = floorFrac / n
    const next = new Array(n)
    let sum = 0
    for (let i = 0; i < n; i++) {
      const tgt = tSum > 0 ? target[i] / tSum : 1 / n
      let v = (1 - alpha) * oldP[i] + alpha * tgt
      v = Math.max(eps, v)
      next[i] = v
      sum += v
    }
    for (let i = 0; i < n; i++)
      next[i] = next[i] / sum
    optimizationState.prob[name] = next
  }

  optimizationState.cemUpdates = (optimizationState.cemUpdates || 0) + 1
  // Memetic: queue single-param refinement of the incumbent for the next round (mirrors GA local search)
  cemQueueIncumbentRefinement(optimizationState)

  // Build a short human-readable note of the current top probabilities
  try {
    const showNames = names.slice(0, Math.min(3, names.length))
    const parts = []
    for (const name of showNames) {
      const domain = optimizationState.domains[name]
      const p = optimizationState.prob[name]
      if (!p || !p.length) continue
      const idxs = p.map((v, i) => i).sort((a, b) => p[b] - p[a]).slice(0, Math.min(2, p.length))
      const picks = idxs.map(i => `${domain[i]}(${Math.round(p[i] * 100)}%)`).join(', ')
      parts.push(`${name}=${picks}`)
    }
    const note = parts.length ? `CEM updated dist r${optimizationState.round - 1}: ${parts.join(' | ')}` : `CEM updated dist r${optimizationState.round - 1}.`
    console.log('[CEM] Distribution update:', { round: optimizationState.round - 1, updates: optimizationState.cemUpdates, top: parts })
    return note
  } catch (err) {
    console.warn('[CEM] Failed to build update note', err)
  }
  return ''
}

function cemWarmStartProb(domain, incumbentValue, floorFrac) {
  const n = Math.max(1, (domain && domain.length) || 0)
  if (n === 1)
    return [1]
  const idx = domain.indexOf(incumbentValue)
  if (idx < 0)
    return new Array(n).fill(1 / n) // no incumbent guidance -> uniform (prior behaviour)
  const eps = (floorFrac || 0) / n
  let peak = 0.6
  const minPeak = 1 / n
  if (peak < minPeak) peak = minPeak
  const rest = (1 - peak) / (n - 1)
  const p = new Array(n)
  for (let i = 0; i < n; i++)
    p[i] = i === idx ? peak : Math.max(eps, rest)
  let sum = 0
  for (let i = 0; i < n; i++) sum += p[i]
  for (let i = 0; i < n; i++) p[i] = p[i] / sum
  return p
}

function cemIncumbentCandidate(optimizationState, bestPropVal) {
  if (!bestPropVal || typeof bestPropVal !== 'object')
    return null
  const names = optimizationState.paramNames
  const params = {}
  let any = false
  for (const name of names) {
    const domain = optimizationState.domains[name]
    if (!domain || !domain.length) { params[name] = null; continue }
    const v = bestPropVal[name]
    if (domain.indexOf(v) >= 0) { params[name] = v; any = true }
    else { params[name] = domain[0] }
  }
  return any ? params : null
}

function cemCmp(a, b, isMaximizing) {
  const af = a.feasible !== false, bf = b.feasible !== false
  if (af !== bf) return af ? -1 : 1
  const x = a.fitness, y = b.fitness
  const xn = x === null || typeof x === 'undefined'
  const yn = y === null || typeof y === 'undefined'
  if (xn && yn) return 0
  if (xn) return 1
  if (yn) return -1
  if (x !== y) return isMaximizing ? (y - x) : (x - y)
  const am = a.metrics || {}, bm = b.metrics || {}
  const aw = typeof am.winRate === 'number' ? am.winRate : null
  const bw = typeof bm.winRate === 'number' ? bm.winRate : null
  if (aw !== null || bw !== null) {
    if (aw === null) return 1
    if (bw === null) return -1
    if (aw !== bw) return bw - aw
  }
  const at = typeof am.trades === 'number' ? am.trades : null
  const bt = typeof bm.trades === 'number' ? bm.trades : null
  if (at !== null || bt !== null) {
    if (at === null) return 1
    if (bt === null) return -1
    if (at !== bt) return bt - at
  }
  const ad = typeof am.maxDD === 'number' ? am.maxDD : null
  const bd = typeof bm.maxDD === 'number' ? bm.maxDD : null
  if (ad !== null || bd !== null) {
    if (ad === null) return 1
    if (bd === null) return -1
    if (ad !== bd) return ad - bd
  }
  return 0
}

function cemIsBetter(candidate, current, isMaximizing) {
  if (!candidate) return false
  if (!current) return true
  return cemCmp(candidate, current, isMaximizing) < 0
}

function cemTrimArchive(optimizationState, isMaximizing) {
  const arch = optimizationState.cemArchive
  const limit = optimizationState.cemArchiveLimit || 500
  if (!arch || arch.length <= limit) return
  arch.sort((a, b) => cemCmp(a, b, isMaximizing))
  arch.length = limit
}

function cemTrimSeen(optimizationState) {
  const seen = optimizationState.seen
  const limit = optimizationState.seenLimit
  if (!seen || !limit || seen.size <= limit) return
  const keep = optimizationState.cemBestEver && optimizationState.cemBestEver.key
  for (const key of seen) {
    if (key === keep) continue
    seen.delete(key)
    if (seen.size <= limit) break
  }
}

function cemTrimCache(optimizationState) {
  const cache = optimizationState.cemCache
  const limit = optimizationState.cemArchiveLimit || 500
  if (!cache || cache.size <= limit) return
  for (const key of cache.keys()) {
    cache.delete(key)
    if (cache.size <= limit) break
  }
}

function cemQueueIncumbentRefinement(optimizationState) {
  const best = optimizationState.cemBestEver
  if (!best || !best.params) return
  const names = optimizationState.paramNames
  const queue = optimizationState.cemLocalQueue
  if (!queue) return
  const shuffled = names.slice()
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t
  }
  const count = Math.min(5, shuffled.length)
  for (let i = 0; i < count; i++) {
    const name = shuffled[i]
    const domain = optimizationState.domains[name]
    if (!domain || domain.length < 2) continue
    const alts = domain.filter(v => v !== best.params[name] && typeof v !== 'undefined')
    if (!alts.length) continue
    const neighbor = { ...best.params }
    neighbor[name] = alts[Math.floor(Math.random() * alts.length)]
    queue.push({ params: neighbor, kind: 'refine' })
  }
}

function cemFindFreshTuple(optimizationState) {
  const names = optimizationState.paramNames
  const seen = optimizationState.seen
  const cache = optimizationState.cemCache
  const sizes = names.map(name => {
    const d = optimizationState.domains[name]
    return (d && d.length) ? d.length : 1
  })
  let total = 1
  for (let i = 0; i < sizes.length; i++) {
    total *= sizes[i]
    if (!Number.isFinite(total) || total > 1e7) { total = Infinity; break }
  }
  const cacheSize = cache ? cache.size : 0
  const maxScan = Math.min(total, cacheSize + 1)
  let cursor = optimizationState.cemCursor
  if (!Array.isArray(cursor) || cursor.length !== names.length)
    cursor = new Array(names.length).fill(0)
  let firstUncached = null
  for (let scanned = 0; scanned < maxScan; scanned++) {
    const params = {}
    for (let i = 0; i < names.length; i++) {
      const d = optimizationState.domains[names[i]]
      params[names[i]] = (d && d.length) ? d[cursor[i]] : null
    }
    const key = cemEncode(params, names)
    // advance odometer for the next step / call
    let carry = 1
    for (let i = names.length - 1; i >= 0 && carry; i--) {
      cursor[i] += 1
      if (cursor[i] >= sizes[i]) cursor[i] = 0
      else carry = 0
    }
    const inCache = cache && cache.has(key)
    if (!inCache) {
      if (!seen.has(key)) {
        optimizationState.cemCursor = cursor
        return { params, key } // never generated, never evaluated — ideal fresh candidate
      }
      // in seen but NOT durably evaluated -> retryable; the caller re-evaluates it regardless of
      // its stale seen marker, so duplicate-suppression here is never permanent.
      if (!firstUncached) firstUncached = { params, key }
    }
  }
  optimizationState.cemCursor = cursor
  return firstUncached // null only when every scanned tuple is in the durable cache -> saturated
}

// Annealing optimization
async function optAnnealingIteration(allRangeParams, testResults, bestValue, bestPropVal, optimizationState) {
  const initTemp = 1// TODO to param? Find teh best match?
  const isMaximizing = testResults.hasOwnProperty('isMaximizing') ? testResults.isMaximizing : true
  if (!optimizationState.isInit) {
    optimizationState.currentTemp = initTemp

    if (!bestPropVal || bestValue === 'undefined') {
      let propVal = optAnnealingNewState(allRangeParams) // Random value
      if (bestPropVal)
        propVal = expandPropVal(propVal, bestPropVal)
      optimizationState.lastState = propVal
      const res = await backtest.getTestIterationResult(testResults, optimizationState.lastState)
      if (!res || !res.data)
        return res

      optimizationState.lastEnergy = res.data[testResults.optParamName]
      optimizationState.bestState = optimizationState.lastState;
      optimizationState.bestEnergy = optimizationState.lastEnergy;
    } else {
      optimizationState.lastState = bestPropVal
      optimizationState.bestState = bestPropVal;
      optimizationState.lastEnergy = bestValue
      optimizationState.bestEnergy = bestValue
    }

    optimizationState.isInit = true
  }
  const iteration = testResults.perfomanceSummary.length


  let propData = optAnnealingNewState(allRangeParams, optimizationState.currentTemp, optimizationState.lastState)
  let propVal = propData.data
  if (bestPropVal)
    propVal = expandPropVal(propVal, bestPropVal)
  const currentState = propVal
  let res = await backtest.getTestIterationResult(testResults, currentState)

  if (!res || !res.data || res.error !== null)
    return res
  res.data['comment'] = res.data['comment'] ? res.data['comment'] + propData.message : propData.message
  if (!res.message)
    res.message = propData.message
  else
    res.message += propData.message
  // return await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal)
  res = await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal)
  if (!res.data.hasOwnProperty(testResults.optParamName))
    return res
  const currentEnergy = res.data[testResults.optParamName]

  if (res.hasOwnProperty('isBestChanged') && res.isBestChanged) {
    optimizationState.lastState = currentState;
    optimizationState.lastEnergy = currentEnergy;
    res.message += ` The best value ${res.bestValue}.`
  } else {
    const randVal = crypto.getRandomValues(new Uint16Array(1))[0] / 65536 //Math.random()
    const expVal = Math.exp(-(currentEnergy - optimizationState.lastEnergy) / optimizationState.currentTemp) // Math.exp(-10) ~0,000045,  Math.exp(-1) 0.3678 Math.exp(0); => 1
    // console.log('#', optimizationState.currentTemp, randVal, expVal, currentEnergy, optimizationState.lastEnergy, currentEnergy - optimizationState.lastEnergy)
    if (randVal <= expVal) { // TODO need to optimize
      optimizationState.lastState = currentState;
      optimizationState.lastEnergy = currentEnergy;
      // res.message += ' Randomly changed state to current.'
    } else { // To revert to best condition
      optimizationState.lastState = res.bestPropVal;
      optimizationState.lastEnergy = res.bestValue;
      // res.message += ` Returned to best state with best value ${res.bestValue}`
    }
  }
  optimizationState.currentTemp = optAnnealingGetTemp(optimizationState.currentTemp, testResults.cycles);
  // optimizationState.currentTemp = optAnnealingGetBoltzmannTemp(initTemp, iteration, Object.keys(allRangeParams).length);
  // optimizationState.currentTemp = optAnnealingGetExpTemp(initTemp, iteration, Object.keys(allRangeParams).length);
  return res
}

function optAnnealingGetTemp(prevTemperature, cylces) {
  return prevTemperature * (1 - 1 / cylces);
}

function optAnnealingGetBoltzmannTemp(initTemperature, iter, cylces, dimensionSize) {
  return iter === 1 ? 1 : initTemperature / Math.log(1 + iter / (dimensionSize * 2));
}

function optAnnealingGetExpTemp(initTemperature, iter, dimensionSize) {
  return initTemperature / Math.pow(iter, 1 / dimensionSize);
}

function optAnnealingNewState(allRangeParams, temperature, curState) {
  const propVal = {} // TODO prepare as
  let msg = ''
  const allParamNames = Object.keys(allRangeParams)
  const isAll = (randomInteger(0, 10) * temperature) >= 5
  if (!isAll && curState) {
    allParamNames.forEach(paramName => {
      propVal[paramName] = curState[paramName]
    })
    const indexToChange = randomInteger(0, allParamNames.length - 1)
    const paramName = allParamNames[indexToChange]
    const curVal = propVal[paramName]
    const diffParams = allRangeParams[paramName].filter(paramVal => paramVal !== curVal)

    if (diffParams.length === 0) {
      propVal[paramName] = curVal
    } else if (diffParams.length === 1) {
      propVal[paramName] = diffParams[0]
    } else {
      propVal[paramName] = diffParams[randomInteger(0, diffParams.length - 1)]

      // Is not proportional chances for edges of array
      // const offset = sign * Math.floor(temperature * randomNormalDistribution(0, (allRangeParams[paramName].length - 1)))
      // const newIndex = curIndex + offset > allRangeParams[paramName].length - 1 ? allRangeParams[paramName].length - 1 : // TODO +/-
      //   curIndex + offset < 0 ? 0 : curIndex + offset
      // propVal[paramName] = allRangeParams[paramName][newIndex]
      // Second variant
      const curIndex = allRangeParams[paramName].indexOf(curState[paramName])
      const sign = randomInteger(0, 1) === 0 ? -1 : 1
      const baseOffset = Math.floor(temperature * randomNormalDistribution(0, (allRangeParams[paramName].length - 1)))
      const offsetIndex = (curIndex + sign * baseOffset) % (allRangeParams[paramName].length)
      const newIndex2 = offsetIndex >= 0 ? offsetIndex : allRangeParams[paramName].length + offsetIndex
      propVal[paramName] = allRangeParams[paramName][newIndex2]
    }
    msg = `Changed "${paramName}": ${curVal} => ${propVal[paramName]}.`
  } else if (isAll && curState) {
    allParamNames.forEach(paramName => {
      const curIndex = allRangeParams[paramName].indexOf(curState[paramName])
      const sign = randomInteger(0, 1) === 0 ? -1 : 1
      const baseOffset = Math.floor(temperature * randomNormalDistribution(0, (allRangeParams[paramName].length - 1)))
      const offsetIndex = (curIndex + sign * baseOffset) % (allRangeParams[paramName].length)
      const newIndex2 = offsetIndex >= 0 ? offsetIndex : allRangeParams[paramName].length + offsetIndex
      propVal[paramName] = allRangeParams[paramName][newIndex2]
    })
    msg = `Changed all parameters randomly.`
  } else {
    allParamNames.forEach(paramName => {
      propVal[paramName] = allRangeParams[paramName][randomInteger(0, allRangeParams[paramName].length - 1)]
    })
    msg = `Changed all parameters randomly without temperature.`
  }
  return { message: msg, data: propVal }
}

async function optAnnealingGetEnergy(testResults, propVal) { // TODO 2del test function annealing
  const allDimensionVal = Object.keys(propVal).map(name => Math.abs(propVal[name] * propVal[name] - 16))
  testResults.perfomanceSummary.push(allDimensionVal)
  const resData = {}
  resData[testResults.optParamName] = allDimensionVal.reduce((sum, item) => item + sum, 0)
  return { error: 0, data: resData };
}


// rute Force
async function optBruteForce(allRangeParams, testResults, bestValue, bestPropVal, optimizationState) {
  const propVal = {}
  let paramName = ''
  let msg = ''
  if (!optimizationState.hasOwnProperty('valuesIdx')) {
    // optimizationState['valuesIdx'] = new Array(testResults.paramPriority.length)
    optimizationState['valuesIdx'] = []
    for (let i = 0; i < testResults.paramPriority.length; i++) {
      optimizationState['valuesIdx'].push(0)
      paramName = testResults.paramPriority[i]
      propVal[paramName] = allRangeParams[paramName][0]
    }
    // optimizationState['valuesIdx'].forEach((val, idx) => optimizationState['valuesIdx'][idx] = 0)
    for (let i = 0; i < testResults.paramPriority.length; i++) {
      paramName = testResults.paramPriority[i]
      propVal[paramName] = allRangeParams[paramName][0]
    }
    msg = 'All parameters set to init values'
  } else {
    for (let i = 0; i < testResults.paramPriority.length; i++) {
      paramName = testResults.paramPriority[i]
      let valIdx = optimizationState['valuesIdx'][i]
      propVal[paramName] = allRangeParams[paramName][valIdx]
    }
    for (let i = 0; i < testResults.paramPriority.length; i++) {
      paramName = testResults.paramPriority[i]
      let valIdx = optimizationState['valuesIdx'][i]

      if (valIdx + 1 < allRangeParams[paramName].length) {
        valIdx += 1
        optimizationState['valuesIdx'][i] = valIdx
        propVal[paramName] = allRangeParams[paramName][valIdx]
        break
      } else if (i + 1 === testResults.paramPriority.length) {
        return null // End all variants
      } else {
        valIdx = 0
        optimizationState['valuesIdx'][i] = valIdx // Next parameter
        propVal[paramName] = allRangeParams[paramName][valIdx]
      }
    }
    msg = `"${paramName}" set to ${propVal[paramName]}.`
  }
  const res = await backtest.getTestIterationResult(testResults, propVal)
  if (!res || !res.data || res.error !== null)
    return res
  res.data['comment'] = res.data['comment'] ? res.data['comment'] + msg : msg
  if (!res.message)
    res.message = msg
  else
    res.message += msg
  return await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal)
}


async function optSequentialIteration(allRangeParams, testResults, bestValue, bestPropVal, optimizationState) {
  if (!optimizationState.hasOwnProperty('paramIdx')) {
    optimizationState.paramIdx = 0
  }
  let paramName = testResults.paramPriority[optimizationState.paramIdx]
  if (!optimizationState.hasOwnProperty('valIdx')) {
    optimizationState.valIdx = 0
  } else {
    optimizationState.valIdx += 1
    if (optimizationState.valIdx >= allRangeParams[paramName].length) {
      optimizationState.valIdx = 0
      optimizationState.paramIdx += 1
      if (optimizationState.paramIdx >= testResults.paramPriority.length) {
        return null // End
      } else {
        paramName = testResults.paramPriority[optimizationState.paramIdx]
      }
    }
  }
  const valIdx = optimizationState.valIdx


  const propVal = {}
  Object.keys(bestPropVal).forEach(paramName => {
    propVal[paramName] = bestPropVal[paramName]
  })
  propVal[paramName] = allRangeParams[paramName][valIdx]
  if (bestPropVal[paramName] === propVal[paramName])
    return {
      error: null,
      currentValue: bestValue,
      message: `The same value of the "${paramName}" parameter equal to ${propVal[paramName]} is skipped`
    }
  const msg = `Changed "${paramName}": ${bestPropVal[paramName]} => ${propVal[paramName]}.`

  const res = await backtest.getTestIterationResult(testResults, propVal)
  if (!res || !res.data || res.error !== null)
    return res
  res.data['comment'] = res.data['comment'] ? res.data['comment'] + msg : msg
  if (!res.message)
    res.message = msg
  else
    res.message += msg
  return await getResWithBestValue(res, testResults, bestValue, bestPropVal, propVal)
}
