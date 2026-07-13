const tv = {
  reportNode: null,
  reportDeepNode: null,
  tickerTextPrev: null,
  timeFrameTextPrev: null,
  isReportChanged: false,
  _settingsMethod: null,
  lastSetStrategyResult: null
}

function normalizeTitle(s) {
  return (s || '').trim().replace(/\s+/g, ' ')
}

function normalizeMetricName(name) {
  if (!name) return ''
  const s = String(name).trim()

  if (s.startsWith('Net P&L')) return 'Net profit'

  // Jun 2026 TV UI renamed the headline report cards ("Total PnL", "Max drawdown", "Profitable trades"); map them to the canonical names the optimizer reads so report keys match.
  // "Total PnL" is NOT "Net profit": the card includes OPEN position P&L (live: card 34.36 = table Net PnL 6.69 + Open P&L 27.67), while the report table's "Net PnL" is closed trades only.
  // Mapping both to 'Net profit' made the exported value flip between the two depending on which write won — the "final report doesn't match the chart" mismatch. Keep the card under its own key.
  if (/^total p(&|n)?l$/i.test(s)) return 'Total P&L'         // "Total PnL" / "Total P&L" card (closed + open)
  if (/^max drawdown$/i.test(s)) return 'Max equity drawdown'
  if (/^profitable trades$/i.test(s)) return 'Percent profitable'

  if (/^net pnl$/i.test(s)) return 'Net profit'                       // returns table "Net PnL" (live; classic "Net P&L" handled above)
  if (/^open pnl$/i.test(s)) return 'Open P&L'
  if (/^total winners$/i.test(s)) return 'Winning trades'
  if (/^total losers$/i.test(s)) return 'Losing trades'
  if (/^average pnl$/i.test(s)) return 'Avg P&L'
  if (/^average profit \/ average loss$/i.test(s)) return 'Ratio avg win / avg loss'  // BEFORE "Average profit" (prefix)
  if (/^average profit$/i.test(s)) return 'Avg winning trade'
  if (/^average loss$/i.test(s)) return 'Avg losing trade'
  if (/^largest profit$/i.test(s)) return 'Largest winning trade'
  if (/^largest loss$/i.test(s)) return 'Largest losing trade'
  if (/^largest profit %$/i.test(s)) return 'Largest winning trade %'
  if (/^largest loss %$/i.test(s)) return 'Largest losing trade %'
  if (/^average bars in trades$/i.test(s)) return 'Avg # bars in trades'
  if (/^average bars in winners$/i.test(s)) return 'Avg # bars in winning trades'
  if (/^average bars in losers$/i.test(s)) return 'Avg # bars in losing trades'
  // Buy & hold: keep the abs and the % as DISTINCT canonical keys (dropdown has both "Buy & hold return" and "Buy & hold return %") — never collapse both to the bare name.
  if (/^buy and hold pnl$/i.test(s)) return 'Buy & hold return'
  if (/^buy and hold % gain$/i.test(s)) return 'Buy & hold return %'

  // Drawdown variants - map to distinct canonical names
  if (/Max equity drawdown as % of initial capital/i.test(s)) return 'Max equity drawdown %'
  if (/Max equity drawdown.*intrabar/i.test(s)) return 'Max equity drawdown intrabar'
  if (/Max equity drawdown.*close-to-close/i.test(s)) return 'Max equity drawdown close-to-close'
  if (/^Max equity drawdown$/i.test(s)) return 'Max equity drawdown'

  // Run-up variants
  if (/Max equity run-up as % of initial capital/i.test(s)) return 'Max equity run-up %'
  if (/Max equity run-up.*intrabar/i.test(s)) return 'Max equity run-up intrabar'
  if (/Max equity run-up.*close-to-close/i.test(s)) return 'Max equity run-up close-to-close'
  if (/^max run-up as % of initial capital \(intrabar\)$/i.test(s)) return 'Max equity run-up %'
  if (/^max run-up \(intrabar\)$/i.test(s)) return 'Max equity run-up'

  return s
}

const SUPPORT_TEXT = 'Please retry. <br />If the problem reproduced then it is possible that TV UI changed. Create task on' +
  '<a href="https://github.com/akumidv/tradingview-assistant-chrome-extension/issues/" target="_blank"> github</a> please (check before if it isn\'t alredy created)'

// Inject script to get access to TradingView data on page
const script = document.createElement('script');
script.src = chrome.runtime.getURL('page-context.js');
document.documentElement.appendChild(script);

const scriptPlot = document.createElement('script');
scriptPlot.src = chrome.runtime.getURL('lib/plotly.min.js')
document.documentElement.appendChild(scriptPlot);

const tvPageMessageData = {}

window.addEventListener('message', messageHandler)

const reconnectWatcher = {
  started: false,
  pendingTimeout: null,
  lastClick: 0,
  minDelayMs: 9000,
  maxDelayMs: 15000,
  observer: null,
  pollTimer: null
}

function startReconnectMonitor() {
  if (reconnectWatcher.started)
    return
  reconnectWatcher.started = true
  const root = document.getElementById('overlap-manager-root') || document.body
  if (root) {
    reconnectWatcher.observer = new MutationObserver(handleReconnectMutations)
    reconnectWatcher.observer.observe(root, { childList: true, subtree: true })
  }
  reconnectWatcher.pollTimer = setInterval(() => {
    const base = document.getElementById('overlap-manager-root') || document.body
    if (!base) {
      cancelPendingReconnect()
      return
    }
    scheduleReconnectIfNeeded(findReconnectButton(base))
  }, 60000)
}

function cancelPendingReconnect() {
  if (reconnectWatcher.pendingTimeout) {
    clearTimeout(reconnectWatcher.pendingTimeout)
    reconnectWatcher.pendingTimeout = null
  }
}

function handleReconnectMutations(mutationList) {
  for (const mutation of mutationList) {
    if (!mutation.addedNodes || !mutation.addedNodes.length)
      continue
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement))
        continue
      const btn = findReconnectButton(node)
      if (btn) {
        scheduleReconnectIfNeeded(btn)
        return
      }
    }
  }
}

function scheduleReconnectIfNeeded(button) {
  if (!button) {
    cancelPendingReconnect()
    return
  }
  if (reconnectWatcher.pendingTimeout)
    return
  const min = reconnectWatcher.minDelayMs
  const max = Math.max(reconnectWatcher.maxDelayMs, reconnectWatcher.minDelayMs + 1)
  const randomizedDelay = min + Math.random() * (max - min)
  reconnectWatcher.pendingTimeout = setTimeout(() => {
    reconnectWatcher.pendingTimeout = null
    reconnectWatcher.lastClick = Date.now()
    try {
      page.mouseClick(button)
    } catch (err) {
      console.warn('[TV-ASS] Failed to click reconnect button automatically.', err)
    }
  }, randomizedDelay)
}

function findReconnectButton(root) {
  const candidates = root.querySelectorAll('button, [role="button"]')
  for (const el of candidates) {
    if (!el)
      continue
    let label = ''
    try {
      label = el.innerText || el.textContent || ''
    } catch {
      label = ''
    }
    if (!label) {
      label = el.getAttribute('aria-label') || el.getAttribute('data-name') || ''
    }
    const normalized = label ? label.trim().toLowerCase() : ''
    if (normalized === 'connect' || normalized === 'reconnect')
      return el
  }
  return null
}

startReconnectMonitor()


async function messageHandler(event) {
  const url = window.location && window.location.origin ? window.location.origin : 'https://www.tradingview.com'
  if (!event.origin.startsWith(url) || !event.data ||
    !event.data.hasOwnProperty('name') || event.data.name !== 'iondvPage' ||
    !event.data.hasOwnProperty('action'))
    return
  const messageKey = event.data.requestId ? `${event.data.action}#${event.data.requestId}` : event.data.action
  if (tvPageMessageData.hasOwnProperty(messageKey) && typeof (tvPageMessageData[messageKey]) === 'function') { // Callback
    const resolve = tvPageMessageData[messageKey]
    delete tvPageMessageData[messageKey]
    resolve(event.data)
  } else {
    tvPageMessageData[messageKey] = event.data.data
  }
}


// opt-in 4th param captureFullContext: when true (only action._getStrategyData passes it), scrape Properties + Style + Visibility while THIS dialog is open — the only window all four tabs are reachable before the report read. Defaults false so every other caller is byte-identical. Capture is fail-soft per tab: it must NEVER break the optimization flow.
tv.getStrategy = async (strategyName = '', isIndicatorSave = false, isDeepTest = false, captureFullContext = false) => {
  try {
    await tv.openStrategyTab(isDeepTest)
  } catch (err) {
    console.warn('checkAndOpenStrategy error', err)
  }
  let isOpened = false
  if (strategyName)
    isOpened = await tv.openStrategyParameters(strategyName, true)
  else
    isOpened = await tv.openStrategyParameters(null, false)
  if (!isOpened) {
    throw new Error('It was not possible open strategy. Add it to the chart and try again.')
  }

  const dialogTitle = await page.waitForSelector(SEL.indicatorTitle)
  if (!dialogTitle || dialogTitle.innerText === null)
    throw new Error('It was not possible to find a strategy with parameters among the indicators. Add it to the chart and try again.')
  const indicatorName = tv.getStrategyNameFromPopup()
  if (!await tv.changeDialogTabToInput())
    throw new Error(`Can\'t activate input tab in strategy parameters` + SUPPORT_TEXT)

  // issue#1 (multiple strategies open): pass the verified dialog title so getStrategyParams scrapes ONLY this strategy's dialog, never a second open dialog's inputs.
  const strategyInputs = await tv.getStrategyParams(isIndicatorSave, false, indicatorName)
  const strategyData = { name: indicatorName, properties: strategyInputs }

  if (captureFullContext) {
    const capture = {}
    try {
      await tv.changeDialogTabToProperties()
      const propsResult = await tv.getPropertiesParams()
      capture.properties = propsResult.properties
      capture.propertiesUnresolved = propsResult.unresolved
    } catch (err) {
      console.warn('[TV-ASS] ISSUE005 capture: Properties scrape failed', err)
    }
    try {
      await tv.changeDialogTabToStyle()
      capture.style = await tv.getStyleParams()
    } catch (err) {
      console.warn('[TV-ASS] ISSUE005 capture: Style scrape failed', err)
    }
    try {
      await tv.changeDialogTabToVisibilities()
      capture.visibility = await tv.getVisibilityParams()
    } catch (err) {
      console.warn('[TV-ASS] ISSUE005 capture: Visibility scrape failed', err)
    }
    try { await tv.changeDialogTabToInput() } catch {}
    strategyData._fullContextCapture = capture
  }

  if (!isIndicatorSave && document.querySelector(SEL.cancelBtn)) {
    document.querySelector(SEL.cancelBtn).click()
    await page.waitForSelector(SEL.cancelBtn, 1000, true)
  }

  return strategyData
}

// issue#1 (multiple strategies open): resolve the SINGLE strategy dialog to scrape. Prefer the dialog whose title matches expectedTitle; else the only open dialog; else null (ambiguous). This prevents merging cells from a second, unrelated indicator-properties-dialog.
tv._resolveStrategyDialogRoot = (expectedTitle = '') => {
  const root = document.querySelector(SEL.tvDialogRoot) || document
  const dialogs = [...root.querySelectorAll(SEL.indicatorDialog)]
  if (!dialogs.length) return null
  if (expectedTitle) {
    // issue#1: when a specific strategy is requested, return ONLY a title-matching dialog, else null. NEVER return "the only open dialog" when its title doesn't match — that would let a wrong single dialog be scraped as the requested strategy.
    const want = normalizeTitle(expectedTitle)
    return dialogs.find(d => {
      const t = d.querySelector(SEL.indicatorTitleInDialog)
      return t && normalizeTitle(t.innerText || '') === want
    }) || null
  }
  // no expected title: only unambiguous when exactly one dialog is open
  return dialogs.length === 1 ? dialogs[0] : null
}

tv.getStrategyParams = async (isIndicatorSave = false, useLiveCheckbox = false, expectedTitle = '') => {
  const strategyInputs = {} // TODO to list of values and set them in the same order
  // issue#1 (multiple strategies open): scope the scrape to the single verified dialog. If a strategy title was requested but no single dialog matches, REFUSE the document-wide scrape (return empty) so foreign dialogs are never merged. The legacy document-wide fallback is kept ONLY for callers that pass no expectedTitle (e.g. the post-set read-back).
  const dialogRoot = tv._resolveStrategyDialogRoot(expectedTitle)
  let indicProperties
  if (dialogRoot) {
    indicProperties = dialogRoot.querySelectorAll(SEL.indicatorPropertyInDialog)
  } else if (expectedTitle) {
    console.warn(`[TV-ASS] getStrategyParams: no single dialog matching "${expectedTitle}"; refusing document-wide scrape to avoid merging other strategies' inputs`)
    return strategyInputs
  } else {
    indicProperties = document.querySelectorAll(SEL.indicatorProperty)   // legacy fallback ONLY when no expectedTitle was given
  }
  for (let i = 0; i < indicProperties.length; i++) {
    const propClassName = indicProperties[i].getAttribute('class')
    const propText = indicProperties[i].innerText
    if (!propClassName || !propText) // Undefined type of element
      continue
    if (propClassName.includes('topCenter-')) {  // Two rows, also have first in class name
      i++ // Skip get the next cell because it content values
      continue // Doesn't realise to manage this kind of properties (two rows)
    } else if (propClassName.includes('first-') && indicProperties[i].innerText) {
      i++
      if (indicProperties[i] && indicProperties[i].querySelector('input')) {
        let propValue = indicProperties[i].querySelector('input').value
        if (indicProperties[i].querySelector('input').getAttribute('inputmode') === 'numeric' ||
          (parseFloat(propValue) == propValue || parseInt(propValue) == propValue)) { // not only inputmode==numbers input have digits
          const digPropValue = parseFloat(propValue) == parseInt(propValue) ? parseInt(propValue) : parseFloat(propValue)  // Detection if float or int in the string
          if (!isNaN(propValue))
            strategyInputs[propText] = digPropValue
          else
            strategyInputs[propText] = propValue
        } else {
          strategyInputs[propText] = propValue
        }
      // Jan 2026 TV UI: list/dropdown is button[role="combobox"] (was span[role="button"])
    } else if (indicProperties[i].querySelector('button[role="combobox"]')) { // List/dropdown
        const buttonEl = indicProperties[i].querySelector('button[role="combobox"]')
        if (!buttonEl)
          continue
        const propValue = buttonEl.innerText
        if (propValue) {
          if (isIndicatorSave) {
            strategyInputs[propText] = propValue
            continue
          }
          buttonEl.scrollIntoView()
          await page.waitForTimeout(100)
          page.mouseClick(buttonEl)
          const isOptions = await page.waitForSelector(SEL.strategyListOptions, 1000)
          if (isOptions) {
            const allOptionsEl = document.querySelectorAll(SEL.strategyListOptions)
            let allOptionsList = propValue + ';'
            for (let optionEl of allOptionsEl) {
              if (optionEl && optionEl.innerText && optionEl.innerText !== propValue) {
                allOptionsList += optionEl.innerText + ';'
              }
            }
            if (allOptionsList)
              strategyInputs[propText] = allOptionsList
            page.mouseClick(buttonEl)
          } else {
            strategyInputs[propText] = propValue
          }
        }
      } else { // Undefined
        continue
      }
    } else if (propClassName.includes('fill-')) {
      const element = indicProperties[i].querySelector('input[type="checkbox"]')
      // useLiveCheckbox reads Boolean(element.checked) for live state; the legacy path keeps getAttribute('checked')
      if (element)
        strategyInputs[propText] = useLiveCheckbox ? Boolean(element.checked) : (element.getAttribute('checked') !== null ? element.checked : false)
      else { // Undefined type of element
        continue
      }
    } else if (propClassName.includes('titleWrap-')) { // Titles bwtwen parameters
      continue
    } else { // Undefined type of element
      continue
    }
  }
  return strategyInputs
}

// DOM-only setter: the page-context API write path is gone (upstream akumidv disabled it after TV changed its internal schema — TV's _widgets.backtesting no longer exposes _strategyDispatcher, so the API threw on every call and fell back to DOM anyway). This goes straight to the visible legacy DOM setter (the same path CSV upload uses). lastSetStrategyResult is still populated from the legacy envelope so the existing diagnostics in backtest.js / file._applyParamsOnly keep working.
tv.setStrategyParams = async (name, propVal, isDeepTest = false, keepStrategyParamOpen = false) => {
  tv.lastSetStrategyResult = null
  // DOM read-back verifier: runs ONLY during an optimization (the #iondvStatus box exists), never for one-off imports/autosave. Keeps the dialog open after the set to read the just-applied values, then commits with OK. Logs per cycle how many selected params changed, which did not, and which NOT-selected params drifted (upstream issue #358). Console-only; never alters applied values or the return contract.
  const verify = !!(typeof document !== 'undefined' && document.getElementById && document.getElementById('iondvStatus'))
  const legacyEnvelope = await tv._setStrategyParamsLegacy(name, propVal, isDeepTest, keepStrategyParamOpen || verify)
  await tv._humanizeStrategyApply(legacyEnvelope)
  if (verify) {
    try { await tv._verifyDomApply(propVal) } catch (err) { console.warn('[TV-ASS] read-back verify failed (non-fatal):', err) }
    if (!keepStrategyParamOpen) { // we forced the dialog open only to read back — close it now, committing via OK
      const okBtn = page.$(SEL.okBtn)
      if (okBtn) okBtn.click()
      else { const cancelBtn = page.$(SEL.cancelBtn); if (cancelBtn) cancelBtn.click() }
    }
  }
  const legacySuccess = !!(legacyEnvelope && legacyEnvelope.success !== false)
  tv.lastSetStrategyResult = { method: legacySuccess ? 'legacy' : 'legacy-error', response: null, legacy: legacyEnvelope }
  return legacySuccess
}

