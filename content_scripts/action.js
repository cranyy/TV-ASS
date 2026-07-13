const action = {
  workerStatus: null
}

const message = {
  errorsNoBacktest: 'There is no backtest data. Try to do a new backtest'
}

action.saveParameters = async () => {
  const strategyData = await tv.getStrategy(null, true)
  if (!strategyData || !strategyData.hasOwnProperty('name') || !strategyData.hasOwnProperty('properties') || !strategyData.properties) {
    await ui.showErrorPopup('The current indicator/strategy do not contain inputs that can be saved.')
    // await ui.showWarningPopup('Please open the indicator (strategy) parameters window before saving them to a file.')
    return
  }
  let strategyParamsCSV = `Name,Value\n"__indicatorName",${JSON.stringify(strategyData.name)}\n`
  Object.keys(strategyData.properties).forEach(key => {
    strategyParamsCSV += `${JSON.stringify(key)},${typeof strategyData.properties[key][0] === 'string' ? JSON.stringify(strategyData.properties[key]) : strategyData.properties[key]}\n`
  })
  file.saveAs(strategyParamsCSV, `${strategyData.name}.csv`)
}

action.loadParameters = async () => {
  await file.upload(file.uploadHandler, '', false)
}

// collect hard-export run context from existing chart/storage helpers without adding unverified TradingView setters
action._readHardDateRange = async () => {
  const out = {
    kind: 'metadata-only',
    from: null,
    to: null,
    label: null,
    isDeepTest: false
  }
  try {
    await tv.openStrategyTab()
    const periodBtn = page.$(SEL.strategyTabPeriodDD)
    if (periodBtn && periodBtn.innerText)
      out.label = periodBtn.innerText.trim()
    const deepStartInput = page.$(SEL.strategyDeepTestStartDate)
    if (deepStartInput && deepStartInput.value)
      out.from = deepStartInput.value
    out.isDeepTest = !!page.$(SEL.strategyDeepTestCheckboxChecked)
    if (out.isDeepTest && out.from)
      out.kind = 'deep-test-start'
  } catch (err) {
    out.error = err && err.message ? err.message : String(err)
  }
  return out
}

// extract the optimizer field map into a pure helper so both the storage-backed hardExport path and the live winner-CSV capture build an identical optimizer block without duplicating the field list
action._extractOptimizerFields = (src) => {
  if (!src || typeof src !== 'object')
    return null
  return {
    method: src.method || null,
    cycles: src.cycles || null,
    paramSpace: src.paramSpace || null,
    optParamName: src.optParamName || null,
    isMaximizing: src.hasOwnProperty('isMaximizing') ? src.isMaximizing : null,
    filters: src.activeFilters || null,
    filterSummary: src.filterSummary || null,
    filterParamName: src.filterParamName || null,
    filterAscending: src.filterAscending,
    filterValue: src.filterValue,
    filterParamName2: src.filterParamName2 || null,
    filter2Ascending: src.filter2Ascending,
    filterValue2: src.filterValue2,
    isDeepTest: src.hasOwnProperty('isDeepTest') ? src.isDeepTest : null,
    deepStartDate: src.deepStartDate || null,
    dataLoadingTime: src.dataLoadingTime || null,
    backtestDelay: src.backtestDelay || 0,
    randomDelay: src.hasOwnProperty('randomDelay') ? src.randomDelay : null,
    autoBestDownload: src.hasOwnProperty('autoBestDownload') ? src.autoBestDownload : null,
    gaTradesGateEnabled: src.hasOwnProperty('gaTradesGateEnabled') ? src.gaTradesGateEnabled : null,
    targetTradesPerDay: src.targetTradesPerDay || null,
    minTradesTotal: src.minTradesTotal || null
  }
}

action._getHardOptimizerContext = async (strategyName, ticker, timeframe) => {
  try {
    const testResults = await storage.getKey(storage.STRATEGY_KEY_RESULTS)
    if (!testResults)
      return null
    const resultStrategy = testResults.shortName || testResults.name || ''
    const resultTicker = testResults.ticker || testResults.symbol || ''
    const resultTimeframe = testResults.timeFrame || testResults.timeframe || ''
    const sameStrategy = normalizeTitle(resultStrategy) === normalizeTitle(strategyName)
    const sameTicker = !ticker || !resultTicker || normalizeTitle(resultTicker) === normalizeTitle(ticker)
    const sameTimeframe = !timeframe || !resultTimeframe || tvChart.correctTF(String(resultTimeframe)) === tvChart.correctTF(String(timeframe))
    if (!sameStrategy || !sameTicker || !sameTimeframe)
      return null
    return action._extractOptimizerFields(testResults)
  } catch (err) {
    console.warn('[TV-ASS] hardExport optimizer context unavailable:', err)
    return null
  }
}

action._getHardRunContext = (payload) => {
  if (!payload || payload.type !== 'tv-assistant-hard-strategy' || payload.version !== 2)
    return null
  if (!payload.runContext || typeof payload.runContext !== 'object')
    return null
  return payload.runContext
}

action._hardDateRangeMatches = (expected, current) => {
  // fail closed when saved date-range fields are not readable on the current chart
  if (!expected)
    return true
  if (!current || current.error)
    return false
  if (expected.kind === 'deep-test-start' && expected.from)
    return current.isDeepTest === true && current.from === expected.from
  if (expected.label && (!current.label || normalizeTitle(expected.label) !== normalizeTitle(current.label)))
    return false
  if (expected.from && (!current.from || expected.from !== current.from))
    return false
  return true
}

action._hardDateRangeCanRestore = (dateRange) => {
  return !!(dateRange && dateRange.kind === 'deep-test-start' && dateRange.from)
}

action._restoreHardOriginalContext = async (original) => {
  if (!original)
    return
  try {
    if (original.timeframe)
      await tvChart.changeTimeFrame(original.timeframe)
  } catch (err) {
    console.warn('[TV-ASS] hardImport failed to restore original timeframe:', err)
  }
  try {
    if (original.sessionId)
      await tv.setChartSession(original.sessionId)
  } catch (err) {
    console.warn('[TV-ASS] hardImport failed to restore original session:', err)
  }
  try {
    if (original.dateRange && original.dateRange.isDeepTest && original.dateRange.from)
      await tv.setDeepTest(true, original.dateRange.from)
    else if (original.dateRange && original.dateRange.isDeepTest === false)
      await tv.setDeepTest(false)
  } catch (err) {
    console.warn('[TV-ASS] hardImport failed to restore original date range:', err)
  }
}

// bestEffort flag: when true, do NOT roll the chart back on failure (the run-context best-effort importer wants every other setting kept + a reported failure, not an abort). Default false preserves the JSON hard-import's fail-closed rollback.
action._setHardTimeframeVerified = async (targetTimeframe, original, bestEffort = false) => {
  if (!targetTimeframe)
    return null
  const normalizedTarget = tvChart.correctTF(String(targetTimeframe))
  try {
    await tvChart.changeTimeFrame(normalizedTarget)
    const actual = await tvChart.getCurrentTimeFrame()
    if (tvChart.correctTF(String(actual)) === normalizedTarget)
      return null
    if (!bestEffort) await action._restoreHardOriginalContext(original)
    return `Error: Timeframe verification failed. Expected "${normalizedTarget}", current "${actual}". Import canceled.`
  } catch (err) {
    if (!bestEffort) await action._restoreHardOriginalContext(original)
    return `Error: Could not set timeframe to "${normalizedTarget}" — ${err.message || err}. Import canceled.`
  }
}

// single source of truth for importer-accepted session IDs. The importer allowlist (regular/extended) was narrower than the exporter / TradingView raw session IDs, so the extension would reject its own saved file (sessionId "us_regular") before any chart mutation. Accept legacy bare values plus region/exchange-prefixed raw forms captured from mainSeries._properties.sessionId (us_regular, us_extended, …). Prefix must be simple alnum tokens; arbitrary strings are still rejected, and the setChartSession->getChartSession round-trip in _setHardSessionVerified remains the hard backstop.
action._SESSION_EXPECTED_HINT = 'regular, extended, or a region-prefixed raw form such as us_regular / us_extended'
action._isSupportedSessionId = (sessionId) => {
  if (typeof sessionId !== 'string')
    return false
  return /^(?:[a-z0-9]+_)*(?:regular|extended)$/.test(sessionId.trim().toLowerCase())
}

// bestEffort flag (same rationale as _setHardTimeframeVerified): skip rollback on failure for the run-context importer; default false keeps the JSON hard-import fail-closed.
action._setHardSessionVerified = async (targetSession, original, bestEffort = false) => {
  if (!targetSession)
    return null
  // replace hard-coded ['regular','extended'] allowlist with shared action._isSupportedSessionId (now also accepts us_regular/us_extended raw forms); round-trip verify below unchanged.
  if (!action._isSupportedSessionId(targetSession))
    return `Error: Session "${targetSession}" is not supported by this importer (expected: ${action._SESSION_EXPECTED_HINT}). Import canceled.`
  try {
    const sessionOk = await tv.setChartSession(targetSession)
    await page.waitForTimeout(250)
    const actual = await tv.getChartSession()
    if (sessionOk && actual === targetSession)
      return null
    if (!bestEffort) await action._restoreHardOriginalContext(original)
    return `Error: Session verification failed. Expected "${targetSession}", current "${actual || 'unknown'}". Import canceled.`
  } catch (err) {
    if (!bestEffort) await action._restoreHardOriginalContext(original)
    return `Error: Could not set session to "${targetSession}" — ${err.message || err}. Import canceled.`
  }
}

