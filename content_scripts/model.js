const model = {}


model.getStrategyParameters = async (strategyData) => {
  const strategyKeys = Object.keys(strategyData.properties)
  let storedRange = await storage.getKey(storage.STRATEGY_KEY_PARAM)
  if (storedRange) {
    const mismatched = Object.keys(storedRange).filter(key => !strategyKeys.includes(key))
    if (mismatched && mismatched.length) {
      const isDef = await ui.alertPopup(`The data loaded from the storage has parameters that are not present in the 
      current strategy: ${mismatched.join(',')}.\n\nYou need to load the correct strategy in the Tradingview chart or 
      load new parameters for the current one. \nAlternatively, you can use the default strategy optimization parameters.
      \n\nShould it use the default settings?`, false, true)
      if (!isDef)
        return null
      storedRange = null
    }
  }

  const currentRange = model.getStrategyRange(strategyData)
  let normalizedRange = {}
  let shouldPersist = false

  if (storedRange) {
    Object.keys(storedRange).forEach(key => {
      const normalizedEntry = normalizeParamEntry(storedRange[key])
      if (normalizedEntry)
        normalizedRange[key] = normalizedEntry
      if (Array.isArray(storedRange[key]) && storedRange[key].length < 6)
        shouldPersist = true
    })
  }

  strategyKeys.forEach(key => {
    if (!normalizedRange.hasOwnProperty(key)) {
      if (currentRange.hasOwnProperty(key)) {
        const base = currentRange[key].slice()
        base[5] = true
        normalizedRange[key] = base
        shouldPersist = true
      }
    } else if (normalizedRange[key].length < 6) {
      normalizedRange[key][5] = true
      shouldPersist = true
    }
  })

  if (Object.keys(normalizedRange).length === 0) {
    normalizedRange = {}
    Object.keys(currentRange).forEach(key => {
      const base = currentRange[key].slice()
      base[5] = true
      normalizedRange[key] = base
    })
    shouldPersist = true
  }

  if (shouldPersist)
    await storage.setKeys(storage.STRATEGY_KEY_PARAM, normalizedRange)

  return normalizedRange
}


model.saveStrategyParameters = async (paramRange) => {
  const normalizedRange = {}
  Object.keys(paramRange || {}).forEach(key => {
    const normalizedEntry = normalizeParamEntry(paramRange[key])
    if (normalizedEntry)
      normalizedRange[key] = normalizedEntry
  })
  await storage.setKeys(storage.STRATEGY_KEY_PARAM, normalizedRange)
}


model.getStrategyRange = (strategyData) => {
  const paramRange = {}
  Object.keys(strategyData.properties).forEach((key, idx) => {
    if(typeof strategyData.properties[key] === 'boolean') {
      paramRange[key] = [true, false, 0, strategyData.properties[key], idx + 1]
    } else if (typeof strategyData.properties[key] === 'string' && strategyData.properties[key].includes(';')) {
      paramRange[key] = [strategyData.properties[key], '', 0, strategyData.properties[key].split(';')[0], idx + 1]
    } else {
      const isInteger = strategyData.properties[key] === Math.round(strategyData.properties[key]) // TODO or convert to string and check the point?
      if(strategyData.properties[key]) { // Not 0 or Nan
        paramRange[key] = [isInteger ? Math.floor(strategyData.properties[key] / 2) : strategyData.properties[key] / 2,
          strategyData.properties[key] * 2]
        let step = isInteger ? Math.round((paramRange[key][1] - paramRange[key][0]) / 10) : (paramRange[key][1] - paramRange[key][0]) / 10
        step = isInteger && step !== 0 ? step : paramRange[key][1] < 0 ? -1 : 1 // TODO or set paramRange[key][1]?
        paramRange[key].push(step)
        paramRange[key].push(strategyData.properties[key])
        paramRange[key].push(idx + 1)
      } else {
        paramRange[key] = [strategyData.properties[key], '', 0, strategyData.properties[key], idx + 1]
      }
    }
  })
  return paramRange
}