tv._valuesLooseEqual = (a, b) => {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  const sa = String(a).trim(), sb = String(b).trim()
  if (sa === sb) return true
  const na = Number(sa), nb = Number(sb)
  if (sa !== '' && sb !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return Math.abs(na - nb) < 1e-9
  return false
}

tv._verifyDomApply = async (requested) => {
  // read with useLiveCheckbox=true: the dialog isn't virtualized (every row renders), but getStrategyParams' default checkbox read uses the stale 'checked' ATTRIBUTE pre-commit, so a just-flipped box would read wrong. Live Boolean(element.checked) is correct on the still-open dialog. (true, true) = read-only + live checkbox.
  let readback = {}
  try { readback = await tv.getStrategyParams(true, true) } catch { readback = {} }
  const reqKeys = Object.keys(requested || {})
  const missing = []
  let appliedN = 0
  for (const k of reqKeys) {
    if (Object.prototype.hasOwnProperty.call(readback, k) && tv._valuesLooseEqual(readback[k], requested[k])) appliedN++
    else missing.push(k)
  }
  const unselectedChanged = []
  const base = tv._lastFullReadback
  if (base && typeof base === 'object') {
    for (const k of Object.keys(readback)) {
      if (reqKeys.includes(k)) continue
      if (Object.prototype.hasOwnProperty.call(base, k) && !tv._valuesLooseEqual(readback[k], base[k]))
        unselectedChanged.push(k)
    }
  }
  tv._lastFullReadback = readback
  const SHOW = 10
  let msg = `[TV-ASS] read-back: set ${appliedN}/${reqKeys.length} selected`
  if (missing.length) msg += ` | ⚠ ${missing.length} selected did NOT change: ${missing.slice(0, SHOW).join(', ')}${missing.length > SHOW ? '…' : ''}`
  if (unselectedChanged.length) msg += ` | ⚠ ${unselectedChanged.length} NOT-selected changed: ${unselectedChanged.slice(0, SHOW).join(', ')}${unselectedChanged.length > SHOW ? '…' : ''}`
  console.info(msg)
  return { appliedN, requested: reqKeys.length, missing, unselectedChanged }
}

tv._setStrategyParamsLegacy = async (name, propVal, isDeepTest = false, keepStrategyParamOpen = false) => {

  const indicatorTitleEl = await tv.checkAndOpenStrategy(name, isDeepTest) // In test.name - ordinary strategy name but in strategyData.name short one as in indicator title
  if (!indicatorTitleEl)
    return null
  // switch to the Inputs tab before setting params; without this the dialog may open on Style/Properties and all params report as missing
  try { await tv.changeDialogTabToInput() } catch {}
  let popupVisibleHeight = 917
  try {
    popupVisibleHeight = page.$(SEL.indicatorScroll)?.getBoundingClientRect()?.bottom || 917
  } catch {
  }
  let indicProperties = document.querySelectorAll(SEL.indicatorProperty)
  const propKeys = Object.keys(propVal)
  let setPropertiesNames = {}
  for (let i = 0; i < indicProperties.length; i++) {
    const propText = indicProperties[i].innerText
    if (propText && propKeys.includes(propText)) {
      try {
        const rect = indicProperties[i].getBoundingClientRect()
        if (rect.top < 0 || rect.bottom > popupVisibleHeight || !indicProperties[i].checkVisibility()) {
          indicProperties[i].scrollIntoView()
          await page.waitForTimeout(10)
          if (indicProperties[i].getBoundingClientRect()?.bottom > popupVisibleHeight)
            await page.waitForTimeout(50)
        }
      } catch {
      }
      setPropertiesNames[propText] = true
      const propClassName = indicProperties[i].getAttribute('class')
      if (propClassName.includes('first-')) {
        i++
        let inputEl = indicProperties[i].querySelector('input')
        if (inputEl) {
          page.setInputElementValue(inputEl, propVal[propText])
          inputEl = null
        } else {
          let buttonEl = indicProperties[i].querySelector('button[role="combobox"]')
          if (buttonEl?.innerText) {
            // upstream #354 fix: open the combobox via page.mouseClick (fires mousedown); native .click() no longer opens TV's menu
            page.mouseClick(buttonEl)
            buttonEl = null
            await page.setSelByText(SEL.strategyListOptions, propVal[propText])
          }
        }
      } else if (propClassName.includes('fill-')) {
        let checkboxEl = indicProperties[i].querySelector('input[type="checkbox"]')
        if (checkboxEl) {
          const isChecked = Boolean(checkboxEl.checked)
          if (Boolean(propVal[propText]) !== isChecked) {
            page.mouseClick(checkboxEl)
            checkboxEl.checked = Boolean(propVal[propText])
          }
          checkboxEl = null
        }
      }
      if (propKeys.length === Object.keys(setPropertiesNames).length)
        break
    }
  }
  indicProperties = null
  const elOkBtn = page.$(SEL.okBtn)
  if (!keepStrategyParamOpen && elOkBtn)
    elOkBtn.click()

  const appliedKeys = Object.keys(setPropertiesNames)
  const missingKeys = propKeys.filter(key => !setPropertiesNames[key])

  return {
    success: missingKeys.length === 0,
    applied: appliedKeys,
    missing: missingKeys
  }
}

tv._humanizeStrategyApply = async (resultLike) => {
  try {
    const keys = resultLike && (Array.isArray(resultLike.applied) ? resultLike.applied
      : (Array.isArray(resultLike.updated) ? resultLike.updated : null))
    const changed = Array.isArray(keys) ? keys.filter(Boolean) : []
    const missCount = (resultLike && Array.isArray(resultLike.missing) ? resultLike.missing.length : 0)
      + (resultLike && Array.isArray(resultLike.errors) ? resultLike.errors.length : 0)
    if (!changed.length && !missCount)
      return 0
    let line
    if (changed.length) {
      const SHOWN = 4 // truncate so a large payload is not dumped in full
      const head = changed.slice(0, SHOWN).join(', ')
      const extra = changed.length > SHOWN ? ` (+${changed.length - SHOWN} more)` : ''
      const warn = missCount ? ` — ⚠ ${missCount} not applied` : ''
      line = `✓ Applied ${changed.length} setting${changed.length === 1 ? '' : 's'}: ${head}${extra}${warn}`
    } else {
      line = `⚠ ${missCount} setting${missCount === 1 ? '' : 's'} not applied`
    }
    console.info(`[TV-ASS] ${line}`)
    try {
      if (typeof ui !== 'undefined' && ui && typeof ui.statusApplyLine === 'function')
        ui.statusApplyLine(line)
    } catch {}
    return changed.length
  } catch {
    return 0
  }
}

tv.changeDialogTabToInput = async () => {
  let isInputTabActive = document.querySelector(SEL.tabInputActive)
  if (isInputTabActive) return true
  const inputTabEl = document.querySelector(SEL.tabInput)
  if (!inputTabEl) {
    throw new Error('There are no parameters in this strategy that can be optimized (There is no "Inputs" tab with input values)')
  }
  inputTabEl.click()
  isInputTabActive = await page.waitForSelector(SEL.tabInputActive, 2000)
  return !!isInputTabActive
}

tv.changeDialogTabToProperties = async () => {
  let isPropsTabActive = document.querySelector(SEL.tabPropertiesActive)
  if (isPropsTabActive) return true
  const propsTabEl = document.querySelector(SEL.tabProperties)
  if (!propsTabEl) {
    throw new Error('There is no "Properties" tab in the strategy dialog')
  }
  propsTabEl.click()
  isPropsTabActive = await page.waitForSelector(SEL.tabPropertiesActive, 2000)
  return !!isPropsTabActive
}

tv._resolveCheckboxLabel = (cb) => {
  // 1. aria-label or name attribute
  const ariaLabel = cb.getAttribute('aria-label')
  if (ariaLabel && ariaLabel.trim())
    return ariaLabel.trim()
  const nameAttr = cb.getAttribute('name')
  if (nameAttr && nameAttr.trim())
    return nameAttr.trim()

  // 2. Immediate sibling text (label or span right next to the checkbox)
  let sibling = cb.nextElementSibling
  if (sibling) {
    const t = (sibling.innerText || sibling.textContent || '').trim()
    if (t)
      return t
  }
  sibling = cb.previousElementSibling
  if (sibling) {
    const t = (sibling.innerText || sibling.textContent || '').trim()
    if (t)
      return t
  }

  // 3. Smallest ancestor that contains only this checkbox's row
  let wrapper = cb.parentElement
  while (wrapper) {
    const siblingCheckboxes = wrapper.querySelectorAll('input[type="checkbox"]')
    if (siblingCheckboxes.length === 1) {
      const t = (wrapper.innerText || wrapper.textContent || '').trim()
      if (t)
        return t
      break
    }
    if (wrapper.getAttribute('class') && wrapper.getAttribute('class').includes('cell-'))
      break
    wrapper = wrapper.parentElement
  }

  return null // unresolvable
}

tv.getPropertiesParams = async () => {
  const properties = {}
  const unresolved = []
  const indicProperties = document.querySelectorAll(SEL.indicatorProperty)
  for (let i = 0; i < indicProperties.length; i++) {
    const propClassName = indicProperties[i].getAttribute('class')
    const propText = indicProperties[i].innerText
    if (!propClassName || !propText)
      continue

    if (propClassName.includes('topCenter-')) {
      const label = propText.trim()
      i++
      if (i >= indicProperties.length)
        break
      const controlCell = indicProperties[i]
      const inputs = controlCell.querySelectorAll('input:not([type="checkbox"])')
      const comboboxes = controlCell.querySelectorAll('button[role="combobox"]')
      const checkboxes = controlCell.querySelectorAll('input[type="checkbox"]')
      if (inputs.length === 1 && comboboxes.length === 1) {
        let numVal = inputs[0].value
        if (inputs[0].getAttribute('inputmode') === 'numeric' || parseFloat(numVal) == numVal || parseInt(numVal) == numVal) {
          const dig = parseFloat(numVal) == parseInt(numVal) ? parseInt(numVal) : parseFloat(numVal)
          if (!isNaN(dig))
            numVal = dig
        }
        properties[label] = { value: numVal, type: comboboxes[0].innerText || '' }
      } else if (checkboxes.length > 0) {
        const cbValues = {}
        const unresolvedInGroup = []
        for (const cb of checkboxes) {
          const cbLabel = tv._resolveCheckboxLabel(cb)
          if (!cbLabel) {
            unresolvedInGroup.push(`${label}[checkbox #${Array.from(checkboxes).indexOf(cb)}]`)
            continue
          }
          cbValues[cbLabel] = cb.checked
        }
        if (Object.keys(cbValues).length > 0)
          properties[label] = cbValues
        if (unresolvedInGroup.length > 0) {
          unresolved.push(...unresolvedInGroup)
          if (Object.keys(cbValues).length === 0)
            unresolved.push(label) // entire group unresolved
        }
      } else if (inputs.length > 0) {
        let numVal = inputs[0].value
        if (parseFloat(numVal) == numVal || parseInt(numVal) == numVal) {
          const dig = parseFloat(numVal) == parseInt(numVal) ? parseInt(numVal) : parseFloat(numVal)
          if (!isNaN(dig))
            numVal = dig
        }
        properties[label] = numVal
      } else if (comboboxes.length > 0) {
        properties[label] = comboboxes[0].innerText || ''
      } else {
        unresolved.push(label) // no recognizable controls in compound row
      }
      continue
    } else if (propClassName.includes('first-') && propText) {
      i++
      if (i >= indicProperties.length)
        break
      const pairedInput = indicProperties[i].querySelector('input:not([type="checkbox"])')
      const pairedCombo = indicProperties[i].querySelector('button[role="combobox"]')
      if (pairedInput && pairedCombo) {
        // Jul-2026 rows merge a value input with a unit/currency combobox in one control cell
        // (Initial capital + currency, Default order size + unit, Commission + unit) — capture both
        // as {value, type} so exports round-trip; a plain-value read here silently drops the unit.
        let numVal = pairedInput.value
        if (pairedInput.getAttribute('inputmode') === 'numeric' || parseFloat(numVal) == numVal || parseInt(numVal) == numVal) {
          const dig = parseFloat(numVal) == parseInt(numVal) ? parseInt(numVal) : parseFloat(numVal)
          // coerce only when the RAW text parses cleanly — parseInt("5,000") is 5, so a
          // thousands-separated value must stay a string exactly like the plain-input branch below
          if (!isNaN(numVal))
            numVal = dig
        }
        properties[propText] = { value: numVal, type: pairedCombo.innerText || '' }
        continue
      }
      if (indicProperties[i].querySelector('input')) {
        let propValue = indicProperties[i].querySelector('input').value
        if (indicProperties[i].querySelector('input').getAttribute('inputmode') === 'numeric' ||
          (parseFloat(propValue) == propValue || parseInt(propValue) == propValue)) {
          const digPropValue = parseFloat(propValue) == parseInt(propValue) ? parseInt(propValue) : parseFloat(propValue)
          if (!isNaN(propValue))
            properties[propText] = digPropValue
          else
            properties[propText] = propValue
        } else {
          properties[propText] = propValue
        }
      } else if (indicProperties[i].querySelector('button[role="combobox"]')) {
        const buttonEl = indicProperties[i].querySelector('button[role="combobox"]')
        if (buttonEl && buttonEl.innerText)
          properties[propText] = buttonEl.innerText
        else
          unresolved.push(propText)
      } else {
        unresolved.push(propText)
      }
    } else if (propClassName.includes('fill-')) {
      const element = indicProperties[i].querySelector('input[type="checkbox"]')
      // use the live element.checked property instead of getAttribute('checked'), which misses controlled DOM state
      if (element)
        properties[propText] = Boolean(element.checked)
      // Jun-2026 Properties section headings ("COST SIMULATION", "MARGIN", …) carry checkableTitle-/fill- classes but contain NO controls; a control-less checkableTitle- cell is a heading — skip it silently. fill- cells without checkableTitle- keep the unresolved reporting.
      else if (propClassName.includes('checkableTitle-'))
        continue
      else
        unresolved.push(propText)
    } else if (propClassName.includes('titleWrap-')) {
      continue
    }
  }
  return { properties, unresolved }
}

// Set a dialog combobox to the option with the given visible text. Standard comboboxes render a
// [role="listbox"] with [role="option"] rows (setSelByText). The Jul-2026 currency dropdown renders a
// menu-style listbox instead: rows are div[class*="button-"] with a [class*="title-"] label and a
// "SHOW MORE" expander for the long tail — no [role="option"] at all, so setSelByText can never match it.
// Try the standard path first, then the menu path (expanding once); close the menu on failure so the
// dialog is never left with a stray popup.
tv._setComboboxByText = async (buttonEl, text) => {
  const target = String(text)
  if ((buttonEl.innerText || '').trim() === target)
    return true
  page.mouseClick(buttonEl)
  if (await page.setSelByText(SEL.strategyListOptions, target))
    return true
  for (let attempt = 0; attempt < 2; attempt++) {
    const listbox = document.querySelector('div[role="listbox"]')
    if (!listbox)
      break
    let expander = null
    for (const row of listbox.querySelectorAll('div[class*="button-"], button')) {
      const title = row.querySelector('[class*="title-"]')
      const label = (title ? title.innerText : row.innerText) || ''
      if (label.trim() === target) {
        page.mouseClick(row)
        await page.waitForTimeout(200)
        return true
      }
      if (/show more/i.test(label))
        expander = row
    }
    if (!expander)
      break
    page.mouseClick(expander)
    await page.waitForTimeout(300)
  }
  if (document.querySelector('div[role="listbox"]'))
    page.mouseClick(buttonEl)   // toggle the abandoned menu closed
  return false
}

// TradingView's Jul-2026 Properties tab removed four rows that older saved payloads still carry.
// Translate each legacy key to its replacement ONLY when the legacy row is absent from the open dialog
// and the replacement row is present, so an A/B-served old dialog keeps the exact-label path untouched:
//   "Base currency" (USD/"Default")            -> currency combobox merged into the "Initial capital" row
//   "Margin for long/short positions" (m %)    -> "Long/Short leverage" = 100 / m  (5% margin = 20x)
//   "Verify price for limit orders" (N ticks)  -> "Limit order execution": 0 -> "Requested price",
//                                                 >0 -> "Requested price and 1 tick beyond" (TV caps at 1 tick)
// An explicit payload entry for a replacement row always wins over a migrated value.
tv._migrateLegacyProperties = (propValues, dialogLabels) => {
  const src = Object.assign({}, propValues)
  const migrated = []
  const skipped = []
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k)
  const canMigrate = (fromKey, toKey) => has(fromKey) && !dialogLabels.has(fromKey) && dialogLabels.has(toKey)

  if (canMigrate('Base currency', 'Initial capital')) {
    const raw = String(src['Base currency']).trim()
    const currency = /^default$/i.test(raw) ? 'Same as chart' : raw
    const cap = has('Initial capital') ? src['Initial capital'] : undefined
    if (cap !== null && typeof cap === 'object' && !Array.isArray(cap)) {
      skipped.push('Base currency (Initial capital already carries a currency)')
    } else {
      src['Initial capital'] = { value: cap, type: currency }
      migrated.push(`Base currency → Initial capital currency (${currency})`)
    }
    delete src['Base currency']
  }

  for (const [fromKey, toKey] of [['Margin for long positions', 'Long leverage'], ['Margin for short positions', 'Short leverage']]) {
    if (!canMigrate(fromKey, toKey))
      continue
    const marginPct = Number(src[fromKey])
    delete src[fromKey]
    if (has(toKey)) {
      skipped.push(`${fromKey} (payload already sets ${toKey})`)
    } else if (!Number.isFinite(marginPct) || marginPct <= 0) {
      skipped.push(`${fromKey} (${marginPct}% has no finite leverage equivalent)`)
    } else {
      const leverage = Math.round((100 / marginPct) * 100) / 100
      src[toKey] = leverage
      migrated.push(`${fromKey} (${marginPct}%) → ${toKey} (${leverage}x)`)
    }
  }

  if (canMigrate('Verify price for limit orders', 'Limit order execution')) {
    const ticks = Number(src['Verify price for limit orders'])
    delete src['Verify price for limit orders']
    if (has('Limit order execution')) {
      skipped.push('Verify price for limit orders (payload already sets Limit order execution)')
    } else {
      const option = ticks > 0 ? 'Requested price and 1 tick beyond' : 'Requested price'
      src['Limit order execution'] = option
      migrated.push(`Verify price for limit orders (${ticks}) → Limit order execution (${option})` +
        (ticks > 1 ? ' — TradingView now verifies at most 1 tick' : ''))
    }
  }

  return { propValues: src, migrated, skipped }
}

// Apply a {value, type} payload entry to one control cell (value input + unit/currency combobox).
// Tolerant halves: only the controls the cell actually renders must succeed — an undefined half or a
// control the row doesn't have (old-UI input-only rows) is not a failure, but a cell with no controls is.
tv._applyValueTypeCell = async (controlCell, targetVal) => {
  const inputs = controlCell.querySelectorAll('input:not([type="checkbox"])')
  const comboboxes = controlCell.querySelectorAll('button[role="combobox"]')
  let inputOk = true
  let dropdownOk = true
  if (inputs.length > 0 && targetVal.value !== undefined && targetVal.value !== null) {
    page.setInputElementValue(inputs[0], targetVal.value)
  } else if (inputs.length === 0 && targetVal.value !== undefined && targetVal.value !== null) {
    inputOk = false
  }
  if (comboboxes.length > 0 && targetVal.type !== undefined && targetVal.type !== null && targetVal.type !== '') {
    dropdownOk = await tv._setComboboxByText(comboboxes[0], targetVal.type)
  } else if (comboboxes.length === 0 && targetVal.type) {
    dropdownOk = false
  }
  return inputOk && dropdownOk && (inputs.length > 0 || comboboxes.length > 0)
}