action._setHardDateRangeVerified = async (dateRange, original) => {
  if (!action._hardDateRangeCanRestore(dateRange))
    return null
  try {
    await tv.openStrategyTab()
    await tv.setDeepTest(true, dateRange.from)
    await page.waitForTimeout(250)
    const actual = await action._readHardDateRange()
    if (action._hardDateRangeMatches(dateRange, actual))
      return null
    await action._restoreHardOriginalContext(original)
    return `Error: Date range verification failed. Expected deep-test start "${dateRange.from}", current "${actual && actual.from ? actual.from : 'unknown'}". Import canceled.`
  } catch (err) {
    await action._restoreHardOriginalContext(original)
    return `Error: Could not restore deep-test date range "${dateRange.from}" — ${err.message || err}. Import canceled.`
  }
}

// hardExport: JSON-based export of inputs + properties + timeframe + sessionId + date metadata; try/finally ensures the dialog closes on any failure
action.hardExport = async () => {
  // detect an already-open dialog to avoid reusing/discarding unsaved user edits
  if (page.$(SEL.indicatorTitle)) {
    await ui.showWarningPopup('A strategy/indicator dialog is already open. Please close it first, then try hard export again.')
    return
  }
  let dialogOpened = false
  try {
    // collect required chart context before dialog scrape and fail export if it cannot prove the run context
    const ticker = await tvChart.getTicker()
    const timeframe = await tvChart.getCurrentTimeFrame()
    const sessionId = await tv.getChartSession()
    if (!ticker || !timeframe || !sessionId) {
      await ui.showErrorPopup(`Hard export canceled: could not read required chart context (ticker: ${ticker || 'missing'}, timeframe: ${timeframe || 'missing'}, session: ${sessionId || 'missing'}).`)
      return
    }

    // fail-closed: get the expected strategy name via page-context; abort if unavailable to prevent scraping a stale/wrong dialog
    // bridge returns null on failure (no more 'iondvPage' envelope leak); fall back to the legend active-strategy name, which works on the Jun-2026 UI
    let expectedName = await tv.getStrategyName()
    if (!expectedName)
      expectedName = tv._getActiveStrategyName()
    if (!expectedName) {
      await ui.showErrorPopup('Could not verify the current strategy name. Ensure a strategy is on the chart and try again.')
      return
    }

    // open Strategy Tester tab first (required for SEL.strategyCaption availability), then use the broad opener path; matches tv.getStrategy()'s precondition
    try {
      await tv.openStrategyTab()
    } catch (err) {
      console.warn('[TV-ASS] hardExport: openStrategyTab failed, continuing', err)
    }
    const isOpened = await tv.openStrategyParameters(null, false)
    if (!isOpened) {
      await ui.showErrorPopup('Could not open strategy dialog. Add a strategy to the chart and try again.')
      return
    }
    dialogOpened = true

    let strategyName = null
    let properties = {}
    let unresolvedProps = []
    let inputs = {}
    try {
      strategyName = tv.getStrategyNameFromPopup()
      if (!strategyName)
        throw new Error('Could not determine strategy name from dialog.')

      // Verify the open dialog matches the expected strategy
      if (expectedName && normalizeTitle(strategyName) !== normalizeTitle(expectedName)) {
        throw new Error(`Strategy dialog shows "${strategyName}" but expected "${expectedName}". Close any open dialogs and try again.`)
      }

      // Switch to Properties tab and scrape
      await tv.changeDialogTabToProperties()
      const propsResult = await tv.getPropertiesParams()
      properties = propsResult.properties
      unresolvedProps = propsResult.unresolved

      // Switch to Inputs tab and scrape (current-value-only, live checkbox reads)
      await tv.changeDialogTabToInput()
      // pass useLiveCheckbox=true so hard export reads live checkbox state without changing the legacy CSV flow
      inputs = await tv.getStrategyParams(true, true)
    } finally {
      // Always close dialog after opening
      const cancelBtn = page.$(SEL.cancelBtn)
      if (cancelBtn) {
        cancelBtn.click()
        await page.waitForSelector(SEL.cancelBtn, 1000, true)
      }
      dialogOpened = false
    }

    // open Strategy Tester tab before reading date-range metadata so selectors are reliably present
    // store date range in v2 runContext and mark deep-test start as restorable
    const dateRange = await action._readHardDateRange()
    const optimizer = await action._getHardOptimizerContext(strategyName, ticker, timeframe)

    // export v2 hard payload with complete runContext instead of partial top-level metadata
    const payload = {
      type: 'tv-assistant-hard-strategy',
      version: 2,
      runContext: {
        strategyName: strategyName,
        ticker: ticker,
        timeframe: timeframe,
        sessionId: sessionId,
        dateRange: dateRange,
        optimizer: optimizer,
        inputs: inputs || {},
        properties: properties || {}
      }
    }

    file.saveAsJSON(payload, `${strategyName} hard-export.json`)

    // Report result
    let msg = 'Hard export saved successfully.'
    if (unresolvedProps && unresolvedProps.length)
      msg += `\n\nWarning: Some Properties fields could not be fully captured: ${unresolvedProps.join(', ')}`
    if (!optimizer)
      msg += '\n\nNote: No matching completed optimizer run was found in storage, so optimizer settings were not included.'
    if (dateRange && dateRange.kind === 'metadata-only')
      msg += '\n\nNote: Date range was saved as metadata-only and can only be imported when the current chart already matches it.'
    await ui.showPopup(msg)
  } catch (err) {
    // Safety net: close dialog if still open from an unexpected throw path
    if (dialogOpened) {
      try {
        const cancelBtn = page.$(SEL.cancelBtn)
        if (cancelBtn) cancelBtn.click()
      } catch {}
    }
    console.error('[TV-ASS] hardExport error:', err)
    await ui.showErrorPopup(`Hard export error: ${err.message || err}`)
  }
}

// hardImport: JSON-based import; fail-closed name prevalidation via page-context getStrategyName, then timeframe/session, then a single dialog open for Properties + Inputs + one OK; try/finally lifecycle
action.hardImport = async () => {
  await file.uploadJSON(action._hardImportHandler)
}

