package app.aitradingterminal;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.ContentValues;
import android.content.Context;
import org.json.JSONArray;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * On-device paper terminal with a persistent virtual-cash ledger.
 * Public market data only; no exchange credentials and no real order execution.
 * Risk exits are evaluated on refreshed, fully closed 1h candles while the app runs.
 */
public final class LocalPaperActivity extends Activity {
    private static final int BG=0xFF080D1A, CARD=0xFF111A2E, TEXT=0xFFF7FAFF, MUTED=0xFFA2B0CA, ACCENT=0xFF8B7CFF;
    private static final long HOUR_MS=60L*60L*1000L;
    private static final long MAX_CANDLE_AGE_MS=2L*HOUR_MS;
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private LocalDb db;
    private LinearLayout body;
    private TextView status, price, wallet, analysis, history;
    private Button openButton, closeButton, stopButton;
    private volatile List<Candle> candles=new ArrayList<>();
    private volatile double lastPrice=0;
    private volatile boolean marketLive=false;
    private volatile boolean stopped=false;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        db=new LocalDb(this);
        stopped=db.isHalted();
        ScrollView scroll=new ScrollView(this);
        body=new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(18),dp(22),dp(18),dp(28)); body.setBackgroundColor(BG);
        scroll.addView(body);
        TextView title=label("AI TRADING TERMINAL",24,true,TEXT); body.addView(title);
        body.addView(label("ON-DEVICE MODE · PAPER ONLY · NO HOSTING",11,true,ACCENT));
        status=label("Local engine ready. Fetch market data to begin.",13,false,MUTED); body.addView(status);
        price=label("BTC/USDT  —",22,true,TEXT); body.addView(card(price));
        wallet=label("",14,true,TEXT); body.addView(card(wallet));
        Button refresh=button("REFRESH MARKET + RUN 12 DIAGNOSTICS"); body.addView(refresh);
        refresh.setOnClickListener(v->refreshMarket());
        openButton=button("OPEN PAPER POSITION · $100"); body.addView(openButton);
        openButton.setOnClickListener(v->openPaper());
        closeButton=button("CLOSE PAPER POSITION"); body.addView(closeButton);
        closeButton.setOnClickListener(v->closePaper());
        stopButton=button(stopped?"RESUME PAPER ENTRIES":"EMERGENCY STOP NEW ENTRIES"); body.addView(stopButton);
        stopButton.setOnClickListener(v->{
            stopped=!stopped;
            db.setHalted(stopped);
            stopButton.setText(stopped?"RESUME PAPER ENTRIES":"EMERGENCY STOP NEW ENTRIES");
            status.setText(stopped?"Emergency stop ON — new entries blocked; existing risk exits remain active.":"Emergency stop OFF — paper entries may be opened when data is fresh.");
            updateWallet();
            updateControls();
        });
        body.addView(label("PAPER ASSUMPTIONS",12,true,ACCENT));
        body.addView(card(label("$1,000 starting virtual cash · $100 fixed position · 0.10% fee per side · 0.05% slippage per fill · 2% stop-loss · 4% take-profit. Costs are estimates, not exchange fills.",12,false,MUTED)));
        history=label("No paper trades yet.",12,false,TEXT); body.addView(card(history));
        analysis=label("12-worker diagnostics will appear here.\nNews sentiment is unavailable without a connected provider.",13,false,TEXT);
        body.addView(card(analysis));
        Button back=button("BACK TO CONNECTION SCREEN"); body.addView(back); back.setOnClickListener(v->finish());
        setContentView(scroll);
        updateWallet();
        updateControls();
        refreshMarket();
    }

    private void refreshMarket() {
        marketLive=false;
        status.setText("Fetching public BTC/USDT closed candles… New entries are paused until fresh data is verified.");
        updateControls();
        io.execute(()->{
            try {
                List<Candle> loaded=fetchCandles();
                Candle latest=loaded.get(loaded.size()-1);
                candles=loaded; lastPrice=latest.close;
                db.cache(loaded);
                String automaticExit=db.evaluateExits(loaded);
                List<String> results=analyze(loaded);
                marketLive=true;
                runOnUiThread(()->{
                    price.setText(String.format(Locale.US,"BTC/USDT  $%,.2f",lastPrice));
                    status.setText("LIVE CLOSED-CANDLE DATA · "+loaded.size()+" candles · newest close "+ageText(System.currentTimeMillis()-latest.closeTime));
                    analysis.setText(String.join("\n\n",results));
                    if(automaticExit!=null) toast("Paper "+automaticExit+" executed from a closed candle");
                    updateWallet();
                    updateControls();
                });
            } catch(Exception ex) {
                marketLive=false;
                List<Candle> cached=db.load();
                if(!cached.isEmpty()) {
                    candles=cached; lastPrice=cached.get(cached.size()-1).close;
                    long age=System.currentTimeMillis()-cached.get(cached.size()-1).closeTime;
                    runOnUiThread(()->{
                        price.setText(String.format(Locale.US,"BTC/USDT  $%,.2f (CACHED)",lastPrice));
                        status.setText("NETWORK / DATA CHECK FAILED — cached mark age "+ageText(age)+". New entries and automatic exits are paused. "+ex.getMessage());
                        analysis.setText(String.join("\n\n",analyze(cached)));
                        updateWallet();
                        updateControls();
                    });
                } else runOnUiThread(()->{
                    status.setText("Market data unavailable and no timestamped cache exists: "+ex.getMessage());
                    updateWallet();
                    updateControls();
                });
            }
        });
    }

    private List<Candle> fetchCandles() throws Exception {
        URL url=new URL("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200");
        HttpURLConnection c=(HttpURLConnection)url.openConnection();
        c.setConnectTimeout(9000); c.setReadTimeout(12000); c.setRequestMethod("GET"); c.setRequestProperty("Accept","application/json");
        try {
            int code=c.getResponseCode(); if(code!=200) throw new IllegalStateException("Market provider HTTP "+code);
            StringBuilder s=new StringBuilder();
            try(BufferedReader r=new BufferedReader(new InputStreamReader(c.getInputStream()))) {String line;while((line=r.readLine())!=null)s.append(line);}
            JSONArray arr=new JSONArray(s.toString()); List<Candle> out=new ArrayList<>();
            long now=System.currentTimeMillis(), previousOpen=Long.MIN_VALUE;
            for(int i=0;i<arr.length();i++) {
                JSONArray x=arr.getJSONArray(i);
                long openTime=x.getLong(0), closeTime=x.getLong(6);
                if(closeTime>=now) continue; // ignore the currently forming candle
                double o=x.getDouble(1),h=x.getDouble(2),lo=x.getDouble(3),cl=x.getDouble(4),vol=x.getDouble(5);
                if(!finitePositive(o)||!finitePositive(h)||!finitePositive(lo)||!finitePositive(cl)||
                        !Double.isFinite(vol)||vol<0||h<Math.max(o,Math.max(lo,cl))||lo>Math.min(o,Math.min(h,cl))||
                        closeTime<openTime||closeTime-openTime>=HOUR_MS) {
                    throw new IllegalStateException("Malformed OHLCV candle rejected");
                }
                if(previousOpen!=Long.MIN_VALUE && openTime-previousOpen!=HOUR_MS) {
                    throw new IllegalStateException("Candle history has a gap or duplicate; refusing unsafe analysis");
                }
                out.add(new Candle(openTime,closeTime,o,h,lo,cl,vol));
                previousOpen=openTime;
            }
            if(out.size()<40) throw new IllegalStateException("Not enough valid closed candles");
            long age=now-out.get(out.size()-1).closeTime;
            if(age<0||age>MAX_CANDLE_AGE_MS) throw new IllegalStateException("Latest closed candle is stale ("+ageText(age)+")");
            return out;
        } finally {c.disconnect();}
    }

    private boolean finitePositive(double v){return Double.isFinite(v)&&v>0;}
    private String ageText(long age){if(age<0)return "future timestamp";return String.format(Locale.US,"%.0f min",age/60000.0);}

    private List<String> analyze(List<Candle> data) {
        List<String> out=new ArrayList<>(); int n=data.size(); Candle z=data.get(n-1);
        double emaFast=ema(data,12), emaSlow=ema(data,26), rsi=rsi(data,14), atr=atr(data,14), volNow=0,volPrev=0;
        for(int i=n-20;i<n-1;i++) volNow+=data.get(i).volume; for(int i=n-40;i<n-20;i++)volPrev+=data.get(i).volume;
        double volRatio=volPrev>0?(volNow/19)/(volPrev/20):0;
        double high=0,low=Double.MAX_VALUE; for(int i=n-21;i<n-1;i++){high=Math.max(high,data.get(i).high);low=Math.min(low,data.get(i).low);}
        int positive=0,negative=0;
        String trend=emaFast>emaSlow?"Bullish":"Bearish"; if(emaFast>emaSlow)positive++;else negative++;
        String momentum=rsi>=55?"Positive":rsi<=45?"Negative":"Neutral";if(rsi>=55)positive++;else if(rsi<=45)negative++;
        out.add(worker("1. Market data integrity", n>=60?"PASS — "+n+" contiguous closed candles":"LIMITED — history short"));
        out.add(worker("2. Trend analyst",trend+" · EMA12 "+fmt(emaFast)+" / EMA26 "+fmt(emaSlow)));
        out.add(worker("3. Momentum analyst",momentum+" · RSI14 "+fmt(rsi)));
        out.add(worker("4. Volume analyst","20-bar relative volume "+fmt(volRatio)+"x"));
        out.add(worker("5. Multi-timeframe analyst","UNAVAILABLE — higher timeframe not yet fetched; no agreement assumed"));
        out.add(worker("6. Breakout & range analyst",z.close>high?"Above prior 20-bar high":z.close<low?"Below prior 20-bar low":"Inside prior 20-bar range"));
        out.add(worker("7. Volatility analyst","ATR14 "+fmt(atr)+" · "+fmt(atr/z.close*100)+"% of price"));
        out.add(worker("8. News & sentiment","UNAVAILABLE — no licensed news provider configured"));
        out.add(worker("9. Strategy reviewer",positive>negative?"Bullish diagnostics lead":negative>positive?"Bearish diagnostics lead":"Mixed diagnostics"));
        out.add(worker("10. Risk guard",stopped?"BLOCKED — emergency stop active":"PAPER ONLY — live execution disabled"));
        out.add(worker("11. Research readiness",n>=100?"READY for local historical review":"LIMITED — collect more history"));
        out.add(worker("12. Portfolio monitor",db.openCount()+" open local paper position(s) · fee-aware ledger · entries never sent to exchange"));
        return out;
    }
    private String worker(String name,String result){return name+"\n"+result;}
    private double ema(List<Candle>d,int p){double a=2.0/(p+1),v=d.get(0).close;for(int i=1;i<d.size();i++)v=d.get(i).close*a+v*(1-a);return v;}
    private double rsi(List<Candle>d,int p){double g=0,l=0;for(int i=d.size()-p;i<d.size();i++){double x=d.get(i).close-d.get(i-1).close;if(x>0)g+=x;else l-=x;}if(l==0)return 100;return 100-100/(1+g/l);}
    private double atr(List<Candle>d,int p){double sum=0;for(int i=d.size()-p;i<d.size();i++){Candle x=d.get(i),prev=d.get(i-1);sum+=Math.max(x.high-x.low,Math.max(Math.abs(x.high-prev.close),Math.abs(x.low-prev.close)));}return sum/p;}

    private void openPaper() {
        if(stopped){toast("Emergency stop is active");return;}
        if(!marketLive||lastPrice<=0){toast("A fresh live market refresh is required before opening");return;}
        if(db.openCount()>0){toast("Only one BTC paper position is allowed");return;}
        try {db.open(lastPrice); updateWallet(); updateControls(); toast("Paper position opened — fees and slippage reserved; no real order sent");}
        catch(Exception ex){toast("Paper entry rejected: "+ex.getMessage());}
    }

    private void closePaper() {
        if(lastPrice<=0){toast("Refresh market data first");return;}
        if(db.openCount()==0){toast("No open paper position");return;}
        try {
            db.closeOpen(lastPrice,"MANUAL");
            updateWallet(); updateControls();
            toast(marketLive?"Paper position closed with modeled costs":"Paper position locally closed at a cached estimate");
        } catch(Exception ex){toast("Paper exit failed: "+ex.getMessage());}
    }

    private void updateWallet() {
        if(wallet==null)return;
        WalletStats w=db.wallet(lastPrice);
        wallet.setText(String.format(Locale.US,
                "VERIFIED LOCAL PAPER LEDGER\nAvailable cash: $%,.2f\nEquity (estimated exit costs): $%,.2f\nRealized net P&L: $%,.2f\nOpen net P&L (estimated): $%,.2f\nFees paid: $%,.2f\nOpen positions: %d · Entry status: %s",
                w.availableCash,w.equity,w.realizedPnl,w.unrealizedPnl,w.feesPaid,db.openCount(),stopped?"HALTED":"PAPER ONLY"));
        history.setText(db.history());
    }

    private void updateControls() {
        if(openButton==null)return;
        openButton.setEnabled(marketLive&&!stopped&&lastPrice>0&&db.openCount()==0&&db.availableCash()>=PaperMath.POSITION_NOTIONAL_USD*(1+PaperMath.FEE_RATE));
        closeButton.setEnabled(lastPrice>0&&db.openCount()>0);
    }
    private TextView label(String s,int size,boolean bold,int color){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);t.setPadding(0,dp(8),0,dp(8));return t;}
    private android.view.View card(TextView t){LinearLayout box=new LinearLayout(this);box.setPadding(dp(14),dp(10),dp(14),dp(10));box.setBackgroundColor(CARD);box.addView(t);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(10);box.setLayoutParams(p);return box;}
    private Button button(String s){Button b=new Button(this);b.setText(s);b.setTextColor(Color.WHITE);b.setAllCaps(false);b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(ACCENT));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(9);b.setLayoutParams(p);return b;}
    private int dp(int v){return Math.round(v*getResources().getDisplayMetrics().density);}
    private String fmt(double v){return String.format(Locale.US,"%.2f",v);}
    private void toast(String s){Toast.makeText(this,s,Toast.LENGTH_SHORT).show();}
    @Override protected void onDestroy(){io.shutdownNow();if(db!=null)db.close();super.onDestroy();}

    private static final class Candle {
        final long openTime,closeTime; final double open,high,low,close,volume;
        Candle(long ot,long ct,double o,double h,double l,double c,double v){openTime=ot;closeTime=ct;open=o;high=h;low=l;close=c;volume=v;}
    }
    private static final class WalletStats {
        final double availableCash,equity,realizedPnl,unrealizedPnl,feesPaid;
        WalletStats(double cash,double eq,double realized,double unrealized,double fees){availableCash=cash;equity=eq;realizedPnl=realized;unrealizedPnl=unrealized;feesPaid=fees;}
    }

    private static final class LocalDb extends SQLiteOpenHelper {
        LocalDb(Context c){super(c,"local_paper.db",null,2);}
        @Override public void onCreate(SQLiteDatabase d) {
            d.execSQL("CREATE TABLE candles(id INTEGER PRIMARY KEY,open_time INTEGER NOT NULL UNIQUE,close_time INTEGER NOT NULL,open REAL,high REAL,low REAL,close REAL,volume REAL)");
            d.execSQL("CREATE TABLE paper(id INTEGER PRIMARY KEY,entry REAL NOT NULL,qty REAL NOT NULL,exit REAL,status TEXT NOT NULL,entry_fee REAL NOT NULL DEFAULT 0,exit_fee REAL NOT NULL DEFAULT 0,stop_loss REAL,take_profit REAL,opened_at INTEGER NOT NULL,closed_at INTEGER,close_reason TEXT,pnl_usd REAL)");
            d.execSQL("CREATE TABLE flags(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
        }
        @Override public void onUpgrade(SQLiteDatabase d,int oldVersion,int newVersion) {
            if(oldVersion<2) {
                d.execSQL("ALTER TABLE candles ADD COLUMN open_time INTEGER");
                d.execSQL("ALTER TABLE candles ADD COLUMN close_time INTEGER");
                d.execSQL("DELETE FROM candles"); // legacy cache has no trustworthy candle timestamps
                d.execSQL("ALTER TABLE paper ADD COLUMN entry_fee REAL NOT NULL DEFAULT 0");
                d.execSQL("ALTER TABLE paper ADD COLUMN exit_fee REAL NOT NULL DEFAULT 0");
                d.execSQL("ALTER TABLE paper ADD COLUMN stop_loss REAL");
                d.execSQL("ALTER TABLE paper ADD COLUMN take_profit REAL");
                d.execSQL("ALTER TABLE paper ADD COLUMN opened_at INTEGER NOT NULL DEFAULT 0");
                d.execSQL("ALTER TABLE paper ADD COLUMN closed_at INTEGER");
                d.execSQL("ALTER TABLE paper ADD COLUMN close_reason TEXT");
                d.execSQL("ALTER TABLE paper ADD COLUMN pnl_usd REAL");
                d.execSQL("UPDATE paper SET stop_loss=entry*? WHERE stop_loss IS NULL",new Object[]{1.0-PaperMath.STOP_LOSS_RATE});
                d.execSQL("UPDATE paper SET take_profit=entry*? WHERE take_profit IS NULL",new Object[]{1.0+PaperMath.TAKE_PROFIT_RATE});
                d.execSQL("UPDATE paper SET opened_at=? WHERE status='OPEN'",new Object[]{System.currentTimeMillis()});
                d.execSQL("CREATE TABLE flags(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
            }
        }

        synchronized void cache(List<Candle> cs) {
            SQLiteDatabase d=getWritableDatabase();d.beginTransaction();
            try {
                d.delete("candles",null,null);
                for(Candle c:cs) {
                    ContentValues v=new ContentValues();v.put("open_time",c.openTime);v.put("close_time",c.closeTime);
                    v.put("open",c.open);v.put("high",c.high);v.put("low",c.low);v.put("close",c.close);v.put("volume",c.volume);
                    if(d.insert("candles",null,v)<0)throw new IllegalStateException("Could not persist candle cache");
                }
                d.setTransactionSuccessful();
            } finally {d.endTransaction();}
        }

        synchronized List<Candle> load() {
            List<Candle> a=new ArrayList<>();
            try(Cursor c=getReadableDatabase().rawQuery("SELECT open_time,close_time,open,high,low,close,volume FROM candles WHERE open_time IS NOT NULL AND close_time IS NOT NULL ORDER BY open_time",null)) {
                while(c.moveToNext())a.add(new Candle(c.getLong(0),c.getLong(1),c.getDouble(2),c.getDouble(3),c.getDouble(4),c.getDouble(5),c.getDouble(6)));
            }
            return a;
        }

        synchronized void open(double referencePrice) {
            double entry=PaperMath.entryFill(referencePrice);
            double quantity=PaperMath.POSITION_NOTIONAL_USD/entry;
            double entryFee=PaperMath.fee(entry,quantity);
            SQLiteDatabase d=getWritableDatabase();d.beginTransaction();
            try {
                if(openCountInternal(d)>0)throw new IllegalStateException("An open BTC position already exists");
                double cash=availableCashInternal(d);
                if(cash+1e-8<PaperMath.POSITION_NOTIONAL_USD+entryFee)throw new IllegalStateException("Insufficient virtual cash");
                ContentValues v=new ContentValues();
                v.put("entry",entry);v.put("qty",quantity);v.put("status","OPEN");v.put("entry_fee",entryFee);v.put("exit_fee",0);
                v.put("stop_loss",entry*(1.0-PaperMath.STOP_LOSS_RATE));v.put("take_profit",entry*(1.0+PaperMath.TAKE_PROFIT_RATE));
                v.put("opened_at",System.currentTimeMillis());
                if(d.insert("paper",null,v)<0)throw new IllegalStateException("Paper position was not saved");
                d.setTransactionSuccessful();
            } finally {d.endTransaction();}
        }

        synchronized void closeOpen(double referencePrice,String reason) {
            if(!Double.isFinite(referencePrice)||referencePrice<=0)throw new IllegalArgumentException("Exit reference price is invalid");
            SQLiteDatabase d=getWritableDatabase();d.beginTransaction();
            try {
                try(Cursor c=d.rawQuery("SELECT id,entry,qty,entry_fee FROM paper WHERE status='OPEN' ORDER BY id DESC LIMIT 1",null)) {
                    if(!c.moveToFirst())throw new IllegalStateException("No open paper position");
                    closeTradeInternal(d,c.getLong(0),c.getDouble(1),c.getDouble(2),c.getDouble(3),referencePrice,reason);
                }
                d.setTransactionSuccessful();
            } finally {d.endTransaction();}
        }

        synchronized String evaluateExits(List<Candle> data) {
            SQLiteDatabase d=getWritableDatabase();d.beginTransaction();String closedReason=null;
            try {
                try(Cursor p=d.rawQuery("SELECT id,entry,qty,entry_fee,stop_loss,take_profit,opened_at FROM paper WHERE status='OPEN' ORDER BY id DESC LIMIT 1",null)) {
                    if(p.moveToFirst()) {
                        long id=p.getLong(0),openedAt=p.getLong(6);
                        double entry=p.getDouble(1),qty=p.getDouble(2),entryFee=p.getDouble(3);
                        double stop=p.getDouble(4)>0?p.getDouble(4):entry*(1.0-PaperMath.STOP_LOSS_RATE);
                        double target=p.getDouble(5)>0?p.getDouble(5):entry*(1.0+PaperMath.TAKE_PROFIT_RATE);
                        for(Candle candle:data) {
                            if(candle.openTime<openedAt)continue; // never use price movement from before the position existed
                            PaperMath.ExitDecision decision=PaperMath.decideExit(candle.open,candle.high,candle.low,stop,target);
                            if(decision!=null) {
                                closeTradeInternal(d,id,entry,qty,entryFee,decision.referencePrice,decision.reason);
                                closedReason=decision.reason;break;
                            }
                        }
                    }
                }
                d.setTransactionSuccessful();
            } finally {d.endTransaction();}
            return closedReason;
        }

        private void closeTradeInternal(SQLiteDatabase d,long id,double entry,double qty,double entryFee,double referencePrice,String reason) {
            double exit=PaperMath.exitFill(referencePrice);
            double exitFee=PaperMath.fee(exit,qty);
            double pnl=PaperMath.netPnl(entry,qty,exit,entryFee,exitFee);
            ContentValues v=new ContentValues();v.put("exit",exit);v.put("exit_fee",exitFee);v.put("status","CLOSED");
            v.put("closed_at",System.currentTimeMillis());v.put("close_reason",reason);v.put("pnl_usd",pnl);
            d.update("paper",v,"id=? AND status='OPEN'",new String[]{String.valueOf(id)});
        }

        synchronized int openCount(){return openCountInternal(getReadableDatabase());}
        private int openCountInternal(SQLiteDatabase d) {
            try(Cursor c=d.rawQuery("SELECT COUNT(*) FROM paper WHERE status='OPEN'",null)){return c.moveToFirst()?c.getInt(0):0;}
        }
        synchronized boolean isHalted() {
            try(Cursor c=getReadableDatabase().rawQuery("SELECT value FROM flags WHERE key='halted'",null)){return c.moveToFirst()&&"1".equals(c.getString(0));}
        }
        synchronized void setHalted(boolean halted) {
            ContentValues v=new ContentValues();v.put("key","halted");v.put("value",halted?"1":"0");
            getWritableDatabase().insertWithOnConflict("flags",null,v,SQLiteDatabase.CONFLICT_REPLACE);
        }
        private double scalar(SQLiteDatabase d,String sql) {
            try(Cursor c=d.rawQuery(sql,null)){return c.moveToFirst()?c.getDouble(0):0.0;}
        }
        private double realizedInternal(SQLiteDatabase d) {
            return scalar(d,"SELECT COALESCE(SUM((exit-entry)*qty-entry_fee-exit_fee),0) FROM paper WHERE status='CLOSED'");
        }
        private double reservedInternal(SQLiteDatabase d) {
            return scalar(d,"SELECT COALESCE(SUM(entry*qty+entry_fee),0) FROM paper WHERE status='OPEN'");
        }
        private double availableCashInternal(SQLiteDatabase d) {
            return PaperMath.STARTING_CAPITAL_USD+realizedInternal(d)-reservedInternal(d);
        }
        synchronized double availableCash(){return availableCashInternal(getReadableDatabase());}
        synchronized WalletStats wallet(double markPrice) {
            SQLiteDatabase d=getReadableDatabase();
            double realized=realizedInternal(d),cash=PaperMath.STARTING_CAPITAL_USD+realized-reservedInternal(d);
            double unrealized=0,openValue=0,projectedExitFees=0;
            try(Cursor c=d.rawQuery("SELECT entry,qty,entry_fee FROM paper WHERE status='OPEN'",null)) {
                while(c.moveToNext()) {
                    double entry=c.getDouble(0),qty=c.getDouble(1),entryFee=c.getDouble(2);
                    double mark=Double.isFinite(markPrice)&&markPrice>0?markPrice:entry;
                    double exit=PaperMath.exitFill(mark);
                    double exitFee=PaperMath.fee(exit,qty);
                    openValue+=mark*qty;projectedExitFees+=exitFee;
                    unrealized+=(mark-entry)*qty-entryFee-exitFee;
                }
            }
            double fees=scalar(d,"SELECT COALESCE(SUM(entry_fee+exit_fee),0) FROM paper");
            return new WalletStats(cash,cash+openValue-projectedExitFees,realized,unrealized,fees);
        }
        synchronized String history() {
            StringBuilder out=new StringBuilder("PAPER TRADE HISTORY · latest 8\n");
            int count=0;
            try(Cursor c=getReadableDatabase().rawQuery("SELECT entry,qty,exit,status,entry_fee,exit_fee,close_reason FROM paper ORDER BY id DESC LIMIT 8",null)) {
                while(c.moveToNext()) {
                    count++;
                    String state=c.getString(3);double pnl=0;
                    if("CLOSED".equals(state))pnl=PaperMath.netPnl(c.getDouble(0),c.getDouble(1),c.getDouble(2),c.getDouble(4),c.getDouble(5));
                    String details="CLOSED".equals(state)?String.format(Locale.US,"net P&L $%+.2f · %s",pnl,c.getString(6)):String.format(Locale.US,"qty %.7f BTC · SL/TP active",c.getDouble(1));
                    out.append(String.format(Locale.US,"%s · entry $%.2f · %s",state,c.getDouble(0),details));
                    out.append('\n');
                }
            }
            if(count==0)return "No paper trades yet.";
            return out.toString();
        }
    }
}