tv.setPropertiesParams = async (propValues) => {
  if (!propValues || typeof propValues !== 'object')
    return { applied: [], missing: [], failed: [], migrated: [], skippedLegacy: [] }
  const dialogLabels = new Set()
  for (const cell of document.querySelectorAll(SEL.indicatorProperty)) {
    const t = (cell.innerText || '').trim()
    if (t)
      dialogLabels.add(t)
  }
  const migration = tv._migrateLegacyProperties(propValues, dialogLabels)
  propValues = migration.propValues
  let popupVisibleHeight = 917
  try {
    popupVisibleHeight = page.$(SEL.indicatorScroll)?.getBoundingClientRect()?.bottom || 917
  } catch {}
  const indicProperties = document.querySelectorAll(SEL.indicatorProperty)
  const propKeys = Object.keys(propValues)
  const applied = []
  const failed = []
  const encountered = new Set()

  for (let i = 0; i < indicProperties.length; i++) {
    const propClassName = indicProperties[i].getAttribute('class')
    const propText = (indicProperties[i].innerText || '').trim()
    if (!propClassName || !propText)
      continue

    if (propClassName.includes('topCenter-') && propKeys.includes(propText)) {
      encountered.add(propText)
      try {
        const rect = indicProperties[i].getBoundingClientRect()
        if (rect.top < 0 || rect.bottom > popupVisibleHeight || !indicProperties[i].checkVisibility()) {
          indicProperties[i].scrollIntoView()
          await page.waitForTimeout(10)
        }
      } catch {}
      i++
      if (i >= indicProperties.length) {
        failed.push(propText)
        break
      }
      const controlCell = indicProperties[i]
      const targetVal = propValues[propText]
      let success = false

      if (targetVal && typeof targetVal === 'object' && !Array.isArray(targetVal)) {
        if (targetVal.hasOwnProperty('value') && targetVal.hasOwnProperty('type')) {
          success = await tv._applyValueTypeCell(controlCell, targetVal)
        } else {
          // Grouped checkboxes — track each child individually
          const checkboxes = controlCell.querySelectorAll('input[type="checkbox"]')
          const targetKeys = Object.keys(targetVal)
          let allOk = targetKeys.length > 0
          for (const childKey of targetKeys) {
            let matched = false
            for (const cb of checkboxes) {
              const cbLabel = tv._resolveCheckboxLabel(cb)
              if (cbLabel === childKey) {
                const want = Boolean(targetVal[childKey])
                if (Boolean(cb.checked) !== want) {
                  page.mouseClick(cb)
                  cb.checked = want
                }
                matched = true
                break
              }
            }
            if (!matched)
              allOk = false
          }
          success = allOk
        }
      } else {
        const inputs = controlCell.querySelectorAll('input:not([type="checkbox"])')
        if (inputs.length > 0) {
          page.setInputElementValue(inputs[0], targetVal)
          success = true
        } else {
          const comboboxes = controlCell.querySelectorAll('button[role="combobox"]')
          if (comboboxes.length > 0)
            success = await tv._setComboboxByText(comboboxes[0], targetVal)
        }
      }

      if (success)
        applied.push(propText)
      else
        failed.push(propText)
      if (propKeys.length === encountered.size)
        break
      continue
    }

    if (!propKeys.includes(propText))
      continue
    encountered.add(propText)

    try {
      const rect = indicProperties[i].getBoundingClientRect()
      if (rect.top < 0 || rect.bottom > popupVisibleHeight || !indicProperties[i].checkVisibility()) {
        indicProperties[i].scrollIntoView()
        await page.waitForTimeout(10)
      }
    } catch {}

    let success = false
    if (propClassName.includes('first-')) {
      i++
      if (i >= indicProperties.length) {
        failed.push(propText)
        break
      }
      const firstVal = propValues[propText]
      if (firstVal && typeof firstVal === 'object' && !Array.isArray(firstVal) && firstVal.hasOwnProperty('value') && firstVal.hasOwnProperty('type')) {
        // Jul-2026 rows pair a value input with a unit/currency combobox under a first- label
        // (Initial capital + currency, …) — writing the raw object into the input would type
        // "[object Object]" and silently skip the combobox
        success = await tv._applyValueTypeCell(indicProperties[i], firstVal)
      } else {
        let inputEl = indicProperties[i].querySelector('input')
        if (inputEl) {
          page.setInputElementValue(inputEl, firstVal)
          success = true
        } else {
          let buttonEl = indicProperties[i].querySelector('button[role="combobox"]')
          if (buttonEl?.innerText)
            success = await tv._setComboboxByText(buttonEl, firstVal)
        }
      }
    } else if (propClassName.includes('fill-')) {
      let checkboxEl = indicProperties[i].querySelector('input[type="checkbox"]')
      if (checkboxEl) {
        const isChecked = Boolean(checkboxEl.checked)
        if (Boolean(propValues[propText]) !== isChecked) {
          page.mouseClick(checkboxEl)
          checkboxEl.checked = Boolean(propValues[propText])
        }
        success = true
      }
    }

    if (success)
      applied.push(propText)
    else
      failed.push(propText)
    if (propKeys.length === encountered.size)
      break
  }

  const missing = propKeys.filter(key => !encountered.has(key))
  return { applied, missing, failed, migrated: migration.migrated, skippedLegacy: migration.skipped }
}

tv.applyInputParams = async (propVal) => {
  if (!propVal || typeof propVal !== 'object')
    return { applied: [], missing: [], failed: [] }
  let popupVisibleHeight = 917
  try {
    popupVisibleHeight = page.$(SEL.indicatorScroll)?.getBoundingClientRect()?.bottom || 917
  } catch {}
  let indicProperties = document.querySelectorAll(SEL.indicatorProperty)
  const propKeys = Object.keys(propVal)
  const applied = []
  const failed = []
  const encountered = new Set()
  for (let i = 0; i < indicProperties.length; i++) {
    const propText = indicProperties[i].innerText
    if (propText && propKeys.includes(propText)) {
      encountered.add(propText)
      try {
        const rect = indicProperties[i].getBoundingClientRect()
        if (rect.top < 0 || rect.bottom > popupVisibleHeight || !indicProperties[i].checkVisibility()) {
          indicProperties[i].scrollIntoView()
          await page.waitForTimeout(10)
          if (indicProperties[i].getBoundingClientRect()?.bottom > popupVisibleHeight)
            await page.waitForTimeout(50)
        }
      } catch {}
      const propClassName = indicProperties[i].getAttribute('class')
      let success = false
      if (propClassName.includes('first-')) {
        i++
        if (i >= indicProperties.length) {
          failed.push(propText)
          break
        }
        let inputEl = indicProperties[i].querySelector('input')
        if (inputEl) {
          page.setInputElementValue(inputEl, propVal[propText])
          success = true
          inputEl = null
        } else {
          let buttonEl = indicProperties[i].querySelector('button[role="combobox"]')
          if (buttonEl?.innerText) {
            if (buttonEl.innerText === propVal[propText]) {
              success = true
            } else {
              page.mouseClick(buttonEl)
              buttonEl = null
              success = await page.setSelByText(SEL.strategyListOptions, propVal[propText])
            }
          }
        }
      } else if (propClassName.includes('fill-')) {
        let checkboxEl = indicProperties[i].querySelector('input[type="checkbox"]')
        if (checkboxEl) {
          const isChecked = Boolean(checkboxEl.checked)
          if (Boolean(propVal[propText]) !== isChecked) {
            page.mouseClick(checkboxEl)
            checkboxEl.checked = Boolean(propVal[propText])
          }
          success = true
          checkboxEl = null
        }
      }
      if (success)
        applied.push(propText)
      else
        failed.push(propText)
      if (propKeys.length === encountered.size)
        break
    }
  }
  indicProperties = null
  const missing = propKeys.filter(key => !encountered.has(key))
  return { applied, missing, failed }
}

tv.getChartSession = async () => {
  try {
    const result = await tv.callPageAction('getChartSession', null, 5000)
    if (result && result.data && result.data.sessionId)
      return result.data.sessionId
    if (result && result.sessionId)
      return result.sessionId
    return null
  } catch (err) {
    console.warn('[TV-ASS] getChartSession failed:', err)
    return null
  }
}

tv.setChartSession = async (sessionId) => {
  try {
    const result = await tv.callPageAction('setChartSession', { sessionId }, 5000)
    if (result && (result.success || (result.data && result.data.success)))
      return true
    console.warn('[TV-ASS] setChartSession returned non-success:', result)
    return false
  } catch (err) {
    console.warn('[TV-ASS] setChartSession failed:', err)
    return false
  }
}

// only result.data.name is a real strategy name: the bridge envelope always carries the channel marker name:'iondvPage', so returning result.name would yield the literal "iondvPage" and poison the fail-closed name prechecks. Return null otherwise so callers fall back to the legend.
tv.getStrategyName = async () => {
  try {
    const result = await tv.callPageAction('getStrategyName', null, 6000)
    if (result && result.data && result.data.name)
      return result.data.name
    return null
  } catch (err) {
    console.warn('[TV-ASS] getStrategyName failed:', err)
    return null
  }
}

tv.getChartSymbol = async () => {
  try {
    const result = await tv.callPageAction('getChartSymbol', null, 5000)
    const data = result && result.data ? result.data : null
    if (data && (data.symbol || data.shortName))
      return { symbol: data.symbol || null, shortName: data.shortName || null, exchange: data.exchange || null }
    return null
  } catch (err) {
    console.warn('[TV-ASS] getChartSymbol failed:', err)
    return null
  }
}

tv.getChartStyle = async () => {
  try {
    const result = await tv.callPageAction('getChartStyle', null, 5000)
    const d = result && result.data ? result.data : result
    if (d && typeof d.style === 'number')
      return d.style
    return null
  } catch (err) {
    console.warn('[TV-ASS] getChartStyle failed:', err)
    return null
  }
}

tv.setChartStyle = async (style) => {
  try {
    const result = await tv.callPageAction('setChartStyle', { style }, 5000)
    if (result && (result.success || (result.data && result.data.success)))
      return true
    console.warn('[TV-ASS] setChartStyle returned non-success:', result)
    return false
  } catch (err) {
    console.warn('[TV-ASS] setChartStyle failed:', err)
    return false
  }
}

tv._chartStyleLabel = (n) => {
  if (typeof n !== 'number')
    return '?'
  const map = { 0: 'Bars', 1: 'Candles', 2: 'Line', 3: 'Area', 4: 'Renko', 5: 'Kagi', 6: 'Point & Figure', 7: 'Line Break', 8: 'Heikin Ashi', 9: 'Hollow candles', 10: 'Baseline', 12: 'Hi-Lo', 14: 'Columns' }
  return map.hasOwnProperty(n) ? map[n] : `type ${n}`
}

tv.getChartLayoutName = () => {
  try {
    const el = document.querySelector(SEL.layoutToolbarName)
    if (el && el.innerText && el.innerText.trim())
      return el.innerText.trim()
  } catch {}
  try {
    const btn = document.querySelector('[data-qa-id="main-menu-button"]')
    const aria = btn ? btn.getAttribute('aria-label') : null
    const m = aria ? /Active layout:\s*(.+?)\s*$/.exec(aria) : null
    if (m && m[1] && m[1].trim())
      return m[1].trim()
  } catch {}
  return null
}

// bounded content-settle after a layout switch: the toolbar name flips instantly but the layout content (indicators/strategy) renders over ~1min with no clean spinner selector, so bound the idle — poll the legend study count + active-strategy-name and settle once stable, with a hard cap as backstop (same philosophy as tv._waitReportSettled).
tv._waitLayoutSettled = async (capMs = 90000) => {
  const start = Date.now()
  await page.waitForTimeout(1500) // small padding so the switch begins tearing down the old legend before we sample
  let prevCount = -1
  let stable = 0
  while (Date.now() - start < capMs) {
    let count = 0
    try { count = document.querySelectorAll(SEL.tvLegendIndicatorItem).length } catch {}
    if (count === prevCount) stable++
    else stable = 0
    prevCount = count
    const named = !!tv._getActiveStrategyName()
    if ((named && stable >= 2) || stable >= 5)
      return true
    await page.waitForTimeout(800)
  }
  return false
}

// switch to a saved chart LAYOUT by name (restore-FIRST step). LOAD ONLY — never Save/Autosave. Skips when already on the target; else opens the save-load menu / "Open layout…" dialog, picks the row, confirms the toolbar name flipped, then runs the bounded content-settle. Uses fresh MouseEvents (TV's cached-event mouseClick doesn't reliably open these menus).
tv.setChartLayout = async (targetName) => {
  if (!targetName)
    return { ok: true, skipped: true }
  const target = String(targetName).trim()
  const freshClick = (el) => {
    if (!el) return
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    el.click()
  }
  const escape = () => {
    try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })) } catch {}
  }
  // layout rows render the name on the FIRST line plus a symbol/timeframe subtitle on a second line, so match the first line (a whole-text === compare never matched). Keep whole-text === as a fast path for single-line rows.
  const rowMatchesName = (el) => {
    const txt = (el.innerText || '').trim()
    if (!txt) return false
    if (txt === target) return true
    return txt.split('\n')[0].trim() === target
  }
  // a document.body Escape does NOT close the load-layout dialog (and a modal left open blocks every later restore step); Escape dispatched on the dialog's search INPUT does close it (mirrors tv.setTicker's closeDialog). Fallback to a close button / Escape on the dialog element.
  const closeLoadDialog = async () => {
    try {
      const inp = document.querySelector(SEL.layoutLoadDialogSearch) || document.querySelector(SEL.layoutLoadDialog + ' input')
      if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
      const dlg = document.querySelector(SEL.layoutLoadDialog)
      if (dlg) dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
    } catch {}
    await page.waitForSelector(SEL.layoutLoadDialog, 1200, true)
  }
  try {
    if (tv.getChartLayoutName() === target)
      return { ok: true, skipped: true } // already on it — avoid the ~1min reload

    const btn = document.querySelector(SEL.layoutMenuButton)
    if (!btn)
      return { ok: false, error: 'layout menu button not found' }
    freshClick(btn)
    await page.waitForSelector(SEL.layoutMenuRecentItem, 2000)
    await page.waitForTimeout(150)

    let clicked = false
    const recents = document.querySelectorAll(SEL.layoutMenuRecentItem)
    for (const r of recents) {
      if (rowMatchesName(r)) { freshClick(r); clicked = true; break }
    }

    if (!clicked) {
      const loadItem = document.querySelector(SEL.layoutMenuLoadItem)
      if (loadItem) {
        freshClick(loadItem)
        const dlg = await page.waitForSelector(SEL.layoutLoadDialog, 4000)
        if (dlg) {
          const search = document.querySelector(SEL.layoutLoadDialogSearch)
          if (search) {
            page.setInputElementValue(search, target, true)
            await page.waitForTimeout(500)
          }
          const items = document.querySelectorAll(SEL.layoutLoadDialogItem)
          for (const it of items) {
            if (rowMatchesName(it)) { freshClick(it); clicked = true; break }
          }
          if (!clicked) await closeLoadDialog() // close the modal if we couldn't find the row (else it blocks later steps)
        }
      }
    }

    if (!clicked) {
      escape()
      return { ok: false, error: 'layout not found in recents or the load dialog' }
    }

    // confirm the toolbar name flipped to the target (the switch registered)
    let flipped = false
    for (let i = 0; i < 50; i++) { // ~5s
      if (tv.getChartLayoutName() === target) { flipped = true; break }
      await page.waitForTimeout(100)
    }
    if (!flipped)
      return { ok: false, error: 'layout name did not update after click' }

    await tv._waitLayoutSettled()
    return { ok: true, skipped: false }
  } catch (err) {
    console.warn('[TV-ASS] setChartLayout failed:', err)
    escape()
    return { ok: false, error: err?.message || String(err) }
  }
}

tv._testingPeriodRangeRegex = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+—\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/
tv._testingPeriodPresetRegex = /^(range from chart( default)?|default|last \d+ days|entire history|all data|custom date range)$/i
tv._monthToNum = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' }
tv._stripDeepBadge = (s) => String(s || '').replace(/\s*\n?\s*DEEP\s*$/i, '').replace(/\s+/g, ' ').trim()
tv._findTestingPeriodButton = () => {
  const area = document.querySelector('#bottom-area')
  if (!area)
    return null
  const buttons = area.querySelectorAll('button')
  let presetBtn = null
  for (const b of buttons) {
    const t = (b.innerText || '').trim()
    if (!t)
      continue
    if (tv._testingPeriodRangeRegex.test(t))
      return b
    if (!presetBtn && tv._testingPeriodPresetRegex.test(tv._stripDeepBadge(t)))
      presetBtn = b
  }
  return presetBtn
}

// Parse "May 25, 2026" -> "2026-05-25"; returns null if unparseable
tv._parseHumanDateToISO = (s) => {
  if (!s)
    return null
  const m = String(s).trim().match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})/i)
  if (!m)
    return null
  const mm = tv._monthToNum[m[1].toLowerCase()]
  if (!mm)
    return null
  const dd = String(parseInt(m[2], 10)).padStart(2, '0')
  return `${m[3]}-${mm}-${dd}`
}

tv._monthAbbr = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
tv._isoToFilenameDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m)
    return ''
  const mon = tv._monthAbbr[parseInt(m[2], 10) - 1]
  if (!mon)
    return ''
  return `${mon}-${parseInt(m[3], 10)}-${m[1]}`
}
tv._isoRangeToFilenameText = (from, to) => {
  const a = tv._isoToFilenameDate(from)
  const b = tv._isoToFilenameDate(to)
  return (a && b) ? `${a}--${b}` : ''
}

tv._readTestingPeriod = () => {
  try {
    const btn = tv._findTestingPeriodButton()
    if (!btn)
      return null
    const rawLabel = (btn.innerText || '').trim()
    if (!rawLabel)
      return null
    const isDeep = /\bDEEP\b/i.test(rawLabel)
    const label = rawLabel.replace(/\s*\n?\s*DEEP\s*$/i, '').trim()
    const rangeMatch = label.match(tv._testingPeriodRangeRegex)
    if (rangeMatch) {
      const parts = label.split('—')
      const from = tv._parseHumanDateToISO(parts[0])
      const to = tv._parseHumanDateToISO(parts[1])
      return { from, to, label, isDeep }
    }
    // Named preset (e.g. "Entire history") — no concrete dates to capture
    return { from: null, to: null, label, isDeep }
  } catch (err) {
    console.warn('[TV-ASS] _readTestingPeriod failed:', err)
    return null
  }
}

