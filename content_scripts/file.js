const file = {}

file.saveAs = (text, filename) => {
  let aData = document.createElement('a');
  aData.setAttribute('href', 'data:text/csv;charset=utf-8,' + encodeURIComponent(text));
  aData.setAttribute('download', filename);
  aData.click();
  if (aData.parentNode)
    aData.parentNode.removeChild(aData);
}

// JSON save helper for hard export (separate from CSV saveAs)
file.saveAsJSON = (obj, filename) => {
  const text = JSON.stringify(obj, null, 2)
  let aData = document.createElement('a')
  aData.setAttribute('href', 'data:application/json;charset=utf-8,' + encodeURIComponent(text))
  aData.setAttribute('download', filename)
  aData.click()
  if (aData.parentNode)
    aData.parentNode.removeChild(aData)
}

// JSON upload helper for hard import (separate from CSV upload)
file.uploadJSON = async (handler) => {
  // make JSON upload single-flight and always settle so the toolbar busy state cannot stick
  if (file._uploadBusy)
    return false
  file._uploadBusy = true
  return new Promise(resolve => {
    let settled = false
    let focusTimer = null
    const fileUploadEl = document.createElement('input')
    fileUploadEl.type = 'file'
    fileUploadEl.accept = '.json'
    fileUploadEl.style.display = 'none'

    const cleanup = (result = true) => {
      if (settled)
        return
      settled = true
      file._uploadBusy = false
      window.removeEventListener('focus', onFocus)
      if (focusTimer)
        clearTimeout(focusTimer)
      if (fileUploadEl.parentNode)
        fileUploadEl.parentNode.removeChild(fileUploadEl)
      resolve(result)
    }

    const onFocus = () => {
      focusTimer = setTimeout(() => {
        if (!settled && (!fileUploadEl.files || fileUploadEl.files.length === 0))
          cleanup(false)
      }, 800)
    }

    // enforce .json extension at runtime, reset ui.isMsgShown
    fileUploadEl.addEventListener('change', async () => {
      let message = 'File upload result:\n'
      let isError = false
      try {
        if (!fileUploadEl.files || fileUploadEl.files.length === 0) {
          cleanup(false)
          return
        }
        for (let f of fileUploadEl.files) {
          if (!f.name.toLowerCase().endsWith('.json')) {
            isError = true
            message += `Error: ${f.name} is not a .json file. Please upload a JSON file.\n`
            continue
          }
          try {
            const text = await new Promise((resolveText, reject) => {
              const reader = new FileReader()
              reader.addEventListener('load', (event) => {
                if (!event.target.result)
                  return reject(new Error(`Error loading content from ${f.name}`))
                resolveText(event.target.result)
              })
              reader.addEventListener('error', () => reject(new Error(`Error reading ${f.name}`)))
              reader.readAsText(f)
            })
            const parsed = JSON.parse(text)
            const res = await handler(parsed, f.name)
            if (typeof res === 'string') {
              const lower = res.toLowerCase()
              if (lower.includes('error') || lower.includes('canceled') || lower.includes('does not match'))
                isError = true
            }
            message += res
          } catch (err) {
            isError = true
            message += `Error reading ${f.name}: ${err.message || err}\n`
          }
        }
        if (isError)
          await ui.showErrorPopup(message)
        else
          await ui.showPopup(message)
        ui.isMsgShown = false
        cleanup(!isError)
      } catch (err) {
        console.error('[TV-ASS] uploadJSON failed:', err)
        ui.isMsgShown = false
        cleanup(false)
      }
    }, { once: true })

    fileUploadEl.addEventListener('cancel', () => cleanup(false), { once: true })
    document.body.appendChild(fileUploadEl)
    window.addEventListener('focus', onFocus)
    fileUploadEl.click()
  })
}

// Unicode-safe Base64 codec for the embedded __tvassMeta run-context cell. Base64 (A-Za-z0-9+/=) is mandatory: it contains no quotes/commas so it survives parseCSVLine as one quoted cell, cannot trigger the quoted-boolean rejection (containsQuotedBooleanValues), and is immune to the Windows organizer's content sanitizer. The encodeURIComponent/escape sandwich keeps non-ASCII labels (e.g. em-dashes) intact through btoa/atob.
file.encodeRunContextMeta = (runContext) => {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(runContext))))
  } catch (err) {
    console.warn('[TV-ASS] encodeRunContextMeta failed:', err)
    return null
  }
}

