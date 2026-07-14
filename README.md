# TV‑ASS 

All the things listed below are some of the changes I added to this extension that I wanted as additions for myself. Some of them are simple QoL improvements, others are a bit more experimental. Please do note, that I cannot guarantee the stability or reliability of my version, so use at your own discretion.

Again, I cannot express enough credit to the original repo creator https://github.com/akumidv/tradingview-assistant-chrome-extension. All of this is built entirely on his work, and comparatively, is menial in scale or approach. (IN THE PRE AI ERA EVEN!!). So once again, huge, huge acknowledgments toward @akumidv.

## DIFFERENCES

- **Auto-reconnect** — if TradingView drops its market-data connection during a long run, it reconnects on its own, so the run keeps going while you're away. ( this is a thing i added ages ago, could have been superseded by the newer changes)

- **Keeps running while minimized** — I hardened it slightly, so all of the processes can easily work in the background and you dont have to have the strategy in your foreground, i.e. you can run 3-4-5 tabs of strategies at once minimized, while doing whatever else you want. ( this is a second thing i added ages ago, could have been superseded by the newer change)

- **Two filters at once** — I added a second filter because i wanted to use different combinations of stuff like Profitable ≥ 25% and Max Drawdown ≤ 20%. Theoretically all potential parameters are possible as filters. Could potentially add a third to make it even more granular.

- **Auto-saves every new best** — every time a new winner is reached, it automatically downloads a results file based on your original filters, and again it still always saves the overall best when the run ends as _FINAL.

- **Reupload to the exact state you started the analysis from** — I was profoundly annoyed at TradingVIew, because I would upload a saved run, and then try to match everything by hand, and the result I had supposedly achieved in the strategy, wasn't even close to what it showed on later uploads, and I couldn't figure out why.
So now each saved result also remembers the whole setup: symbol, timeframe, session, date range, chart layout, chart type, and every strategy setting. When you reupload that file later it puts the chart back the way it was when you started the strategy, so the result you saved, SHOULD THEORETICALLY BE the one you get on upload.
This sadly, didnt solve the issue with the mismatch fully, and still results might vary, but, hopefully, quite a bit less.

- **Download and upload parameter ranges** — You can immediately download and upload parameters per strategy, with the same buttons we have in the strategy updater, just inside the Parameter seelction. So you select that you want, click the down arrow and download it as is, then when you upload, it will set it to your saved parameters.

- **Track in F12 console which settings were applied** — On upload, or during the actual testing process you can see in the console which settings were applied, and hopefully see if they match what was intented to change.

- **Minor speed ups** — It is marginally faster at selecting settings and applying them.



## Downloads Organizer (optional, Windows)

Every winner you save lands in your Downloads as a file. The included Organizer is a small companion that watches that folder and automatically files each result into a clean, per-symbol folder and renames it to something readable like 
`GOLD-[49.16% Net, 74.37% WR, 3.80% DD], TF-[1m], Range-[Mar 28 2026 - Jun 27 2026], Created-[27.06.26 11h43], Max Value-[Sharpe ratio - 0.547].csv`

— so you can see the imporant stuff (net %, win rate, drawdown), the timeframe, the date range, when it was saved, and **what you optimized it for**.

**HOW TO USE IT**

1. Open the folder you unzipped/cloned.
2. **Double-click `start_organizer.bat`.** A small console window opens titled *TradingView CSV Organizer* and shows the folder it's **Watching** — your Downloads folder by default.
3. If that's the right folder, press **`1`** to start. If your CSVs download somewhere else, press **`2`**, paste the correct folder path (or just press Enter to accept the suggested Downloads), then press **`1`**.
4. It prints *"Watcher is now active."* — just leave it open while you run strategies. Every new winner that lands in the folder is filed into its per-symbol folder and renamed automatically. It remembers your folder choice for next time.
5. To stop it, press **`Ctrl+C`** in that window, or simply close it.