// resolve a BOUNDED relative preset ("Last N days"/"Range from chart") to the concrete {from,to} it currently resolves to, so the winner CSV freezes the real window instead of a label that re-resolves against the upload date. Method: open the menu → "Custom date range", READ the prefilled YYYY-MM-DD inputs, then CANCEL (never Submit) — read-only. Fail-closed: any problem returns the label-only base. Concrete ranges are returned unchanged; unbounded presets stay label-only by design.
tv._boundedPresetRegex = /^(last \d+ days|range from chart( default)?)$/i
tv._isBoundedTestingPreset = (l) => tv._boundedPresetRegex.test(tv._stripDeepBadge(l || ''))
tv.resolveTestingPeriodConcrete = async () => {
  const base = tv._readTestingPeriod()
  if (!base)
    return null
  // Already concrete (custom range) — nothing to resolve, do NOT touch the UI
  if (base.from && base.to)
    return base
  // Only BOUNDED presets get resolved; unbounded presets stay label-only
  if (!base.label || !tv._isBoundedTestingPreset(base.label))
    return base
  const closeMenu = async (btn) => { try { if (btn) { page.mouseClick(btn); await page.waitForTimeout(300) } } catch {} }
  let btn = null
  try {
    btn = tv._findTestingPeriodButton()
    if (!btn)
      return base
    page.mouseClick(btn)
    await page.waitForTimeout(500)
    // open "Custom date range" (same menu-row scan as setTestingPeriod's concrete branch)
    const rows = document.querySelectorAll(SEL.testingPeriodMenuRow)
    let customRow = null
    for (const r of rows) {
      if ((r.innerText || '').trim() === 'Custom date range') { customRow = r; break }
    }
    if (!customRow) { await closeMenu(btn); return base }
    page.mouseClick(customRow)
    const dlg = await page.waitForSelector(SEL.customDateRangeDialog, 2000)
    if (!dlg) { await closeMenu(btn); return base }
    // READ the pre-filled inputs (the resolution source of truth), then CANCEL — never commit
    const ins = document.querySelectorAll(SEL.customDateRangeInput)
    const from = ins[0] ? String(ins[0].value || '').trim() : ''
    const to = ins[1] ? String(ins[1].value || '').trim() : ''
    const cancel = document.querySelector(SEL.customDateRangeCancel)
    if (!cancel)
      return base
    cancel.click()
    const stillOpen = await page.waitForSelector(SEL.customDateRangeDialog, 2000, true)
    if (stillOpen)
      return base
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return base
    // fail-closed: the open->read->cancel must NOT have changed the active period. Re-read via
    // _readTestingPeriod (re-discovers the button, robust to a React node swap); if the label drifted,
    // distrust the dates and fall back to label-only.
    const after = tv._readTestingPeriod()
    if (!after || !after.label || normalizeTitle(after.label) !== normalizeTitle(base.label))
      return base
    return { from, to, label: base.label, isDeep: base.isDeep, resolvedFromPreset: true }
  } catch (err) {
    console.warn('[TV-ASS] resolveTestingPeriodConcrete failed:', err)
    try {
      if (document.querySelector(SEL.customDateRangeDialog)) {
        const c = document.querySelector(SEL.customDateRangeCancel)
        if (c) c.click()
        await page.waitForSelector(SEL.customDateRangeDialog, 1000, true)
      } else if (document.querySelector(SEL.testingPeriodMenuRow)) {
        await closeMenu(btn)
      }
    } catch {}
    return base
  }
}

tv.changeDialogTabToStyle = async () => {
  if (document.querySelector(SEL.tabStyleActive)) return true
  const el = document.querySelector(SEL.tabStyle)
  if (!el)
    throw new Error('There is no "Style" tab in the strategy dialog')
  el.click()
  return !!(await page.waitForSelector(SEL.tabStyleActive, 2000))
}

tv.changeDialogTabToVisibilities = async () => {
  if (document.querySelector(SEL.tabVisibilitiesActive)) return true
  const el = document.querySelector(SEL.tabVisibilities)
  if (!el)
    throw new Error('There is no "Visibility" tab in the strategy dialog')
  el.click()
  return !!(await page.waitForSelector(SEL.tabVisibilitiesActive, 2000))
}

tv.getStyleParams = async () => {
  const rows = []
  const unresolved = []
  const cells = document.querySelectorAll(SEL.indicatorProperty)
  let current = null
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    const cls = cell.getAttribute('class') || ''
    if (cls.includes('titleWrap-'))
      continue
    const label = (cell.innerText || '').trim()
    const checkbox = cell.querySelector('input[type="checkbox"]')
    const swatchEl = cell.querySelector(SEL.styleSwatchColor)
    const combo = cell.querySelector('button[role="combobox"]')
    const textInput = cell.querySelector('input:not([type="checkbox"]):not([type="radio"])')
    const radios = [...cell.querySelectorAll('input[type="radio"]')]
    // A labelled checkbox cell starts a new row; control cells attach to the current row.
    if (label && checkbox) {
      current = { idx: rows.length, label, checkbox: Boolean(checkbox.checked) }
      if (combo && combo.innerText) current.combo = combo.innerText
      if (textInput) current.text = textInput.value
      if (radios.length) current.thickness = (radios.find(r => r.checked) || {}).value || null
      if (swatchEl) current.color = getComputedStyle(swatchEl).backgroundColor
      rows.push(current)
    } else if (current) {
      // control cell for the current row
      if (swatchEl && current.color === undefined) current.color = getComputedStyle(swatchEl).backgroundColor
      if (combo && combo.innerText && current.combo === undefined) current.combo = combo.innerText
      if (textInput && current.text === undefined) current.text = textInput.value
      if (radios.length && current.thickness === undefined) current.thickness = (radios.find(r => r.checked) || {}).value || null
    } else if (label && !checkbox) {
      // labelled non-checkbox row with no preceding checkbox row (e.g. a standalone combobox/text style)
      current = { idx: rows.length, label }
      if (combo && combo.innerText) current.combo = combo.innerText
      if (textInput) current.text = textInput.value
      if (radios.length) current.thickness = (radios.find(r => r.checked) || {}).value || null
      if (swatchEl) current.color = getComputedStyle(swatchEl).backgroundColor
      if (Object.keys(current).length > 2)
        rows.push(current)
      else
        unresolved.push(`${current.idx}#${label}`)
    }
  }
  return { rows, unresolved }
}

tv.getVisibilityParams = async () => {
  const rows = []
  const cells = document.querySelectorAll(SEL.indicatorProperty)
  let current = null
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    const label = (cell.innerText || '').trim()
    const checkbox = cell.querySelector('input[type="checkbox"]')
    const textInputs = [...cell.querySelectorAll('input:not([type="checkbox"])')]
    if (label && checkbox) {
      current = { idx: rows.length, label, checkbox: Boolean(checkbox.checked) }
      rows.push(current)
    } else if (current && textInputs.length >= 2) {
      current.from = textInputs[0].value
      current.to = textInputs[1].value
    }
  }
  return { rows }
}

// Style restore (dialog already on Style tab): applies the safe DOM controls (checkbox, thickness radio, combobox, precision text) keyed POSITIONALLY with a label sanity-check (a mismatch degrades that row to failed — never writes to the wrong row). COLOR is NOT applied: the swatch color-picker write path is not programmable, so any captured color is reported as "<label> (color)" in failed so the upload popup surfaces it (never a silent green 1:1). Does NOT click OK.
tv.setStyleParams = async (styleData) => {
  const applied = []
  const missing = []
  const failed = []
  if (!styleData || !Array.isArray(styleData.rows) || !styleData.rows.length)
    return { applied, missing, failed }
  // Re-derive the live positional rows the same way the getter does
  const liveCells = document.querySelectorAll(SEL.indicatorProperty)
  const liveRows = []
  let cur = null
  for (let i = 0; i < liveCells.length; i++) {
    const cell = liveCells[i]
    const cls = cell.getAttribute('class') || ''
    if (cls.includes('titleWrap-'))
      continue
    const label = (cell.innerText || '').trim()
    const checkbox = cell.querySelector('input[type="checkbox"]')
    if (label && checkbox) {
      cur = { label, cells: [cell] }
      liveRows.push(cur)
    } else if (cur) {
      cur.cells.push(cell)
    } else if (label && !checkbox) {
      cur = { label, cells: [cell] }
      liveRows.push(cur)
    }
  }
  for (const want of styleData.rows) {
    const live = liveRows[want.idx]
    const key = `${want.idx}#${want.label}`
    if (!live || normalizeTitle(live.label) !== normalizeTitle(want.label || '')) {
      missing.push(key)
      continue
    }
    let rowOk = true
    let colorPending = false
    for (const cell of live.cells) {
      const checkbox = cell.querySelector('input[type="checkbox"]')
      if (checkbox && want.hasOwnProperty('checkbox')) {
        if (Boolean(checkbox.checked) !== Boolean(want.checkbox)) {
          page.mouseClick(checkbox)
          checkbox.checked = Boolean(want.checkbox)
        }
      }
      const radios = [...cell.querySelectorAll('input[type="radio"]')]
      if (radios.length && want.thickness != null) {
        const target = radios.find(r => r.value === String(want.thickness))
        if (target) {
          if (!target.checked) page.mouseClick(target)
        } else {
          rowOk = false
        }
      }
      const combo = cell.querySelector('button[role="combobox"]')
      if (combo && want.combo != null) {
        if (combo.innerText !== want.combo) {
          page.mouseClick(combo)
          const ok = await page.setSelByText(SEL.strategyListOptions, want.combo)
          if (!ok) rowOk = false
        }
      }
      const textInput = cell.querySelector('input:not([type="checkbox"]):not([type="radio"])')
      if (textInput && want.text != null) {
        page.setInputElementValue(textInput, want.text)
      }
      // only flag a color as un-restorable when the saved color actually DIFFERS from the live swatch (the common re-upload-on-same-chart case matches → nothing to change, don't report it). A genuine mismatch is reported since the swatch picker isn't programmable; the checkbox/radio/combobox/precision selections above ARE applied.
      const swatchEl = cell.querySelector(SEL.styleSwatchColor)
      if (swatchEl && want.color != null) {
        let liveColor = null
        try { liveColor = getComputedStyle(swatchEl).backgroundColor } catch {}
        if (liveColor !== want.color)
          colorPending = true
      }
    }
    if (colorPending)
      failed.push(`${key} (color)`)
    if (rowOk && !colorPending)
      applied.push(key)
    else if (rowOk && colorPending) {
      // checkbox/etc applied but color could not be — count as applied for the non-color parts, color already in failed
      applied.push(key)
    } else {
      failed.push(key)
    }
  }
  return { applied, missing, failed }
}

tv.setVisibilityParams = async (visData) => {
  const applied = []
  const missing = []
  const failed = []
  if (!visData || !Array.isArray(visData.rows) || !visData.rows.length)
    return { applied, missing, failed }
  const liveCells = document.querySelectorAll(SEL.indicatorProperty)
  const liveRows = []
  let cur = null
  for (let i = 0; i < liveCells.length; i++) {
    const cell = liveCells[i]
    const label = (cell.innerText || '').trim()
    const checkbox = cell.querySelector('input[type="checkbox"]')
    const textInputs = [...cell.querySelectorAll('input:not([type="checkbox"])')]
    if (label && checkbox) {
      cur = { label, checkbox, fromTo: null }
      liveRows.push(cur)
    } else if (cur && textInputs.length >= 2 && !cur.fromTo) {
      cur.fromTo = textInputs
    }
  }
  for (const want of visData.rows) {
    const live = liveRows[want.idx]
    const key = `${want.idx}#${want.label}`
    if (!live || normalizeTitle(live.label) !== normalizeTitle(want.label || '')) {
      missing.push(key)
      continue
    }
    try {
      if (want.hasOwnProperty('checkbox') && Boolean(live.checkbox.checked) !== Boolean(want.checkbox)) {
        page.mouseClick(live.checkbox)
        live.checkbox.checked = Boolean(want.checkbox)
      }
      if (live.fromTo && want.from != null && want.to != null) {
        page.setInputElementValue(live.fromTo[0], want.from)
        page.setInputElementValue(live.fromTo[1], want.to)
      }
      applied.push(key)
    } catch (err) {
      failed.push(key)
    }
  }
  return { applied, missing, failed }
}

// ticker setter via the Jun-2026 symbol-search dialog: opens #header-toolbar-symbol-search, types the exchange-qualified symbol, commits the exact matching result row, then verifies via getChartSymbol read-after-write. Fail-closed: returns true only on a verified match; closes the dialog (Escape) on failure.
tv.setTicker = async (tickerFull) => {
  if (!tickerFull)
    return false
  const target = String(tickerFull).trim()
  const targetUpper = target.toUpperCase()
  const freshClick = (el) => {
    if (!el) return
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    el.click()
  }
  const closeDialog = async () => {
    const inp = document.querySelector(SEL.symbolSearchInput)
    if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
    await page.waitForSelector(SEL.symbolSearchDialog, 800, true)
  }
  try {
    const btn = document.querySelector(SEL.symbolSearchButton)
    if (!btn)
      return false
    freshClick(btn)
    const dlg = await page.waitForSelector(SEL.symbolSearchDialog, 2000)
    if (!dlg)
      return false
    const input = document.querySelector(SEL.symbolSearchInput)
    if (!input) {
      await closeDialog()
      return false
    }
    page.setInputElementValue(input, target, true)
    await page.waitForTimeout(700)
    // Find the exact result row: prefer one whose text contains both EXCHANGE and SYMBOL of "EXCHANGE:SYMBOL"
    const wantExchange = targetUpper.includes(':') ? targetUpper.split(':')[0] : null
    const wantSymbol = targetUpper.includes(':') ? targetUpper.split(':')[1] : targetUpper
    const items = document.querySelectorAll(SEL.symbolSearchItem)
    // STRICT match: require BOTH symbol AND exchange to match (symbol-only for an unqualified target) so we never silently land on a wrong-exchange security that shares the ticker. No symbol-only fallback for qualified targets — if the qualified row isn't found, fail (best-effort flags the ticker for a manual click) rather than guess.
    let chosen = null
    for (const it of items) {
      const txt = (it.innerText || '').toUpperCase()
      const tokens = txt.split('\n').map(s => s.trim()).filter(Boolean)
      const symbolMatch = tokens.some(t => t === wantSymbol) || txt.includes(wantSymbol)
      const exchMatch = !wantExchange || txt.includes(wantExchange)
      if (symbolMatch && exchMatch) { chosen = it; break }
    }
    if (!chosen) {
      await closeDialog()
      return false
    }
    freshClick(chosen)
    await page.waitForSelector(SEL.symbolSearchDialog, 1500, true)
    await page.waitForTimeout(400)
    // verify
    const sym = await tv.getChartSymbol()
    if (!sym) {
      await closeDialog()
      return false
    }
    const got = String(sym.symbol || '').toUpperCase()
    const gotShort = String(sym.shortName || '').toUpperCase()
    const ok = wantExchange ? (got === targetUpper) : (got === targetUpper || gotShort === wantSymbol)
    if (!ok)
      await closeDialog()
    return ok
  } catch (err) {
    console.warn('[TV-ASS] setTicker failed:', err)
    await closeDialog()
    return false
  }
}