action._hardImportHandler = async (payload, fileName) => {
  // detect an already-open dialog to avoid committing through a reused dialog with unsaved user edits
  if (page.$(SEL.indicatorTitle)) {
    return `Error: A strategy/indicator dialog is already open. Please close it first, then try hard import again.`
  }

  // validate v2 runContext before any chart mutation so legacy/partial files cannot import green
  if (!payload || payload.type !== 'tv-assistant-hard-strategy') {
    return `Error: "${fileName}" is not a valid hard-export file (missing or wrong type field).`
  }
  if (payload.version !== 2) {
    return `Error: "${fileName}" has unsupported version ${payload.version}. Expected version 2. Re-export the strategy with the current hard export button so ticker/timeframe/session context is present.`
  }
  const runContext = action._getHardRunContext(payload)
  if (!runContext) {
    return `Error: "${fileName}" does not contain a valid v2 runContext. Import canceled.`
  }
  const strategyName = runContext.strategyName
  const ticker = runContext.ticker
  const timeframe = runContext.timeframe
  const sessionId = runContext.sessionId
  const dateRange = runContext.dateRange || null
  const properties = runContext.properties || {}
  const inputs = runContext.inputs || {}
  if (!strategyName) {
    return `Error: "${fileName}" does not contain a strategy name.`
  }
  if (!ticker || !timeframe || !sessionId) {
    return `Error: "${fileName}" is missing required run context (ticker/timeframe/session). Import canceled before chart mutation.`
  }
  // reject unsupported hard-import sessions before any timeframe/date mutation can occur
  // use shared action._isSupportedSessionId so the exporter's own raw forms (us_regular/us_extended) pass; still fail-closed before mutation for unsupported/garbage. Replaces the ['regular','extended'] literal allowlist (which wrongly rejected our own saved files).
  if (!action._isSupportedSessionId(sessionId)) {
    return `Error: Session "${sessionId}" is not supported by this importer (expected: ${action._SESSION_EXPECTED_HINT}). Import canceled before chart mutation.`
  }

  // Non-mutating fail-closed strategy name check via page-context bridge (before any chart mutations)
  // bridge returns null on failure (no more 'iondvPage' envelope leak); fall back to the legend active-strategy name
  let currentName = await tv.getStrategyName()
  if (!currentName)
    currentName = tv._getActiveStrategyName()
  if (!currentName) {
    return `Error: Could not verify the current strategy name. Ensure a strategy is on the chart and try again. Import canceled.`
  }
  if (normalizeTitle(strategyName) !== normalizeTitle(currentName)) {
    return `Error: Strategy name "${strategyName}" from file does not match current strategy "${currentName}". Import canceled.`
  }

  const currentTicker = await tvChart.getTicker()
  if (normalizeTitle(ticker) !== normalizeTitle(currentTicker)) {
    return `Error: Chart ticker "${currentTicker}" does not match file ticker "${ticker}". No verified ticker setter exists, so import canceled before chart mutation.`
  }

  const originalContext = {
    timeframe: await tvChart.getCurrentTimeFrame(),
    sessionId: await tv.getChartSession(),
    dateRange: await action._readHardDateRange()
  }
  if (dateRange && (dateRange.label || dateRange.from) && !originalContext.dateRange) {
    return `Error: Could not verify current chart date range. Import canceled before chart mutation.`
  }
  if (dateRange && !action._hardDateRangeMatches(dateRange, originalContext.dateRange) && !action._hardDateRangeCanRestore(dateRange)) {
    return `Error: Date range from file is "${dateRange.label || dateRange.from || 'unknown'}" and is metadata-only. Set the chart date range manually to match the file, then retry. Import canceled before chart mutation.`
  }

  const timeframeError = await action._setHardTimeframeVerified(timeframe, originalContext)
  if (timeframeError)
    return timeframeError
  const sessionError = await action._setHardSessionVerified(sessionId, originalContext)
  if (sessionError)
    return sessionError
  const dateRangeError = await action._setHardDateRangeVerified(dateRange, originalContext)
  if (dateRangeError)
    return dateRangeError

  const warnings = []

  // Single dialog open for Properties + Inputs
  let dialogOpened = false
  let dialogSuccess = false
  let propsResult = { applied: [], missing: [], failed: [] }
  let inputsResult = { applied: [], missing: [], failed: [] }

  try {
    // open Strategy Tester tab first (required for SEL.strategyCaption availability), then use the broad opener path; matches tv.getStrategy()'s precondition
    try {
      await tv.openStrategyTab()
    } catch (err) {
      console.warn('[TV-ASS] hardImport: openStrategyTab failed, continuing', err)
    }
    const isOpened = await tv.openStrategyParameters(null, false)
    if (!isOpened) {
      return `Error: Could not open strategy dialog. Add a strategy to the chart and try again.${warnings.length ? ' Warnings: ' + warnings.join('; ') : ''}`
    }
    dialogOpened = true

    // verify the popup title matches the prevalidated name to prevent applying to a stale/wrong dialog
    const popupName = tv.getStrategyNameFromPopup()
    if (!popupName || normalizeTitle(popupName) !== normalizeTitle(currentName)) {
      try {
        const cancelBtn = page.$(SEL.cancelBtn)
        if (cancelBtn) cancelBtn.click()
      } catch {}
      dialogOpened = false
      return `Error: Strategy dialog shows "${popupName || '(unknown)'}" but expected "${currentName}". Close any open dialogs and try again.`
    }

    try {
      // apply Properties/Inputs from validated v2 runContext after chart context is verified
      // Switch to Properties tab and apply
      if (properties && Object.keys(properties).length) {
        await tv.changeDialogTabToProperties()
        propsResult = await tv.setPropertiesParams(properties)
      }

      // Switch to Inputs tab and apply
      if (inputs && Object.keys(inputs).length) {
        await tv.changeDialogTabToInput()
        inputsResult = await tv.applyInputParams(inputs)
      }

      // Click OK once
      const okBtn = page.$(SEL.okBtn)
      if (okBtn) {
        okBtn.click()
        dialogSuccess = true
        dialogOpened = false
      }
    } finally {
      // If OK was not clicked (failure path), cancel to close dialog
      if (dialogOpened) {
        try {
          const cancelBtn = page.$(SEL.cancelBtn)
          if (cancelBtn) cancelBtn.click()
        } catch {}
        dialogOpened = false
      }
    }
  } catch (err) {
    // Safety net: close dialog if still open
    if (dialogOpened) {
      try {
        const cancelBtn = page.$(SEL.cancelBtn)
        if (cancelBtn) cancelBtn.click()
      } catch {}
    }
    return `Error: Hard import failed — ${err.message || err}`
  }

  // Build result message
  const parts = []
  const totalPropsApplied = propsResult.applied.length
  const totalPropsMissing = propsResult.missing.length
  const totalPropsFailed = propsResult.failed.length
  const totalInputsApplied = inputsResult.applied.length
  const totalInputsMissing = inputsResult.missing.length
  const totalInputsFailed = inputsResult.failed.length
  const totalApplied = totalPropsApplied + totalInputsApplied
  const totalIssues = totalPropsMissing + totalPropsFailed + totalInputsMissing + totalInputsFailed

  if (totalApplied > 0)
    parts.push(`Applied: ${totalPropsApplied} properties, ${totalInputsApplied} inputs`)
  if (propsResult.migrated && propsResult.migrated.length)
    parts.push(`Legacy properties auto-mapped to the new TradingView dialog (${propsResult.migrated.length}): ${propsResult.migrated.join('; ')}`)
  if (propsResult.skippedLegacy && propsResult.skippedLegacy.length)
    parts.push(`Legacy properties skipped (${propsResult.skippedLegacy.length}): ${propsResult.skippedLegacy.join('; ')}`)
  if (totalPropsMissing > 0)
    parts.push(`Properties not found in dialog (${totalPropsMissing}): ${propsResult.missing.slice(0, 15).join(', ')}`)
  if (totalPropsFailed > 0)
    parts.push(`Properties failed to set (${totalPropsFailed}): ${propsResult.failed.slice(0, 15).join(', ')}`)
  if (totalInputsMissing > 0)
    parts.push(`Inputs not found in dialog (${totalInputsMissing}): ${inputsResult.missing.slice(0, 15).join(', ')}`)
  if (totalInputsFailed > 0)
    parts.push(`Inputs failed to set (${totalInputsFailed}): ${inputsResult.failed.slice(0, 15).join(', ')}`)
  if (warnings.length)
    parts.push(`Warnings: ${warnings.join('; ')}`)

  // report verified date-range handling from v2 runContext instead of legacy top-level payload metadata
  if (dateRange && dateRange.kind === 'metadata-only')
    parts.push('Date range: metadata-only in file and matched before import')
  else if (dateRange && dateRange.kind === 'deep-test-start')
    parts.push(`Date range: restored deep-test start ${dateRange.from}`)

  if (!dialogSuccess)
    parts.push('Error: Dialog OK button could not be clicked')

  if (totalIssues > 0 || warnings.length || !dialogSuccess) {
    return `Hard import completed with errors:\n${parts.join('\n')}`
  }
  return `Hard import successful.\n${parts.join('\n')}`
}

// restore the captured "original" chart context (ticker/timeframe/session/testing-period) — the revert helper used when a step fails. The original is captured BEFORE tv.setTicker, so a setTicker that mutates the chart but fails verification can be reverted.
action._restoreRunContextOriginal = async (original) => {
  if (!original)
    return
  try { if (original.tickerFull) await tv.setTicker(original.tickerFull) } catch (err) { console.warn('[TV-ASS] ISSUE005 restore original ticker failed', err) }
  try { if (original.timeframe) await tvChart.changeTimeFrame(original.timeframe) } catch (err) { console.warn('[TV-ASS] ISSUE005 restore original timeframe failed', err) }
  try { if (original.sessionId) await tv.setChartSession(original.sessionId) } catch (err) { console.warn('[TV-ASS] ISSUE005 restore original session failed', err) }
  try {
    if (original.testingPeriod && original.testingPeriod.from && original.testingPeriod.to)
      await tv.setTestingPeriod(original.testingPeriod.from, original.testingPeriod.to, original.testingPeriod.label)
    // also restore NAMED-PRESET originals (e.g. "Last 30 days"), not only concrete from/to ranges
    else if (original.testingPeriod && original.testingPeriod.label)
      await tv.setTestingPeriod(null, null, original.testingPeriod.label)
  } catch (err) { console.warn('[TV-ASS] ISSUE005 restore original testing period failed', err) }
}

