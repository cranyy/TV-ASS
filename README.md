# TV‑ASS 

All the things listed below are some of the changes I added to this extension that I wanted as additions for myself. Some of them are simple QoL improvements, others are a bit more experimental. Please do note, that I cannot guarantee the stability or reliability of my version, so use at your own discretion.

Again, I cannot express enough credit to the original repo creator https://github.com/akumidv/tradingview-assistant-chrome-extension. All of this is built entirely on his work, and comparatively, is menial in scale or approach of their original accomplishment. (IN THE PRE AI ERA EVEN!!).

## DIFFERENCES

- **Auto-reconnect** — if TradingView drops its market-data connection during a long run, it reconnects on its own, so the run keeps going while you're away.

- **Two filters at once** — I added a second filter because i wanted to use different combinations of stuff Profitable ≥ 5% and Max Drawdown ≤ 20%. Could potentially add a third to make it even more granular.

- **Auto-saves every new best** — every time a new winner is reached, it automatically downloads a results file, and again it still always saves the overall best when the run ends as _FINAL.

- **Reupload to the exact state you started the analysis from** — I was profoundly annoyed at TradingVIew, I would upload and so often match everything by hand, and the result I had supposedly achieved wasn't even close to what it showed on later uploads. So now each saved result also remembers the whole setup: symbol, timeframe, session, date range, chart layout, chart type, and every strategy setting. When you reupload that file later and it puts the chart back the way it was, so the result you saved SHOULD THEORETICALLY BE the one you get, as close to 1:1 as possible, when you check it.
This sadly, didnt solve the issue with the mismatch fully, and still results might vary, but. hopefully, quite a bit less.

- **Keeps running while minimized** — I hardened it slightly, so all of the processes can easily work in the background and you dont have to have the strategy in your foreground

- **Drop-in parameter ranges** — You can immediately download and upload parameters per strategy, with the same buttons we have in the strategy updater. 

- **Track in F12 console which settings were applied** — On upload, or during the actual testing process you can see in the console which settings were applied, and hopefully see if they match what was intented to change.

- **Minor speed ups** — It is marginally faster at selecting settings and applying them.


## Downloads Organizer (optional, Windows)

Every winner you save lands in your Downloads as a file. The included Organizer is a small companion that watches that folder and automatically files each result into a clean, per-symbol folder and renames it to something readable like 
`GOLD-[62.80% Net, 76.42% WR, 4.92% DD], TF-[1m], Range-[Mar 18 2026 - Jun 17 2026], Created-[17.06.26 20h22].csv …`

To use it: double-click **start_organizer.bat**, choose the folder to watch (your Downloads), and leave it running. It's optional — the extension works fine without it.

## NEW STRATEGIES

I added two new methods as well for optimization which I wanted to test out. 

**Genetic Algorithm (GA)** — an optimizer modelled on natural selection. It keeps a "population" of parameter sets, scores each one on your strategy, keeps the best performers, then breeds new ones by combining two good sets (crossover) and randomly tweaking a few values (mutation). Each generation tends to beat the last, so it converges on strong configurations instead of guessing blindly — in my testing it lands on better results than plain random search. 

**Cross-Entropy Method (CEM)** — a probability-driven optimizer. Instead of a population it keeps a probability for every value of every parameter, samples a batch of candidate settings from those probabilities, scores them, takes the top performers (the "elite"), and nudges the probabilities toward what the elite used — so over each round it concentrates around the best-scoring region. Based on the Cross-Entropy Method introduced by Reuven Rubinstein (1997), later developed for optimization (Rubinstein & Kroese, "The Cross-Entropy Method", 2004). It's still experimental — I'm refining it to reliably beat random and rival the GA.


---

## How to install

The extension loads straight from a folder/zip

**CHROME** 


Download this ZIP below
https://github.com/cranyy/TV-ASS/archive/refs/heads/main.zip

Unzip it in any folder 

Open Chrome.

Click in the top right corner the 3 dots to open the Settings

Click Extensions > Manage Extensions

You will see the Tradingview assistant 2.11.16.
[OPTIONAL] -- you can disable it temporarily with the blue toggle to not confuse you, you can click again to reenable it at any time.

Then in the Top Right Corner there is a toggle - Developer Mode - click it - and 3 new things will appear.

Click Load Unpacked.

Select the directory you unzipped to in Step 2.

Thats it you can use the new one as normal now.

**EDGE** 


Download this ZIP below
https://github.com/cranyy/TV-ASS/archive/refs/heads/main.zip

Unzip it in any folder 

Open Edge.

Click in the top right corner the 3 dots to open the menu

Click Extensions > Manage extensions

You will see the original Tradingview assistant in the list.
[OPTIONAL] -- you can disable it temporarily with the toggle to not confuse you, you can click again to reenable it at any time.

This is the one bit that differs from Chrome: the Developer Mode toggle is in the BOTTOM-LEFT corner (not the top right) - click it, and 3 new things will appear at the top.

Click Load Unpacked.

Select the directory you unzipped to.

Thats it you can use the new one as normal now.

## Good to know

- Saved result files are plain spreadsheets — open them in Excel or Google Sheets to compare runs.
- A re-opened winner restores the chart for everything that can be set automatically. The one thing TradingView won't let any tool set is plot colours, so those are flagged for you to set by hand if you want (they don't affect results).
- The Organizer is Windows-only.

---

## Credits & License

Built entirely on the original TradingView Assistant by Andrei Kuminov (akumidv). See the included [LICENSE](LICENSE).