tv.setTestingPeriod = async (from, to, label) => {
  const closeMenu = async (btn) => {
    // re-click the range button toggles the menu closed; verify no Custom-date row remains
    try {
      if (btn) { page.mouseClick(btn); await page.waitForTimeout(300) }
    } catch {}
  }
  const isoToHuman = null // not needed; we compare by re-reading
  try {
    const btn = tv._findTestingPeriodButton()
    if (!btn)
      return { ok: false, message: 'Testing-period button not found on the current UI.' }
    const before = tv._readTestingPeriod()
    // Already matching?
    if (before && from && to && before.from === from && before.to === to)
      return { ok: true, message: 'Testing period already matches.' }

    page.mouseClick(btn)
    await page.waitForTimeout(500)

    // Named preset path (no concrete dates): click the matching menu row
    if ((!from || !to) && label) {
      const rows = document.querySelectorAll(SEL.testingPeriodMenuRow)
      let row = null
      for (const r of rows) {
        const t = (r.innerText || '').trim()
        if (normalizeTitle(t) === normalizeTitle(label)) { row = r; break }
      }
      if (!row) {
        await closeMenu(btn)
        return { ok: false, message: `Testing-period preset "${label}" not found in menu.` }
      }
      page.mouseClick(row)
      await page.waitForTimeout(500)
      let afterLabel = (btn && btn.isConnected) ? tv._stripDeepBadge(btn.innerText) : ''
      if (!afterLabel) {
        const area = document.querySelector('#bottom-area')
        if (area) {
          for (const b of area.querySelectorAll('button')) {
            if (normalizeTitle(tv._stripDeepBadge(b.innerText)) === normalizeTitle(tv._stripDeepBadge(label))) { afterLabel = tv._stripDeepBadge(b.innerText); break }
          }
        }
      }
      if (afterLabel && normalizeTitle(afterLabel) === normalizeTitle(tv._stripDeepBadge(label)))
        return { ok: true, message: `Testing period set to "${label}".` }
      return { ok: false, message: `Testing-period preset "${label}" could not be verified after selection (button now reads "${afterLabel || 'unknown'}").` }
    }

    // Concrete date-range path: open Custom date range
    const rows = document.querySelectorAll(SEL.testingPeriodMenuRow)
    let customRow = null
    for (const r of rows) {
      if ((r.innerText || '').trim() === 'Custom date range') { customRow = r; break }
    }
    if (!customRow) {
      await closeMenu(btn)
      return { ok: false, message: '"Custom date range" row not found in testing-period menu.' }
    }
    page.mouseClick(customRow)
    const dlg = await page.waitForSelector(SEL.customDateRangeDialog, 2000)
    if (!dlg)
      return { ok: false, message: 'Custom date range dialog did not open.' }
    // TV's date picker is a range STATE MACHINE that ignores the "to" textbox (the end date never commits), so write via the CALENDAR GRID: day buttons carry data-day="YYYY-MM-DD", month-nav buttons have stable aria-labels. First day click = range start, second = range end.
    const dlgSel = SEL.customDateRangeDialog
    const navClick = (dir) => {
      const b = [...document.querySelectorAll(`${dlgSel} button`)].find(x => (x.getAttribute('aria-label') || '').startsWith(dir))
      if (b) { b.click(); return true }
      return false
    }
    const findDay = async (iso) => {
      // navigate (max 36 month-hops) until the target day exists as a CURRENT-month cell
      for (let hops = 0; hops < 36; hops++) {
        const el = document.querySelector(`${dlgSel} button[data-day="${iso}"]:not([class*="another-month"])`)
        if (el) return el
        const anyCur = document.querySelector(`${dlgSel} button[data-day]:not([class*="another-month"])`)
        if (!anyCur) return null
        const cur = anyCur.getAttribute('data-day').slice(0, 7)
        const want = iso.slice(0, 7)
        if (want === cur) return null // month shown but day cell absent
        if (!navClick(want < cur ? 'Previous month' : 'Next month')) return null
        await page.waitForTimeout(180)
      }
      return null
    }
    const closeFail = (why) => {
      const cancel = document.querySelector(SEL.customDateRangeCancel)
      if (cancel) cancel.click()
      return { ok: false, message: why }
    }
    // the date picker is a range state machine: when the prefill already shows the target END, the FIRST day click can complete the whole range and a SECOND click then RESETS it to end→end. So click ONLY what's needed — prefill == target ⇒ submit directly; after the start click, re-read and skip the end click once the range is already complete.
    const readDlgInputs = () => {
      const ins = document.querySelectorAll(SEL.customDateRangeInput)
      return { from: ins[0] ? String(ins[0].value || '').trim() : '', to: ins[1] ? String(ins[1].value || '').trim() : '' }
    }
    let needEndClick = true
    const pre = readDlgInputs()
    if (pre.from === from && pre.to === to) {
      needEndClick = false   // prefill already equals the target range -> least-mutating: go straight to submit
    } else {
      const fromEl = await findDay(from)
      if (!fromEl || fromEl.disabled)
        return closeFail(`Start date ${from} is not selectable in the calendar (before first available data?).`)
      fromEl.click()
      await page.waitForTimeout(200)
      const afterFrom = readDlgInputs()
      if (afterFrom.from === from && afterFrom.to === to)
        needEndClick = false   // the start click already completed the target range; a second click would RESET it (the bug)
    }
    if (needEndClick) {
      const toEl = await findDay(to)
      if (!toEl || toEl.disabled)
        return closeFail(`End date ${to} is not selectable in the calendar.`)
      toEl.click()
      await page.waitForTimeout(250)
    }
    const submit = document.querySelector(SEL.customDateRangeSubmit)
    if (submit && !submit.disabled && submit.getAttribute('aria-disabled') !== 'true') {
      submit.click()
    } else {
      // submit disabled => range unchanged (already matching) — close without committing
      const cancel = document.querySelector(SEL.customDateRangeCancel)
      if (cancel) cancel.click()
    }
    await page.waitForSelector(SEL.customDateRangeDialog, 2000, true)
    await page.waitForTimeout(400)
    const after = tv._readTestingPeriod()
    if (after && after.from === from && after.to === to)
      return { ok: true, message: `Testing period set to ${from} — ${to}.` }
    const got = after ? `${after.from}—${after.to}` : 'unknown'
    const noConcrete = !after || (after.from === null && after.to === null)
    let cause = ''
    if (noConcrete) {
      const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const dow = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return isNaN(d.getTime()) ? -1 : d.getUTCDay() }
      const weekendBoundaries = [['start', from], ['end', to]]
        .filter(([, iso]) => { const w = dow(iso); return w === 0 || w === 6 })
        .map(([side, iso]) => `${side} ${iso} (${DOW[dow(iso)]})`)
      const note = weekendBoundaries.length ? ` (note: ${weekendBoundaries.join(' and ')} ${weekendBoundaries.length > 1 ? 'fall' : 'falls'} on a weekend)` : ''
      cause = ` The calendar did not commit the requested concrete range — a boundary may be a weekend, a market holiday, or outside the available data${note}. Set the testing period to the nearest trading day with data, then re-upload.`
    }
    return { ok: false, message: `Testing period verification failed (wanted ${from}—${to}, got ${got}).${cause}` }
  } catch (err) {
    return { ok: false, message: `Testing period error: ${err.message || err}` }
  }
}

tv._openStrategyByButtonNearTitle = async () => {
  if (tv._settingsMethod !== null && tv._settingsMethod !== 'setButton')
    return false
  const stratParamEl = page.$(SEL.strategyDialogParam) // Version before 2025.02.21 with param button near title
  if (!stratParamEl)
    return false
  tv._settingsMethod = 'setButton'
  page.mouseClick(stratParamEl) // stratParamEl.click()
  return true
}

tv._openStrategyParamsByStrategyDoubleClickBy = async (indicatorTitle) => {
  if ((tv._settingsMethod !== null && tv._settingsMethod !== 'indName') || !indicatorTitle)
    return false
  const indicatorLegendsEl = document.querySelectorAll(SEL.tvLegendIndicatorItem)
  if (!indicatorLegendsEl)
    return false
  // Same title can appear on several legend rows (duplicate strategy copies); the Tester reports on the
  // "Active strategy". Try the active copy FIRST so we edit the strategy whose report we actually read.
  const ordered = [...indicatorLegendsEl].sort((a, b) =>
    (b.querySelector(SEL.legendActiveStrategyMarker) ? 1 : 0) - (a.querySelector(SEL.legendActiveStrategyMarker) ? 1 : 0))
  for (let indicatorItemEl of ordered) {
    const indicatorTitleEl = indicatorItemEl.querySelector(SEL.tvLegendIndicatorItemTitle)
    if (!indicatorTitleEl)
      continue
    if (normalizeTitle(indicatorTitle) !== normalizeTitle(indicatorTitleEl.innerText))
      continue
    page.mouseDoubleClick(indicatorTitleEl)
    // page.mouseClick(indicatorTitleEl)
    // page.mouseClick(indicatorTitleEl)
    const dialogTitle = await page.waitForSelector(SEL.indicatorTitle, 2500)
    if (dialogTitle && normalizeTitle(dialogTitle.innerText) === normalizeTitle(indicatorTitle)) {
      tv._settingsMethod = 'indName'
      return true
    }
    if (page.$(SEL.cancelBtn))
      page.mouseClickSelector(SEL.cancelBtn)//.click()

  }
  return false
}

tv._openStrategyParamsByStrategyMenu = async () => {
  if (tv._settingsMethod !== null && tv._settingsMethod !== 'setMenu')
    return false
  const strategyCaptionEl = await page.waitForSelector(SEL.strategyCaption, 1000)
  if (!strategyCaptionEl)
    return false
  page.mouseClick(strategyCaptionEl)
  const menuItemSettingsEl = await page.waitForSelector(SEL.strategyMenuItemSettings)
  if (!menuItemSettingsEl)
    return false
  tv._settingsMethod = 'setMenu'
  page.mouseClick(menuItemSettingsEl)
  return true
}

// primary open path for the Jun 2026 TV UI: click the Settings gear on the active strategy's legend row. The legend lost its data-name attrs and the #bottom-area strategy caption was removed, breaking the menu and data-name double-click paths.
tv._openStrategyParamsByLegendSettings = async (indicatorTitle) => {
  if (tv._settingsMethod !== null && tv._settingsMethod !== 'legendGear')
    return false
  const items = document.querySelectorAll(SEL.tvLegendIndicatorItem)
  if (!items || !items.length)
    return false
  let targetItem = null
  let expectedTitle = null
  if (indicatorTitle) {
    // A chart can carry several strategies with the SAME title (duplicate copies). The Strategy Tester
    // reports on exactly ONE of them — the one flagged "Active strategy". Editing any other same-named
    // copy commits values that never move the report we read, so every cycle fails to settle
    // ("No report update signal … after the parameter change"). Collect ALL title matches and open the
    // ACTIVE one; fall back to the first match only when none is marked active.
    const matches = []
    for (const it of items) {
      const t = it.querySelector(SEL.tvLegendIndicatorItemTitle)
      if (t && normalizeTitle(t.innerText) === normalizeTitle(indicatorTitle)) matches.push(it)
    }
    if (!matches.length)
      return false // requested a specific strategy that is not in the legend — let other methods try
    targetItem = matches.find(it => it.querySelector(SEL.legendActiveStrategyMarker)) || matches[0]
    if (matches.length > 1 && !matches.some(it => it.querySelector(SEL.legendActiveStrategyMarker)))
      console.warn(`[TV-ASS] ${matches.length} strategies titled "${indicatorTitle}" are on the chart but none is the Tester's "Active strategy"; editing the first copy — the report may belong to a different one. Remove the duplicate, or click the intended strategy so it becomes the active one in the Strategy Tester.`)
    expectedTitle = indicatorTitle
  } else {
    for (const it of items) {
      if (it.querySelector(SEL.legendActiveStrategyMarker)) { targetItem = it; break }
    }
    if (!targetItem) {
      for (const it of items) {
        const c = typeof it.className === 'string' ? it.className : ''
        if (/\bselected-/.test(c)) { targetItem = it; break }
      }
    }
    if (!targetItem && items.length === 1)
      targetItem = items[0]
    if (targetItem) {
      const t = targetItem.querySelector(SEL.tvLegendIndicatorItemTitle)
      expectedTitle = t ? t.innerText.trim() : null
    }
  }
  if (!targetItem) {
    for (const it of items) {
      const g = it.querySelector(SEL.legendItemSettingsButton)
      if (!g) continue
      page.mouseClick(g)
      const dlg = await page.waitForSelector(SEL.indicatorTitle, 2500)
      if (dlg) { tv._settingsMethod = 'legendGear'; return true }
      const cancelEl = page.$(SEL.cancelBtn); if (cancelEl) cancelEl.click()
    }
    return false
  }
  const gearEl = targetItem.querySelector(SEL.legendItemSettingsButton)
  if (!gearEl)
    return false
  page.mouseClick(gearEl)
  const dialogTitleEl = await page.waitForSelector(SEL.indicatorTitle, 3500)
  if (!dialogTitleEl)
    return false
  // verify the dialog that opened is the strategy we targeted; if not, close it and fail (do not proceed on the wrong strategy)
  if (expectedTitle && normalizeTitle(dialogTitleEl.innerText) !== normalizeTitle(expectedTitle)) {
    const cancelEl = page.$(SEL.cancelBtn)
    if (cancelEl) cancelEl.click()
    return false
  }
  tv._settingsMethod = 'legendGear'
  return true
}

tv._getActiveStrategyName = () => {
  const items = document.querySelectorAll(SEL.tvLegendIndicatorItem)
  for (const it of items) {
    if (it.querySelector(SEL.legendActiveStrategyMarker)) {
      const t = it.querySelector(SEL.tvLegendIndicatorItemTitle)
      if (t && t.innerText) return t.innerText.trim()
    }
  }
  for (const it of items) {
    const c = typeof it.className === 'string' ? it.className : ''
    if (/\bselected-/.test(c)) {
      const t = it.querySelector(SEL.tvLegendIndicatorItemTitle)
      if (t && t.innerText) return t.innerText.trim()
    }
  }
  if (items.length === 1) {
    const t = items[0].querySelector(SEL.tvLegendIndicatorItemTitle)
    if (t && t.innerText) return t.innerText.trim()
  }
  return tv.getStrategyNameFromPopup()
}

tv.getStrategyNameFromPopup = () => {
  const strategyTitleEl = page.$(SEL.indicatorTitle)
  if (strategyTitleEl)
    return strategyTitleEl.innerText ? strategyTitleEl.innerText.trim() : null
  return null
}

tv.openStrategyParameters = async (indicatorTitle, searchAgainstStrategies = false) => {
  const curStrategyTitle = tv.getStrategyNameFromPopup()
  let isOpened = !!curStrategyTitle
  // issue#1 (multiple strategies open): an already-open dialog only counts as "opened" if its title MATCHES the requested strategy. A stale/wrong dialog left open must NOT be scraped as the requested one — close it (Cancel = no save) so the correct dialog is opened below.
  if (isOpened && indicatorTitle && normalizeTitle(curStrategyTitle) !== normalizeTitle(indicatorTitle)) {
    try { const cancelEl = document.querySelector(SEL.cancelBtn); if (cancelEl) { cancelEl.click(); await page.waitForTimeout(250) } } catch (e) {}
    isOpened = false
  }
  if (!isOpened)
    isOpened = await tv._openStrategyParamsByLegendSettings(indicatorTitle)
  if (!isOpened && (indicatorTitle && normalizeTitle(indicatorTitle) !== normalizeTitle(curStrategyTitle)) && searchAgainstStrategies) {
    isOpened = await tv._openStrategyParamsByStrategyDoubleClickBy(indicatorTitle)
    tv._settingsMethod = null
  } else if (!isOpened) {
    // isOpened = await tv._openStrategyByButtonNearTitle()
    // if (!isOpened)
    isOpened = await tv._openStrategyParamsByStrategyMenu()
    if (!isOpened) {
      if (!indicatorTitle) {
        const curStrategyCaptionEl = page.$(SEL.strategyCaption)
        if (curStrategyCaptionEl)
          indicatorTitle = curStrategyCaptionEl.innerText
      }
      isOpened = await tv._openStrategyParamsByStrategyDoubleClickBy(indicatorTitle)
    }
  }

  if (!isOpened) {
    await ui.showErrorPopup('There is not strategy param button on the strategy tab. Test stopped. Open correct page please')
    return null
  }
  const stratIndicatorEl = await page.waitForSelector(SEL.indicatorTitle, 2000)
  if (!stratIndicatorEl) {
    await ui.showErrorPopup('There is not strategy parameters popup. If was not opened, probably TV UI changes. ' +
      'Reload page and try again. Test stopped. Open correct page please')
    return null
  }
  const tabInputEl = document.querySelector(SEL.tabInput)
  if (!tabInputEl) {
    await ui.showErrorPopup('There is not strategy parameters input tab. Test stopped. Open correct page please')
    return null
  }
  page.mouseClick(tabInputEl) //tabInputEl.click()

  const tabInputActiveEl = await page.waitForSelector(SEL.tabInputActive)
  if (!tabInputActiveEl) {
    await ui.showErrorPopup('There is not strategy parameters active input tab. Test stopped. Open correct page please')
    return null
  }
  return true
}

tv.setDeepTest = async (isDeepTest, deepStartDate = null) => {
  function isTurnedOn() {
    return page.$(SEL.strategyDeepTestCheckboxChecked)
  }

  function isTurnedOff() {
    return page.$(SEL.strategyDeepTestCheckboxUnchecked)
  }

  async function turnDeepModeOn() {
    const switchTurnedOffEl = isTurnedOff()
    if (switchTurnedOffEl)
      switchTurnedOffEl.click() // page.mouseClick(switchTurnedOffEl)
    const el = await page.waitForSelector(SEL.strategyDeepTestCheckboxChecked)
    if (!el)
      throw new Error('Can not switch to deep backtesting mode')
  }

  async function turnDeepModeOff() {
    const switchTurnedOnEl = isTurnedOn()
    if (switchTurnedOnEl)
      switchTurnedOnEl.click() //page.mouseClick(switchTurnedOnEl) // // switchTurnedOnEl.click()
    const el = await page.waitForSelector(SEL.strategyDeepTestCheckboxUnchecked)
    if (!el)
      throw new Error('Can not switch off from deep backtesting mode')
  }

  if ((typeof selStatus.userDoNotHaveDeepBacktest === 'undefined' || selStatus.userDoNotHaveDeepBacktest) && !isDeepTest)
    return // Do not check if user do not have userDoNotHaveDeepBacktest switch

  if (selStatus.isNewVersion === false) {
    console.log('[INFO] FOR PREVIOUS VERSION (Feb of 2025) DEEP BACKTEST SHOULD BE SET MANUALLY')
    return
  }

  let deepCheckboxEl = await page.waitForSelector(SEL.strategyDeepTestCheckbox)
  if (!deepCheckboxEl) {
    selStatus.userDoNotHaveDeepBacktest = true
    if (isDeepTest)
      throw new Error('Deep Backtesting mode switch not found. Do you have Premium subscription or may be TV UI changed?')
    return
  } else {
    selStatus.userDoNotHaveDeepBacktest = false
  }

  if (!isDeepTest) {
    await turnDeepModeOff()
    return
  }
  if (isTurnedOff())
    await turnDeepModeOn()
  if (deepStartDate) {
    const startDateEl = await page.waitForSelector(SEL.strategyDeepTestStartDate)
    if (startDateEl) {
      page.setInputElementValue(startDateEl, deepStartDate)
    }
  }
}

tv.checkAndOpenStrategy = async (name, isDeepTest = false) => {
  let indicatorTitleEl = page.$(SEL.indicatorTitle)
  if (!indicatorTitleEl || normalizeTitle(indicatorTitleEl.innerText) !== normalizeTitle(name)) {
    try {
      await tv.openStrategyTab(isDeepTest)
    } catch (err) {
      console.warn('checkAndOpenStrategy: openStrategyTab failed, continuing to openStrategyParameters', err)
    }
    const isOpened = await tv.openStrategyParameters(name)
    if (!isOpened) {
      console.warn('Can able to open current strategy parameters')
      await ui.showErrorPopup('Can able to open current strategy parameters Reload the page, leave one strategy on the chart and try again.')
      return null
    }
    if (name) {
      indicatorTitleEl = page.$(SEL.indicatorTitle)
      if (!indicatorTitleEl || normalizeTitle(indicatorTitleEl.innerText) !== normalizeTitle(name)) {
        await ui.showErrorPopup(`The ${name} strategy parameters could not opened. ${indicatorTitleEl.innerText ? 'Opened "' + indicatorTitleEl.innerText + '".' : ''} Reload the page, leave one strategy on the chart and try again.`)
        return null
      }
    }
  }
  await page.waitForSelector(SEL.indicatorProperty)
  return indicatorTitleEl
}

tv.checkIsNewVersion = async (timeout = 1000) => {
  selStatus.isNewVersion = true
  return
}

// Jun 2026 TV UI: the [data-name="backtesting"] tester-tab selectors and #bottom-area strategyCaption are gone, so the old code wasted ~10s/cycle on two 5s timeouts. The report panel now renders by default; if it's present (strategyReportContainer / metricsTab), return immediately without touching tabs. Legacy fallback kept for older UIs with short timeouts and no throw.
tv.openStrategyTab = async (isDeepTest = false) => {
  // Fast path (current UI): report panel already open. Still make sure the report VIEW is the active
  // light-tab — with "List of Trades" selected the metric DOM is unmounted and nothing downstream can read.
  if (page.$(SEL.strategyReportContainer) || page.$(SEL.metricsTab)) {
    try { await tv._ensureMetricsViewActive() } catch {}
    return true
  }
  // Legacy fallback: activate the Strategy Tester tab (short timeouts; do not throw — non-fatal to callers)
  let isStrategyActiveEl = await page.waitForSelector(SEL.strategyTesterTabActive, 1500)
  if (!isStrategyActiveEl) {
    const strategyTabEl = await page.waitForSelector(SEL.strategyTesterTab, 1500)
    if (strategyTabEl) {
      strategyTabEl.click()
      await page.waitForSelector(SEL.strategyTesterTabActive, 1500)
    } else {
      return false
    }
  }
  let metricsTabActive = await page.waitForSelector(SEL.metricsTab, 1500)
  if (!metricsTabActive)
    return false
  if (!page.$(SEL.metricsTabActive))
    metricsTabActive.click()
  await page.waitForSelector(SEL.metricsTabActive, 1000)
  return true
}

