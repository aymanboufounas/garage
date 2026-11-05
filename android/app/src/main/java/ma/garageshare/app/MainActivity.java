package ma.garageshare.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private static final String LOCAL_HOST = "appassets.androidplatform.net";
    private WebView web;
    private Uri appOrigin;
    private GeolocationPermissions.Callback locationCallback;
    private String locationOrigin;

    private boolean trusted(Uri uri) {
        return "https".equals(uri.getScheme()) && appOrigin.getHost().equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        final boolean local = BuildConfig.SERVER_URL.isEmpty();
        appOrigin = Uri.parse(local ? "https://" + LOCAL_HOST : BuildConfig.SERVER_URL);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(251,248,242));
        web = new WebView(this);
        root.addView(web,new FrameLayout.LayoutParams(-1,-1));
        setContentView(root);
        root.setOnApplyWindowInsetsListener((view,insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                view.setPadding(bars.left,bars.top,bars.right,bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); // Required only for our same-origin application.
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " GarageShare/0.2.0 Android");
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (trusted(req.getUrl())) return false;
                if (req.isForMainFrame() && req.hasGesture() && "https".equals(req.getUrl().getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,req.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE)); } catch(Exception ignored) { }
                }
                return true;
            }
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error) { handler.cancel(); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest req) {
                if (!local || !LOCAL_HOST.equals(req.getUrl().getHost())) return super.shouldInterceptRequest(view,req);
                if (!trusted(req.getUrl()) || !"GET".equals(req.getMethod())) return denied();
                String path = req.getUrl().getPath();
                if (path == null) return denied();
                if (path.equals("/api/config")) return json("{\"demo\":true}");
                if (path.equals("/api/session")) return json("{\"user\":null,\"csrf\":\"preview\"}");
                if (path.startsWith("/api/")) return json("{}");
                if (path.equals("/")) path="/index.html";
                if (path.contains("..") || path.contains("\\") || path.contains("\u0000") || path.contains("/.") || !path.startsWith("/")) return denied();
                String mime=path.endsWith(".js")?"text/javascript":path.endsWith(".css")?"text/css":path.endsWith(".html")?"text/html":path.endsWith(".svg")?"image/svg+xml":path.endsWith(".webp")?"image/webp":path.endsWith(".png")?"image/png":path.endsWith(".woff2")?"font/woff2":path.endsWith(".json")?"application/json":null;
                if (mime==null) return denied();
                try {
                    Map<String,String> headers = new HashMap<>();
                    headers.put("X-Content-Type-Options","nosniff");
                    headers.put("Referrer-Policy","strict-origin-when-cross-origin");
                    headers.put("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' https://tile.openstreetmap.org; font-src 'self'; object-src 'none'; base-uri 'none'");
                    return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open("web"+path));
                } catch(IOException e) { return denied(); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin,GeolocationPermissions.Callback callback) {
                if (!trusted(Uri.parse(origin))) { callback.invoke(origin,false,false);return; }
                if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED) { callback.invoke(origin,true,false);return; }
                if (locationCallback!=null) locationCallback.invoke(locationOrigin,false,false);
                locationCallback=callback; locationOrigin=origin;
                requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION},7);
            }
        });
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,this::goBack);
        web.loadUrl(appOrigin.toString().replaceAll("/$","")+"/index.html");
    }
    private WebResourceResponse json(String body) { return new WebResourceResponse("application/json","UTF-8",new ByteArrayInputStream(body.getBytes(java.nio.charset.StandardCharsets.UTF_8))); }
    private WebResourceResponse denied() { return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",new HashMap<>(),new ByteArrayInputStream(new byte[0])); }
    private void goBack() { web.evaluateJavascript("(window.garageshareBack && window.garageshareBack()) || false",result->{if (!"true".equals(result)) finish();}); }
    @Override public void onBackPressed() { goBack(); }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] grants) {
        super.onRequestPermissionsResult(code,permissions,grants);
        if (code==7 && locationCallback!=null) { locationCallback.invoke(locationOrigin,grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED,false);locationCallback=null; }
    }
    @Override protected void onDestroy() {
        if (locationCallback!=null) locationCallback.invoke(locationOrigin,false,false);
        if (web!=null) { web.stopLoading();web.destroy(); }
        super.onDestroy();
    }
}
