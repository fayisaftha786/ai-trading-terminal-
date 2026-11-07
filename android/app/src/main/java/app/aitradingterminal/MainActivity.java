package app.aitradingterminal;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.view.WindowInsets;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceError;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.graphics.Typeface;
import android.view.WindowManager;
import android.graphics.drawable.GradientDrawable;
import android.net.http.SslError;

import java.net.URI;
import java.util.Locale;

/**
 * Thin Android shell for the private cloud trading dashboard.
 * The backend runs in the cloud; this APK never stores dashboard or exchange credentials.
 */
public final class MainActivity extends Activity {
    private static final String KEY_SERVER = "backend_url";
    private static final String DEFAULT_SERVER = "";
    private WebView webView;
    private LinearLayout root;
    private String trustedOrigin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(8, 13, 26));
        getWindow().setNavigationBarColor(Color.rgb(8, 13, 26));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        String saved = getPreferences(MODE_PRIVATE).getString(KEY_SERVER, DEFAULT_SERVER);
        if (isAllowedServer(saved)) openDashboard(normalizeBase(saved));
        else showConnectScreen(saved == null ? DEFAULT_SERVER : saved);
    }

    private boolean isAllowedServer(String raw) {
        try {
            URI uri = URI.create(raw == null ? "" : raw.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) return false;
            String path = uri.getPath() == null ? "" : uri.getPath();
            if (!path.isEmpty() && !"/".equals(path)) return false;
            // Cloud edition: only HTTPS cloud origins are accepted. No loopback or cleartext HTTP.
            int port = uri.getPort();
            return "https".equals(scheme) && host.contains(".") && (port == -1 || port == 443);
        } catch (IllegalArgumentException ex) {
            return false;
        }
    }

    private String normalizeBase(String value) {
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        return trimmed;
    }

    private void showConnectScreen(String initial) {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(dp(24), dp(28), dp(24), dp(28));
        root.setBackgroundColor(Color.rgb(8, 13, 26));

        TextView title = new TextView(this);
        title.setText("AI TRADING TERMINAL");
        title.setTextColor(Color.WHITE);
        title.setTextSize(23);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Use the on-device paper terminal without hosting, or connect to a private cloud backend if you have one.");
        subtitle.setTextColor(Color.rgb(162, 176, 202));
        subtitle.setTextSize(14);
        subtitle.setPadding(0, dp(10), 0, dp(22));
        root.addView(subtitle);

        EditText url = new EditText(this);
        url.setSingleLine(true);
        url.setText(initial);
        url.setHint("https://your-service.onrender.com");
        url.setTextColor(Color.WHITE);
        url.setHintTextColor(Color.GRAY);
        url.setTextSize(14);
        url.setPadding(dp(14), dp(12), dp(14), dp(12));
        url.setBackground(rounded(Color.rgb(17, 26, 46), Color.rgb(74, 84, 112)));
        root.addView(url, new LinearLayout.LayoutParams(-1, dp(52)));

        Button connect = new Button(this);
        connect.setText("CONNECT TO DASHBOARD");
        connect.setAllCaps(false);
        connect.setTextColor(Color.WHITE);
        connect.setBackground(rounded(Color.rgb(103, 89, 226), Color.rgb(103, 89, 226)));
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(-1, dp(52));
        buttonParams.topMargin = dp(14);
        root.addView(connect, buttonParams);

        Button localMode = new Button(this);
        localMode.setText("OPEN ON-DEVICE PAPER TERMINAL");
        localMode.setAllCaps(false);
        localMode.setTextColor(Color.WHITE);
        localMode.setBackground(rounded(Color.rgb(35, 112, 105), Color.rgb(35, 112, 105)));
        LinearLayout.LayoutParams localParams = new LinearLayout.LayoutParams(-1, dp(52));
        localParams.topMargin = dp(10);
        root.addView(localMode, localParams);
        localMode.setOnClickListener(v -> startActivity(new Intent(MainActivity.this, LocalPaperActivity.class)));

        TextView hint = new TextView(this);
        hint.setText("Local mode: public market data + paper trades saved on this phone.\nCloud mode: HTTPS only · Never enter exchange API keys here.");
        hint.setTextColor(Color.rgb(162, 176, 202));
        hint.setTextSize(12);
        hint.setPadding(0, dp(18), 0, 0);
        root.addView(hint);

        connect.setOnClickListener(v -> {
            String candidate = normalizeBase(url.getText().toString());
            if (!isAllowedServer(candidate)) {
                Toast.makeText(this, "Enter your private cloud backend HTTPS URL.", Toast.LENGTH_LONG).show();
                return;
            }
            ((InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE))
                    .hideSoftInputFromWindow(url.getWindowToken(), 0);
            getPreferences(MODE_PRIVATE).edit().putString(KEY_SERVER, candidate).apply();
            openDashboard(candidate);
        });
        setContentView(root);
        applySystemBarInsets(root);
    }

    private void applySystemBarInsets(View target) {
        final int baseLeft = target.getPaddingLeft();
        final int baseTop = target.getPaddingTop();
        final int baseRight = target.getPaddingRight();
        final int baseBottom = target.getPaddingBottom();
        target.setOnApplyWindowInsetsListener((view, insets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = bars.left;
                top = bars.top;
                right = bars.right;
                bottom = bars.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(baseLeft + left, baseTop + top, baseRight + right, baseBottom + bottom);
            return insets;
        });
        target.requestApplyInsets();
    }

    private void openDashboard(String baseUrl) {
        trustedOrigin = baseUrl;
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(8, 13, 26));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (isTrustedUrl(target)) return false;
                if ("https".equalsIgnoreCase(target.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, target)); } catch (Exception ignored) { }
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame())
                    Toast.makeText(MainActivity.this, "Cloud backend not reachable. Check the HTTPS URL and service status.", Toast.LENGTH_LONG).show();
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                Toast.makeText(MainActivity.this, "HTTPS certificate validation failed. Connection blocked.", Toast.LENGTH_LONG).show();
            }
        });
        setContentView(webView);
        applySystemBarInsets(webView);
        webView.loadUrl(baseUrl + "/");
    }

    private boolean isTrustedUrl(Uri uri) {
        try {
            URI base = URI.create(trustedOrigin);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            int port = uri.getPort() == -1 ? ("https".equals(scheme) ? 443 : 80) : uri.getPort();
            String baseScheme = base.getScheme().toLowerCase(Locale.ROOT);
            int basePort = base.getPort() == -1 ? ("https".equals(baseScheme) ? 443 : 80) : base.getPort();
            return scheme.equals(baseScheme) && host.equalsIgnoreCase(base.getHost()) && port == basePort;
        } catch (Exception ex) {
            return false;
        }
    }

    private GradientDrawable rounded(int fill, int stroke) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(12));
        shape.setStroke(dp(1), stroke);
        return shape;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else showConnectScreen(getPreferences(MODE_PRIVATE).getString(KEY_SERVER, DEFAULT_SERVER));
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