tv.switchToStrategyTabAndSetObserveForReport = async (isDeepTest = false, knownName = '') => {
  // 2026-01-14 Not used anymore because of joining all tabs in one Performance tab in new UI
  // await tv.openStrategyTab(isDeepTest)

  const testResults = {}
  testResults.ticker = await tvChart.getTicker()
  testResults.timeFrame = await tvChart.getCurrentTimeFrame()
  const trimmedKnown = (typeof knownName === 'string' ? knownName : '').trim()
  const activeStrategyName = trimmedKnown || tv._getActiveStrategyName()
  if (!activeStrategyName)
    throw new Error('Could not determine the strategy name from the chart legend (no "Active strategy" row and no open strategy dialog). Make sure your strategy is added to the chart and set as the active strategy, then run the test again.')
  testResults.name = activeStrategyName

  try { await tv._ensureReportPanelOpen() } catch {}
  try { await tv._ensureMetricsViewActive() } catch {}
  try { tv._lastReportSignature = tv._reportSignature() } catch { tv._lastReportSignature = null }

  // const reportEl = await page.waitForSelector(SEL.strategyReportObserveArea, 10000)
  // if (!tv.reportNode) {
  //   // TODO When user switch to deep backtest or minimize window - it should be deleted and created again. Or delete observer after every test
  //   tv.reportNode = await page.waitForSelector(SEL.strategyReportObserveArea, 10000)
  //   if (tv.reportNode) {
  //     const reportObserver = new MutationObserver(() => {
  //       tv.isReportChanged = true
  //     });
  //     reportObserver.observe(tv.reportNode, {
  //       childList: true,
  //       subtree: true,
  //       attributes: false,
  //       characterData: false
  //     });
  //     console.log('[INFO] Observer added to tv.reportNode')
  //   } else {
  //     throw new Error('The strategy report did not found.' + SUPPORT_TEXT)
  //   }
  // }

  // if (isDeepTest) {
  //   if (!tv.reportDeepNode) {
  //     tv.reportDeepNode = await page.waitForSelector(SEL.strategyReportDeepTestObserveArea, 5000)
  //     if (tv.reportDeepNode) {
  //       const reportObserver = new MutationObserver(() => {
  //         tv.isReportChanged = true
  //       });
  //       reportObserver.observe(tv.reportDeepNode, {
  //         childList: true,
  //         subtree: true,
  //         attributes: false,
  //         characterData: false
  //       });
  //       console.log('[INFO] Observer added to tv.reportDeepNode')
  //     } else {
  //       console.error('[INFO] The strategy deep report did not found.')
  //     }
  //   }
  // }
  return testResults
}

tv.dialogHandler = async () => {
  const indicatorTitle = page.getTextForSel(SEL.indicatorTitle)
  if (!document.querySelector(SEL.okBtn) || !document.querySelector(SEL.tabInput))
    return
  if (indicatorTitle === 'iondvSignals' && action.workerStatus === null) {
    let tickerText = document.querySelector(SEL.ticker).innerText
    let timeFrameEl = document.querySelector(SEL.timeFrameActive)
    if (!timeFrameEl)
      timeFrameEl = document.querySelector(SEL.timeFrame)


    let timeFrameText = timeFrameEl.innerText
    if (!tickerText || !timeFrameText)
      // ui.alertMessage('There is not timeframe element on page. Open correct page please')
      return

    timeFrameText = timeFrameText.toLowerCase() === 'd' ? '1D' : timeFrameText
    if (ui.isMsgShown && tickerText === tv.tickerTextPrev && timeFrameText === tv.timeFrameTextPrev)
      return
    tv.tickerTextPrev = tickerText
    tv.timeFrameTextPrev = timeFrameText

    if (!await tv.changeDialogTabToInput()) {
      console.error(`Can't set parameters tab to input`)
      ui.isMsgShown = true
      return
    }

    console.log("Tradingview indicator parameters window opened for ticker:", tickerText);
    const tsData = await storage.getKey(`${storage.SIGNALS_KEY_PREFIX}_${tickerText}::${timeFrameText}`.toLowerCase())
    if (tsData === null) {
      await ui.showErrorPopup(`No data was loaded for the ${tickerText} and timeframe ${timeFrameText}.\n\n` +
        `Please change the ticker and timeframe to correct and reopen script parameter window.`)
      ui.isMsgShown = true
      return
    }
    ui.isMsgShown = false

    const indicProperties = document.querySelectorAll(SEL.indicatorProperty)

    const propVal = {
      TSBuy: tsData && tsData.hasOwnProperty('buy') ? tsData.buy : '',
      TSSell: tsData && tsData.hasOwnProperty('sell') ? tsData.sell : '',
      Ticker: tickerText,
      Timeframe: timeFrameText
    }
    const setResult = []
    const propKeys = Object.keys(propVal)
    for (let i = 0; i < indicProperties.length; i++) {
      const propText = indicProperties[i].innerText
      if (propKeys.includes(propText)) {
        setResult.push(propText)
        page.setInputElementValue(indicProperties[i + 1].querySelector('input'), propVal[propText])
        if (propKeys.length === setResult.length)
          break
      }
    }
    const notFoundParam = propKeys.filter(item => !setResult.includes(item))
    if (notFoundParam && notFoundParam.length) {
      await ui.showErrorPopup(`One of the parameters named ${notFoundParam} was not found in the window. Check the script.\n`)
      ui.isMsgShown = true
      return
    }
    document.querySelector(SEL.okBtn).click()
    const allSignals = [].concat(tsData.buy.split(','), tsData.sell.split(',')).sort()
    await ui.showPopup(`${allSignals.length} signals are set.\n  - date of the first signal: ${new Date(parseInt(allSignals[0]))}.\n  - date of the last signal: ${new Date(parseInt(allSignals[allSignals.length - 1]))}`)
    ui.isMsgShown = true
  }
}

const paramNamePrevVersionMap = {
  // Prev version: New version from set parameters
  'Net Profit': 'Net profit',
  'Gross Profit': 'Gross profit',
  'Gross Loss': 'Gross loss',
  'Max Drawdown': 'Max equity drawdown',
  'Buy & Hold Return': 'Buy & hold return',
  'Sharpe Ratio': 'Sharpe ratio',
  'Sortino Ratio': 'Sortino ratio',
  'Max Contracts Held': 'Max contracts held',
  'Open PL': 'Open P&L',
  'Commission Paid': 'Commission paid',
  'Total Closed Trades': 'Total trades',
  'Total Open Trades': 'Total open trades',
  'Number Winning Trades': 'Winning trades',
  'Number Losing Trades': 'Losing trades',
  'Avg Trade': 'Avg P&L',
  'Avg Winning Trade': 'Avg winning trade',
  'Avg Losing Trade': 'Avg losing trade',
  'Ratio Avg Win / Avg Loss': 'Ratio avg win / avg loss',
  'Largest Winning Trade': 'Largest winning trade',
  'Percent Profitable': 'Percent profitable',
  'Largest Losing Trade': 'Largest losing trade',
  'Avg # Bars in Trades': 'Avg # bars in trades',
  'Avg # Bars in Winning Trades': 'Avg # bars in winning trades',
  'Avg # Bars in Losing Trades': 'Avg # bars in losing trades',
  'Margin Calls': 'Margin calls',
}

tv.convertParameterName = (field) => {
  if (selStatus.isNewVersion)  // new version
    return field
  if (Object.hasOwn(paramNamePrevVersionMap, field))
    return paramNamePrevVersionMap[field]
  return field
}


tv.isParsed = false

tv._parseRows = (allReportRowsEl, strategyHeaders, report) => {
  function parseNumTypeByRowName(rowName, value) {
    const digitalValues = value.replaceAll(/([\-\d\.\n])|(.)/g, (a, b) => b || '')
    return rowName.toLowerCase().includes('trades') || rowName.toLowerCase().includes('contracts held')
      ? parseInt(digitalValues)
      : parseFloat(digitalValues)
  }

  // Expanded lists for Jan 2026 TV UI
  const firstColumnValues = ['Initial capital', 'Open P&L', 'Buy & hold return', 'Buy & hold % gain', 'Strategy outperformance',
    'Sharpe ratio', 'Sortino ratio', 'Account size required', 'Max margin used', 'Margin efficiency', 'Margin calls',
    'Avg equity run-up duration (close-to-close)', 'Avg equity run-up (close-to-close)', 'Max equity run-up (close-to-close)',
    'Max equity run-up (intrabar)', 'Max equity run-up as % of initial capital (intrabar)',
    'Avg equity drawdown duration (close-to-close)', 'Avg equity drawdown (close-to-close)', 'Max equity drawdown (close-to-close)',
    'Max equity drawdown (intrabar)', 'Max equity drawdown as % of initial capital (intrabar)', 'Return of max equity drawdown'
  ]
  const negativeValues = ['Gross loss', 'Commission paid', 'Avg equity run-up duration (close-to-close)',
    'Avg equity run-up (close-to-close)', 'Max equity run-up (close-to-close)', 'Max equity run-up (intrabar)',
    'Max equity run-up as % of initial capital (intrabar)', 'Avg equity drawdown duration (close-to-close)',
    'Avg equity drawdown (close-to-close)', 'Max equity drawdown (close-to-close)', 'Max equity drawdown (intrabar)',
    'Max equity drawdown as % of initial capital (intrabar)', 'Losing trades', 'Avg losing trade', 'Largest losing trade',
    'Largest losing trade percent', 'Avg # bars in losing trades', 'Margin calls'
  ]

  for (let rowEl of allReportRowsEl) {
    if (rowEl) {
      const allTdEl = rowEl.querySelectorAll('td')
      if (!allTdEl || allTdEl.length < 2 || !allTdEl[0]) {
        continue
      }
      let paramName = allTdEl[0].innerText || ''
      paramName = normalizeMetricName(paramName)
      let isSingleValue = allTdEl.length === 3 || firstColumnValues.includes(paramName)
      for (let i = 1; i < allTdEl.length; i++) {
        if (isSingleValue && i >= 2)
          continue
        let values = allTdEl[i].innerText
        const isNegative = negativeValues.includes(paramName.toLowerCase()) || negativeValues.includes(paramName)
        if (values && typeof values === 'string' && strategyHeaders[i]) {
          values = values.replaceAll(' ', ' ').replaceAll('−', '-').trim()
          const digitalValues = values.replaceAll(/([\-\d\.\n])|(.)/g, (a, b) => b || '')
          let digitOfValues = digitalValues.match(/-?\d+\.?\d*/)
          const nameDigits = isSingleValue ? paramName : `${paramName}: ${strategyHeaders[i]}`
          const namePercents = isSingleValue ? `${paramName} %` : `${paramName} %: ${strategyHeaders[i]}`
          const isAllColumn = strategyHeaders[i] === 'All'
          const aliasDigits = isAllColumn && !isSingleValue ? paramName : null
          // Avoid double % - if paramName already has %, alias is just paramName, else paramName + ' %'
          const aliasPercents = isAllColumn && !isSingleValue ? (paramName.includes('%') ? paramName : `${paramName} %`) : null
          if ((values.includes('\n') && values.endsWith('%'))) {
            const valuesPair = values.split('\n', 3)
            if (valuesPair && valuesPair.length >= 2) {
              const digitVal0 = valuesPair[0] //.replaceAll(/([\-\d\.])|(.)/g, (a, b) => b || '') //.match(/-?\d+\.?\d*/)
              const digitVal1 = valuesPair[valuesPair.length - 1]//.replaceAll(/([\-\d\.])|(.)/g, (a, b) => b || '') //match(/-?\d+\.?\d*/)

              if (Boolean(digitVal0)) {
                report[nameDigits] = parseNumTypeByRowName(nameDigits, digitVal0)
                if (report[nameDigits] > 0 && isNegative)
                  report[nameDigits] = report[nameDigits] * -1
                if (aliasDigits) report[aliasDigits] = report[nameDigits]
              } else {
                report[nameDigits] = valuesPair[0]
                if (aliasDigits) report[aliasDigits] = report[nameDigits]
              }
              if (Boolean(digitVal1)) {
                report[namePercents] = parseNumTypeByRowName(namePercents, digitVal1)
                if (report[namePercents] > 0 && isNegative)
                  report[namePercents] = report[namePercents] * -1
                if (aliasPercents) report[aliasPercents] = report[namePercents]
              } else {
                report[namePercents] = valuesPair[1]
                if (aliasPercents) report[aliasPercents] = report[namePercents]
              }
            }
          } else if (Boolean(digitOfValues)) {
            report[nameDigits] = parseNumTypeByRowName(namePercents, digitalValues)
            if (report[nameDigits] > 0 && isNegative)
              report[nameDigits] = report[nameDigits] * -1
            if (aliasDigits) report[aliasDigits] = report[nameDigits]
          } else {
            report[nameDigits] = values
            if (aliasDigits) report[aliasDigits] = report[nameDigits]
          }
        }
      }
      if (isSingleValue && paramName) {
        if (Object.hasOwn(report, paramName) && !Object.hasOwn(report, `${paramName}: All`))
          report[`${paramName}: All`] = report[paramName]
        if (Object.hasOwn(report, `${paramName} %`) && !Object.hasOwn(report, `${paramName} %: All`))
          report[`${paramName} %: All`] = report[`${paramName} %`]
      }
    }
  }
  return report
}


tv._parseMetrics = async (report) => {
  const metricsValuesEls = document.querySelectorAll(SEL.metricsValueCell)
  for (let metricEl of metricsValuesEls) {
    if (!metricEl) continue
    const metricNameAndValEls = metricEl.querySelectorAll('div[class^="container-"]')
    if (metricNameAndValEls && metricNameAndValEls.length < 2) continue
    let metricName = normalizeMetricName(metricNameAndValEls[0].innerText || '')
    let metricValue = metricNameAndValEls[1].innerText || ''
    if (metricValue && typeof metricValue === 'string') {
      metricValue = metricValue.replaceAll(' ', ' ').replaceAll('−', '-').trim()
      // the regex digit class must be single-escaped (\d): a double-escaped class matches a literal backslash + letters (not the digit class), strips every digit, and produces non-numeric card values → "error" each cycle.
      const digitalValues = metricValue.replaceAll(/([\/\-\d\.\n%])|(.)/g, (a, b) => b || '')
      let digitOfValuesArr = digitalValues.split('\n')
      // issue#2 numeric correctness: TradingView cards can render negatives ACCOUNTING-style, e.g. "(42.50) USD" / "(1.25%)". The digit strip above drops the parentheses (so the number parses POSITIVE and contradicts the chart). Detect the parentheses on the ORIGINAL per-line text — the strip preserves '\n', so _rawLines[i] aligns with digitOfValuesArr[i] — and flip the sign. Does NOT touch already-signed values (leading '-') or the drawdown fix above.
      const _rawLines = metricValue.split('\n')
      const _isAccountingNeg = (s) => typeof s === 'string' && /\(\s*[\d.,]+\s*%?\s*\)/.test(s)
      const _applyParenSign = (n, rawLine) => (typeof n === 'number' && !isNaN(n) && n > 0 && _isAccountingNeg(rawLine)) ? -n : n
      let value0 = null
      let value1 = null
      let name1 = null
      if (digitOfValuesArr.length === 1) {
        value0 = digitOfValuesArr[0].match(/-?\d+\.?\d*/g)
      } else {
        value0 = digitOfValuesArr[0].match(/-?\d+\.?\d*/g)
        const lastIdx = digitOfValuesArr.length - 1
        if (digitOfValuesArr[lastIdx].includes('/')) {
          value1 = digitOfValuesArr[lastIdx]
          name1 = `${metricName} ratio`
        } else {
          value1 = digitOfValuesArr[digitOfValuesArr.length - 1].match(/-?\d+\.?\d*/g)
          name1 = digitOfValuesArr[digitOfValuesArr.length - 1].endsWith('%') ? `${metricName} %` : `${metricName}_1`
          // issue#2 ("results don't match the chart"): REMOVED the `if (metricName==='Max equity drawdown') value1 = -1 * value1` negation. TradingView shows Max drawdown as a POSITIVE magnitude (live: "Max drawdown 166.09 USD 3.26%") and this card's absolute value0 is already stored positive (+166.09), so negating only the % produced an exported "Max equity drawdown %: -3.26" that both contradicted the chart (+3.26%) AND disagreed with the absolute and with the table parser (negativeValues at ~tv.js:2177 omits plain "Max equity drawdown"). Leaving the % positive makes card=table=chart consistent and fixes "minimize Max drawdown" (minimizing a negative previously chased the LARGEST drawdown).
        }
      }
      // issue#2 numeric correctness: apply the accounting-negative sign to BOTH card values (value0 from the first line, value1 from the last line). The x/y ratio branch is left untouched.
      if (Boolean(value0)) report[metricName] = _applyParenSign(parseFloat(value0), _rawLines[0])
      else report[metricName] = metricValue
      if (Boolean(value1) && name1) report[name1] = (String(value1).includes('/')) ? value1 : _applyParenSign(parseFloat(value1), _rawLines[_rawLines.length - 1])
      report[`${metricName}: All`] = report[metricName]
      if (Boolean(value1) && name1) report[`${name1}: All`] = report[name1]
    }
  }
  return report
}

tv._getMetricGroupTitle = (group) => {
  const titleEl = [...(group?.children || [])]
    .find(child => child.matches?.('p[class^="title"], p[class*=" title"]'))
  return (titleEl?.innerText || '').trim()
}

tv._getMetricSectionRoot = (el) => {
  const reportRoot = page.$(SEL.reportSectionRoot) || page.$('#bottom-area')
  for (let node = el; node && node !== reportRoot; node = node.parentElement) {
    if (tv._getMetricGroupTitle(node)) return node
  }
  return null
}

tv._getMetricSectionGroups = () => {
  const sections = new Set()
  for (const el of document.querySelectorAll(SEL.metricSectionTable)) {
    const s = tv._getMetricSectionRoot(el); if (s) sections.add(s)
  }
  for (const el of document.querySelectorAll(SEL.metricSectionSubTab)) {
    const s = tv._getMetricSectionRoot(el); if (s) sections.add(s)
  }
  return [...sections]
}

