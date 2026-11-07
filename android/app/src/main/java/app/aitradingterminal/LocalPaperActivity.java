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
 * On-device, offline-persistent paper terminal.
 * Public market data only; no exchange credentials and no real order execution.
 */
public final class LocalPaperActivity extends Activity {
    private static final int BG=0xFF080D1A, CARD=0xFF111A2E, TEXT=0xFFF7FAFF, MUTED=0xFFA2B0CA, ACCENT=0xFF8B7CFF;
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private LocalDb db;
    private LinearLayout body;
    private TextView status, price, wallet, analysis;
    private volatile List<Candle> candles=new ArrayList<>();
    private volatile double lastPrice=0;
    private volatile boolean stopped=false;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        db=new LocalDb(this);
        ScrollView scroll=new ScrollView(this);
        body=new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(18),dp(22),dp(18),dp(28)); body.setBackgroundColor(BG);
        scroll.addView(body);
        TextView title=label("AI TRADING TERMINAL",24,true,TEXT); body.addView(title);
        body.addView(label("ON-DEVICE MODE · PAPER ONLY · NO HOSTING",11,true,ACCENT));
        status=label("Local engine ready. Fetch market data to begin.",13,false,MUTED); body.addView(status);
        price=label("BTC/USDT  —",22,true,TEXT); body.addView(card(price));
        wallet=label("",15,true,TEXT); body.addView(card(wallet));
        Button refresh=button("REFRESH MARKET + RUN 12 DIAGNOSTICS"); body.addView(refresh);
        refresh.setOnClickListener(v->refreshMarket());
        Button buy=button("OPEN PAPER POSITION · $100"); body.addView(buy);
        buy.setOnClickListener(v->openPaper());
        Button close=button("CLOSE PAPER POSITION"); body.addView(close);
        close.setOnClickListener(v->closePaper());
        Button stop=button("EMERGENCY STOP / RESUME"); body.addView(stop);
        stop.setOnClickListener(v->{stopped=!stopped; status.setText(stopped?"Emergency stop ON — new paper entries blocked.":"Emergency stop OFF — paper entries enabled.");});
        analysis=label("12-worker diagnostics will appear here.\nNews sentiment is unavailable without a connected provider.",13,false,TEXT);
        body.addView(card(analysis));
        Button back=button("BACK TO CONNECTION SCREEN"); body.addView(back); back.setOnClickListener(v->finish());
        setContentView(scroll);
        updateWallet();
        refreshMarket();
    }

    private void refreshMarket() {
        status.setText("Fetching public BTC/USDT candles…");
        io.execute(()->{
            try {
                List<Candle> loaded=fetchCandles();
                if(loaded.size()<40) throw new IllegalStateException("Not enough valid candles");
                candles=loaded; lastPrice=loaded.get(loaded.size()-1).close;
                db.cache(loaded);
                List<String> results=analyze(loaded);
                runOnUiThread(()->{
                    price.setText(String.format(Locale.US,"BTC/USDT  $%,.2f",lastPrice));
                    status.setText("Market data updated · "+loaded.size()+" candles · local cache saved");
                    analysis.setText(String.join("\n\n",results));
                    updateWallet();
                });
            } catch(Exception ex) {
                List<Candle> cached=db.load();
                if(!cached.isEmpty()) {
                    candles=cached; lastPrice=cached.get(cached.size()-1).close;
                    runOnUiThread(()->{price.setText(String.format(Locale.US,"BTC/USDT  $%,.2f (cached)",lastPrice));status.setText("Network unavailable — using saved candles. "+ex.getMessage());analysis.setText(String.join("\n\n",analyze(cached)));});
                } else runOnUiThread(()->status.setText("Market data unavailable and no cache yet: "+ex.getMessage()));
            }
        });
    }

    private List<Candle> fetchCandles() throws Exception {
        URL url=new URL("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=200");
        HttpURLConnection c=(HttpURLConnection)url.openConnection(); c.setConnectTimeout(9000); c.setReadTimeout(12000); c.setRequestMethod("GET"); c.setRequestProperty("Accept","application/json");
        try {
            int code=c.getResponseCode(); if(code!=200) throw new IllegalStateException("Market provider HTTP "+code);
            StringBuilder s=new StringBuilder(); try(BufferedReader r=new BufferedReader(new InputStreamReader(c.getInputStream()))) {String line;while((line=r.readLine())!=null)s.append(line);}
            JSONArray arr=new JSONArray(s.toString()); List<Candle> out=new ArrayList<>();
            for(int i=0;i<arr.length();i++){JSONArray x=arr.getJSONArray(i); double o=x.getDouble(1),h=x.getDouble(2),l=x.getDouble(3),cl=x.getDouble(4),vol=x.getDouble(5); if(o>0&&h>=l&&l>0&&cl>0&&vol>=0)out.add(new Candle(o,h,l,cl,vol));}
            return out;
        } finally {c.disconnect();}
    }

    private List<String> analyze(List<Candle> data) {
        List<String> out=new ArrayList<>(); int n=data.size(); Candle z=data.get(n-1);
        double emaFast=ema(data,12), emaSlow=ema(data,26), rsi=rsi(data,14), atr=atr(data,14), volNow=0,volPrev=0;
        for(int i=n-20;i<n-1;i++) volNow+=data.get(i).volume; for(int i=n-40;i<n-20;i++)volPrev+=data.get(i).volume;
        double volRatio=volPrev>0?(volNow/19)/(volPrev/20):0;
        double high=0,low=Double.MAX_VALUE; for(int i=n-21;i<n-1;i++){high=Math.max(high,data.get(i).high);low=Math.min(low,data.get(i).low);}
        int positive=0,negative=0;
        String trend=emaFast>emaSlow?"Bullish":"Bearish"; if(emaFast>emaSlow)positive++;else negative++;
        String momentum=rsi>=55?"Positive":rsi<=45?"Negative":"Neutral";if(rsi>=55)positive++;else if(rsi<=45)negative++;
        out.add(worker("1. Market data integrity", n>=60?"PASS — "+n+" valid candles":"LIMITED — history short"));
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
        out.add(worker("12. Portfolio monitor",db.openCount()+" open local paper position(s) · entries never sent to exchange"));
        return out;
    }
    private String worker(String name,String result){return name+"\n"+result;}
    private double ema(List<Candle>d,int p){double a=2.0/(p+1),v=d.get(0).close;for(int i=1;i<d.size();i++)v=d.get(i).close*a+v*(1-a);return v;}
    private double rsi(List<Candle>d,int p){double g=0,l=0;for(int i=d.size()-p;i<d.size();i++){double x=d.get(i).close-d.get(i-1).close;if(x>0)g+=x;else l-=x;}if(l==0)return 100;return 100-100/(1+g/l);}
    private double atr(List<Candle>d,int p){double sum=0;for(int i=d.size()-p;i<d.size();i++){Candle x=d.get(i),prev=d.get(i-1);sum+=Math.max(x.high-x.low,Math.max(Math.abs(x.high-prev.close),Math.abs(x.low-prev.close)));}return sum/p;}

    private void openPaper() {
        if(stopped){toast("Emergency stop is active");return;} if(lastPrice<=0){toast("Fetch market data first");return;}
        if(db.openCount()>0){toast("Only one BTC paper position is allowed");return;}
        double qty=100.0/lastPrice; db.open(lastPrice,qty); updateWallet(); toast("Paper position opened — no real order sent");
    }
    private void closePaper() {
        if(lastPrice<=0){toast("Refresh market data first");return;} if(db.openCount()==0){toast("No open paper position");return;}
        db.close(lastPrice); updateWallet(); toast("Paper position closed locally");
    }
    private void updateWallet(){if(wallet!=null)wallet.setText("PAPER LEDGER\nOpen positions: "+db.openCount()+" · Initial virtual capital: $1,000\nRealized P&L: "+String.format(Locale.US,"$%.2f",db.realized()));}
    private TextView label(String s,int size,boolean bold,int color){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);if(bold)t.setTypeface(Typeface.DEFAULT,Typeface.BOLD);t.setPadding(0,dp(8),0,dp(8));return t;}
    private android.view.View card(TextView t){LinearLayout box=new LinearLayout(this);box.setPadding(dp(14),dp(10),dp(14),dp(10));box.setBackgroundColor(CARD);box.addView(t);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(10);body.addView(box,p);return new TextView(this);}
    private Button button(String s){Button b=new Button(this);b.setText(s);b.setTextColor(Color.WHITE);b.setAllCaps(false);b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(ACCENT));LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(9);body.addView(b,p);return b;}
    private int dp(int v){return Math.round(v*getResources().getDisplayMetrics().density);}
    private String fmt(double v){return String.format(Locale.US,"%.2f",v);}
    private void toast(String s){Toast.makeText(this,s,Toast.LENGTH_SHORT).show();}
    @Override protected void onDestroy(){io.shutdownNow();super.onDestroy();}

    private static final class Candle {final double open,high,low,close,volume;Candle(double o,double h,double l,double c,double v){open=o;high=h;low=l;close=c;volume=v;}}
    private static final class LocalDb extends SQLiteOpenHelper {
        LocalDb(Context c){super(c,"local_paper.db",null,1);}
        public void onCreate(SQLiteDatabase d){d.execSQL("CREATE TABLE candles(id INTEGER PRIMARY KEY,open REAL,high REAL,low REAL,close REAL,volume REAL)");d.execSQL("CREATE TABLE paper(id INTEGER PRIMARY KEY,entry REAL,qty REAL,exit REAL,status TEXT)");}
        public void onUpgrade(SQLiteDatabase d,int a,int b){}
        synchronized void cache(List<Candle> cs){SQLiteDatabase d=getWritableDatabase();d.delete("candles",null,null);for(Candle c:cs){ContentValues v=new ContentValues();v.put("open",c.open);v.put("high",c.high);v.put("low",c.low);v.put("close",c.close);v.put("volume",c.volume);d.insert("candles",null,v);}}
        synchronized List<Candle> load(){List<Candle> a=new ArrayList<>();try(android.database.Cursor c=getReadableDatabase().rawQuery("SELECT open,high,low,close,volume FROM candles ORDER BY id",null)){while(c.moveToNext())a.add(new Candle(c.getDouble(0),c.getDouble(1),c.getDouble(2),c.getDouble(3),c.getDouble(4)));}return a;}
        synchronized void open(double p,double q){ContentValues v=new ContentValues();v.put("entry",p);v.put("qty",q);v.put("status","OPEN");getWritableDatabase().insert("paper",null,v);}
        synchronized int openCount(){try(android.database.Cursor c=getReadableDatabase().rawQuery("SELECT COUNT(*) FROM paper WHERE status='OPEN'",null)){return c.moveToFirst()?c.getInt(0):0;}}
        synchronized void close(double p){try(android.database.Cursor c=getReadableDatabase().rawQuery("SELECT id,qty FROM paper WHERE status='OPEN' ORDER BY id DESC LIMIT 1",null)){if(c.moveToFirst()){ContentValues v=new ContentValues();v.put("exit",p);v.put("status","CLOSED");getWritableDatabase().update("paper",v,"id=?",new String[]{String.valueOf(c.getLong(0))});}}}
        synchronized double realized(){double total=0;try(android.database.Cursor c=getReadableDatabase().rawQuery("SELECT (exit-entry)*qty FROM paper WHERE status='CLOSED'",null)){while(c.moveToNext())total+=c.getDouble(0);}return total;}
    }
}