model.parseStrategyParamsAndGetMsg = async (fileData, allowedKeys = null, baseRange = null) => {
  console.log('parsStrategyParamsAndGetMsg filename', fileData)
  const paramRange = {}
  const csvData = await file.parseCSV(fileData)
  const headers = Object.keys(csvData[0])
  const missColumns = ['parameter','from','to','step','default','priority'].filter(columnName => !headers.includes(columnName.toLowerCase()))
  if(missColumns && missColumns.length)
    return `  - ${fileData.name}: There is no column(s) "${missColumns.join(', ')}" in CSV.\nPlease add all necessary columns to CSV like showed in the template.\n\nUploading canceled.\n`
  const allowedCanonicalMap = buildCanonicalMap(allowedKeys)
  const allowedValues = Object.values(allowedCanonicalMap)
  const allowedSet = allowedValues.length ? new Set(allowedValues) : null
  const unknownKeys = new Set()
  csvData.forEach(row => {
    if (!row.hasOwnProperty('parameter'))
      return
    const rawName = String(row['parameter']).trim()
    if (!rawName)
      return
    const canonical = canonicalizeParamName(rawName)
    const mappedName = allowedCanonicalMap[canonical]
    if (allowedSet && !mappedName)
      return unknownKeys.add(rawName)
    const paramName = mappedName || rawName
    if (!paramName)
      return
    const priority = Number.isNaN(parseInt(row['priority'])) ? row['priority'] : parseInt(row['priority'])
    const enabledRaw = row.hasOwnProperty('enabled') ? row['enabled'] : true
    const enabled = parseEnabledValue(enabledRaw)
    const entry = [row['from'], row['to'], row['step'], row['default'], priority, enabled]
    const normalizedEntry = normalizeParamEntry(entry)
    if (normalizedEntry)
      paramRange[paramName] = normalizedEntry
  })
  if (allowedSet && unknownKeys.size) {
    return `  - ${fileData.name}: The file contains parameter(s) that are not part of the current strategy: ${Array.from(unknownKeys).join(', ')}. Upload canceled.\n`
  }
  const baseEntries = baseRange || {}
  if (allowedSet || baseEntries) {
    const iterateKeys = allowedKeys && allowedKeys.length ? allowedKeys : Object.keys(baseEntries)
    iterateKeys.forEach(key => {
      if (!key)
        return
      const canonicalKey = canonicalizeParamName(key)
      const targetKey = allowedCanonicalMap[canonicalKey] || key
      if (paramRange.hasOwnProperty(targetKey))
        return
      if (baseEntries && baseEntries.hasOwnProperty(targetKey)) {
        const baseEntry = normalizeParamEntry(baseEntries[targetKey])
        if (baseEntry) {
          baseEntry[5] = false
          paramRange[targetKey] = baseEntry
        }
      }
    })
  }
  await model.saveStrategyParameters(paramRange)
  console.log(paramRange)
  return `The data was saved in the storage. \nTo use them for repeated testing, click on the "Test strategy" button in the extension pop-up window.`
}

model.convertStrategyRangeToTemplate = (paramRange) => {
  let csv = 'Parameter,From,To,Step,Default,Priority,Enabled\n'
  Object.keys(paramRange).forEach(key => {
    const range = normalizeParamEntry(paramRange[key])
    if (!range)
      return
    const isEnabled = isParamEnabled(range)
    const fromVal = typeof range[0] === 'string' ? JSON.stringify(range[0]) : range[0]
    const toVal = typeof range[1] === 'string' ? JSON.stringify(range[1]) : range[1]
    const stepVal = typeof range[2] === 'string' ? JSON.stringify(range[2]) : range[2]
    const defVal = typeof range[3] === 'string' ? JSON.stringify(range[3]) : range[3]
    csv += `${JSON.stringify(key)},${fromVal},${toVal},${stepVal},${defVal},${range[4]},${isEnabled ? 'true' : 'false'}\n`
  })
  return csv
}

model.filterRangeByAllowedKeys = (paramRange, allowedKeys) => {
  const allowedCanonicalMap = buildCanonicalMap(allowedKeys)
  const allowedCanonicalKeys = Object.keys(allowedCanonicalMap)
  const allowedCanonicalSet = new Set(allowedCanonicalKeys)
  const filteredRange = {}
  const unknownKeys = []
  Object.keys(paramRange || {}).forEach(key => {
    const canonical = canonicalizeParamName(key)
    if (!allowedCanonicalSet.size || allowedCanonicalMap[canonical]) {
      const targetKey = allowedCanonicalMap[canonical] || key
      filteredRange[targetKey] = paramRange[key]
    } else
      unknownKeys.push(key)
  })
  return { filteredRange, unknownKeys }
}