file.decodeRunContextMeta = (b64) => {
  try {
    if (!b64 || typeof b64 !== 'string')
      return null
    return JSON.parse(decodeURIComponent(escape(atob(b64.trim()))))
  } catch (err) {
    console.warn('[TV-ASS] decodeRunContextMeta failed (corrupt/truncated payload):', err)
    return null
  }
}

file.upload = async (handler, endOfMsg, isMultiple = false) => {
  // make CSV upload single-flight and always settle so injected toolbar guards release on cancel/error
  if (file._uploadBusy)
    return false
  file._uploadBusy = true
  return new Promise(resolve => {
    let settled = false
    let focusTimer = null
    const fileUploadEl = document.createElement('input')
    fileUploadEl.type = 'file'
    fileUploadEl.style.display = 'none'
    if(isMultiple)
      fileUploadEl.multiple = 'multiple'

    const cleanup = (result = true) => {
      if (settled)
        return
      settled = true
      file._uploadBusy = false
      window.removeEventListener('focus', onFocus)
      if (focusTimer)
        clearTimeout(focusTimer)
      if (fileUploadEl.parentNode)
        fileUploadEl.parentNode.removeChild(fileUploadEl)
      resolve(result)
    }

    const onFocus = () => {
      focusTimer = setTimeout(() => {
        if (!settled && (!fileUploadEl.files || fileUploadEl.files.length === 0))
          cleanup(false)
      }, 800)
    }

    fileUploadEl.addEventListener('change', async () => {
      let message = isMultiple ? 'File upload results:\n' : 'File upload result:\n'
      let isError = false
      try {
        if (!fileUploadEl.files || fileUploadEl.files.length === 0) {
          cleanup(false)
          return
        }
        for(let file of fileUploadEl.files) {
          try {
            const res = await handler(file)
            // include "does not match" in the error-detection keywords
            if (typeof res === 'string') {
              const lower = res.toLowerCase()
              if (lower.includes('upload canceled') || lower.includes('uploading canceled') || lower.includes('not part of the current strategy') || lower.includes('error') || lower.includes('does not match'))
                isError = true
            }
            message += res
          } catch (err) {
            isError = true
            message += `Error reading ${file.name}: ${err.message || err}\n`
          }
        }
        message += endOfMsg ? '\n' + endOfMsg : ''
        if (isError)
          await ui.showErrorPopup(message)
        else
          await ui.showPopup(message)
        ui.isMsgShown = false
        cleanup(!isError)
      } catch (err) {
        console.error('[TV-ASS] upload failed:', err)
        ui.isMsgShown = false
        cleanup(false)
      }
    }, { once: true })

    fileUploadEl.addEventListener('cancel', () => cleanup(false), { once: true })
    document.body.appendChild(fileUploadEl)
    window.addEventListener('focus', onFocus)
    fileUploadEl.click()
  })
}


file.parseCSV = async (fileData) => {
  return new Promise((resolve, reject) => {
    const CSV_FILENAME = fileData.name
    const isCSV = CSV_FILENAME.toLowerCase().endsWith('.csv')
    if(!isCSV) return reject(`please upload correct file.`)
    const reader = new FileReader();
    reader.addEventListener('load', async (event) => {
      if(!event.target.result) return reject(`there error when loading content from the file ${CSV_FILENAME}`)
      const CSV_VALUE = event.target.result
      if (containsQuotedBooleanValues(CSV_VALUE)) {
        console.warn(`[CSV validation] ${CSV_FILENAME} rejected due to quoted boolean values`)
        return reject('Invalid parameters.')
      }
      try {
        const csvData = parseCSV2JSON(CSV_VALUE)
        if (csvData && csvData.length)
          return resolve(csvData)
      } catch (err) {
        console.error(err)
        return reject(`CSV parsing error: ${err.message}`)
      }
      return reject(`there is no data in the file`)
    })
    return reader.readAsText(fileData);
  });
}