action._restoreRunContextFromMeta = async (meta, inputsPropVal, fileName, strategyNameFromCsv) => {
  if (!meta || meta.v !== 3)
    return `Error: "${fileName}" embedded run context is not a supported version. Import canceled.`

  // 0. a strategy dialog is commonly left OPEN by a prior params-only apply (tv.setStrategyParams with keepStrategyParamOpen=true) or opened manually. Instead of erroring ("close it first") at a dialog the user never opened, auto-close it via Cancel and proceed — this import is about to apply a full saved config, so any unsaved edits there are intentionally superseded. Only error if it genuinely cannot be closed.
  if (page.$(SEL.indicatorTitle)) {
    try {
      const c = page.$(SEL.cancelBtn)
      if (c) c.click()
      await page.waitForSelector(SEL.indicatorTitle, 1500, true)
    } catch {}
    if (page.$(SEL.indicatorTitle))
      return `Error: A strategy dialog is open and could not be closed automatically. Click Cancel/X on it, then re-upload.`
  }

  const strategyName = meta.strategyName || strategyNameFromCsv || null
  const tickerFull = meta.tickerFull || null
  const timeframe = meta.timeframe || null
  const sessionId = meta.sessionId || null
  const dateRange = meta.dateRange || null
  const properties = meta.properties || {}
  const style = meta.style || null
  const visibility = meta.visibility || null
  const captureComplete = meta.captureComplete || {}
  // layout name + chart-type int targets. chartTypeTarget accepts 0 (Bars), so it tests typeof, not truthiness. Both null on old files -> their steps skip silently.
  const layoutName = meta.layout || null
  const chartTypeTarget = (typeof meta.chartType === 'number') ? meta.chartType : null

  // BEST-EFFORT restore, ZERO hard-fails: a run carries hundreds of settings nobody re-enters by hand, so apply everything we can and, when a step can't resolve (esp. ticker), record it and KEEP GOING — leave the chart with everything applied and surface a RED report flagging exactly what to fix by hand. NOTHING is rolled back. (The JSON hard-import path action._hardImportHandler stays fail-closed via the default bestEffort=false on the shared verifiers.)

  // LAYOUT — restore FIRST: loading a layout replaces the symbol + every indicator + the strategy, so it MUST run before strategy detection / ticker / timeframe / session / period / strategy-dialog, or those would be applied and then wiped. Best-effort: skips when absent (old files) or already on it; on failure records ❌ and keeps going (the rest still applies onto whatever layout is loaded). LOAD ONLY — never Save/Autosave. setChartLayout runs the bounded content-settle internally before returning.
  let layoutOk = true
  if (layoutName) {
    const layoutRes = await tv.setChartLayout(layoutName)
    layoutOk = !!(layoutRes && layoutRes.ok)
  }

  // 1. strategy presence/name — NON-FATAL: if it can't be matched, skip ONLY the strategy-dialog pass; chart-level context still applies
  let currentName = await tv.getStrategyName()
  if (!currentName)
    currentName = tv._getActiveStrategyName()
  let skipStrategy = false
  let strategyNote = null
  if (!currentName) {
    skipStrategy = true
    strategyNote = 'no strategy detected on the chart — add the strategy and re-upload'
  } else if (strategyName && normalizeTitle(strategyName) !== normalizeTitle(currentName)) {
    skipStrategy = true
    strategyNote = `chart has "${currentName}", file is "${strategyName}"`
  }

  // 2. capture original (reference/logging only — best-effort never rolls back)
  const original = {}
  try { const s = await tv.getChartSymbol(); original.tickerFull = s ? s.symbol : null } catch {}
  try { original.timeframe = await tvChart.getCurrentTimeFrame() } catch {}
  try { original.sessionId = await tv.getChartSession() } catch {}
  try { original.testingPeriod = tv._readTestingPeriod() } catch {}

  // 3. ticker — best-effort (records tickerOk; never aborts)
  let tickerOk = true
  if (tickerFull) {
    let curSym = ''
    try { const cur = await tv.getChartSymbol(); curSym = cur ? String(cur.symbol || '').toUpperCase() : '' } catch {}
    if (curSym !== String(tickerFull).toUpperCase())
      tickerOk = await tv.setTicker(tickerFull)
  }

  // 4. timeframe — best-effort (bestEffort=true => no rollback; returns an error string only when it couldn't set)
  const tfOk = !(await action._setHardTimeframeVerified(timeframe, original, true))

  // 5. session — best-effort (unsupported value => skip+report; otherwise set+verify with no rollback)
  let sessOk = true
  if (sessionId && !action._isSupportedSessionId(sessionId))
    sessOk = false
  else
    sessOk = !(await action._setHardSessionVerified(sessionId, original, true))

  // 6. testing period — best-effort (the calendar-state-machine case where the prefill end is later than the target end can fail; we no longer abort — we apply everything else and flag the period to set by hand)
  let periodOk = true
  if (dateRange && (dateRange.from || dateRange.label)) {
    const periodRes = await tv.setTestingPeriod(dateRange.from, dateRange.to, dateRange.label)
    periodOk = !!(periodRes && periodRes.ok)
  }

  // 7. strategy dialog pass — best-effort (Properties -> Inputs -> Style -> Visibility -> OK). Skipped entirely if no matching strategy; any failure is recorded (strategyNote) and we KEEP GOING — never roll back. Whatever DID apply stays.
  let propsResult = { applied: [], missing: [], failed: [] }
  let inputsResult = { applied: [], missing: [], failed: [] }
  let styleResult = { applied: [], missing: [], failed: [] }
  let visResult = { applied: [], missing: [], failed: [] }
  let strategyApplied = false
  if (!skipStrategy) {
    let dialogOpened = false
    try {
      try { await tv.openStrategyTab() } catch (err) { console.warn('[TV-ASS] restore: openStrategyTab failed, continuing', err) }
      const isOpened = await tv.openStrategyParameters(null, false)
      if (!isOpened) {
        strategyNote = 'could not open the strategy dialog'
      } else {
        dialogOpened = true
        const popupName = tv.getStrategyNameFromPopup()
        if (!popupName || normalizeTitle(popupName) !== normalizeTitle(currentName)) {
          try { const c = page.$(SEL.cancelBtn); if (c) c.click() } catch {}
          dialogOpened = false
          strategyNote = `dialog showed "${popupName || 'unknown'}"`
        } else {
          if (properties && Object.keys(properties).length) {
            await tv.changeDialogTabToProperties()
            propsResult = await tv.setPropertiesParams(properties)
          }
          if (inputsPropVal && Object.keys(inputsPropVal).length) {
            await tv.changeDialogTabToInput()
            inputsResult = await tv.applyInputParams(inputsPropVal)
          }
          if (style && Array.isArray(style.rows) && style.rows.length) {
            await tv.changeDialogTabToStyle()
            styleResult = await tv.setStyleParams(style)
          }
          if (visibility && Array.isArray(visibility.rows) && visibility.rows.length) {
            await tv.changeDialogTabToVisibilities()
            visResult = await tv.setVisibilityParams(visibility)
          }
          const okBtn = page.$(SEL.okBtn)
          if (okBtn) {
            okBtn.click()
            strategyApplied = true
            dialogOpened = false
          } else {
            strategyNote = 'OK button unavailable — settings not committed'
          }
        }
      }
    } catch (err) {
      strategyNote = `dialog pass failed (${err.message || err})`
    } finally {
      if (dialogOpened) {
        try { const c = page.$(SEL.cancelBtn); if (c) c.click() } catch {}
      }
    }
  }

  // CHART TYPE / candles: instant model write placed AFTER ticker/session/strategy so a symbol change can't reset it. Best-effort: skip when absent (old file) or already equal; set + read-back verify otherwise. If the correct layout loaded first the chart type usually already matches, so this is a no-op. Accepts 0 (Bars).
  let chartTypeOk = true
  if (chartTypeTarget != null) {
    let curStyle = null
    try { curStyle = await tv.getChartStyle() } catch {}
    if (curStyle !== chartTypeTarget) {
      const setOk = await tv.setChartStyle(chartTypeTarget)
      let after = null
      try { after = await tv.getChartStyle() } catch {}
      chartTypeOk = setOk && after === chartTypeTarget
    }
  }

  // 8. report (every applied/missing/failed surfaced; never a silent green with unapplied Style/Visibility)
  // when the concrete window was resolved from a relative preset at run start, surface provenance in the green box so it's clear the exact saved dates — not the preset re-resolved against today — were applied. Concrete custom ranges and label-only fallbacks keep their prior wording.
  // require BOTH from AND to before treating the range as concrete, so a malformed one-date record renders honest label-only wording instead of "period <from>–null".
  // detailed, one-field-per-line success box. The popup body is white-space:pre-line, so "\n" = line break but runs of spaces collapse — hence "Label: value" lines + a blank line between the context block and the applied block (not space-aligned columns). Dates shown DD.MM.YY; session carries a human RTH/ETH gloss + the raw token; per-category applied counts. The headers below ("…successful — 1:1 restore."/"…successful."/"…completed with errors:") are unchanged so file.upload's green/red keyword routing still holds.
  const _fmtDMY = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : (iso || '?') }
  const _sessionLabel = (s) => {
    const v = String(s || '').toLowerCase()
    if (v.includes('extended')) return `Extended hours / ETH (${s})`
    if (v.includes('regular')) return `Regular hours / RTH (${s})`
    return s || '?'
  }
  let _periodLine
  if (dateRange && dateRange.from && dateRange.to)
    _periodLine = `Testing period: ${_fmtDMY(dateRange.from)} – ${_fmtDMY(dateRange.to)}` +
      (dateRange.resolvedFromPreset && dateRange.label ? ` (from preset "${dateRange.label}" — exact saved dates applied)` : '')
  else if (dateRange && dateRange.label)
    _periodLine = `Testing period: ${dateRange.label}`
  else
    _periodLine = `Testing period: (unchanged)`
  // status-aware summary — ✓ on applied lines, ❌ + "set manually" on the ones that couldn't be applied (esp. ticker). Strategy block collapses to one ❌ line when the dialog pass was skipped/failed.
  const _ok = (v) => v ? '✓' : '❌ set manually'
  // two confirmation-box lines: Layout sits at the TOP (first applied step + most impactful); chart type after Session. Both render "(unchanged)" when the file never captured them (old files) so they never show a false ❌.
  const _layoutLine = layoutName
    ? `Layout: ${layoutName}  ${layoutOk ? '✓' : '❌ load the layout manually'}`
    : `Layout: (unchanged)`
  const _chartTypeLine = chartTypeTarget != null
    ? `Chart type: ${tv._chartStyleLabel(chartTypeTarget)}  ${_ok(chartTypeOk)}`
    : `Chart type: (unchanged)`
  const strategyBlock = (skipStrategy || !strategyApplied)
    ? `Strategy settings: ❌ not applied${strategyNote ? ' — ' + strategyNote : ''}`
    : [
        `Strategy Inputs: ${inputsResult.applied.length} applied`,
        `Strategy Properties: ${propsResult.applied.length} applied`,
        `Strategy Style: ${styleResult.applied.length} applied`,
        `Stat Visibility: ${visResult.applied.length} applied`
      ].join('\n')
  const summary = [
    _layoutLine,
    tickerFull ? `Ticker: ${tickerFull}  ${tickerOk ? '✓' : '❌ set the symbol manually — everything else below is already applied'}` : `Ticker: (unchanged)`,
    timeframe ? `Interval: ${timeframe}  ${_ok(tfOk)}` : `Interval: (unchanged)`,
    `${_periodLine}  ${_ok(periodOk)}`,
    sessionId ? `Session: ${_sessionLabel(sessionId)}  ${_ok(sessOk)}` : `Session: (unchanged)`,
    _chartTypeLine,
    '',
    strategyBlock
  ].join('\n')
  // step-level problems (actionable) — distinct from param-level `issues` below
  const stepProblems = []
  // layout listed FIRST in the actionable list (it is the first step); chart type with the rest. Both only flagged when the file actually carried them and they could not be applied.
  if (layoutName && !layoutOk) stepProblems.push(`Load the saved layout "${layoutName}" manually (Manage layouts → ${layoutName}), then re-upload to re-apply the rest onto it.`)
  if (!tickerOk) stepProblems.push(`Set the symbol to ${tickerFull} manually — every other setting is already applied, so one click lines it up.`)
  if (!tfOk) stepProblems.push(`Set the interval to ${timeframe} manually.`)
  if (!sessOk) stepProblems.push(`Set the session (${sessionId}) manually.`)
  if (chartTypeTarget != null && !chartTypeOk) stepProblems.push(`Set the chart type to ${tv._chartStyleLabel(chartTypeTarget)} manually.`)
  if (!periodOk) stepProblems.push(`Set the testing period (${dateRange && dateRange.from ? `${_fmtDMY(dateRange.from)} – ${_fmtDMY(dateRange.to)}` : (dateRange && dateRange.label) || '?'}) manually.`)
  if (skipStrategy || !strategyApplied) stepProblems.push(`Strategy settings not applied${strategyNote ? ` (${strategyNote})` : ''}.`)

  // severity has two tiers (red does not equal success):
  //   issues       = REAL failures (something restorable did not restore) -> message contains "errors" -> file.upload shows the RED popup.
  //   limitations  = known-unautomatable fields (plot colors: TradingView's picker cannot be driven programmatically) and capture-quality notes -> EXPLICITLY LISTED, but in a GREEN success popup (wording avoids file.upload's error keywords). Acceptance 3a forbids a green popup that SILENTLY hides unapplied Style fields — listing them explicitly satisfies it; a red "Error" box on a fully-successful restore was wrong.
  const issues = []
  const limitations = []
  // legacy->new dialog property translations are successful applies with provenance, not errors; a
  // skipped legacy key (no representable equivalent) is a TradingView capability change, so it is
  // listed explicitly but does not turn the popup red
  if (propsResult.migrated && propsResult.migrated.length) limitations.push(`Legacy properties auto-mapped to the new TradingView dialog (${propsResult.migrated.length}): ${propsResult.migrated.join('; ')}`)
  if (propsResult.skippedLegacy && propsResult.skippedLegacy.length) limitations.push(`Legacy properties skipped (${propsResult.skippedLegacy.length}): ${propsResult.skippedLegacy.join('; ')}`)
  if (propsResult.missing.length) issues.push(`Properties not found (${propsResult.missing.length}): ${propsResult.missing.slice(0, 12).join(', ')}`)
  if (propsResult.failed.length) issues.push(`Properties failed (${propsResult.failed.length}): ${propsResult.failed.slice(0, 12).join(', ')}`)
  if (inputsResult.missing.length) issues.push(`Inputs not found (${inputsResult.missing.length}): ${inputsResult.missing.slice(0, 12).join(', ')}`)
  if (inputsResult.failed.length) issues.push(`Inputs failed (${inputsResult.failed.length}): ${inputsResult.failed.slice(0, 12).join(', ')}`)
  if (styleResult.missing.length) issues.push(`Style not found (${styleResult.missing.length}): ${styleResult.missing.slice(0, 12).join(', ')}`)
  // split Style failures: "(color)"-suffixed rows are the known-unautomatable picker writes; anything else is a real failure
  const styleColorSkips = styleResult.failed.filter(k => k.endsWith('(color)'))
  const styleRealFails = styleResult.failed.filter(k => !k.endsWith('(color)'))
  if (styleRealFails.length) issues.push(`Style failed (${styleRealFails.length}): ${styleRealFails.slice(0, 12).join(', ')}`)
  if (styleColorSkips.length) limitations.push(`${styleColorSkips.length} plot color(s) differ from the saved run and could not be applied (TradingView's color picker isn't programmable; cosmetic only, PnL unaffected): ${styleColorSkips.slice(0, 12).join(', ')}${styleColorSkips.length > 12 ? '…' : ''}`)
  if (visResult.missing.length) issues.push(`Visibility not found (${visResult.missing.length}): ${visResult.missing.slice(0, 12).join(', ')}`)
  if (visResult.failed.length) issues.push(`Visibility failed (${visResult.failed.length}): ${visResult.failed.slice(0, 12).join(', ')}`)
  if (captureComplete.style === false) issues.push('Style was not captured at save time (not embedded) — chart style not restored.')
  if (captureComplete.visibility === false) issues.push('Visibility was not captured at save time (not embedded) — not restored.')
  if (Array.isArray(meta.propertiesUnresolved) && meta.propertiesUnresolved.length) limitations.push(`Capture note — Properties fields not fully captured at save time: ${meta.propertiesUnresolved.slice(0, 12).join(', ')}`)
  // a legacy/unresolved preset-only file (bounded preset label, no concrete from/to) restores via the named-preset click path, which TradingView re-resolves against TODAY — so the window (and PnL) can differ from the saved run. List it as a limitation so the final message is NOT "1:1 restore" (it routes to the limitations branch below). New files resolved at capture carry concrete from/to and skip this.
  // treat partial concrete data as unresolved too — a one-date bounded-preset record (only from OR only to) is flagged as a limitation, not slipped through to "1:1 restore" wording.
  if (dateRange && dateRange.label && (!dateRange.from || !dateRange.to) && typeof tv._isBoundedTestingPreset === 'function' && tv._isBoundedTestingPreset(dateRange.label))
    limitations.push(`The saved run used preset "${dateRange.label}" without concrete dates (older file); it now resolves to a different window than the original run, so PnL may not match. Re-run and re-download to capture the exact dates.`)
  // the !dialogSuccess case returns early above, so reaching here means OK was clicked — dialogSuccess is guaranteed true.

  // RED only when something actually couldn't be applied (step problems OR param-level issues); the chart still keeps everything that DID apply. "completed with errors" keeps file.upload's red routing; pure-color/capture limitations stay a GREEN box.
  const allProblems = stepProblems.concat(issues)
  if (allProblems.length)
    return `Run-context import completed with errors — fix the ❌ item(s) below (everything else IS applied):\n\n${summary}\n\nWhat to do:\n${allProblems.map(s => '• ' + s).join('\n')}${limitations.length ? '\n\nNotes:\n' + limitations.map(s => '• ' + s).join('\n') : ''}`
  if (limitations.length)
    return `Run-context import successful.\n\n${summary}\n\nNotes:\n${limitations.map(s => '• ' + s).join('\n')}`
  return `Run-context import successful — 1:1 restore.\n\n${summary}`
}