model.buildExportSummaries = async (testResults) => {
  const summaryChunks = await storage.loadChunks(testResults.summaryChunks || [])
  const filteredChunks = await storage.loadChunks(testResults.filteredChunks || [])
  const fullSummary = summaryChunks.reduce((acc, chunk) => {
    if (Array.isArray(chunk))
      acc.push(...chunk)
    return acc
  }, [])
  if (Array.isArray(testResults.perfomanceSummary))
    fullSummary.push(...testResults.perfomanceSummary)
  const fullFiltered = filteredChunks.reduce((acc, chunk) => {
    if (Array.isArray(chunk))
      acc.push(...chunk)
    return acc
  }, [])
  if (Array.isArray(testResults.filteredSummary))
    fullFiltered.push(...testResults.filteredSummary)
  return { fullSummary, fullFiltered }
}

model.getBestResult = (testResults) => {
  if (testResults && testResults.bestResultRow)
    return testResults.bestResultRow
  const perfomanceSummary = testResults.perfomanceSummary
  const checkField = testResults.optParamName || backtest.DEF_MAX_PARAM_NAME
  const isMaximizing = testResults.hasOwnProperty('isMaximizing') ?  testResults.isMaximizing : true
  if(!perfomanceSummary || !perfomanceSummary.length)
    return ''
  const bestResult = perfomanceSummary.reduce((curBestRes, curResult) => {
    if(curResult.hasOwnProperty(checkField)) {
      if(isMaximizing && (!curBestRes || !curBestRes[checkField] || curBestRes[checkField] < curResult[checkField]))
        return curResult
      else if (!isMaximizing && (!curBestRes || !curBestRes[checkField] || curBestRes[checkField] > curResult[checkField]))
        return curResult
    }
    return curBestRes
  })
  return bestResult
}

model.createParamsFromRange = (paramRange) => {
  const allRangeParams = {}

  Object.keys(paramRange).forEach(key => {
    const entry = normalizeParamEntry(paramRange[key])
    if(!entry || !isParamEnabled(entry))
      return
    if(entry.length < 5) {
      console.error('Errors in param length', key, entry)
    } else if(typeof entry[0] === 'boolean' && typeof entry[1] === 'boolean') {
      allRangeParams[key] = [true, false]
    } else if (typeof entry[0] === 'string' && entry[1] === '' && entry[0].includes(';')) {
      // trim/sanitize categorical dropdown ranges so split(';') cannot produce empty domains
      const parsedDomain = entry[0]
        .split(';')
        .map(item => typeof item === 'string' ? item.trim() : item)
        .filter(item => !(typeof item === 'string' && item.length === 0))
      if (parsedDomain.length)
        allRangeParams[key] = parsedDomain
      else
        console.warn(`Parameter "${key}" skipped because parsed categorical domain is empty.`)
    } else if(entry[2] === 0) {
      if(entry[1] !== '')
        allRangeParams[key] = [entry[0], entry[1]]
      else
        console.log(`Parameter "${key}" will be skipped, because it have only one value in range`)
    } else if (typeof  entry[0] === 'number' && typeof entry[1] === 'number' && typeof entry[2] === 'number') {
      // generate numeric domains direction-tolerantly (matches the UI's Math.abs handling): from===to is one fixed value, from>to is a valid descending range, step uses Math.abs. Empty domains must be avoided — the param-space is a product, so one empty param would zero the whole search; non-finite or step-0 ranges are skipped, with a runaway guard against infinite loops.
      const from = entry[0], to = entry[1], rawStep = entry[2]
      const stepAbs = Math.abs(rawStep)
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(stepAbs) || stepAbs === 0) {
        console.warn(`Parameter "${key}" skipped: invalid numeric range [${from}..${to} step ${rawStep}].`)
      } else {
        const domain = []
        const isFloat = from % 1 !== 0 || to % 1 !== 0 || stepAbs % 1 !== 0
        const fmt = v => isFloat ? Number(v.toFixed(4)) : v
        if (from === to) {
          domain.push(fmt(from))
        } else {
          const dir = from < to ? 1 : -1
          let guard = 0
          for (let i = from; dir > 0 ? i < to : i > to; i += dir * stepAbs) {
            domain.push(fmt(i))
            guard += 1
            if (guard > 100000) {
              console.warn(`Parameter "${key}" skipped: numeric range is too large or invalid.`)
              domain.length = 0
              break
            }
          }
          if (domain.length && domain[domain.length - 1] !== fmt(to))
            domain.push(fmt(to))
        }
        if (domain.length)
          allRangeParams[key] = domain
      }
    } else {
      console.error('Unsupported param values combination', key, entry)
    }
  })
  return allRangeParams
}