// uploadHandler is a context-aware importer: it strips the __tvassMeta row (exactly like __indicatorName) and routes:
//   • valid {v:3} payload -> action._restoreRunContextFromMeta (ticker/timeframe/session/period + Properties/Inputs/Style/Visibility, fail-closed)
//   • corrupt/unsupported payload -> params-only apply with a non-error note (NEVER abort the params apply — ISSUE005 Edge Cases)
//   • no meta row (legacy file) -> today's EXACT params-only behavior + a non-error filename advisory (requirement (c): old files keep working, untouched on disk)
// The legacy params-only logic is unchanged, only relocated into file._applyParamsOnly so the routing can wrap its message.
file.uploadHandler = async (fileData) => {
  const propVal = {}
  let strategyName = null
  let metaRaw = null
  const csvData = await file.parseCSV(fileData)
  const headers = Object.keys(csvData[0])
  const missColumns = ['Name','Value'].filter(columnName => !headers.includes(columnName.toLowerCase()))
  if(missColumns && missColumns.length)
    return `  - ${fileData.name}: There is no column(s) "${missColumns.join(', ')}" in CSV.\nPlease add all necessary columns to CSV like showed in the template.\n\nSet parameters canceled.\n`
  csvData.forEach(row => {
    if(row['name'] === '__indicatorName')
      strategyName = row['value']
    else if(row['name'] === '__tvassMeta')   // strip embedded run context before propVal is built (else it becomes a "missing parameter" and reddens the popup)
      metaRaw = row['value']
    else
      propVal[row['name']] = row['value']
  })
  if(!strategyName)
    return 'The name for indicator in row with name ""__indicatorName"" is missed in CSV file'

  // context-restoring import when __tvassMeta is present and valid v3
  if (metaRaw) {
    const meta = file.decodeRunContextMeta(metaRaw)
    if (meta && meta.v === 3 && typeof action !== 'undefined' && typeof action._restoreRunContextFromMeta === 'function')
      return await action._restoreRunContextFromMeta(meta, propVal, fileData.name, strategyName)
    // corrupt/truncated or unsupported version -> params-only with a non-error note (decodeRunContextMeta already logged the cause)
    const legacyMsg = await file._applyParamsOnly(strategyName, propVal, fileData)
    return `Note: embedded run context could not be read (corrupt or unsupported version); applied parameters only.\n${legacyMsg}`
  }

  // legacy CSV (no embedded context) -> params-only behavior + best-effort filename advisory (non-error wording so the green path stays green)
  const legacyMsg = await file._applyParamsOnly(strategyName, propVal, fileData)
  const advisory = file._buildLegacyContextAdvisory(fileData.name)
  return advisory ? `${legacyMsg}\n${advisory}` : legacyMsg
}

// non-error advisory for legacy (metadata-less) CSVs: parses ticker/_TF/_RANGE from the filename (the same segments the organizer emits) and tells the user what to set manually. Deliberately auto-sets nothing, to keep the existing params-only green path green.
file._buildLegacyContextAdvisory = (fileName) => {
  try {
    if (!fileName)
      return ''
    const ticker = (fileName.match(/^([A-Za-z0-9]+)_/) || [])[1] || null
    const tf = (fileName.match(/_TF([A-Za-z0-9]+)/) || [])[1] || null
    const range = (fileName.match(/_RANGE([A-Za-z0-9-]+?)(?:_[a-z0-9]+)?\.csv$/i) || [])[1] || null
    if (!ticker && !tf && !range)
      return ''
    const bits = []
    if (ticker) bits.push(`ticker ${ticker}`)
    if (tf) bits.push(`timeframe ${tf}`)
    if (range) bits.push(`range ${range}`)
    return `Note: this file has no embedded run context. Filename suggests ${bits.join(', ')} — set them on the chart manually to reproduce the saved run.`
  } catch {
    return ''
  }
}

