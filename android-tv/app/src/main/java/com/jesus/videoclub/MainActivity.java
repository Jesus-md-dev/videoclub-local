package com.jesus.videoclub;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * APK del videoclub (#146): la web a pantalla completa en un WebView propio,
 * no en una TWA (#93), que en teles sin Chrome se abría como un navegador
 * con cursor. Aquí la cruceta llega a la página como flechas (la navegación
 * la hace la web en modo tele, client/src/tvMode.js) y los botones del
 * mando que la web no puede leer se traducen:
 *
 * - Atrás: atrás del historial (cierra ventanas, sale del reproductor);
 *   en la primera página, dos veces para salir.
 * - OK largo, Menú o Info: ficha rápida de la carátula enfocada.
 * - Multimedia (play/pausa, avanzar, retroceder): al reproductor.
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://192.168.1.200:3000/";
    private static final String PREFS = "videoclub";
    private static final String PREF_URL = "serverUrl";
    private static final int LONG_PRESS_MS = 600;
    private static final int BACKGROUND = Color.rgb(0x0C, 0x1A, 0x33);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView webView;
    private LinearLayout errorView;
    private TextView errorDetail;
    private EditText urlInput;
    private Button retryButton;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private long lastBackAt;

    // OK del mando: se retiene hasta saber si es pulsación corta (se le pasa
    // tal cual a la página) o larga (ficha rápida).
    private KeyEvent pendingCenterDown;
    private boolean centerLongFired;
    private final Runnable centerLongPress = new Runnable() {
        @Override
        public void run() {
            centerLongFired = true;
            sendRemote("menu");
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);

        webView = new WebView(this);
        webView.setBackgroundColor(BACKGROUND);
        configureWebView();
        root.addView(webView, matchParent());

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, matchParent());

        setContentView(root);
        webView.requestFocus();
        webView.loadUrl(serverUrl());
    }

    private static FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private String serverUrl() {
        return prefs.getString(PREF_URL, DEFAULT_URL);
    }

    private boolean isTelevision() {
        UiModeManager uiMode = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        if (uiMode != null && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) return true;
        PackageManager pm = getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(true);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        // "VideoclubTV" activa el modo tele de la web (tvMode.js); en un
        // móvil la web se queda como siempre (táctil).
        settings.setUserAgentString(settings.getUserAgentString() + " VideoclubApp/2.0"
                + (isTelevision() ? " VideoclubTV" : ""));

        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.addJavascriptInterface(new Bridge(), "VideoclubApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openOutside(Uri.parse(url));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openOutside(request.getUrl());
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // Android < 6: solo llega este, y solo para la página principal.
                if (Build.VERSION.SDK_INT < 23) showError(description);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= 23 && request.isForMainFrame()) {
                    showError(String.valueOf(error.getDescription()));
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Por si se configura la dirección HTTPS del servidor, con su
                // certificado autofirmado: se acepta solo para ese equipo.
                Uri server = Uri.parse(serverUrl());
                Uri failing = Uri.parse(error.getUrl());
                if (server.getHost() != null && server.getHost().equals(failing.getHost())) handler.proceed();
                else handler.cancel();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                hideCustomView();
                customView = view;
                customViewCallback = callback;
                root.addView(view, matchParent());
                webView.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }

            @Override
            public Bitmap getDefaultVideoPoster() {
                // Sin esto, cada <video> sin cargar enseña un icono gris de
                // "play" del sistema.
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });
    }

    // Lo que no es del servidor (enlaces a TMDB, etc.) se abre fuera, si hay
    // con qué; la app nunca navega a otro sitio.
    private boolean openOutside(Uri uri) {
        Uri server = Uri.parse(serverUrl());
        if (uri.getHost() != null && uri.getHost().equals(server.getHost())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Toast.makeText(this, "No hay ninguna app para abrir ese enlace", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        webView.setVisibility(View.VISIBLE);
        webView.requestFocus();
    }

    // ---- Pantalla de "no se puede conectar" (y para cambiar la dirección) ----

    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BACKGROUND);
        int pad = dp(48);
        box.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("No se puede conectar con el videoclub");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        errorDetail = new TextView(this);
        errorDetail.setTextColor(Color.rgb(0x9F, 0xB3, 0xD9));
        errorDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        errorDetail.setGravity(Gravity.CENTER);
        errorDetail.setPadding(0, dp(12), 0, dp(24));
        box.addView(errorDetail);

        urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setImeOptions(EditorInfo.IME_ACTION_GO);
        urlInput.setTextColor(Color.WHITE);
        urlInput.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(TextView v, int actionId, KeyEvent event) {
                retry();
                return true;
            }
        });
        box.addView(urlInput, new LinearLayout.LayoutParams(dp(420), ViewGroup.LayoutParams.WRAP_CONTENT));

        retryButton = new Button(this);
        retryButton.setText("Reintentar");
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                retry();
            }
        });
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonParams.topMargin = dp(16);
        box.addView(retryButton, buttonParams);
        return box;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showError(String description) {
        errorDetail.setText("Comprueba que el PC del videoclub está encendido y en la misma red.\n"
                + "Si ha cambiado de dirección, corrígela aquí abajo.\n(" + description + ")");
        urlInput.setText(serverUrl());
        errorView.setVisibility(View.VISIBLE);
        retryButton.requestFocus();
    }

    private void retry() {
        String url = urlInput.getText().toString().trim();
        if (url.isEmpty()) url = DEFAULT_URL;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        if (!url.endsWith("/")) url = url + "/";
        prefs.edit().putString(PREF_URL, url).apply();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(urlInput.getWindowToken(), 0);
        errorView.setVisibility(View.GONE);
        webView.requestFocus();
        webView.loadUrl(url);
    }

    // ---- Mando ----

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean firstDown = down && event.getRepeatCount() == 0;

        if (errorView.getVisibility() == View.VISIBLE) {
            if (code == KeyEvent.KEYCODE_BACK) {
                if (!down) finish();
                return true;
            }
            return super.dispatchKeyEvent(event);
        }

        switch (code) {
            case KeyEvent.KEYCODE_BACK:
                if (!down) handleBack();
                return true;
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_INFO:
                if (firstDown) sendRemote("menu");
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
                return handleCenter(event);
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                if (firstDown) sendKey("MediaPlayPause");
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                if (firstDown) sendKey("MediaPlay");
                return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (firstDown) sendKey("MediaPause");
                return true;
            // Mantenidos, siguen avanzando/retrocediendo.
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                if (down) sendKey("MediaFastForward");
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                if (down) sendKey("MediaRewind");
                return true;
            default:
                return super.dispatchKeyEvent(event);
        }
    }

    private boolean handleCenter(KeyEvent event) {
        if (customView != null) return super.dispatchKeyEvent(event);
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (event.getRepeatCount() == 0) {
                pendingCenterDown = event;
                centerLongFired = false;
                handler.postDelayed(centerLongPress, LONG_PRESS_MS);
            } else if (!centerLongFired) {
                // Mantenida: el mando empieza a repetir la tecla (o la marca
                // como pulsación larga) antes de que salte el temporizador,
                // que queda para los mandos que no repiten.
                handler.removeCallbacks(centerLongPress);
                centerLongPress.run();
            }
            return true;
        }
        if (event.getAction() == KeyEvent.ACTION_UP) {
            handler.removeCallbacks(centerLongPress);
            if (!centerLongFired && pendingCenterDown != null) {
                // Pulsación corta: a la página, como si no hubiera pasado por aquí.
                webView.dispatchKeyEvent(pendingCenterDown);
                webView.dispatchKeyEvent(event);
            }
            pendingCenterDown = null;
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private void handleBack() {
        if (customView != null) {
            webView.evaluateJavascript(
                    "(document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document)", null);
            hideCustomView();
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (now - lastBackAt < 2000) {
            finish();
        } else {
            lastBackAt = now;
            Toast.makeText(this, "Pulsa Atrás otra vez para salir", Toast.LENGTH_SHORT).show();
        }
    }

    // Aviso para la web (tvMode.js escucha "videoclub-remote").
    private void sendRemote(String action) {
        webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('videoclub-remote',{detail:'" + action + "'}))", null);
    }

    // Tecla multimedia como KeyboardEvent con el nombre estándar, que el
    // reproductor ya entiende (VideoControls.jsx, keyNameFor).
    private void sendKey(String key) {
        webView.evaluateJavascript("(document.activeElement||document.body).dispatchEvent("
                + "new KeyboardEvent('keydown',{key:'" + key + "',bubbles:true,cancelable:true}))", null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Al salir con Inicio, el vídeo se queda en pausa (como Netflix).
        webView.evaluateJavascript("document.querySelectorAll('video').forEach(function(v){v.pause()})", null);
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        webView.destroy();
        super.onDestroy();
    }

    /** Lo que la web puede pedirle a la app (window.VideoclubApp). */
    private class Bridge {
        @JavascriptInterface
        public void setKeepScreenOn(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                    if (imm != null) imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
                }
            });
        }

    }
}
