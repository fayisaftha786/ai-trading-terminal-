// Research disclosure: separate EMA20/50 crossover baseline is not the automatic-entry strategy; it is not the live automatic-paper entry rules.
const $ = (id) => document.getElementById(id);
let snapshot = {cex: [], solana: []};
let deferredInstallPrompt = null;
const money = (v) => v == null || !Number.isFinite(Number(v)) ? '—' : '$' + Number(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:6});
const short = (v) => v == null ? '—' : Number(v).toLocaleString(undefined,{maximumFractionDigits:0});
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3000)}
let authMode = null;
let authToken = sessionStorage.getItem('att_cloud_token') || '';
let authPrompt = null;
async function cloudAuthRequired(){
  if(authMode!==null)return authMode;
  const response=await fetch('/api/auth/status',{cache:'no-store'});
  if(!response.ok)throw new Error('Cannot read cloud authentication status');
  const status=await response.json();authMode=!!status.required;return authMode;
}
function showCloudLogin(){
  if(authPrompt)return authPrompt;
  authPrompt=new Promise((resolve,reject)=>{
    const overlay=document.createElement('div');overlay.className='cloud-auth-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','cloudAuthTitle');
    const card=document.createElement('form');card.className='cloud-auth-card';
    const eyebrow=document.createElement('div');eyebrow.className='eyebrow';eyebrow.textContent='PRIVATE CLOUD INSTANCE';
    const title=document.createElement('h2');title.id='cloudAuthTitle';title.textContent='Sign in to AI Trading Terminal';
    const note=document.createElement('p');note.textContent='Use the dashboard username and password configured for your private cloud service. Exchange API keys do not belong here.';
    const userLabel=document.createElement('label');userLabel.textContent='Username';
    const user=document.createElement('input');user.name='username';user.autocomplete='username';user.required=true;user.maxLength=80;user.value='admin';
    const passLabel=document.createElement('label');passLabel.textContent='Password';
    const pass=document.createElement('input');pass.name='password';pass.type='password';pass.autocomplete='current-password';pass.required=true;pass.maxLength=256;
    const error=document.createElement('div');error.className='cloud-auth-error';error.setAttribute('aria-live','polite');
    const submit=document.createElement('button');submit.className='btn primary wide';submit.type='submit';submit.textContent='Sign in securely';
    card.append(eyebrow,title,note,userLabel,user,passLabel,pass,error,submit);overlay.append(card);document.body.append(overlay);
    card.addEventListener('submit',async event=>{
      event.preventDefault();submit.disabled=true;error.textContent='';
      try{
        const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.value.trim(),password:pass.value})});
        const body=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(body.detail||`Sign-in failed (${response.status})`);
        authToken=body.access_token;sessionStorage.setItem('att_cloud_token',authToken);overlay.remove();resolve(authToken);
      }catch(e){error.textContent=e.message;pass.value='';pass.focus();submit.disabled=false;}
    });
    user.focus();
    overlay.addEventListener('keydown',event=>{if(event.key==='Escape')event.preventDefault();});
  }).finally(()=>{authPrompt=null;});
  return authPrompt;
}
async function ensureCloudLogin(){
  if(!(await cloudAuthRequired()))return '';
  if(authToken)return authToken;
  return showCloudLogin();
}
async function api(path, options={}){
  const protectedRequest=path!=='/api/auth/status'&&path!=='/api/auth/login';
  let token=protectedRequest?await ensureCloudLogin():'';
  const send=()=>fetch(path,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...(options.headers||{})}});
  let res=await send();
  if(res.status===401&&protectedRequest&&await cloudAuthRequired()){
    authToken='';sessionStorage.removeItem('att_cloud_token');token=await ensureCloudLogin();res=await send();
  }
  let body={};try{body=await res.json()}catch{}
  if(!res.ok){const error=new Error(body.detail||body.error||`Request failed (${res.status})`);error.status=res.status;throw error}
  return body;
}
function setTag(id,status){const el=$(id);el.textContent=(status||'unknown').toUpperCase();el.className='tag '+(status==='live'?'safe':status==='error'?'bad':'neutral')}
async function loadHealth(){try{const h=await api('/api/health');$('apiStatus').textContent='CLOUD API ONLINE · LIVE LOCKED';$('apiDot').style.background='var(--green)';if(h.live_trading_enabled!==false)throw new Error('Unexpected live state');await loadAutoScanStatus();await loadAutoPaperStatus();await loadTestnet()}catch(e){$('apiStatus').textContent='CLOUD API ERROR';$('apiDot').style.background='var(--red)';toast(e.message)}}
async function loadAutoScanStatus(){const s=await api('/api/automation/scan');$('autoScanBtn').textContent=s.enabled?'● Auto scan ON':'○ Auto scan OFF';$('autoScanBtn').className='btn '+(s.enabled?'primary':'secondary');$('autoScanBtn').title=`Background market refresh every ${s.interval_seconds}s.`}
async function loadAutoPaperStatus(){const s=await api('/api/automation/paper-trading');$('autoTradeBtn').textContent=s.enabled?'● Auto paper ON':'○ Auto paper OFF';$('autoTradeBtn').className='btn '+(s.enabled?'primary':'secondary');$('autoTradeBtn').title='Paper-only automatic CEX entries. No real funds are used.'}
async function loadTestnet(){try{const s=await api('/api/testnet/status');$('testnetBadge').textContent=s.order_execution_enabled?'ORDERS ENABLED':'LOCKED';$('testnetBadge').className='tag '+(s.order_execution_enabled?'warn':'neutral');$('testnetConnection').textContent=s.ready_for_connection_check?'Credentials configured':'Not configured';$('testnetOrderGate').textContent=s.order_execution_enabled?'ON':'OFF';$('testnetMaxOrder').textContent=Number(s.maximum_order_usdt||0).toFixed(2)+' USDT';$('testnetMaxOpen').textContent=String(s.maximum_open_orders??'—');const select=$('testnetSymbol');const symbols=s.allowed_symbols||[];select.innerHTML=symbols.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');if(!symbols.length)select.innerHTML='<option value="">No allowlisted USDT symbols</option>';$('testnetConnectBtn').disabled=!s.ready_for_connection_check;$('testnetSubmitBtn').disabled=!s.order_execution_enabled||!symbols.length;$('testnetOrderMessage').textContent=s.emergency_halted?'Emergency Testnet lock is active. Reconcile all open or unknown orders before reset.':(s.order_execution_enabled?'Testnet order gate is ON. This form cannot reach production.':'Order execution is locked. Configure Testnet credentials and explicitly enable the local Testnet order gate.');$('testnetStopBtn').disabled=!!s.emergency_halted;$('testnetResetBtn').disabled=!s.emergency_halted;const data=await api('/api/testnet/orders?limit=50');renderTestnetOrders(data.orders||[])}catch(e){$('testnetConnection').textContent='Status unavailable';$('testnetOrderMessage').textContent=e.message;$('testnetOrderMessage').classList.add('error')}}
function renderTestnetOrders(orders){const tbody=$('testnetOrderRows');if(!orders.length){tbody.innerHTML='<tr><td colspan="8" class="empty">No Testnet orders submitted.</td></tr>';return}tbody.innerHTML=orders.map(o=>{const active=['OPEN','PARTIALLY_FILLED','UNKNOWN','SUBMITTING'].includes(o.status);const cancel=['OPEN','PARTIALLY_FILLED'].includes(o.status)&&o.exchange_order_id;return `<tr><td><b>${esc(o.symbol)}</b></td><td>${esc(o.side)}</td><td>${Number(o.amount).toPrecision(7)}</td><td>${Number(o.price).toPrecision(8)}</td><td><span class="tag ${o.status==='FILLED'?'safe':active?'warn':o.status==='REJECTED'?'bad':'neutral'}">${esc(o.status)}</span></td><td>${Number(o.filled||0).toPrecision(7)}</td><td>${esc(o.exchange_order_id||'—')}</td><td>${active?`<button class="action-btn" onclick="refreshTestnetOrder('${esc(o.client_order_id)}')">Refresh</button> `:''}${cancel?`<button class="action-btn" onclick="cancelTestnetOrder('${esc(o.client_order_id)}')">Cancel</button>`:''}</td></tr>`}).join('')}
async function checkTestnetConnection(){const b=$('testnetConnectBtn');b.disabled=true;try{const r=await api('/api/testnet/connection-check',{method:'POST'});$('testnetConnection').textContent='CONNECTED · '+Number(r.usdt_free||0).toFixed(2)+' USDT free';toast('Binance Spot Testnet connection verified');await loadTestnet()}catch(e){$('testnetConnection').textContent='Connection failed';$('testnetOrderMessage').textContent=e.message;$('testnetOrderMessage').classList.add('error')}finally{b.disabled=false}}
async function refreshTestnetOrder(clientId){try{const r=await api(`/api/testnet/orders/${encodeURIComponent(clientId)}/refresh`,{method:'POST'});$('testnetOrderMessage').textContent=r.reconciled?'Order status reconciled from Testnet.':(r.message||'Order state is still uncertain. Do not resubmit.');await loadTestnet()}catch(e){$('testnetOrderMessage').textContent=e.message;$('testnetOrderMessage').classList.add('error')}}
async function cancelTestnetOrder(clientId){if(!confirm('Cancel this open Binance Spot Testnet limit order?'))return;try{await api(`/api/testnet/orders/${encodeURIComponent(clientId)}/cancel`,{method:'POST'});toast('Testnet cancellation requested');await loadTestnet()}catch(e){$('testnetOrderMessage').textContent=e.message;$('testnetOrderMessage').classList.add('error')}}
async function stopTestnetOrders(){if(!confirm('Activate a persistent Testnet order lock and cancel open orders recorded by this app?'))return;const b=$('testnetStopBtn');b.disabled=true;try{const result=await api('/api/testnet/kill-switch',{method:'POST'});$('testnetOrderMessage').textContent=`Emergency lock active · canceled ${result.canceled_client_order_ids.length} · unresolved ${result.unresolved_client_order_ids.length}. Inspect Testnet history for unresolved orders.`;await loadTestnet()}catch(e){$('testnetOrderMessage').textContent=e.message;$('testnetOrderMessage').classList.add('error')}finally{b.disabled=false}}
async function resetTestnetOrders(){const confirmation=prompt('Only after checking every open Testnet order in Binance, type exactly: RESET TESTNET ORDER LOCK');if(confirmation!=='RESET TESTNET ORDER LOCK')return;try{await api('/api/testnet/kill-switch/reset',{method:'POST',body:JSON.stringify({confirmation})});toast('Testnet order lock reset');await loadTestnet()}catch(e){$('testnetOrderMessage').textContent=e.message;$('testnetOrderMessage').classList.add('error')}}
async function loadDashboard(){const d=await api('/api/dashboard');const p=d.portfolio;$('equity').textContent=money(p.equity_usd);$('pnl').textContent=money(p.realized_pnl_usd);$('pnl').className='stat-value '+(p.realized_pnl_usd>0?'pnl-positive':p.realized_pnl_usd<0?'pnl-negative':'');$('openCount').textContent=p.open_positions;$('exposure').textContent=money(p.exposure_usd)+' exposure · unrealized '+money(p.unrealized_pnl_usd);fillRisk(d.risk);renderTrades(d.recent_trades||[]);await loadPerformance()}
async function loadPerformance(){const days=Number($('performanceDays')?.value||30);try{const r=await api(`/api/performance?days=${days}`);const m=r.metrics||{};$('perfTrades').textContent=String(m.closed_trades??0);$('perfWinRate').textContent=m.win_rate_pct==null?'—':m.win_rate_pct.toFixed(1)+'%';$('perfProfitFactor').textContent=m.profit_factor==null?(m.profit_factor_status==='no_losses_in_sample'?'No losses yet':'—'):m.profit_factor.toFixed(2);$('perfExpectancy').textContent=money(m.expectancy_usd_per_trade);$('perfNetPnl').textContent=money(m.net_pnl_usd);$('perfNetPnl').className=Number(m.net_pnl_usd)>0?'pnl-positive':Number(m.net_pnl_usd)<0?'pnl-negative':'';$('perfSnapshots').textContent=String(r.equity_snapshot_count??0);$('performanceNote').textContent=`${r.sample_status.replaceAll('_',' ')} · realized max drawdown ${r.all_time_realized_max_drawdown_pct}% · observed marked drawdown ${r.max_observed_marked_drawdown_pct==null?'no snapshot data':r.max_observed_marked_drawdown_pct+'%'} · ${r.interpretation}`;$('exportPerformance').href='/api/performance.csv'}catch(e){$('performanceNote').textContent='Performance report unavailable: '+e.message}}
function fillRisk(r){const f=$('riskForm');Object.entries(r).forEach(([k,v])=>{if(f.elements[k])f.elements[k].value=v})}
function renderTrades(trades){const tbody=$('tradeRows');if(!trades.length){tbody.innerHTML='<tr><td colspan="10" class="empty">No paper trades yet.</td></tr>';return}tbody.innerHTML=trades.map(t=>`<tr><td>#${t.id}</td><td>${t.engine==='solana'?'SOLANA':'MULTI'}</td><td><b>${esc(t.symbol)}</b><span class="token-sub">${esc(t.name||'')}</span></td><td>${money(t.entry_price)}</td><td>${Number(t.quantity).toPrecision(5)}</td><td>${money(t.stop_loss)}</td><td>${money(t.take_profit)}</td><td><span class="tag ${t.status==='OPEN'?'warn':'neutral'}">${t.status}</span></td><td class="${Number(t.pnl_usd)>0?'pnl-positive':Number(t.pnl_usd)<0?'pnl-negative':''}">${t.pnl_usd==null?'—':money(t.pnl_usd)}</td><td>${t.status==='OPEN'?`<button class="action-btn" onclick="closeTrade(${t.id},${t.entry_price})">Close @ entry</button>`:'—'}</td></tr>`).join('')}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renderCex(result){snapshot.cex=result.markets||[];setTag('cexStatus',result.status);$('cexCount').textContent=snapshot.cex.filter(x=>x.status==='live').length;$('cexExchange').textContent=(result.exchange||'—').toUpperCase();const tb=$('cexRows');if(!snapshot.cex.length){tb.innerHTML=`<tr><td colspan="5" class="empty">${esc(result.error||'No market data returned')}</td></tr>`;return}tb.innerHTML=snapshot.cex.map((m,i)=>`<tr><td><b>${esc(m.symbol)}</b></td><td>${money(m.last)}</td><td class="${Number(m.percentage)>0?'pnl-positive':Number(m.percentage)<0?'pnl-negative':''}">${m.percentage==null?'—':Number(m.percentage).toFixed(2)+'%'}</td><td>${esc(result.exchange||'CCXT')}</td><td><button class="action-btn" ${m.status!=='live'?'disabled':''} onclick="selectCex(${i})">Paper</button> <button class="action-btn" ${m.status!=='live'?'disabled':''} onclick="analyzeCex(${i})">Analyze</button></td></tr>`).join('')}
function renderSol(result){snapshot.solana=result.tokens||[];setTag('solStatus',result.status);$('solCount').textContent=snapshot.solana.length;$('solEligible').textContent=snapshot.solana.filter(t=>t.screening?.eligible_for_paper).length;const tb=$('solRows');if(!snapshot.solana.length){tb.innerHTML=`<tr><td colspan="5" class="empty">${esc(result.error||'No recent token data returned')}</td></tr>`;return}tb.innerHTML=snapshot.solana.slice(0,30).map((t,i)=>{const ok=!!t.screening?.eligible_for_paper;return `<tr><td><span class="token-name">${esc(t.symbol)}</span><span class="token-sub">${esc(t.name)} · ${esc((t.mint||'').slice(0,8))}…</span></td><td>${money(t.liquidity_usd)}</td><td class="score">${t.screening?.score??0}/100</td><td><span class="tag ${ok?'safe':'bad'}">${ok?'SCREENED':'REJECT'}</span></td><td><button class="action-btn" ${!ok||!t.price_usd?'disabled':''} onclick="selectSol(${i})">Paper</button></td></tr>`}).join('')}
async function scan(){const b=$('scanBtn');b.disabled=true;b.textContent='Scanning…';try{const data=await api('/api/scan',{method:'POST'});renderCex(data.cex);renderSol(data.solana);$('scanTime').textContent='Last scan: '+new Date().toLocaleTimeString();$('symbol').innerHTML='<option value="">Choose scanned market</option>';const markets=[...snapshot.cex.filter(m=>m.status==='live').map(m=>({engine:'multi_crypto',symbol:m.symbol,name:m.symbol,price:m.last})),...snapshot.solana.filter(t=>t.screening?.eligible_for_paper&&t.price_usd).map(t=>({engine:'solana',symbol:t.mint,name:t.name,price:t.price_usd,mint:t.mint,display:`${t.symbol} · ${t.name}`}))];markets.forEach((m,i)=>{const opt=document.createElement('option');opt.value=String(i);opt.textContent=m.display||m.symbol;opt.dataset.engine=m.engine;opt.dataset.symbol=m.symbol;opt.dataset.name=m.name;opt.dataset.price=m.price;opt.dataset.mint=m.mint||'';$('symbol').appendChild(opt)});snapshot.options=markets;refreshSymbolOptions($('engine').value);await loadDashboard();const opened=data.auto_paper?.paper_entries?.length||0;toast(opened?`Paper auto-entry opened: ${data.auto_paper.paper_entries[0].symbol}`:'Market scan complete · no paper entry qualified')}catch(e){toast('Scan failed: '+e.message)}finally{b.disabled=false;b.textContent='↻ Scan markets'}}
function refreshSymbolOptions(engine){const select=$('symbol');const list=(snapshot.options||[]).filter(m=>m.engine===engine);select.innerHTML='<option value="">Choose scanned market</option>';list.forEach(m=>{const opt=document.createElement('option');opt.value=String(snapshot.options.indexOf(m));opt.textContent=m.display||m.symbol;opt.dataset.engine=m.engine;opt.dataset.symbol=m.symbol;opt.dataset.name=m.name;opt.dataset.price=m.price;opt.dataset.mint=m.mint||'';select.appendChild(opt)});if(list.length){select.value=String(snapshot.options.indexOf(list[0]));const first=list[0];setOrder(first.engine,first.symbol,first.name,first.price,first.mint||'')}}
function selectCex(i){const item=snapshot.cex[i];setOrder('multi_crypto',item.symbol,item.symbol,item.last,'')}
function selectSol(i){const item=snapshot.solana[i];setOrder('solana',item.mint,item.name,item.price_usd,item.mint)}
function setOrder(engine,symbol,name,price,mint){$('engine').value=engine;let opt=[...$('symbol').options].find(o=>o.dataset.symbol===symbol);if(opt)$('symbol').value=opt.value;$('price').value=price??'';$('paperForm').dataset.name=name||symbol;$('paperForm').dataset.mint=mint||'';$('paperForm').dataset.symbol=symbol;document.getElementById('paper').scrollIntoView({behavior:'smooth',block:'center'})}
$('symbol').addEventListener('change',()=>{const opt=$('symbol').selectedOptions[0];if(!opt?.dataset.symbol)return;setOrder(opt.dataset.engine,opt.dataset.symbol,opt.dataset.name,opt.dataset.price,opt.dataset.mint)})
$('engine').addEventListener('change',()=>refreshSymbolOptions($('engine').value))
$('paperForm').addEventListener('submit',async e=>{e.preventDefault();const msg=$('orderMessage');msg.textContent='';msg.className='form-message';const symbol=$('paperForm').dataset.symbol||$('symbol').selectedOptions[0]?.dataset.symbol;if(!symbol){msg.textContent='Choose a market from the latest scan.';msg.classList.add('error');return}const payload={engine:$('engine').value,symbol,name:$('paperForm').dataset.name||symbol,mint:$('paperForm').dataset.mint||'',price_usd:Number($('price').value),requested_notional_usd:$('notional').value?Number($('notional').value):null};try{const d=await api('/api/paper/orders',{method:'POST',body:JSON.stringify(payload)});msg.textContent=`Paper position #${d.trade.id} opened. No real funds moved.`;await loadDashboard();toast('Simulated paper position opened')}catch(err){msg.textContent=err.message;msg.classList.add('error')}})
$('testnetConnectBtn').addEventListener('click',checkTestnetConnection);$('testnetRefreshBtn').addEventListener('click',loadTestnet);$('testnetStopBtn').addEventListener('click',stopTestnetOrders);$('testnetResetBtn').addEventListener('click',resetTestnetOrders);
$('testnetOrderForm').addEventListener('submit',async e=>{e.preventDefault();const form=$('testnetOrderForm');const msg=$('testnetOrderMessage');const button=$('testnetSubmitBtn');msg.className='form-message';msg.textContent='Submitting isolated Testnet LIMIT order…';button.disabled=true;const key=form.dataset.idempotencyKey||(globalThis.crypto?.randomUUID?globalThis.crypto.randomUUID():`att-${Date.now()}-${Math.random().toString(36).slice(2,12)}`);form.dataset.idempotencyKey=key;const payload={idempotency_key:key,symbol:$('testnetSymbol').value,side:$('testnetSide').value,amount:Number($('testnetAmount').value),price:Number($('testnetPrice').value)};try{const result=await api('/api/testnet/orders',{method:'POST',body:JSON.stringify(payload)});const order=result.order||{};msg.textContent=`${result.replayed?'Existing':'Submitted'} Testnet ${order.side||payload.side.toUpperCase()} ${order.symbol||payload.symbol} · ${order.status||'UNKNOWN'} · client ID ${order.client_order_id||'—'}`;form.dataset.idempotencyKey='';await loadTestnet();toast('Testnet order request recorded')}catch(err){msg.textContent=err.message;msg.classList.add('error');if(err.status===422)form.dataset.idempotencyKey='';/* 502/unknown keeps the same key: never bypass idempotency on retry */}finally{button.disabled=!$('testnetBadge').textContent.includes('ORDERS ENABLED')}});
$('riskForm').addEventListener('submit',async e=>{e.preventDefault();const form=new FormData(e.currentTarget);const payload=Object.fromEntries(form.entries());for(const k of Object.keys(payload))payload[k]=Number(payload[k]);try{const d=await api('/api/risk',{method:'PUT',body:JSON.stringify(payload)});fillRisk(d.risk);$('riskMessage').textContent='Risk controls saved on the server.';toast('Risk controls updated')}catch(err){$('riskMessage').textContent=err.message;$('riskMessage').classList.add('error')}})
async function closeTrade(id,price){const mark=prompt('Enter a reference exit price (USD). This remains a paper simulation:',String(price));if(mark===null)return;try{await api(`/api/paper/close/${id}?price_usd=${encodeURIComponent(mark)}`,{method:'POST'});await loadDashboard();toast('Paper position closed')}catch(e){toast(e.message)}}
async function analyzeCex(i) {
  const market = snapshot.cex[i];
  const box = $('analysisResults');
  box.textContent = `Loading ${market.symbol} candles, multi-timeframe indicators and walk-forward validation…`;
  try {
    const result = await api(`/api/strategies/multi/${encodeURIComponent(market.symbol)}?timeframe=1h&limit=1000`);
    const analysis = result.analysis || {};
    const higher = result.higher_timeframe || {};
    const higherRows = higher.candles || [];
    const body = {
      candles: result.candles || [],
      higher_timeframe_candles: higherRows,
      timeframe: '1h'
    };
    const dataQualityOk = result.data_quality?.contiguous_closed_candles === true && result.data_quality?.sufficient_indicator_history === true;
    const primaryIntegrity = result.data_quality?.primary_integrity || {};
    const higherIntegrity = result.data_quality?.higher_timeframe_integrity || {};
    const integrityDetails = `1h: ${primaryIntegrity.valid_unique_candles ?? 0} valid · ${primaryIntegrity.duplicate_timestamps ?? 0} duplicates · ${primaryIntegrity.off_grid_timestamps ?? 0} off-grid · ${primaryIntegrity.missing_intervals ?? 0} gaps · ${primaryIntegrity.invalid_rows ?? 0} invalid; 4h: ${higherIntegrity.valid_unique_candles ?? 0} valid · ${higherIntegrity.duplicate_timestamps ?? 0} duplicates · ${higherIntegrity.off_grid_timestamps ?? 0} off-grid · ${higherIntegrity.missing_intervals ?? 0} gaps · ${higherIntegrity.invalid_rows ?? 0} invalid.`;
    let strategyTest = null;
    let strategyWalkForward = null;
    let strategyResearchError = '';
    let emaBaseline = null;

    if (dataQualityOk && body.candles.length >= 200 && higherRows.length >= 150) {
      const [backtestResult, walkForwardResult] = await Promise.allSettled([
        api('/api/backtest/strategy', { method: 'POST', body: JSON.stringify(body) }),
        api('/api/research/strategy-walk-forward', {
          method: 'POST', body: JSON.stringify({ ...body, folds: 3 })
        })
      ]);
      if (backtestResult.status === 'fulfilled') strategyTest = backtestResult.value;
      else strategyResearchError = backtestResult.reason?.message || 'Strategy backtest unavailable';
      if (walkForwardResult.status === 'fulfilled') strategyWalkForward = walkForwardResult.value;
      else strategyResearchError = [strategyResearchError, walkForwardResult.reason?.message].filter(Boolean).join(' · ');

      try {
        // Keep the EMA crossover as a separate comparison baseline only.
        emaBaseline = await api('/api/backtest', {
          method: 'POST',
          body: JSON.stringify({ candles: body.candles, fee_bps: 10, slippage_bps: 10 })
        });
      } catch (_) {
        emaBaseline = null;
      }
    }

    const strategyMetrics = strategyTest
      ? `<span>Strategy test net <b class="${strategyTest.net_return_pct >= 0 ? 'pnl-positive' : 'pnl-negative'}">${strategyTest.net_return_pct}%</b></span>
         <span>Strategy max DD <b class="pnl-negative">${strategyTest.max_drawdown_pct}%</b></span>
         <span>Strategy PF <b>${strategyTest.profit_factor ?? strategyTest.profit_factor_status ?? '—'}</b></span>
         <span>Strategy trades <b>${strategyTest.closed_trades}</b></span>
         <span>Signal candidates <b>${strategyTest.eligible_strategy_signals}</b></span>
         <span>Strategy expectancy <b>${money(strategyTest.expectancy_usd_per_trade)}</b></span>
         <span>Excess vs exposure-matched hold <b>${strategyTest.excess_return_vs_benchmark_pct ?? '—'}%</b></span>
         <span>Saved risk / stop / target <b>${strategyTest.risk_assumptions?.risk_per_trade_pct ?? '—'}% / ${strategyTest.risk_assumptions?.stop_loss_pct ?? '—'}% / ${strategyTest.risk_assumptions?.take_profit_pct ?? '—'}%</b></span>
         <span>Costs / side <b>${strategyTest.cost_assumptions?.fee_bps_per_side ?? '—'} fee + ${strategyTest.cost_assumptions?.slippage_bps_per_side ?? '—'} slip bps</b></span>`
      : `<span>Strategy test <b>${esc(strategyResearchError || (!dataQualityOk ? 'Blocked: candle integrity/history requirements failed' : 'Not enough synchronized 1h/4h history'))}</b></span>`;

    const walkForwardText = Array.isArray(strategyWalkForward?.cost_stress)
      ? `Signal walk-forward: ${strategyWalkForward.positive_folds}/${strategyWalkForward.total_folds} positive windows · mean ${strategyWalkForward.mean_fold_return_pct}% · max fold drawdown ${strategyWalkForward.worst_fold_drawdown_pct}%. 1.5x / 2x cost stress: ${strategyWalkForward.cost_stress.filter(x => x.cost_multiplier > 1).map(x => `${x.cost_multiplier}x ${x.positive_folds}/${x.total_folds} positive`).join(' · ')}.`
      : (strategyResearchError || (!dataQualityOk ? 'Backtest blocked because closed candle history failed integrity gates.' : 'Signal walk-forward unavailable: insufficient aligned history.'));

    box.innerHTML = `
      <div class="analysis-title">${esc(market.symbol)} · Wilder indicator + multi-timeframe analysis</div>
      <div class="analysis-metrics">
        <span>Decision <b>${esc(analysis.signal || 'HOLD')}</b></span>
        <span>Score <b>${analysis.score ?? '—'}/100</b></span>
        <span>Regime <b>${esc(analysis.regime || '—')}</b></span>
        <span>Higher TF <b>${esc(higher.analysis?.regime || '—')}</b></span>
        <span>Confluence <b>${esc(result.timeframe_confluence || '—')}</b></span>
        <span>Candle integrity <b>${dataQualityOk ? 'CLEAN / CONTIGUOUS' : 'BLOCKED'}</b></span>
        <span>Momentum <b>${esc(analysis.momentum_state || '—')}</b></span>
        <span>Momentum score <b>${analysis.momentum_score ?? '—'}/100</b></span>
        <span>ROC 5 / 10 / 20 <b>${analysis.roc_5_pct ?? '—'}% / ${analysis.roc_10_pct ?? '—'}% / ${analysis.roc_20_pct ?? '—'}%</b></span>
        <span>MACD / Signal <b>${analysis.macd_line ?? '—'} / ${analysis.macd_signal ?? '—'}</b></span>
        <span>MACD histogram <b>${analysis.macd_histogram ?? '—'} (${analysis.macd_histogram_slope ?? '—'} Δ)</b></span>
        <span>Wilder RSI14 <b>${analysis.rsi14 ?? '—'}</b></span>
        <span>ATR % <b>${analysis.atr_pct ?? '—'}</b></span>
        <span>ADX14 <b>${analysis.adx14 ?? '—'}</b></span>
        <span>+DI / -DI <b>${analysis.plus_di14 ?? '—'} / ${analysis.minus_di14 ?? '—'}</b></span>
        <span>EMA20 slope % <b>${analysis.ema20_slope_pct ?? '—'}</b></span>
        <span>Volume ratio <b>${analysis.volume_ratio_20 ?? '—'}</b></span>
        <span>Breakout <b>${esc(analysis.breakout_20 || '—')}</b></span>
        ${strategyMetrics}
        ${emaBaseline ? `<span>EMA-only baseline <b class="${emaBaseline.net_return_pct >= 0 ? 'pnl-positive' : 'pnl-negative'}">${emaBaseline.net_return_pct}%</b></span><span>EMA baseline DD <b class="pnl-negative">${emaBaseline.max_drawdown_pct}%</b></span>` : ''}
      </div>
      <div class="analysis-reason">${esc(integrityDetails)}</div>
      <div class="analysis-reason"><b>Momentum read:</b> ${(analysis.momentum_reasons || []).map(esc).join(' · ') || 'Not enough momentum data'}.</div>
      <div class="analysis-reason">${(analysis.reasons || []).map(esc).join(' · ') || esc(analysis.reason || 'No strong setup')}</div>
      <div class="analysis-reason">${esc(walkForwardText)}</div>
      <div class="analysis-reason">Research limits: the strategy walk-forward uses the same primary signal and closed 4h trend confirmation and the saved server risk profile. Historical candles cannot replay historical spread, top-book depth, live freshness, queue position or real fills. The EMA-only baseline is separate, uses fixed 10 bps fee and 10 bps slippage per side, and is not the live automatic-paper entry rules. Cost stress is an assumption, not a forecast; historical results do not guarantee future performance.</div>`;
  } catch (error) {
    box.textContent = `Analysis unavailable: ${error.message}`;
  }
}
window.closeTrade=closeTrade;window.selectCex=selectCex;window.selectSol=selectSol;window.analyzeCex=analyzeCex;window.refreshTestnetOrder=refreshTestnetOrder;window.cancelTestnetOrder=cancelTestnetOrder;

$('exportPerformance').addEventListener('click',async event=>{
  event.preventDefault();
  try{
    const token=await ensureCloudLogin();
    const response=await fetch('/api/performance.csv',{headers:token?{Authorization:`Bearer ${token}`}:{}});
    if(!response.ok)throw new Error(`CSV export failed (${response.status})`);
    const blob=await response.blob();const objectUrl=URL.createObjectURL(blob);const link=document.createElement('a');link.href=objectUrl;link.download='ai-trading-terminal-performance.csv';document.body.append(link);link.click();link.remove();URL.revokeObjectURL(objectUrl);
  }catch(error){toast(error.message)}
});
$('scanBtn').addEventListener('click',scan);$('autoTradeBtn').addEventListener('click',async()=>{const turningOn=$('autoTradeBtn').textContent.includes('OFF');if(turningOn&&!confirm('Enable automatic PAPER trading only? It will never send real orders.'))return;try{const status=await api('/api/automation/paper-trading',{method:'PUT',body:JSON.stringify({enabled:turningOn})});$('autoTradeBtn').textContent=status.enabled?'● Auto paper ON':'○ Auto paper OFF';$('autoTradeBtn').className='btn '+(status.enabled?'primary':'secondary');toast(status.enabled?'Automatic paper trading enabled. First cycle starts on next scan.':'Automatic paper trading disabled')}catch(e){toast(e.message)}});$('killSwitchBtn').addEventListener('click',async()=>{try{const stopped=await api('/api/automation/kill-switch',{method:'POST'});await loadAutoScanStatus();await loadAutoPaperStatus();await loadTestnet();toast(stopped.exit_monitoring_kept_on?'New paper entries OFF · open-position exit monitoring remains ON':'Emergency stop activated · no paper entries will be opened')}catch(e){toast(e.message)}});$('autoScanBtn').addEventListener('click',async()=>{try{const status=await api('/api/automation/scan',{method:'PUT',body:JSON.stringify({enabled:$('autoScanBtn').textContent.includes('OFF')})});$('autoScanBtn').textContent=status.enabled?'● Auto scan ON':'○ Auto scan OFF';$('autoScanBtn').className='btn '+(status.enabled?'primary':'secondary');toast(status.enabled?`Background scan enabled · every ${status.interval_seconds}s`:'Background scan disabled')}catch(e){toast(e.message)}});$('refreshLedger').addEventListener('click',async()=>{try{await loadDashboard();toast('Ledger refreshed')}catch(e){toast(e.message)}});$('refreshPerformance').addEventListener('click',loadPerformance);$('performanceDays').addEventListener('change',loadPerformance);
(async()=>{await loadHealth();try{await loadDashboard()}catch(e){toast(e.message)} })();

// Installable PWA shell. Market data APIs are never cached by the service worker.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const button = $('installBtn');
  if (button) button.hidden = false;
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const button = $('installBtn');
  if (button) button.hidden = true;
  toast('AI Trading Terminal installed');
});
const installButton = $('installBtn');
if (installButton) installButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    toast('Use your browser menu → Add to Home screen / Install app');
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.hidden = true;
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('PWA service worker registration failed:', error);
    });
  });
}