action.uploadSignals = async () => {
  await file.upload(signal.parseTSSignalsAndGetMsg, `Please check if the ticker and timeframe are set like in the downloaded data and click on the parameters of the "iondvSignals" script to automatically enter new data on the chart.`, true)
}

action.uploadStrategyTestParameters = async () => {
  const strategyData = await tv.getStrategy(null, true)
  if (!strategyData || !strategyData.hasOwnProperty('properties')) {
    await ui.showErrorPopup('The current strategy does not contain inputs that can be imported.')
    return
  }
  const baseRange = model.getStrategyRange(strategyData)
  const allowedKeys = Object.keys(baseRange)
  await file.upload(async (fileData) => {
    return await model.parseStrategyParamsAndGetMsg(fileData, allowedKeys, baseRange)
  }, '', false)
}

action.downloadStrategyTestParameters = async () => {
  const strategyData = await tv.getStrategy(null, true)
  if (!strategyData || !strategyData.hasOwnProperty('name') || !strategyData.hasOwnProperty('properties') || !strategyData.properties) {
    await ui.showErrorPopup('The current strategy does not contain inputs that can be exported.')
    return
  }
  let paramRange = await storage.getKey(storage.STRATEGY_KEY_PARAM)
  // issue#1: STRATEGY_KEY_PARAM is a single global raw range map with no per-strategy scoping, so it can hold ranges saved for a DIFFERENT strategy. If any stored key is not an input of the current strategy, do NOT export the stale ranges under this strategy's name — fall back to the current strategy's own range (same key-vs-current-strategy test model.getStrategyParameters uses).
  const _curParamKeys = Object.keys(strategyData.properties || {})
  if (paramRange && Object.keys(paramRange).length && _curParamKeys.length) {
    const _foreign = Object.keys(paramRange).filter(k => !_curParamKeys.includes(k))
    if (_foreign.length) {
      await ui.showWarningPopup(`The saved testing parameters include inputs that are not part of the current strategy (${_foreign.slice(0, 6).join(', ')}${_foreign.length > 6 ? '…' : ''}).\n\nExporting the current strategy's own parameters instead of the stored ones.`)
      paramRange = null
    }
  }
  if (!paramRange || !Object.keys(paramRange).length) {
    paramRange = model.getStrategyRange(strategyData)
    if (!paramRange || !Object.keys(paramRange).length) {
      await ui.showWarningPopup('There are no strategy testing parameters available to download yet. Configure them first and try again.')
      return
    }
  }
  const csvData = model.convertStrategyRangeToTemplate(paramRange)
  file.saveAs(csvData, `${strategyData.name} strategy parameters.csv`)
  await ui.showPopup('The strategy testing parameters were exported into a CSV file.')
}

action.getStrategyTemplate = async () => {
  const strategyData = await tv.getStrategy()
  if (!strategyData || !strategyData.hasOwnProperty('name') || !strategyData.hasOwnProperty('properties') || !strategyData.properties) {
    await ui.showErrorPopup('The current strategy do not contain inputs, than can be saved')
  } else {
    const paramRange = model.getStrategyRange(strategyData)
    console.log(paramRange)
    // await storage.setKeys(storage.STRATEGY_KEY_PARAM, paramRange)
    const strategyRangeParamsCSV = model.convertStrategyRangeToTemplate(paramRange)
    await ui.showPopup('The range of parameters is saved for the current strategy.\n\nYou can start optimizing the strategy parameters by clicking on the "Test strategy" button')
    file.saveAs(strategyRangeParamsCSV, `${strategyData.name}.csv`)
  }
}