// the params-only upload body, wrapped by the routing above.
file._applyParamsOnly = async (strategyName, propVal, fileData) => {
  const res = await tv.setStrategyParams(strategyName, propVal, false, true)
  const lastSetResult = tv.lastSetStrategyResult || {}
  // include the "error" keyword when issues exist (so the popup routes red instead of a misleading green)
  if (res) {
    const response = lastSetResult.response
    const fallbackInfoRaw = lastSetResult.legacy
    const fallbackInfo = (fallbackInfoRaw && typeof fallbackInfoRaw === 'object')
      ? fallbackInfoRaw
      : null
    const fallbackAppliedSet = new Set(Array.isArray(fallbackInfo?.applied) ? fallbackInfo.applied.filter(Boolean) : [])
    const fallbackMissing = Array.isArray(fallbackInfo?.missing) ? fallbackInfo.missing.filter(Boolean) : []
    const formatList = (items) => {
      const unique = Array.from(new Set((items || []).filter(Boolean)))
      if (!unique.length)
        return ''
      const sample = unique.slice(0, 25)
      return `${sample.join(', ')}${unique.length > sample.length ? '...' : ''}`
    }

    let hasIssues = false
    const messageChunks = []

    if (response && typeof response === 'object') {
      const missing = Array.isArray(response.missing) ? response.missing.filter(Boolean) : []
      const errorObjs = Array.isArray(response.errors) ? response.errors.filter(Boolean) : []
      const errorNames = errorObjs.map(err => err && err.name ? err.name : '?').filter(Boolean)

      const resolvedMissing = missing.filter(name => fallbackAppliedSet.has(name))
      const resolvedErrors = errorNames.filter(name => fallbackAppliedSet.has(name))
      const unresolvedMissing = missing.filter(name => !fallbackAppliedSet.has(name))
      const unresolvedErrors = errorNames.filter(name => !fallbackAppliedSet.has(name))

      if (unresolvedMissing.length) {
        messageChunks.push(`Missing parameters (${unresolvedMissing.length}): ${formatList(unresolvedMissing)}`)
        hasIssues = true
      }
      if (unresolvedErrors.length) {
        messageChunks.push(`Failed parameters (${unresolvedErrors.length}): ${formatList(unresolvedErrors)}`)
        hasIssues = true
      }

      if (hasIssues) {
        const resolvedCombined = [...resolvedMissing, ...resolvedErrors]
        if (resolvedCombined.length)
          messageChunks.push(`Legacy fallback applied: ${formatList(resolvedCombined)}`)
      }

      if (hasIssues && !messageChunks.length && Array.isArray(response.catalogSample) && response.catalogSample.length && (!Array.isArray(response.updated) || !response.updated.length))
        messageChunks.push(`Detected fields include: ${response.catalogSample.slice(0, 10).join(', ')}`)
    }

    const unresolvedFallback = fallbackMissing.filter(name => !fallbackAppliedSet.has(name))
    if (unresolvedFallback.length) {
      hasIssues = true
      messageChunks.push(`Legacy fallback could not locate parameters (${unresolvedFallback.length}): ${formatList(unresolvedFallback)}`)
    }

    // Use "error" keyword in message when there are issues so file.upload() triggers red popup
    let msg
    if (hasIssues) {
      msg = `Parameter upload completed with errors:\n${messageChunks.join('\n')}`
    } else {
      msg = 'All settings applied successfully.'
      if (messageChunks.length)
        msg += `\n${messageChunks.join('\n')}`
    }

    return msg
  }

  // check if the API actually applied params before showing a misleading error
  // also handle missing/errors when appliedCount === 0
  // The API might have applied parameters even if res is false (legacy fallback failed)
  const apiResponse = lastSetResult.response
  if (apiResponse && typeof apiResponse === 'object') {
    const updated = Array.isArray(apiResponse.updated) ? apiResponse.updated : []
    const unchanged = Array.isArray(apiResponse.unchanged) ? apiResponse.unchanged : []
    const missing = Array.isArray(apiResponse.missing) ? apiResponse.missing : []
    const errors = Array.isArray(apiResponse.errors) ? apiResponse.errors : []
    const errorNames = errors.map(e => e && e.name ? e.name : '?').filter(Boolean)

    const appliedCount = updated.length + unchanged.length
    const hasIssues = missing.length > 0 || errorNames.length > 0

    if (appliedCount > 0 && !hasIssues) {
      // Full success - parameters applied with no missing or errors
      return `All settings applied successfully via API: ${appliedCount} parameter(s) processed.`
    } else if (appliedCount > 0 && hasIssues) {
      // Partial success - some applied but also some missing/errors
      // newline-sectioned (applied / missing / failed) for readability; keeps the "errors" keyword (red routing) and every count/name unchanged.
      const partialLines = [`Parameter upload completed with errors:`, `Applied: ${appliedCount}`]
      if (missing.length)
        partialLines.push(`Missing (${missing.length}): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`)
      if (errorNames.length)
        partialLines.push(`Failed (${errorNames.length}): ${errorNames.slice(0, 10).join(', ')}${errorNames.length > 10 ? '...' : ''}`)
      return partialLines.join('\n')
    } else if (hasIssues) {
      // check legacy results when the API shows 0 applied
      // API returned 0 applied, but legacy DOM method may have applied parameters
      const legacyInfo = lastSetResult.legacy
      if (legacyInfo && typeof legacyInfo === 'object') {
        const legacyApplied = Array.isArray(legacyInfo.applied) ? legacyInfo.applied : []
        const legacyMissing = Array.isArray(legacyInfo.missing) ? legacyInfo.missing : []
        if (legacyApplied.length > 0) {
          // Legacy method applied some parameters - show success with info
          if (legacyMissing.length === 0) {
            return `All settings applied successfully via DOM: ${legacyApplied.length} parameter(s) set.`
          } else {
            // newline-sectioned for readability; keeps "partial success" / "not found in dialog" wording (green routing) and counts/names unchanged.
            return [`Parameter upload partial success:`,
              `Applied via DOM: ${legacyApplied.length}`,
              `Not found in dialog (${legacyMissing.length}): ${legacyMissing.slice(0, 10).join(', ')}${legacyMissing.length > 10 ? '...' : ''}`].join('\n')
          }
        }
      }
      // Both API and legacy failed to apply anything
      // newline-sectioned (missing / failed) for readability; keeps the "error" keyword (red routing) and every count/name unchanged.
      const errorLines = [`Parameter upload error: 0 applied`]
      if (missing.length)
        errorLines.push(`Missing (${missing.length}): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`)
      if (errorNames.length)
        errorLines.push(`Failed (${errorNames.length}): ${errorNames.slice(0, 10).join(', ')}${errorNames.length > 10 ? '...' : ''}`)
      return errorLines.join('\n')
    }
  }

  // also check legacy when there is no API response
  // Check if legacy method applied parameters even without API response
  const legacyInfo = lastSetResult.legacy
  if (legacyInfo && typeof legacyInfo === 'object') {
    const legacyApplied = Array.isArray(legacyInfo.applied) ? legacyInfo.applied : []
    const legacyMissing = Array.isArray(legacyInfo.missing) ? legacyInfo.missing : []
    if (legacyApplied.length > 0) {
      if (legacyMissing.length === 0) {
        return `All settings applied successfully via DOM: ${legacyApplied.length} parameter(s) set.`
      } else {
        // newline-sectioned for readability; keeps "partial success" / "not found in dialog" wording (green routing) and counts/names unchanged.
        return [`Parameter upload partial success:`,
          `Applied via DOM: ${legacyApplied.length}`,
          `Not found in dialog (${legacyMissing.length}): ${legacyMissing.slice(0, 10).join(', ')}${legacyMissing.length > 10 ? '...' : ''}`].join('\n')
      }
    }
  }

  // Only show this when nothing was applied at all
  return `The name "${strategyName}" of the indicator from the file does not match the name in the open window`
}