tv._readSectionTable = (group, report) => {
  const table = group.querySelector('table')
  if (!table) return report
  const strategyHeaders = [...table.querySelectorAll('thead > tr > th')].map(h => (h?.innerText || '').trim())
  const rowEls = table.querySelectorAll('tbody > tr')
  if (rowEls.length) report = tv._parseRows(rowEls, strategyHeaders, report)
  return report
}

// The headline cards are the freshness oracle: the settle gate in getPerformance proved THEY belong to
// the current backtest, while the section tables can re-render LATER than the cards (issue#2 round 3:
// "trade numbers / maxdrawdown of cycle N+1 are exactly the chart of cycle N" — table-sourced metrics
// lagging one cycle). Each anchored table carries a card-backed ": All" row that must agree with the
// already-parsed card value; disagreement = stale render.
// Only card/table twins with IDENTICAL semantics qualify as anchors. 'Net profit' does NOT: the card is
// "Total PnL" (closed + open, kept under its own 'Total P&L' key) while the table's Net PnL is closed-only.
tv.SECTION_TAB_CARD_ANCHORS = {
  'returns-summary-table': ['Profit factor: All'],
  'trades-analysis-table': ['Percent profitable: All'],
  'drawdowns-table': ['Max equity drawdown: All', 'Max equity drawdown %: All'],
}

// true = anchors agree (fresh), false = at least one disagrees (stale), null = no anchor overlap (inconclusive)
tv._sectionAnchorsVerdict = (tabId, partial, cardReport) => {
  const anchors = tv.SECTION_TAB_CARD_ANCHORS[tabId] || []
  let seen = false
  for (const k of anchors) {
    if (!Object.hasOwn(partial, k) || !Object.hasOwn(cardReport, k)) continue
    seen = true
    if (!tv._valuesLooseEqual(partial[k], cardReport[k])) return false
  }
  return seen ? true : null
}

// Fail-closed section read: parse the table into a PARTIAL, accept it only when the card anchors agree
// (or, for unanchored tables, when two consecutive reads are identical). A table that stays stale or
// unstable for the whole budget is DROPPED — the row then misses those metrics instead of carrying the
// previous cycle's values.
tv._readSectionTableValidated = async (group, tabId, report) => {
  const budgetMs = 3000, tick = 200
  let waited = 0
  let lastSig = null
  while (true) {
    const partial = tv._readSectionTable(group, {})
    if (!Object.keys(partial).length) return { partial, ok: true }   // no table / no rows: nothing to merge
    const verdict = tv._sectionAnchorsVerdict(tabId, partial, report)
    if (verdict === true) return { partial, ok: true }
    if (verdict === null) {
      const sig = JSON.stringify(partial)
      if (sig === lastSig) return { partial, ok: true }
      lastSig = sig
    }
    if (verdict === false) {
      // The table disagrees with the harvest's card baseline — but the CARDS can be the stale side:
      // the settle gate is fooled when the loading overlay lifts a beat before the cards re-render
      // (proven live: cards showed the previous cycle while the tables were already fresh). Re-read
      // the live cards; if they moved vs the baseline, abort so the caller restarts the whole harvest.
      let freshCards = {}
      try { freshCards = await tv._parseMetrics({}) } catch {}
      for (const k of (tv.SECTION_TAB_CARD_ANCHORS[tabId] || [])) {
        if (Object.hasOwn(freshCards, k) && Object.hasOwn(report, k) && !tv._valuesLooseEqual(freshCards[k], report[k])) {
          const err = new Error('cards re-rendered mid-harvest (stale cards at settle)')
          err.__cardsMoved = true
          throw err
        }
      }
    }
    if (waited >= budgetMs)
      return { partial, ok: false, reason: verdict === false ? 'stale (card anchors disagree)' : 'unstable while parsing' }
    await page.waitForTimeout(tick)
    waited += tick
  }
}

tv._noteDroppedSection = (report, groupTitle, tabId, reason) => {
  const note = `Section "${groupTitle || tabId}" not recorded: ${reason}.`
  console.warn(`[TV-ASS] ${note}`)
  report['comment'] = report['comment'] ? `${report['comment']} ${note}` : note
}

// canonical metric BASE (side/percent stripped) -> the sub-tab id whose table holds it. Built from the
// live Jun-2026 report (E3) so a TARGETED parse clicks ONLY the sub-tab holding the needed metric (AC#4).
// Card-backed metrics (Percent profitable / Profit factor / Max equity drawdown) are resolved by
// _parseMetrics BEFORE any click, so those entries here are used only when a Long/Short variant is needed.
// 'Net profit' always resolves from the returns table (the "Total PnL" card is a different quantity —
// closed + open P&L — stored separately as 'Total P&L').
// An unmapped base falls through to the bounded last-resort pass in parseReportTable (never a per-cycle full scan).
tv.METRIC_SECTION_TAB = {
  'net profit': 'returns-summary-table',
  'gross profit': 'returns-summary-table',
  'gross loss': 'returns-summary-table',
  'commission paid': 'returns-summary-table',
  'open p&l': 'returns-summary-table',
  'profit factor': 'returns-summary-table',
  'expected payoff': 'returns-summary-table',
  'initial capital': 'returns-summary-table',
  'total trades': 'trades-analysis-table',
  'total open trades': 'trades-analysis-table',
  'winning trades': 'trades-analysis-table',
  'losing trades': 'trades-analysis-table',
  'percent profitable': 'trades-analysis-table',
  'avg p&l': 'trades-analysis-table',
  'avg winning trade': 'trades-analysis-table',
  'avg losing trade': 'trades-analysis-table',
  'ratio avg win / avg loss': 'trades-analysis-table',
  'largest winning trade': 'trades-analysis-table',
  'largest losing trade': 'trades-analysis-table',
  'avg # bars in trades': 'trades-analysis-table',
  'avg # bars in winning trades': 'trades-analysis-table',
  'avg # bars in losing trades': 'trades-analysis-table',
  'outliers': 'trades-analysis-table',
  'buy & hold return': 'benchmarking-table',
  'strategy outperformance': 'benchmarking-table',
  'sharpe ratio': 'risk-adjusted-performance-table',
  'sortino ratio': 'risk-adjusted-performance-table',
  'max equity run-up': 'run-ups-table',
  'average run-up (close-to-close)': 'run-ups-table',
  'max run-up (close-to-close)': 'run-ups-table',
  'return of max drawdown': 'drawdowns-table',
  'average drawdown (close-to-close)': 'drawdowns-table',
  'max drawdown (close-to-close)': 'drawdowns-table',
  'max drawdown (intrabar)': 'drawdowns-table',
  'max drawdown as % of initial capital (intrabar)': 'drawdowns-table',
  'largest profit as % of gross profit': 'trades-analysis-table',
  'largest loss as % of gross loss': 'trades-analysis-table',
  'outliers p&l': 'trades-analysis-table',
  'annualized return (cagr)': 'capital-usage-table',
  'return on initial capital': 'capital-usage-table',
  'account size required': 'capital-usage-table',
  'return on account size required': 'capital-usage-table',
  'net pnl as % of largest loss': 'capital-usage-table',
  'margin calls': 'margin-usage-table',
  'max margin used': 'margin-usage-table',
  'average margin used': 'margin-usage-table',
  'margin efficiency': 'margin-usage-table',
  'total liquidated volume': 'margin-usage-table',
  'largest liquidated volume': 'margin-usage-table',
}

tv._metricBase = (name) => String(name || '')
  .toLowerCase()
  .replace(/:\s*(all|long|short)\s*$/i, '')   // strip side
  .replace(/\s+percent\s*$/i, '')             // strip trailing "percent" word
  .replace(/\s*%\s*$/i, '')                   // strip trailing percent sign
  .trim()

tv._sectionTabIdForMetric = (name) => tv.METRIC_SECTION_TAB[tv._metricBase(name)] || null

// Parse ONE section block. Always reads the currently-rendered (selected DETAIL) table for FREE (0 clicks).
// Clicks a HIDDEN detail sub-tab only when allowed (full harvest, the tab id is in allowedTabIds, or the bounded
// fallback pass), waits until THAT tab is actually selected before reading (never parse the previous tab's stale
// rows), then RESTORES the block's ORIGINAL selection — including "Overview" (strategy-report-summary), so the
// user's view never churns. neededRemaining (a Set) shrinks as metrics resolve, so a card-backed target => 0 clicks.
// Every table read goes through tv._readSectionTableValidated: a section whose card anchors disagree with the
// settled headline cards (a late/stale re-render) is re-read within a bounded budget and DROPPED if still stale,
// so table-sourced metrics can never lag one cycle behind the cards in the recorded row.
tv._parseMetricSectionGroup = async (group, report, parsedTabs, opts) => {
  const { fullHarvest = false, allowedTabIds = null, neededRemaining = null, allowFallback = false } = opts || {}
  const groupTitle = tv._getMetricGroupTitle(group)
  const allTabs = [...group.querySelectorAll('button[id][aria-selected]')]
  const detailTabs = allTabs.filter(b => /-table$/.test(b.id))   // returns-summary-table, …; excludes Overview + top-level tabs
  if (!detailTabs.length) return report
  // restore target = whatever was selected ACROSS ALL section buttons (incl. Overview), not just detail tabs
  const originallySelected = allTabs.find(b => b.getAttribute('aria-selected') === 'true') || null

  // 1) read the rendered table for free — only when a DETAIL tab is currently selected (Overview has no table)
  const selectedDetail = detailTabs.find(b => b.getAttribute('aria-selected') === 'true') || null
  if (selectedDetail) {
    const selKey = `${groupTitle}::${selectedDetail.id}`
    if (!parsedTabs.has(selKey)) {
      const read = await tv._readSectionTableValidated(group, selectedDetail.id, report)
      if (read.ok) Object.assign(report, read.partial)
      else tv._noteDroppedSection(report, groupTitle, selectedDetail.id, read.reason)
      parsedTabs.add(selKey)
      if (neededRemaining) for (const k of [...neededRemaining]) if (Object.hasOwn(report, k)) neededRemaining.delete(k)
    }
  }

  // 2) hidden detail sub-tabs — click only the ALLOWED ones
  let clickedAny = false
  for (const tabBtn of detailTabs) {
    if (!fullHarvest && neededRemaining && neededRemaining.size === 0) break
    const tabKey = `${groupTitle}::${tabBtn.id}`
    if (parsedTabs.has(tabKey)) continue
    if (tabBtn.getAttribute('aria-selected') === 'true') continue
    const allowClick = fullHarvest || (allowedTabIds && allowedTabIds.has(tabBtn.id)) || allowFallback
    if (!allowClick) continue
    tabBtn.scrollIntoView({ block: 'center' })
    await page.waitForTimeout(60)
    page.mouseClick(tabBtn)
    clickedAny = true
    // wait until THIS tab is actually selected (its table swapped in) — never read the previous tab's stale rows
    let became = false
    for (let w = 0; w < 15; w++) {
      await page.waitForTimeout(60)
      if (tabBtn.getAttribute('aria-selected') === 'true' && group.querySelector('table')) { became = true; break }
    }
    if (became) {
      await page.waitForTimeout(80)   // brief settle so the new table's rows are populated
      const read = await tv._readSectionTableValidated(group, tabBtn.id, report)
      if (read.ok) Object.assign(report, read.partial)
      else tv._noteDroppedSection(report, groupTitle, tabBtn.id, read.reason)
      if (neededRemaining) for (const k of [...neededRemaining]) if (Object.hasOwn(report, k)) neededRemaining.delete(k)
    }
    parsedTabs.add(tabKey)   // mark attempted either way so the bounded fallback never re-clicks a flaky tab
  }

  // 3) restore the block's original selection (incl. Overview) so the user's report view doesn't churn each cycle
  if (clickedAny && originallySelected && originallySelected.getAttribute('aria-selected') !== 'true') {
    page.mouseClick(originallySelected)
    for (let w = 0; w < 10; w++) {
      if (originallySelected.getAttribute('aria-selected') === 'true') break
      await page.waitForTimeout(60)
    }
  }
  return report
}

tv.parseReportTable = async (neededMetrics = null) => {
  // First expand all metric groups
  for (const groupButton of [
    [SEL.metricPerformanceGroup, SEL.metricPerformanceGroupExpanded],
    [SEL.metricTradeAnalysisGroup, SEL.metricTradeAnalysisGroupExpanded],
    [SEL.metricCapitalEfficiencyGroup, SEL.metricCapitalEfficiencyGroupExpanded],
    [SEL.metricRunUpsGroup, SEL.metricRunUpsGroupExpanded],
  ]) {
    const groupBtnEl = page.$(groupButton[0])
    if (groupBtnEl) {
      const isExpanded = page.$(groupButton[1])
      if (!isExpanded) {
        page.mouseClick(groupBtnEl)
        await page.waitForSelector(groupButton[1], 1000)
      }
    }
  }

  // Bounded consistency loop: when a section read proves the CARDS re-rendered after the settle
  // gate (cards-moved abort from tv._readSectionTableValidated), throw the mixed snapshot away and
  // re-harvest everything from the now-current cards, so a recorded row can never blend two cycles.
  let report = {}
  for (let harvestAttempt = 0; ; harvestAttempt++) {
    report = {}
    report = await tv._parseMetrics(report)

    try {
      const fullHarvest = neededMetrics === null
      const parsedTabs = new Set()
      const groups = tv._getMetricSectionGroups()
      if (fullHarvest) {
        for (const group of groups)
          report = await tv._parseMetricSectionGroup(group, report, parsedTabs, { fullHarvest: true })
      } else {
        const neededRemaining = new Set((neededMetrics || []).filter(Boolean).filter(k => !Object.hasOwn(report, k)))
        // map each still-missing needed metric to the ONE sub-tab that holds it (AC#4: click only those)
        const allowedTabIds = new Set()
        for (const k of neededRemaining) { const id = tv._sectionTabIdForMetric(k); if (id) allowedTabIds.add(id) }
        // PASS A — read every rendered table free + click ONLY the mapped sub-tabs
        for (const group of groups)
          report = await tv._parseMetricSectionGroup(group, report, parsedTabs, { allowedTabIds, neededRemaining })
        // PASS B — bounded last-resort, ONLY if a needed metric is still missing; stops as soon as all needed resolve
        if (neededRemaining.size > 0) {
          for (const group of groups) {
            if (neededRemaining.size === 0) break
            report = await tv._parseMetricSectionGroup(group, report, parsedTabs, { neededRemaining, allowFallback: true })
          }
        }
      }
      break
    } catch (e) {
      if (e && e.__cardsMoved && harvestAttempt < 2) {
        console.info('[TV-ASS] cards re-rendered mid-harvest — re-harvesting the full report (attempt ' + (harvestAttempt + 2) + ')')
        await page.waitForTimeout(400)
        continue
      }
      console.log('[TV-ASS] ISSUE015 section harvest error:', e && e.message ? e.message : e)
      break
    }
  }

  let foundDataQaIdTables = false

  // Parse each metric table using data-qa-id selectors
  for (const sel of [
    SEL.metricPerformanceReturnsTable,
    SEL.metricBenchmarkingTable,
    SEL.metricRatiosTable,
    SEL.metricTradeAnalysisTable,
    SEL.metricCapitalEfficiencyTable,
    SEL.metricMarginEfficiencyTable,
    SEL.metricRunUpsTable,
    SEL.metricDrawdownsTable
  ]) {
    const tabElActive = page.$(sel)
    if (!tabElActive) continue

    foundDataQaIdTables = true
    const selHeader = sel + ' ' + SEL.strategyReportHeaderBase
    const selRow = sel + ' ' + SEL.strategyReportRowBase
    let strategyHeaders = []
    let allHeadersEl = document.querySelectorAll(selHeader)
    for (let headerEl of allHeadersEl) {
      if (headerEl)
        strategyHeaders.push(headerEl.innerText)
    }
    await page.waitForSelector(selRow, 2500)
    let allReportRowsEl = document.querySelectorAll(selRow)
    if (allReportRowsEl && allReportRowsEl.length !== 0) {
      report = tv._parseRows(allReportRowsEl, strategyHeaders, report)
    }
  }

  // Fallback: if no data-qa-id tables found, use .ka-table-wrapper tables
  if (!foundDataQaIdTables || Object.keys(report).length === 0) {
    console.log('[TV-ASS] data-qa-id tables not found, using .ka-table-wrapper fallback')
    const fallbackTables = document.querySelectorAll(SEL.strategyReportTableFallback)
    if (fallbackTables && fallbackTables.length > 0) {
      for (const table of fallbackTables) {
        let strategyHeaders = []
        const headerEls = table.querySelectorAll('thead > tr > th')
        for (let headerEl of headerEls) {
          if (headerEl)
            strategyHeaders.push(headerEl.innerText)
        }
        // Only parse tables that have "Metric" header (report tables)
        if (strategyHeaders.length > 0 && (strategyHeaders[0] === 'Metric' || strategyHeaders.includes('Metric'))) {
          const rowEls = table.querySelectorAll('tbody > tr')
          if (rowEls && rowEls.length > 0) {
            report = tv._parseRows(rowEls, strategyHeaders, report)
          }
        }
      }
    }
  }

  return report
}

tv.generateDeepTestReport = async () => { //loadingTime = 60000) => {
  // let generateBtnEl = await page.waitForSelector(SEL.strategyDeepTestGenerateBtn)
  let generateBtnEl = await page.waitForSelector(SEL.strategyReportUpdate)
  if (generateBtnEl) {
    // page.mouseClick(generateBtnEl) // // generateBtnEl.click()
    generateBtnEl.click()
    await page.waitForSelector(SEL.strategyReportUpdate, 1000, true) // Some times is not started
    // await page.waitForSelector(SEL.strategyDeepTestGenerateBtnDisabled, 1000) // Some times is not started
    // let progressEl = await page.waitForSelector(SEL.strategyReportDeepTestInProcess, 1000)
    // generateBtnEl = await page.$(SEL.strategyDeepTestGenerateBtn)
    // if (!progressEl && generateBtnEl) { // Some time button changed, but returned
    //   generateBtnEl.click()
    // }

  // } else if (page.$(SEL.strategyDeepTestGenerateBtnDisabled)) {
  //   return 'Deep backtesting strategy parameters are not changed'
  }
  // else {
  //   throw new Error('Error for generate deep backtesting report due the button is not exist.' + SUPPORT_TEXT)
  // }
  return ''
}