action.clearAll = async () => {
  const clearRes = await storage.clearAll()
  await ui.showPopup(clearRes && clearRes.length ? `The data was deleted: \n${clearRes.map(item => '- ' + item).join('\n')}` : 'There was no data in the storage')
}

// issue#1 ("not my params"): STRATEGY_KEY_RESULTS is a single GLOBAL object with no per-strategy scoping, so preview/download/3D-chart can show (or apply) results captured for a DIFFERENT strategy/ticker/timeframe. This mirrors action._getHardOptimizerContext's same strategy/ticker/timeframe test but is read-only and lenient: it only reports a POSITIVE mismatch (both sides known and different), never blocks when the current identity can't be read.
action._currentResultsContextMatch = async (testResults) => {
  try {
    const storedStrategy = (testResults && (testResults.shortName || testResults.name)) || ''
    const storedTicker   = (testResults && (testResults.ticker || testResults.symbol)) || ''
    const storedTF       = (testResults && (testResults.timeFrame || testResults.timeframe)) || ''
    let curStrategy = '', curTicker = '', curTF = ''
    try { curStrategy = tv._getActiveStrategyName() || '' } catch (e) {}
    try { curTicker = (await tvChart.getTicker()) || '' } catch (e) {}
    try { curTF = (await tvChart.getCurrentTimeFrame()) || '' } catch (e) {}
    const sameStrategy = !storedStrategy || !curStrategy || normalizeTitle(storedStrategy) === normalizeTitle(curStrategy)
    const sameTicker   = !storedTicker   || !curTicker   || normalizeTitle(storedTicker) === normalizeTitle(curTicker)
    const sameTF       = !storedTF       || !curTF       || tvChart.correctTF(String(storedTF)) === tvChart.correctTF(String(curTF))
    return { match: sameStrategy && sameTicker && sameTF, sameStrategy, sameTicker, sameTF,
             stored: { strategy: storedStrategy, ticker: storedTicker, tf: storedTF },
             current: { strategy: curStrategy, ticker: curTicker, tf: curTF } }
  } catch (err) {
    console.warn('[TV-ASS] results context match check failed:', err)
    return { match: true, error: true }   // never block the user's own data on an internal error
  }
}

// issue#1: human-readable "these results are from another strategy" warning.
action._resultsMismatchMessage = (m) => {
  const parts = []
  if (m && !m.sameStrategy) parts.push(`strategy "${m.stored.strategy}" (chart has "${m.current.strategy || 'unknown'}")`)
  if (m && !m.sameTicker)   parts.push(`symbol "${m.stored.ticker}" (chart has "${m.current.ticker || 'unknown'}")`)
  if (m && !m.sameTF)       parts.push(`timeframe "${m.stored.tf}" (chart has "${m.current.tf || 'unknown'}")`)
  return `These saved results were captured for ${parts.join(', ')}.\n\nThey do NOT match the strategy currently open on the chart, so the parameters shown are not the current strategy's. Re-run the optimizer on the open strategy to get matching results.`
}

action.previewStrategyTestResults = async () => {
  const testResults = await storage.getKey(storage.STRATEGY_KEY_RESULTS)
  const hasSummary = (testResults && testResults.perfomanceSummary && testResults.perfomanceSummary.length) || (testResults && testResults.summaryChunks && testResults.summaryChunks.length)
  if (!testResults || !hasSummary) {
    await ui.showWarningPopup(message.errorsNoBacktest)
    return
  }
  // issue#1: warn (not silently) when the saved results belong to a different strategy/ticker/timeframe.
  const _ctx = await action._currentResultsContextMatch(testResults)
  if (!_ctx.match)
    await ui.showWarningPopup(action._resultsMismatchMessage(_ctx))
  console.log('previewStrategyTestResults', testResults)
  const { fullSummary, fullFiltered } = await model.buildExportSummaries(testResults)
  const previewResults = { ...testResults, perfomanceSummary: fullSummary, filteredSummary: fullFiltered }
  const eventData = await sendActionMessage(previewResults, 'previewStrategyTestResults')
  if (eventData.hasOwnProperty('message'))
    await ui.showPopup(eventData.message)

  // await ui.showPreviewResults(previewResults) // WHY NOT WORKING ?
}

action.downloadStrategyTestResults = async () => {
  const testResults = await storage.getKey(storage.STRATEGY_KEY_RESULTS)
  const hasSummary = (testResults && testResults.perfomanceSummary && testResults.perfomanceSummary.length) || (testResults && testResults.summaryChunks && testResults.summaryChunks.length)
  if (!testResults || !hasSummary) {
    await ui.showWarningPopup(message.errorsNoBacktest)
    return
  }
  testResults.optParamName = testResults.optParamName || backtest.DEF_MAX_PARAM_NAME
  console.log('downloadStrategyTestResults', testResults)
  // issue#1: never APPLY foreign stored params onto the open strategy. Only auto-set the best parameters when the stored results actually match the current strategy/ticker/timeframe; on mismatch, warn and still save the (stored-labelled) CSV.
  const _ctx = await action._currentResultsContextMatch(testResults)
  const { fullSummary, fullFiltered } = await model.buildExportSummaries(testResults)
  const exportResults = { ...testResults, perfomanceSummary: fullSummary, filteredSummary: fullFiltered }
  const CSVResults = file.convertResultsToCSV(exportResults)
  if (!_ctx.match) {
    await ui.showWarningPopup(action._resultsMismatchMessage(_ctx) + `\n\nThe results CSV will still be saved (labelled with the original strategy), but the parameters were NOT applied to the open strategy.`)
  } else {
    const bestResult = testResults.perfomanceSummary ? model.getBestResult(testResults) : {}
    const propVal = {}
    testResults.paramsNames.forEach(paramName => {
      if (bestResult.hasOwnProperty(`__${paramName}`))
        propVal[paramName] = bestResult[`__${paramName}`]
    })
    await tv.setStrategyParams(testResults.shortName, propVal)
    if (bestResult && bestResult.hasOwnProperty(testResults.optParamName))
      await ui.showPopup(`The best found parameters are set for the strategy\n\nThe best ${testResults.isMaximizing ? '(max) ' : '(min)'} ${testResults.optParamName}: ` + bestResult[testResults.optParamName])
  }
  file.saveAs(CSVResults, `${testResults.ticker}:${testResults.timeFrame} ${testResults.shortName} - ${testResults.cycles}_${testResults.isMaximizing ? 'max' : 'min'}_${testResults.optParamName}_${testResults.method}.csv`)
}




action.testStrategy = async (request, isDeepTest = false) => {
  try {
    const strategyData = await action._getStrategyData(isDeepTest)
    isDeepTest = await tvChart.detectDeepTest()
    const [allRangeParams, paramRange, cycles] = await action._getRangeParams(strategyData)
    if (allRangeParams !== null) { // click cancel on parameters
      const testParams = await action._getTestParams(request, strategyData, allRangeParams, paramRange, cycles, isDeepTest)
      console.log('Test parameters', testParams)
      action._showStartMsg(testParams.paramSpace, testParams.cycles, testParams.backtestDelay ? ` with delay between tests ${testParams.backtestDelay} sec` : '')
      testParams.isDeepTest = isDeepTest
      // await tv.setDeepTest(isDeepTest, testParams.deepStartDate)

      let testResults = {}
      if (testParams.shouldTestTF) {
        if (!testParams.listOfTF || testParams.listOfTF.length === 0) {
          await ui.showWarningPopup(`You set to test timeframes in options, but timeframes list after correction values is empty: ${testParams.listOfTFSource}\nPlease set correct one with separation by comma. \nFor example: 1m,4h`)
        } else {
          let bestValue = null
          let bestTf = null
          testParams.shouldSkipInitBestResult = true
          for (const tf of testParams.listOfTF) {
            console.log('\nTest timeframe:', tf)
            await tvChart.changeTimeFrame(tf)
            testParams.timeFrame = tf
            if (testParams.hasOwnProperty('bestPropVal'))
              delete testParams.bestPropVal
            if (testParams.hasOwnProperty('bestValue'))
              delete testParams.bestValue
            testResults = await backtest.testStrategy(testParams, strategyData, allRangeParams) // TODO think about not save, but store them from  testResults.perfomanceSummary, testResults.filteredSummary = [], testResults.timeFrame to list
            await action._saveTestResults(testResults, testParams, false)
            if (bestTf === null) {
              bestValue = testResults.bestValue
              bestTf = tf
            } else if (testResults.isMaximizing ? testParams.bestValue > bestValue : testParams.bestValue < bestValue) {
              bestValue = testResults.bestValue
              bestTf = tf
            }
            if (action.workerStatus === null) {
              console.log('Stop command detected')
              break
            }
          }
          if (bestValue !== null) {
            await ui.showPopup(`The best value ${bestValue} for timeframe ${bestTf}. Check the saved files to get the best result parameters`)
          } else {
            await ui.showWarningPopup(`Did not found any result value after testing`)
          }
        }
      } else {
        testResults = await backtest.testStrategy(testParams, strategyData, allRangeParams)
        await action._saveTestResults(testResults, testParams)
      }
      // if (isDeepTest)
      //   await tv.setDeepTest(!isDeepTest) // Reverse (switch off)
    }
  } catch (err) {
    console.error(err)
    await ui.showErrorPopup(`${err}`)
  }
  ui.statusMessageRemove()
}