function parseCSV2JSON(s, sep= ',') {
  const csv = s.split(/\r\n|\r|\n/g).filter(item => item).map(line => parseCSVLine(line))
  if(!csv || csv.length <= 1) return []
  const headers = csv[0].map(item => item.toLowerCase())
  const JSONData = csv.slice(1).map((line) => {
    const lineObj = {}
    line.forEach((value, line_index) => lineObj[headers[line_index]] = value)
    return lineObj
  })
  return JSONData;
}


function parseCSVLine(text) {
  function replaceEscapedSymbols(textVal) {
    return textVal.replaceAll('\\"', '"')
  }

  return text.match( /\s*(".*?"|'.*?'|[^,]+|)\s*(,(?!\s*\\")|$)/g ).map(function (subText) { // \s*(\".*?\"|'.*?'|[^,]+|)\s*(,|$)
    let m;
    if (m = subText.match(/^\s*\"(.*?)\"\s*,?(?!\s*\\")$/)) {
      const value = replaceEscapedSymbols(m[1])
      const lower = value.trim().toLowerCase()
      if (lower === 'true')
        return true
      if (lower === 'false')
        return false
      return value // Double Quoted Text // /^\s*\"(.*?)\"\s*,?$/
    }
    if (m = subText.match(/^\s*'(.*?)'\s*,?$/)) {
      const value = replaceEscapedSymbols(m[1])
      const lower = value.trim().toLowerCase()
      if (lower === 'true')
        return true
      if (lower === 'false')
        return false
      return value; // Single Quoted Text
    }
    if (m = subText.match(/^\s*(true|false)\s*,?$/i))
      return m[1].toLowerCase() === 'true'; // Boolean
    if (m = subText.match(/^\s*((?:\+|\-)?\d+)\s*,?$/))
      return parseInt(m[1]); // Integer Number
    if (m = subText.match(/^\s*((?:\+|\-)?\d*\.\d*)\s*,?$/))
      return parseFloat(m[1]); // Floating Number
    if (m = subText.match(/^\s*(.*?)\s*,?$/))
      return replaceEscapedSymbols(m[1]); // Unquoted Text
    return subText;
  } );
}