model.getParamPriorityList = (paramRange) => {
  const entries = []
  let order = 0
  Object.keys(paramRange).forEach(key => {
    const entry = normalizeParamEntry(paramRange[key])
    if(!entry || !isParamEnabled(entry))
      return
    if(entry.length < 5)
      return console.error('Errors in param length', key, entry)
    const priorityValueRaw = Number(entry[4])
    const priority = Number.isFinite(priorityValueRaw) ? priorityValueRaw : (order + 1)
    entries.push({ key, priority, order })
    order += 1
  })
  entries.sort((a, b) => {
    if (a.priority === b.priority)
      return a.order - b.order
    return a.priority - b.priority
  })
  return entries.map(item => item.key)
}

model.getStartParamValues = async (paramRange, strategyData) => {
  const currenPropVal = getCurrentPropValues(strategyData)
  const startValues = {'default': {}, 'current': currenPropVal}

  Object.keys(paramRange).forEach(key => {
    const entry = normalizeParamEntry(paramRange[key])
    if(!entry || !isParamEnabled(entry))
      return
    if(entry.length < 5)
      console.error('Errors in param length', key, entry)
    else
      startValues.default[key] = entry[3]
  })

  const testResults = await storage.getKey(storage.STRATEGY_KEY_RESULTS)
  if(testResults && testResults.perfomanceSummary && testResults.perfomanceSummary.length) {
    const bestResult = testResults.perfomanceSummary ? model.getBestResult(testResults) : {}
    const allParamsName = Object.keys(startValues.default)
    if(bestResult) {
      const propVal = {}
      testResults.paramsNames.forEach(paramName => {
        if(bestResult.hasOwnProperty(`__${paramName}`))
          propVal[paramName] = bestResult[`__${paramName}`]
      })
      if(propVal && Object.keys(propVal).every(key => allParamsName.includes(key)))
        startValues.best = propVal
    }
  }
  return startValues
}

function getCurrentPropValues(strategyData) {
  const propVal = {}
  Object.keys(strategyData.properties).forEach(key => {
    if (typeof strategyData.properties[key] === 'string' && strategyData.properties[key].includes(';'))
      propVal[key] = strategyData.properties[key].split(';')[0]
    else
      propVal[key] = strategyData.properties[key]
  })
  return propVal
}

function normalizeParamEntry(entry) {
  if (!Array.isArray(entry))
    return null
  const base = entry.slice(0, 5)
  if (base.length < 5)
    return null
  const enabled = entry.length > 5 ? parseEnabledValue(entry[5]) : true
  base[5] = enabled
  return base
}

function isParamEnabled(entry) {
  if (!Array.isArray(entry))
    return false
  if (entry.length > 5)
    return parseEnabledValue(entry[5])
  return true
}

function parseEnabledValue(value) {
  if (typeof value === 'boolean')
    return value
  if (typeof value === 'number')
    return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (!normalized)
      return true
    if (['false', '0', 'no', 'off'].includes(normalized))
      return false
    if (['true', '1', 'yes', 'on'].includes(normalized))
      return true
  }
  return Boolean(value)
}

function canonicalizeParamName(name) {
  if (!name)
    return ''
  return name.toString().trim().toLowerCase()
}

function buildCanonicalMap(keys = []) {
  const map = {}
  if (!keys)
    return map
  keys.forEach(key => {
    if (!key)
      return
    const canonical = canonicalizeParamName(key)
    if (canonical)
      map[canonical] = key
  })
  return map
}
