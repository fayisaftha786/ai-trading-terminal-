# പൂജ്യം ബജറ്റിൽ AI Trading Terminal ഉപയോഗിക്കുന്ന വിധം

ഈ രേഖയുടെ ലക്ഷ്യം: പണമടയ്ക്കുന്ന cloud hosting, paid database, subscription എന്നിവ ഇല്ലാതെ നിലവിലുള്ള ആപ്പിന്റെ സുരക്ഷിതമായ ഭാഗങ്ങൾ മാത്രം ഉപയോഗിക്കുക.

## സൗജന്യമായി ഇപ്പോൾ ഉപയോഗിക്കാവുന്നത്

1. Android APK / PWA ഉപയോഗിച്ച് dashboard തുറക്കുക.
2. PAPER mode-ൽ മാത്രം virtual balance ഉപയോഗിച്ച് പരീക്ഷിക്കുക.
3. Public market data ലഭ്യമാണെങ്കിൽ market analysis, indicators, backtest, walk-forward reports എന്നിവ പരിശോധിക്കുക.
4. GitHub Actions-ൽ automated tests, ARM64 container build എന്നിവ സൗജന്യ quota ലഭ്യമായ പരിധിയിൽ നടത്തുക.
5. Source code, test reports, release artifacts GitHub-ൽ സൂക്ഷിക്കുക.

## പൂജ്യം ബജറ്റിൽ ലഭിക്കാത്തത്

- സ്ഥിരമായി 24/7 പ്രവർത്തിക്കുന്ന Python scheduler/worker.
- ഉറപ്പുള്ള persistent SQLite storage ഉള്ള public cloud backend.
- ഫോണിൽ app അടച്ചിട്ടാലും തുടർന്നുകൊണ്ടിരിക്കുന്ന automatic trading.
- യഥാർത്ഥ Binance Spot Testnet authenticated OPOCO lifecycle പരിശോധന, API credentials ഇല്ലാതെ.
- Production LIVE trading.

GitHub Pages പോലുള്ള static hosting frontend ഫയലുകൾ മാത്രം നൽകും; ഈ Python FastAPI backend, scheduler, SQLite ledger എന്നിവ പ്രവർത്തിപ്പിക്കില്ല. GitHub Actions CI ഒരു സ്ഥിരമായി പ്രവർത്തിക്കുന്ന trading server അല്ല. Free hosting-ൽ sleep/restart/storage പരിധികൾ ഉള്ളതിനാൽ അതിനെ 24/7 execution ആയി കണക്കാക്കരുത്.

## സുരക്ഷാ ക്രമീകരണം

- PAPER mode ആണ് default ശുപാർശ.
- Binance Spot Testnet auto-entry OFF ആയി തന്നെ വയ്ക്കുക, പ്രത്യേകിച്ച് authenticated end-to-end test പൂർത്തിയാകുന്നതുവരെ.
- Production LIVE trading hard-disabled ആണ്; അതിനെ unlock ചെയ്യാനുള്ള workaround ശ്രമിക്കരുത്.
- API keys ഒരിക്കലും chat, GitHub source, APK, public logs എന്നിവയിൽ ഇടരുത്.
- പിന്നീട് Testnet പരിശോധിക്കുമ്പോൾ മാത്രം provider-ന്റെ private secret store-ൽ credentials നൽകുക.
- ഒരു free service ഉറക്കത്തിലേക്ക് പോകുകയോ restart ആകുകയോ ചെയ്താൽ background scheduler പ്രവർത്തിക്കില്ലെന്ന് കരുതുക.

## പിന്നീട് ബജറ്റ് ലഭിച്ചാൽ

ആദ്യം ഒരു കുറഞ്ഞ ചെലവുള്ള single-instance backend + persistent disk ഉപയോഗിച്ച് health check, login, database persistence, restart recovery എന്നിവ പരിശോധിക്കുക. തുടർന്ന് Binance Spot Testnet-ൽ ചെറിയ test-only workflow നടത്തുക. എല്ലാ checks-ും വിജയിച്ചാലും production LIVE trading സ്വയം enable ചെയ്യരുത്.

## നിലവിലെ സത്യാവസ്ഥ

CI വിജയിക്കുന്നത് source code-ന്റെ automated checks വിജയിച്ചു എന്നർത്ഥം മാത്രമാണ്. അത് cloud deployment, authenticated exchange test, profitability, അല്ലെങ്കിൽ 24/7 uptime തെളിയിക്കുന്നില്ല.