// Specialist-worker dashboard. All worker requests are read-only diagnostics.
function workerTag(status){
  const label=String(status||'unknown').replaceAll('_',' ').toUpperCase();
  const tone=status==='complete'?'safe':status==='blocked'?'warn':status==='error'?'bad':'neutral';
  return `<span class="tag ${tone}">${esc(label)}</span>`;
}
function renderWorkerCards(workers){
  const grid=$('workerGrid');
  if(!Array.isArray(workers)||!workers.length){
    grid.innerHTML='<div class="worker-empty">No worker registry data is available.</div>';
    return;
  }
  grid.innerHTML=workers.map(worker=>{
    const result=worker.result||{};
    const findings=Array.isArray(result.findings)?result.findings.slice(0,3):[];
    const metrics=Object.entries(result.metrics||{})
      .filter(([,value])=>value!==null&&['string','number','boolean'].includes(typeof value))
      .slice(0,4);
    const summary=result.summary||worker.description||'Waiting for a run.';
    return `<article class="worker-card">
      <div class="worker-card-head"><div><h3>${esc(worker.name)}</h3><div class="worker-id">${esc(worker.id)}</div></div>${workerTag(worker.status||worker.availability)}</div>
      <p>${esc(summary)}</p>
      ${findings.length?`<ul class="worker-findings">${findings.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}
      ${metrics.length?`<div class="worker-metric-list">${metrics.map(([key,value])=>`<span>${esc(key.replaceAll('_',' '))}: ${esc(String(value))}</span>`).join('')}</div>`:''}
      <div class="worker-meta"><span>${worker.attempts?esc(String(worker.attempts))+' attempt(s)':'READ ONLY'}</span><span>${worker.duration_ms!=null?esc(String(worker.duration_ms))+' ms':esc(worker.execution_mode||'specialist')}</span></div>
    </article>`;
  }).join('');
}
async function loadWorkerRegistry(){
  try{
    const registry=await api('/api/workers');
    $('workerTotal').textContent=String(registry.worker_count??12);
    $('workerReady').textContent=String(registry.ready_count??'—');
    $('workerUnavailable').textContent=String(registry.unavailable_count??'—');
    $('workerSystemTag').textContent='REGISTRY READY';
    $('workerSystemTag').className='tag safe';
    $('workerGrid').innerHTML='<div class="worker-empty">Registry loaded. Run the specialist team to inspect a market.</div>';
    renderWorkerCards((registry.workers||[]).map(worker=>({...worker,status:worker.health_status||worker.availability,
      duration_ms:worker.last_duration_ms,
      result:{summary:worker.last_summary||worker.description,findings:worker.id==='news_sentiment'?['No provider configured; no sentiment score is fabricated.']:[]}})));
    return registry;
  }catch(error){
    $('workerSystemTag').textContent='REGISTRY ERROR';
    $('workerSystemTag').className='tag bad';
    $('workerNote').textContent='Worker registry could not be loaded: '+error.message;
    return null;
  }
}
async function runSpecialistWorkers(){
  const button=$('runWorkersBtn');
  const symbol=$('workerSymbol').value;
  const timeframe=$('workerTimeframe').value;
  button.disabled=true;
  button.textContent='Workers running…';
  $('workerSystemTag').textContent='ANALYZING';
  $('workerSystemTag').className='tag warn';
  $('workerNote').textContent=`Fetching one closed-candle snapshot for ${symbol} (${timeframe}); specialist workers are analyzing it in parallel.`;
  try{
    const result=await api(`/api/workers/analyze/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}&limit=300`);
    $('workerTotal').textContent=String(result.worker_count??12);
    $('workerCompleted').textContent=String(result.counts?.complete??0);
    $('workerUnavailable').textContent=String((result.counts?.unavailable??0)+(result.counts?.blocked??0)+(result.counts?.error??0));
    $('workerDuration').textContent=Number(result.duration_ms||0).toFixed(0)+' ms';
    $('workerSystemTag').textContent=String(result.status||'unknown').replaceAll('_',' ').toUpperCase();
    $('workerSystemTag').className='tag '+(result.status==='complete'?'safe':result.status==='failed'?'bad':'warn');
    renderWorkerCards(result.workers||[]);
    $('workerNote').textContent=`Run ${result.run_id} · ${symbol} · ${timeframe} · max parallel workers: ${result.max_concurrency}. ${result.supervisor_note||''} News sentiment is unavailable without a connected provider. This run did not execute any order.`;
  }catch(error){
    $('workerSystemTag').textContent='RUN FAILED';
    $('workerSystemTag').className='tag bad';
    $('workerNote').textContent='Worker analysis failed: '+error.message;
    toast(error.message);
  }finally{
    button.disabled=false;
    button.textContent='▶ Run 12 workers';
  }
}
$('runWorkersBtn')?.addEventListener('click',runSpecialistWorkers);
$('refreshWorkersBtn')?.addEventListener('click',loadWorkerRegistry);
(async()=>{await loadWorkerRegistry()})();