// FAIL-CLOSED "wait for the report to finish updating": the snackbar selectors getPerformance relies on don't exist in the Jun 2026 UI, so this settles ONLY after an OBSERVED transition — the loading overlay was seen, OR the report signature changed vs the previous cycle — then stabilises. It NEVER treats a stale, unchanged report as done. Baseline signature is seeded at run start.
tv._reportSignature = () => {
  // the empty "This report requires trade data" state is a VALID settled state (these params produced no trades), not "still loading" — return a stable sentinel so tv._waitReportSettled settles on it instead of looping to timeout (error 3 every cycle).
  if (document.querySelector('#bottom-area [class*="emptyStateBlock"]'))
    return '__EMPTY__'
  const cells = document.querySelectorAll('[class^="reportContainer-"] [class^="containerCell"]')
  if (!cells.length) return ''
  return [...cells].map(c => (c.innerText || '').replace(/\s+/g, ' ').trim()).join(' || ')   // all headline cards
}
tv._lastReportSignature = null
// expectChange=false (baseline/current read): a present, stable report settles immediately (incl. the '__EMPTY__' no-trade state) — nothing was mutated.
// expectChange=true (post-mutation read): success requires an OBSERVED update — loading overlay seen-then-gone, OR signature changed vs the previous cycle, OR an explicit empty/no-trade state. A stable-but-unchanged report is a diagnostic timeout (settled:false); the old cards are never treated as a valid new result.
tv._waitReportSettled = async (testResults, expectChange = true) => {
  const LOADING = '#bottom-area .bottom-widgetbar-loading-overlay:not(.js-hidden)'
  const prev = tv._lastReportSignature
  // two time budgets: idleBudgetMs bounds NO-signal waiting only (an active recompute — overlay / "Updating report" snackbar / moving signature — resets it); activeHardCapMs is a generous total-elapsed backstop for a hung report. Invariant: a stable populated post-mutation report with NO observed update still FAILS CLOSED ('idle-no-update') and never parses stale cards. The Update-report fallback is mutation-only (expectChange===true) and resets the idle timer after clicking ('update-no-effect' if nothing follows).
  const isDeep = !!(testResults && testResults.isDeepTest)
  const baseMs = ((testResults && testResults.dataLoadingTime) ? testResults.dataLoadingTime * 1000 : 0) || 8000
  const idleBudgetMs = isDeep ? baseMs * 2 : baseMs                       // bound on NO-signal (idle) waiting; active recompute does not count against it
  const activeHardCapMs = Math.max(baseMs * 10, isDeep ? 600000 : 300000) // generous backstop: only a hung/never-settling report can hit this
  const tick = 100
  const allowUpdateFallback = expectChange === true
  const STUCK_MS = 1500
  const snackText = () => { const s = document.querySelector('#snackbar-container'); return s ? (s.innerText || '') : '' }
  let totalElapsed = 0, idleElapsed = 0, sawLoading = false, changed = false, stable = 0, clickedUpdate = false, updPresentMs = 0
  let lastSig = tv._reportSignature()
  const diag = (extra) => Object.assign({ totalElapsed, idleElapsed, sawLoading, changed, clickedUpdate, idleBudgetMs, activeHardCapMs }, extra)
  // single idle-timeout for every no-signal branch: spend the idle budget then return the timeout diag, so a no-signal report can never wait all the way to activeHardCapMs. Active recompute / signature movement reset idleElapsed inline and never call this.
  const addIdle = () => {
    idleElapsed += tick
    if (idleElapsed >= idleBudgetMs) {
      if (!expectChange) tv._lastReportSignature = tv._reportSignature()        // refresh baseline even on timeout
      return diag({ settled: false, timedOut: true, reason: clickedUpdate ? 'update-no-effect' : 'idle-no-update' })
    }
    return null
  }
  while (true) {
    // generous hard backstop on TOTAL time — reached only by an actively-recomputing-but-hung (or otherwise never-settling) report, since every progress signal below resets idleElapsed, never totalElapsed
    if (totalElapsed >= activeHardCapMs) {
      if (!expectChange) tv._lastReportSignature = tv._reportSignature()
      return diag({ settled: false, timedOut: true, reason: 'active-timeout' })
    }
    await page.waitForTimeout(tick)
    totalElapsed += tick
    if (page.$(LOADING) || /updating report/i.test(snackText())) { sawLoading = true; stable = 0; updPresentMs = 0; idleElapsed = 0; continue }   // ACTIVE recompute -> reset idle, keep waiting (does not count against idleBudget)
    // FALLBACK (last resort, mutation reads only): an "Update report" button means the visible report is STALE. Don't settle on it; after it lingers STUCK_MS, click once to force the refresh and RESET the idle timer so the forced recompute has room to appear. Only the real overlay/"Updating report"/signature change that follows counts — a failed/no-op click can never settle stale data.
    if (allowUpdateFallback && !clickedUpdate) {
      const updBtn = page.$(SEL.strategyReportUpdate)
      if (updBtn) {
        updPresentMs += tick
        stable = 0
        if (updPresentMs >= STUCK_MS) {
          try { updBtn.click() } catch {}
          clickedUpdate = true
          updPresentMs = 0
          idleElapsed = 0                                                        // reset idle after forcing a refresh so the recompute has room to appear
          stable = 0
          continue
        }
        const t = addIdle(); if (t) return t                                     // button lingering, not yet clicked -> idle-budgeted no-signal wait
        continue
      }
      updPresentMs = 0
    }
    const sig = tv._reportSignature()
    if (!sig) { stable = 0; const t = addIdle(); if (t) return t; continue }      // transitional/unknown DOM -> no signal (idle-budgeted)
    if (prev !== null && sig !== prev) changed = true                             // report changed vs previous cycle
    if (sig !== lastSig) { stable = 0; lastSig = sig; idleElapsed = 0; continue } // value still moving -> signal, reset idle
    stable++
    const isEmpty = sig === '__EMPTY__'                                           // explicit no-trade result (valid settled state)
    // '__EMPTY__' ("This report requires trade data") is a TERMINAL TV state, not a loading state (the overlay/"Updating report" branch above already waits through the real recompute and is checked first each tick), and it carries no numbers — so an empty report settles a mutation read too. Otherwise a no-trade config (empty-after-empty) could never settle → 8s error-3 timeout → retry → hang.
    const observedUpdate = sawLoading || changed || isEmpty
    // overlay-only settles (loading seen but the values never changed) get a longer stability window:
    // the cards can re-render a beat AFTER the overlay lifts, and 100ms of stale-card stability was
    // enough to settle on the previous cycle's numbers. 300ms gives the late re-render room to move
    // the signature (which resets `stable` above) before old cards are accepted as the result.
    const needStable = (expectChange && sawLoading && !changed && !isEmpty) ? 3 : 1
    // baseline read: stable-present is enough; mutation read: observed an update (overlay/"Updating report" seen, or value changed) OR a terminal no-trade empty state — never accept stale NON-empty cards (stale-card protection preserved for cards that carry numbers)
    if (stable >= needStable && (!expectChange || observedUpdate)) {
      tv._lastReportSignature = sig
      return diag({ settled: true, reason: 'settled', empty: isEmpty })
    }
    // expectChange && !observedUpdate: stable POPULATED report with no overlay/change — this is IDLE (no-op/no-effect). Fail closed after the idle budget; NEVER trust stale numbers.
    const t = addIdle(); if (t) return t
  }
}

// open the bottom Strategy Tester panel if the user COLLAPSED it: when collapsed, #bottom-area shrinks to ~2px and the report DOM isn't rendered, so _reportSignature() returns '' forever → error 3 every cycle. The toggle's aria-label is "Open panel" when collapsed / "Collapse panel" when open; click ONLY when collapsed. This reveals the existing report (it does NOT change report data, unlike the forbidden Update-report click).
tv._ensureReportPanelOpen = async () => {
  const toggle = document.querySelector(SEL.bottomPanelToggle)
  if (!toggle) return false
  const label = (toggle.getAttribute('aria-label') || '').toLowerCase()
  if (label.includes('open panel')) {   // collapsed -> open it
    page.mouseClick(toggle)
    await page.waitForTimeout(450)       // let the panel expand + the report DOM render
    return true
  }
  return false
}

// Jul-2026 tester header: "Strategy report" / "List of Trades" are icon-only view tabs at the left of the
// toolbar. With "List of Trades" active the headline cards and metric tables are UNMOUNTED, so
// _reportSignature() returns '' forever and every settle can only end in the update-no-effect timeout.
// Select the report view and wait for a metrics-specific readiness signal: a non-empty signature (cards
// rendered, or the '__EMPTY__' no-trades sentinel). Tab-active alone is NOT readiness — the report DOM
// mounts a beat after the switch. No-op when already active or when the tabs don't exist (older UIs).
tv._ensureMetricsViewActive = async () => {
  if (page.$(SEL.metricsTabActive))
    return true
  const tabEl = page.$(SEL.metricsTab)
  if (!tabEl)
    return false
  page.mouseClick(tabEl)
  const active = await page.waitForSelector(SEL.metricsTabActive, 2000)
  for (let waited = 0; waited < 2000; waited += 100) {
    if (tv._reportSignature())
      return true
    await page.waitForTimeout(100)
  }
  return !!active
}

tv.getPerformance = async (testResults, isIgnoreError = false, expectChange = true) => {
  await tv._ensureReportPanelOpen()
  await tv._ensureMetricsViewActive()
  // MANDATORY fail-closed settle gate: wait for the report to actually update (loading overlay seen OR report-signature change vs the previous cycle), then stabilise. If it does NOT settle in the window, return error 3 with EMPTY data — NEVER parse the stale visible cards. backtest.js retries on error 3, so a slow report gets more attempts before being skipped.
  const settleRes = await tv._waitReportSettled(testResults, expectChange)
  if (!settleRes.settled) {
    const s = settleRes
    const secs = (ms) => Math.round((ms || 0) / 1000)
    const detail =
      s.reason === 'active-timeout'   ? `TradingView was still recomputing the report after ${secs(s.totalElapsed)}s (active recompute exceeded the ${secs(s.activeHardCapMs)}s safety cap).` :
      s.reason === 'update-no-effect' ? `The "Update report" button was clicked but no report update followed within ${secs(s.idleElapsed)}s. If the Strategy Tester is showing "List of trades", switch it to the report view (left toolbar toggle).` :
                                        `No report update signal (no loading overlay, no value change) within ${secs(s.idleElapsed)}s after the parameter change.`
    return {
      error: 3,
      message: `Backtesting report did not settle: ${detail}`,
      data: {},
      settle: {
        reason: s.reason, totalElapsed: s.totalElapsed, idleElapsed: s.idleElapsed,
        idleBudgetMs: s.idleBudgetMs, activeHardCapMs: s.activeHardCapMs,
        sawLoading: s.sawLoading, changed: s.changed, clickedUpdate: s.clickedUpdate, timedOut: true
      }
    }
  }
  let reportData = {}
  let message = ''
  let isProcessError = null
  let isProcessStart = true
  let isProcessEnd = true
  await page.waitForTimeout(120)

  isProcessError = isProcessError || document.querySelector(SEL.strategyReportError)
  await page.waitForTimeout(250) // Waiting for update numbers in table

  if (!isProcessError) {
    // Always harvest the full metric set so the exported final report is complete (every report metric, not just the optimization target + filters).
    reportData = await tv.parseReportTable(null)
    // Re-baseline the settle signature to the FINAL rendered state. The gate can settle on cards that
    // re-render a beat after the loading overlay lifts (the harvest recovers via the cards-moved
    // restart); without this refresh the next cycle "changes" against that stale baseline and settles
    // instantly on THIS cycle's report — a self-sustaining one-cycle lag on every recorded row.
    try { tv._lastReportSignature = tv._reportSignature() } catch {}
  }

  if (!isProcessError && !isProcessEnd && testResults.perfomanceSummary.length) {
    const lastRes = testResults.perfomanceSummary[testResults.perfomanceSummary.length - 1]
    if (reportData.hasOwnProperty(testResults.optParamName) && lastRes.hasOwnProperty(testResults.optParamName) &&
      reportData[testResults.optParamName] !== lastRes[testResults.optParamName]) {
      isProcessEnd = true
      isProcessStart = true
    }
  }
  if (reportData['comment'])
    message += '. ' + reportData['comment']
  const comment = message ? message : testResults.isDeepTest ? 'Deep BT. ' : null
  if (comment) {
    if (reportData['comment'])
      reportData['comment'] = comment ? comment + ' ' + reportData['comment'] : reportData['comment']
    else {
      reportData['comment'] = comment
    }
  }

  const reportArea = document.querySelector('#bottom-area') || document.body
  const rangeRegex = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s+—\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/
  const rangeMatch = reportArea.textContent.match(rangeRegex)
  if (rangeMatch && testResults) {
    // Convert "Jan 27, 2026 — Feb 3, 2026" to "jan-27-2026--feb-3-2026"
    testResults.rangeText = rangeMatch[0]
      .replace(/,/g, '')           // Remove commas: "Jan 27 2026 — Feb 3 2026"
      .replace(/\s+—\s+/g, '--')   // Em-dash to double hyphen: "Jan 27 2026--Feb 3 2026"
      .replace(/\s+/g, '-')        // Spaces to hyphens: "Jan-27-2026--Feb-3-2026"
      .toLowerCase()               // Lowercase: "jan-27-2026--feb-3-2026"
  }

  // surface the terminal no-trade state: settleRes.empty===true means the gate settled on '__EMPTY__' ("requires trade data") — a definitive zero-trade result, not a transient failure. The flag lets the caller skip the (pointless) retries; error stays null (not an error, just no trades and no optParamName to compete).
  return {
    error: isProcessError ? 2 : !isProcessStart ? 1 : !isProcessEnd ? 3 : null,
    message: message,
    data: reportData,
    empty: settleRes.empty === true
  }
  // return await tv.parseReportTable()
  // TODO change the object to get data
  // function convertPercent(key, value) {
  //   if (!value)
  //     return 0
  //   return key.endsWith('Percent') || key.startsWith('percent')? value * 100 : value
  // }
  //
  // const perfDict = {
  //   'netProfit': 'Net Profit',
  //   'netProfitPercent': 'Net Profit %',
  //   'grossProfit': 'Gross Profit',
  //   'grossProfitPercent': 'Gross Profit %',
  //   'grossLoss': 'Gross Loss',
  //   'grossLossPercent': 'Gross Loss %',
  //   'maxStrategyDrawDown': 'Max Drawdown',
  //   'maxStrategyDrawDownPercent': 'Max Drawdown %',
  //   'buyHoldReturn': 'Buy & Hold Return',
  //   'buyHoldReturnPercent': 'Buy & Hold Return %',
  //   'sharpeRatio': 'Sharpe Ratio',
  //   'sortinoRatio': 'Sortino Ratio',
  //   'profitFactor': 'Profit Factor',
  //   'maxContractsHeld': 'Max Contracts Held',
  //   'openPL': 'Open PL',
  //   'openPLPercent': 'Open PL %',
  //   'commissionPaid': 'Commission Paid',
  //   'totalTrades': 'Total Closed Trades',
  //   'totalOpenTrades': 'Total Open Trades',
  //   'numberOfLosingTrades': 'Number Losing Trades',
  //   'numberOfWiningTrades': 'Number Winning Trades',
  //   'percentProfitable': 'Percent Profitable',
  //   'avgTrade': 'Avg Trade',
  //   'avgTradePercent': 'Avg Trade %',
  //   'avgWinTrade': 'Avg Winning Trade',
  //   'avgWinTradePercent': 'Avg Winning Trade %',
  //   'avgLosTrade': 'Avg Losing Trade',
  //   'avgLosTradePercent': 'Avg Losing Trade %',
  //   'ratioAvgWinAvgLoss': 'Ratio Avg Win / Avg Loss',
  //   'largestWinTrade': 'Largest Winning Trade',
  //   'largestWinTradePercent': 'Largest Winning Trade %',
  //   'largestLosTrade': 'Largest Losing Trade',
  //   'largestLosTradePercent': 'Largest Losing Trade %',
  //   'avgBarsInTrade': 'Avg # Bars in Trades',
  //   'avgBarsInLossTrade': 'Avg # Bars In Losing Trades',
  //   'avgBarsInWinTrade': 'Avg # Bars In Winning Trades',
  //   'marginCalls': 'Margin Calls',
  // }
  //
  // const performanceData = await tv.getPageData('getPerformance')
  // let data = {}
  // if (performanceData) {
  //   if(performanceData.hasOwnProperty('all') && performanceData.hasOwnProperty('long') && performanceData.hasOwnProperty('short')) {
  //     for (let key of Object.keys(performanceData['all'])) {
  //       const keyName = perfDict.hasOwnProperty(key) ? perfDict[key] : key
  //       data[`${keyName}: All`] = convertPercent(key, performanceData['all'][key])
  //       if(performanceData['long'].hasOwnProperty(key))
  //         data[`${keyName}: Long`] = convertPercent(key, performanceData['long'][key])
  //       if(performanceData['short'].hasOwnProperty(key))
  //         data[`${keyName}: Short`] = convertPercent(key, performanceData['short'][key])
  //     }
  //   }
  //   for(let key of Object.keys(performanceData)) {
  //     if (!['all', 'long', 'short'].includes(key)) {
  //       const keyName = perfDict.hasOwnProperty(key) ? perfDict[key] : key
  //       data[keyName] =  convertPercent(key, performanceData[key])
  //     }
  //   }
  // }
  // return data
}

tv.getPageData = async (actionName, timeout = 1000) => {
  delete tvPageMessageData[actionName]
  const url = window.location && window.location.origin ? window.location.origin : 'https://www.tradingview.com'
  window.postMessage({ name: 'iondvScript', action: actionName }, url) // TODO wait for data
  let iter = 0
  const tikTime = 50
  do {
    await page.waitForTimeout(tikTime)
    iter += 1
    if (tikTime * iter >= timeout)
      break
  } while (!tvPageMessageData.hasOwnProperty(actionName))
  return tvPageMessageData.hasOwnProperty(actionName) ? tvPageMessageData[actionName] : null
}

tv.callPageAction = async (actionName, payload = null, timeout = 4000) => {
  const url = window.location && window.location.origin ? window.location.origin : 'https://www.tradingview.com'
  const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const messageKey = `${actionName}#${requestId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (tvPageMessageData.hasOwnProperty(messageKey))
        delete tvPageMessageData[messageKey]
      reject(new Error(`Timeout waiting for "${actionName}" response`))
    }, timeout)
    tvPageMessageData[messageKey] = (data) => {
      clearTimeout(timer)
      if (tvPageMessageData.hasOwnProperty(messageKey))
        delete tvPageMessageData[messageKey]
      resolve(data)
    }
    window.postMessage({ name: 'iondvScript', action: actionName, data: payload, requestId }, url)
  })
}