function containsQuotedBooleanValues(csvText) {
  if (!csvText)
    return false
  const doubleQuotedBool = /,\s*"\s*(true|false)\s*"\s*(?=,|\r?\n|$)/gi
  if (doubleQuotedBool.test(csvText))
    return true
  const singleQuotedBool = /,\s*'\s*(true|false)\s*'\s*(?=,|\r?\n|$)/gi
  return singleQuotedBool.test(csvText)
}



file.convertResultsToCSV = (testResults) => {
  function prepareValToCSV(value) {
    if (!value)
      return 0
    if (typeof value !== 'number')
      return JSON.stringify(value)
    return parseFloat(value) === parseInt(value) ? parseInt(value) : parseFloat(value)
    // return (Math.round(value * 100)/100).toFixed(2)
  }

  if(!testResults || !testResults.perfomanceSummary || !testResults.perfomanceSummary.length)
    return 'There is no data for conversion'
  // issue#2 (jiangyoutan): headers were taken from ONE representative row, so any metric column missing from that row was dropped for every row. Build the header set as the UNION of all rows' keys (passing + filtered), preserving first-seen order, so no captured metric is lost. Rows still emit '' for keys they lack (unchanged below).
  const headers = []
  const _seenHeader = new Set()
  const _collectHeaders = (rows) => {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (!row) continue
      for (const k of Object.keys(row)) if (!_seenHeader.has(k)) { _seenHeader.add(k); headers.push(k) }
    }
  }
  _collectHeaders(testResults.perfomanceSummary)
  _collectHeaders(testResults.filteredSummary)
  if (!headers.length) headers.push(...Object.keys(testResults.perfomanceSummary[0]))

  let csv = headers.map(header => JSON.stringify(header)).join(',')
  csv += '\n'
  testResults.perfomanceSummary.forEach(row => {
    const rowData = headers.map(key => typeof row[key] === 'undefined' ? '' : prepareValToCSV(row[key]))
    csv += rowData.join(',').replaceAll('\\"', '""')
    csv += '\n'
  })
  if(testResults.filteredSummary && testResults.filteredSummary.length) {
    csv += headers.map(key => key !== 'comment' ? '' : 'Bellow filtered results of tests') // Empty line
    csv += '\n'
    testResults.filteredSummary.forEach(row => {
      const rowData = headers.map(key => typeof row[key] === 'undefined' ? '' : prepareValToCSV(row[key]))
      csv += rowData.join(',').replaceAll('\\"', '""')
      csv += '\n'
    })
  }
  return csv
}