action._getRangeParams = async (strategyData) => {
  let paramRange = await model.getStrategyParameters(strategyData)
  console.log('paramRange', paramRange)
  if (paramRange === null)
    // throw new Error('Error get changed strategy parameters')
    return [null, null, null]

  const initParams = {}
  initParams.paramRange = paramRange
  initParams.paramRangeSrc = model.getStrategyRange(strategyData)
  initParams.strategyName = strategyData.name
  initParams.allowedKeys = Object.keys(initParams.paramRangeSrc || {})
  const changedStrategyParams = await ui.showAndUpdateStrategyParameters(initParams)
  if (changedStrategyParams === null) {
    return [null, null, null]
  }
  const cycles = changedStrategyParams.cycles ? changedStrategyParams.cycles : 100
  console.log('changedStrategyParams', changedStrategyParams)
  if (changedStrategyParams.paramRange === null) {
    console.log('Don not change paramRange')
  } else if (typeof changedStrategyParams.paramRange === 'object' && Object.keys(changedStrategyParams.paramRange).length) {
    paramRange = changedStrategyParams.paramRange
    await model.saveStrategyParameters(paramRange)
    console.log('ParamRange changes to', paramRange)
  } else {
    throw new Error('The strategy parameters invalid. Change them or run default parameters set.')
  }

  const allRangeParams = model.createParamsFromRange(paramRange)
  console.log('allRangeParams', allRangeParams)
  if (!allRangeParams) {
    throw new Error('Empty range parameters for strategy')
  }
  return [allRangeParams, paramRange, cycles]
}

action._getStrategyData = async (isDeepTest) => {
  ui.statusMessage('Get the initial parameters.')
  // request full-context capture (Properties/Style/Visibility) inside this getStrategy dialog window; it is the only point before the report read where all four tabs are reachable. Capture is fail-soft and does not affect the returned strategyData.properties used by the optimizer.
  const strategyData = await tv.getStrategy('', false, isDeepTest, true)
  if (!strategyData || !strategyData.hasOwnProperty('name') || !strategyData.hasOwnProperty('properties') || !strategyData.properties) {
    throw new Error('The current strategy do not contain inputs, than can be optimized. You can choose another strategy to optimize.')
  }
  return strategyData
}


action._parseTF = (listOfTF) => {
  if (!listOfTF || typeof (listOfTF) !== 'string')
    return []
  return listOfTF.split(',').map(tf => tf.trim()).filter(tf => /(^\d{1,2}m$)|(^\d{1,2}h$)|(^\d{1,2}D$)|(^\d{1,2}W$)|(^\d{1,2}M$)/.test(tf))

}

action._getTestParams = async (request, strategyData, allRangeParams, paramRange, cycles, isDeepTest=false) => {
  // pass the already-read dialog-title name (strategyData.name, validated in _getStrategyData) as the authoritative knownName so a multi-study chart with no "Active strategy" legend marker no longer hard-aborts the run. Legend re-read stays a fallback only; filenames unchanged (shortName still = strategyData.name).
  let testParams = await tv.switchToStrategyTabAndSetObserveForReport(isDeepTest, strategyData && strategyData.name ? strategyData.name : '')
  const options = request && request.hasOwnProperty('options') ? request.options : {}
  const testMethod = options.hasOwnProperty('optMethod') && typeof (options.optMethod) === 'string' ? options.optMethod.toLowerCase() : 'random'
  let paramSpaceNumber = 0
  let isSequential = false
  if (['sequential'].includes(testMethod)) {
    paramSpaceNumber = Object.keys(allRangeParams).reduce((sum, param) => sum += allRangeParams[param].length, 0)
    isSequential = true
  } else {
    paramSpaceNumber = Object.keys(allRangeParams).reduce((mult, param) => mult *= allRangeParams[param].length, 1)
  }
  console.log('paramSpaceNumber', paramSpaceNumber)

  // abort BEFORE the run (before _showStartMsg / backtest.testStrategy) when there is no valid mutable domain. "0 possible combinations" means a parameter has an empty value array (a param.length of 0 zeroes the product); no keys means nothing was enabled. Running it produces a pointless/stuck search. Throw a clear, actionable error instead — caught by action.testStrategy -> showErrorPopup.
  if (!allRangeParams || Object.keys(allRangeParams).length === 0 || !Number.isFinite(paramSpaceNumber) || paramSpaceNumber <= 0)
    throw new Error('No parameters are enabled to optimize (0 possible combinations). Enable at least one parameter with a valid from/to/step range (each must yield at least one value), then run again.')

  testParams.shouldTestTF = options.hasOwnProperty('shouldTestTF') ? options.shouldTestTF : false
  testParams.listOfTF = action._parseTF(options.listOfTF)
  testParams.listOfTFSource = options.listOfTF
  testParams.shouldSkipInitBestResult = false // TODO get from options

  testParams.paramSpace = paramSpaceNumber
  let paramPriority = model.getParamPriorityList(paramRange) // Filter by allRangeParams
  paramPriority = paramPriority.filter(key => allRangeParams.hasOwnProperty(key))
  console.log('paramPriority list', paramPriority)
  testParams.paramPriority = paramPriority

  testParams.startParams = await model.getStartParamValues(paramRange, strategyData)
  console.log('testParams.startParams', testParams.startParams)
  if (!testParams.hasOwnProperty('startParams') || !testParams.startParams.hasOwnProperty('current') || !testParams.startParams.current) {
    throw new Error('Error.\n\n The current strategy parameters could not be determined.\n Testing aborted')
  }

  testParams.cycles = cycles

    if (request.options) {
    testParams.isMaximizing = request.options.hasOwnProperty('isMaximizing') ? request.options.isMaximizing : true
    testParams.optParamName = request.options.optParamName ? request.options.optParamName : backtest.DEF_MAX_PARAM_NAME
    testParams.method = testMethod
    testParams.filterAscending = request.options.hasOwnProperty('optFilterAscending') ? request.options.optFilterAscending : null
    testParams.filterValue = request.options.hasOwnProperty('optFilterValue') ? request.options.optFilterValue : 50
    testParams.filterParamName = request.options.hasOwnProperty('optFilterParamName') ? request.options.optFilterParamName : 'Total trades: All'
    testParams.filter2Ascending = request.options.hasOwnProperty('optFilter2Ascending') ? request.options.optFilter2Ascending : null
    testParams.filterValue2 = request.options.hasOwnProperty('optFilterValue2') ? request.options.optFilterValue2 : 50
    testParams.filterParamName2 = request.options.hasOwnProperty('optFilterParamName2') ? request.options.optFilterParamName2 : 'Total trades: All'
    testParams.deepStartDate = !request.options.hasOwnProperty('deepStartDate') || request.options['deepStartDate'] === '' ? null : request.options['deepStartDate']
    testParams.backtestDelay = !request.options.hasOwnProperty('backtestDelay') || !request.options['backtestDelay'] ? 0 : request.options['backtestDelay']
    testParams.randomDelay = request.options.hasOwnProperty('randomDelay') ? Boolean(request.options['randomDelay']) : true
    testParams.shouldSkipInitBestResult = request.options.hasOwnProperty('shouldSkipInitBestResult') ? Boolean(request.options['shouldSkipInitBestResult']) : false
      testParams.shouldSkipWaitingForDownload = request.options.hasOwnProperty('shouldSkipWaitingForDownload') ? Boolean(request.options['shouldSkipWaitingForDownload']) : false
      testParams.dataLoadingTime = request.options.hasOwnProperty('dataLoadingTime') && !isNaN(parseInt(request.options['dataLoadingTime'])) ? request.options['dataLoadingTime'] : 30
      testParams.autoBestDownload = request.options.hasOwnProperty('autoBestDownload') ? Boolean(request.options['autoBestDownload']) : true
      // disable GA min-trades gate by default; only enable when the user explicitly provides GA trade-threshold options
      // fix popup null/invalid thresholds so the GA gate only enables for valid numeric opt-in values
      // GA feasibility: target trades per day (opt-in only)
      if (request.options.hasOwnProperty('targetTradesPerDay')) {
        const tpd = parseFloat(request.options['targetTradesPerDay'])
        if (Number.isFinite(tpd) && tpd >= 0) {
          testParams.targetTradesPerDay = tpd
          testParams.gaTradesGateEnabled = true
        }
      } else {
        testParams.gaTradesGateEnabled = false
      }
      // GA feasibility: minimum total closed trades (explicit UI knob). If provided, override computed threshold.
      if (request.options.hasOwnProperty('gaMinTradesTotal')) {
        const mtt = parseInt(request.options['gaMinTradesTotal'], 10)
        if (Number.isFinite(mtt) && mtt >= 0) {
          testParams.minTradesTotal = mtt
          testParams.gaTradesGateEnabled = true
        }
      }
    }

  if (!testParams.hasOwnProperty('autoBestDownload'))
    testParams.autoBestDownload = true
  // keep GA gate opt-in default false when the caller does not provide explicit GA feasibility options
  if (!testParams.hasOwnProperty('gaTradesGateEnabled'))
    testParams.gaTradesGateEnabled = false

  // assemble the v3 runContext on testParams (== testResults during the run, so it survives to _autosaveOnBest/_saveTestResults). The async chart reads (session, exchange-qualified symbol) happen HERE; backtest._autosaveOnBest only does the sync per-save refresh (date range + optimizer block) so it stays synchronous.
  testParams.runContext = await action._buildRunContextV3(testParams, strategyData)

  return testParams
}