It's Windows-only — it runs on PowerShell. It's completely optional; the extension works fine without it. If Windows shows a blue **"Windows protected your PC"** popup the first time, click **More info → Run anyway** (it's just an unsigned local script).

## NEW STRATEGIES

I added two new methods for optimization which I wanted to test out. 

**Genetic Algorithm (GA)** — an optimizer modelled on natural selection. It keeps a "population" of parameter sets, scores each one on your strategy, keeps the best performers, then breeds new ones by combining two good sets (crossover) and randomly tweaking a few values (mutation). Each generation tends to beat the last, so it converges on strong configurations instead of guessing blindly — in my testing it lands on better results than plain random search. 

**Cross-Entropy Method (CEM)** — a probability-driven optimizer. Instead of a population it keeps a probability for every value of every parameter, samples a batch of candidate settings from those probabilities, scores them, takes the top performers (the "elite"), and nudges the probabilities toward what the elite used — so over each round it concentrates around the best-scoring region. Based on the Cross-Entropy Method introduced by Reuven Rubinstein (1997), later developed for optimization (Rubinstein & Kroese, "The Cross-Entropy Method", 2004). It's still experimental — I'm refining it to reliably beat random and rival the GA.


---

## How to install 

The extension loads straight from a folder/zip

## CHROME


1. Download this ZIP below
https://github.com/cranyy/TV-ASS/archive/refs/heads/main.zip

Or just run:
```
git clone https://github.com/cranyy/TV-ASS.git
```

(Tip: cloning makes updates painless — when a new version is out, just run `git pull` in that folder and hit the refresh icon on the extension in your browser. No re-downloading zips.)

2. Unzip it in any folder 

3. Open Chrome.

4. Click in the top right corner the 3 dots to open the Settings

5. Click Extensions > Manage Extensions

5.1 If you have the original version downloaded, it will also show up there - something like Tradingview assistant 2.13.2.
[OPTIONAL] -- you can disable it temporarily with the blue toggle to not confuse you, you can click again to reenable it at any time.

6. Then in the Top Right Corner there is a toggle - Developer Mode - click it - and 3 new things will appear.

7. Click Load Unpacked.

8. Select the directory you unzipped/cloned to in Step 2. 

Thats it you can use the new one as normal now, it will be called TV-ASS 1.120



## EDGE


1. Download this ZIP below
https://github.com/cranyy/TV-ASS/archive/refs/heads/main.zip

Or just run:
```
git clone https://github.com/cranyy/TV-ASS.git
```

(Tip: cloning makes updates painless — when a new version is out, just run `git pull` in that folder and hit the refresh icon on the extension in your browser. No re-downloading zips.)

2. Unzip it in any folder 

3. Open Edge.

4. Click in the top right corner the 3 dots to open the menu

5. Click Extensions > Manage extensions

5.1 If you have the original version downloaded, it will also show up there - something like Tradingview assistant 2.13.2.
[OPTIONAL] -- you can disable it temporarily with the blue toggle to not confuse you, you can click again to reenable it at any time.

6. This is the one bit that differs from Chrome: the Developer Mode toggle is in the BOTTOM-LEFT corner (not the top right) - click it, and 3 new things will appear at the top.

7. Click Load Unpacked.

8. Select the directory you unzipped to/cloned to in step 2.

Thats it you can use the new one as normal now, it will be called TV-ASS 1.120


## Good to know

- Saved result files are plain spreadsheets — open them in Excel or Google Sheets to compare runs.
- A re-opened winner restores the chart for everything that can be set automatically. The one thing TradingView won't let any tool set is plot colours, so those are flagged for you to set by hand if you want (they don't affect results).
- The Organizer is Windows-only.
---

## Credits & License

Built entirely on the original TradingView Assistant by Andrei Kuminov (akumidv). See the included [LICENSE](LICENSE).

---

## CHANGELOG

### 1.120 — Upload restore: ticker tab + testing period (July 2026)

Two long-standing upload annoyances fixed:

- **Ticker no longer fails when symbol search was left on the wrong tab** — TradingView remembers which category tab (All / Stocks / Forex / Crypto…) you last used in the symbol search, and if it wasn't "All" the uploaded ticker often wasn't in the filtered results at all, so the upload flagged *"set the symbol manually"* for no good reason. The extension now switches the dialog to "All" first (your typed search re-filters instantly), so the ticker is found no matter what tab you left it on.

- **Testing period restore is now consistent instead of a coin flip** — several problems in the custom date-range dialog, all fixed:
  - If the chart's current preset (e.g. "Last 90 days") already resolved to exactly the file's dates, the upload still errored out with *"set manually"*. Now the file's exact dates get pinned as a proper custom range instead — which also means they can't silently drift to different dates tomorrow the way a rolling preset does.
  - The calendar used to be clicked and submitted blindly, and when TradingView interpreted a click differently than expected this could **commit a wrong range** (even a nonsense 1-day window) on top of showing an error. Now the Select button is only ever pressed when the dialog literally shows your file's dates — committing a wrong range is impossible.
  - All the fixed "wait 200ms and hope" delays were replaced with proper settle-polling (dialog mounting, month navigation, input updates), which kills the sometimes-works-sometimes-doesn't behavior.
  - If TradingView's calendar refuses the scripted end-date change outright (some TV builds do this — only a real mouse click works there), the upload no longer wrecks your period: it leaves it untouched and tells you the exact two calendar clicks to make by hand, while everything else from the file is already applied.

### 1.119 — TradingView moved the furniture again (July 2026)

TradingView redesigned the strategy Properties tab and the Strategy Tester panel, which quietly broke a couple of things. This version adapts to all of it:

- **Old saved runs upload cleanly again** — TradingView removed four rows from the Properties tab: "Base currency" now lives as a little dropdown next to Initial capital, "Margin for long/short positions" got replaced by "Long/Short leverage", and "Verify price for limit orders" became a "Limit order execution" dropdown. So every time you uploaded an older saved run you'd get slapped with *"Properties not found (4): Base currency, Verify price for limit orders, Margin for long positions, Margin for short positions"* — even though nothing was actually wrong with your file.
Now the extension translates your old files to the new layout on the fly — e.g. Margin 5% becomes Long leverage 20x (same thing, different units), and it TELLS you what it mapped in the upload summary instead of erroring. New saves also remember the currency and units properly now, which the old scraper silently dropped.
One honest caveat: TradingView reduced "verify price for limit orders" from any-number-of-ticks to a simple "1 tick beyond" option, so if your old file had it set above 1, the closest possible thing is applied and you get a note about it.

- **Fixed the endless "Backtesting report did not settle" error** — the Strategy Tester now has a little icon toggle on the left (report view vs List of trades). If it was sitting on List of trades, the report data literally doesn't exist on the page, so every single cycle would blow up with *"The 'Update report' button was clicked but no report update followed within 45s"*. The extension now just flips itself back to the report view before reading, so you can leave the panel however you want.

- **CAGR and ~50 more metrics as optimization targets and filters** — TradingView's new report exposes a bunch of metrics we simply never listed: Annualized return (CAGR), Expected payoff, Strategy outperformance, the whole close-to-close run-up/drawdown family, Return on initial capital, Net PnL as % of largest loss, margin usage stuff, and more. All of them are now selectable both as the thing you maximize AND in the two filters. A couple were deliberately left out (the duration ones like "Average drawdown duration") because TradingView renders them as text like "21h 30m" and they don't compare as clean numbers.