// build the v3 runContext (async chart reads done once at run start). style/visibility are REQUIRED v3 fields; captureComplete flags preserve whether each tab actually scraped, so restore/reporting never treats a partial capture as a complete 1:1. Fail-soft: any read error leaves that field null and is reflected in captureComplete.
action._buildRunContextV3 = async (testParams, strategyData) => {
  const cap = (strategyData && strategyData._fullContextCapture) ? strategyData._fullContextCapture : {}
  let sessionId = null
  let tickerFull = null
  try { sessionId = await tv.getChartSession() } catch (err) { console.warn('[TV-ASS] ISSUE005 runContext session read failed', err) }
  try {
    const sym = await tv.getChartSymbol()
    if (sym && sym.symbol)
      tickerFull = sym.symbol
  } catch (err) { console.warn('[TV-ASS] ISSUE005 runContext symbol read failed', err) }
  // capture the chart TYPE int (candles/Heikin Ashi/…) and the active LAYOUT name at run start. Both fail-soft (null on any read error) — they never block the run. chartType is PnL-affecting for Heikin Ashi/Renko/etc.; layout is restored FIRST on import (it replaces symbol + indicators).
  let chartType = null
  try { chartType = await tv.getChartStyle() } catch (err) { console.warn('[TV-ASS] ISSUE011 runContext chart style read failed', err) }
  let layout = null
  try { layout = (typeof tv.getChartLayoutName === 'function') ? tv.getChartLayoutName() : null } catch (err) { console.warn('[TV-ASS] ISSUE011 runContext layout read failed', err) }
  let extVersion = null
  try { extVersion = chrome.runtime.getManifest().version } catch {}
  // resolve a BOUNDED relative preset ("Last N days"/"Range from chart") to its concrete {from,to} window at run start, so the winner CSV freezes the real window instead of a label that re-resolves against the upload date. _buildRunContextV3 is already async, so awaiting the read-only resolver is free; it is fail-closed (returns the label-only read, or null, on any problem — never throws/blocks the run). Falls back to the prior sync read if the resolver is unavailable.
  const dateRange = (typeof tv.resolveTestingPeriodConcrete === 'function'
    ? await tv.resolveTestingPeriodConcrete()
    : (typeof tv._readTestingPeriod === 'function' ? tv._readTestingPeriod() : null)) || null
  return {
    v: 3,
    strategyName: testParams.name || (strategyData && strategyData.name) || null,
    ticker: testParams.ticker || null,
    tickerFull: tickerFull,
    timeframe: testParams.timeFrame || null,
    sessionId: sessionId,
    dateRange: dateRange,
    // layout (name string) + chartType (int) embedded in v3 meta. Old files lack these and restore skips them silently (no false ❌). chartType is DISTINCT from `style` below (which is the strategy Style-tab params, NOT the chart type).
    layout: layout,
    chartType: chartType,
    properties: cap.properties || {},
    propertiesUnresolved: cap.propertiesUnresolved || [],
    style: cap.style || null,
    visibility: cap.visibility || null,
    optimizer: action._extractOptimizerFields(testParams),
    extVersion: extVersion,
    captureComplete: {
      properties: !!cap.properties,
      style: !!(cap.style && Array.isArray(cap.style.rows) && cap.style.rows.length),
      visibility: !!(cap.visibility && Array.isArray(cap.visibility.rows) && cap.visibility.rows.length)
    }
  }
}


action._showStartMsg = (paramSpaceNumber, cycles, addInfo) => {
  let extraHeader = `The search is performed among ${paramSpaceNumber} possible combinations of parameters (space).`
  extraHeader += (paramSpaceNumber / cycles) > 10 ? `<br />This is too large for ${cycles} cycles. It is recommended to use up to 3-4 essential parameters, remove the rest from the strategy parameters file.` : ''
  ui.statusMessage(`Started${addInfo}.`, extraHeader)
}

action._saveTestResults = async (testResults, testParams, isFinalTest = true) => {
  console.log('testResults', testResults)
  const hasSummaryList = Array.isArray(testResults && testResults.perfomanceSummary)
  const hasSummaryChunks = Array.isArray(testResults && testResults.summaryChunks)
  if (!testResults || (!hasSummaryList && !hasSummaryChunks)) {
    await ui.showWarningPopup('There is no testing data for saving. Try to do test again')
    return
  }

  const { fullSummary, fullFiltered } = await model.buildExportSummaries(testResults)
  const exportResults = { ...testResults, perfomanceSummary: fullSummary, filteredSummary: fullFiltered }

  const CSVResults = file.convertResultsToCSV(exportResults)
  const bestResult = model.getBestResult(testResults) || {}
  const initBestValue = testResults.hasOwnProperty('initBestValue') ? testResults.initBestValue : null
  const propVal = {}
  testResults.paramsNames.forEach(paramName => {
    if (bestResult.hasOwnProperty(`__${paramName}`))
      propVal[paramName] = bestResult[`__${paramName}`]
  })
  if (isFinalTest)
    await tv.setStrategyParams(testResults.shortName, propVal)

  let text = `All done.\n\n`
  text += bestResult && bestResult.hasOwnProperty(testParams.optParamName) ? 'The best ' + (testResults.isMaximizing ? '(max) ' : '(min) ') + testParams.optParamName + ': ' + backtest.convertValue(bestResult[testParams.optParamName]) : ''
  text += (initBestValue !== null && bestResult && bestResult.hasOwnProperty(testParams.optParamName) && initBestValue === bestResult[testParams.optParamName]) ? `\nIt isn't improved from the initial value: ${backtest.convertValue(initBestValue)}` : ''
  ui.statusMessage(text)
  // clear #iondvApplyLine at the terminal "All done." status. The final best-parameter apply above (isFinalTest -> tv.setStrategyParams) leaves "✓ Applied …" in the apply line; without this it would sit next to the completed-run message. Guarded; statusMessage(text) above is the replace-path and does not touch the apply line.
  try { if (typeof ui.statusApplyLine === 'function') ui.statusApplyLine('') } catch {}
  console.log(`All done.\n\n${bestResult && bestResult.hasOwnProperty(testParams.optParamName) ? 'The best ' + (testResults.isMaximizing ? '(max) ' : '(min) ') + testParams.optParamName + ': ' + bestResult[testParams.optParamName] : ''}`)
  file.saveAs(CSVResults, `${testResults.ticker}:${testResults.timeFrame}${testResults.isDeepTest ? ' deep backtesting' : ''} ${testResults.shortName} - ${testResults.cycles}_${testResults.isMaximizing ? 'max' : 'min'}_${testParams.optParamName}_${testResults.method}.csv`)

  if (propVal && Object.keys(propVal).length && bestResult && typeof bestResult === 'object') {
    const bestResultSnapshot = { ...bestResult }
    let bestPropSnapshot = { ...propVal }
    if (typeof backtest._prepareFullBestPropVal === 'function') {
      const merged = backtest._prepareFullBestPropVal(testResults, propVal)
      if (merged && typeof backtest._clonePropValues === 'function')
        bestPropSnapshot = backtest._clonePropValues(merged)
      else
        bestPropSnapshot = { ...merged }
    } else if (typeof backtest._clonePropValues === 'function') {
      bestPropSnapshot = backtest._clonePropValues(propVal)
    }
    if (typeof backtest._autosaveOnBest === 'function') {
      try {
        backtest._autosaveOnBest(testResults, { data: bestResultSnapshot, bestPropVal: bestPropSnapshot }, { force: true, suffix: 'final' })
      } catch (err) {
        console.error('Failed to save final best parameters', err)
      }
    }
  }
}


action.show3DChart = async () => {
  const testResults = await storage.getKey(storage.STRATEGY_KEY_RESULTS)
  const hasSummaryShow = (testResults && testResults.perfomanceSummary && testResults.perfomanceSummary.length) || (testResults && testResults.summaryChunks && testResults.summaryChunks.length)
  if (!testResults || !hasSummaryShow) {
    await ui.showPopup('There is no results data for to show. Try to backtest again')
    return
  }
  testResults.optParamName = testResults.optParamName || backtest.DEF_MAX_PARAM_NAME
  // issue#1: warn (not silently) when the 3D-chart data belongs to a different strategy/ticker/timeframe than the one open on the chart.
  const _ctx3d = await action._currentResultsContextMatch(testResults)
  if (!_ctx3d.match)
    await ui.showWarningPopup(action._resultsMismatchMessage(_ctx3d))
  const { fullSummary: showSummary, fullFiltered: showFiltered } = await model.buildExportSummaries(testResults)
  const showPayload = { ...testResults, perfomanceSummary: showSummary, filteredSummary: showFiltered }
  const eventData = await sendActionMessage(showPayload, 'show3DChart')
  if (eventData.hasOwnProperty('message'))
    await ui.showPopup(eventData.message)
}

function parseMetricValue(value) {
  if (value === null || typeof value === 'undefined')
    return null
  if (typeof value === 'number')
    return value
  const normalized = String(value).trim()
  if (!normalized)
    return null
  const cleaned = normalized.replace(/,/g, '')
  const match = cleaned.match(/-?\d+(?:\.\d+)?/)
  if (!match)
    return null
  const num = parseFloat(match[0])
  return Number.isFinite(num) ? num : null
}

async function sendActionMessage(data, action) {
  return new Promise(resolve => {
    const url = window.location && window.location.origin ? window.location.origin : 'https://www.tradingview.com'
    tvPageMessageData[action] = resolve
    window.postMessage({ name: 'iondvScript', action, data }, url) // TODO wait for data
  })
}
