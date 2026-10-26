package com.speakup30.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Hosts the SpeakUp 30 web app (app/src/main/assets/www) in a WebView and gives it
 * native speech recognition, text-to-speech, permissions and a daily reminder
 * through the "Android" JavaScript bridge.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/www/index.html";
    private static final int REQ_MIC = 101;
    private static final int REQ_NOTIFY = 102;

    private WebView web;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private boolean listening = false;
    private long lastLevelAt = 0;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web = new WebView(this);
        setContentView(web);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.addJavascriptInterface(new Bridge(), "Android");
        web.loadUrl(START_URL);

        tts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) return;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String id) {
                }

                @Override
                public void onDone(String id) {
                    ttsEvent("done", id);
                }

                @Override
                public void onError(String id) {
                    ttsEvent("done", id);
                }

                @Override
                public void onStop(String id, boolean interrupted) {
                    ttsEvent("stop", id);
                }
            });
            ttsReady = true;
        });

        ReminderReceiver.schedule(this);
    }

    /* ---------------- JavaScript helpers ---------------- */

    private void js(final String code) {
        main.post(() -> {
            if (web != null) web.evaluateJavascript(code, null);
        });
    }

    private void ttsEvent(String type, String id) {
        js("window.onNativeTts&&window.onNativeTts(" + JSONObject.quote(type) + "," + JSONObject.quote(id) + ")");
    }

    private void speechEvent(String type, String text, int code, float confidence) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            o.put("text", text == null ? "" : text);
            o.put("code", code);
            o.put("confidence", Float.isNaN(confidence) ? -1.0 : (double) confidence);
            js("window.onNativeSpeech&&window.onNativeSpeech(" + o.toString() + ")");
        } catch (Exception ignored) {
        }
    }

    /* ---------------- Speech recognition ---------------- */

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            speechEvent("start", null, 0, 0f);
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rms) {
            long now = System.currentTimeMillis();
            if (now - lastLevelAt < 120 || Float.isNaN(rms)) return;
            lastLevelAt = now;
            js("window.onNativeSpeech&&window.onNativeSpeech({type:'level',level:" + rms + "})");
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onError(int error) {
            listening = false;
            speechEvent("error", null, error, 0f);
        }

        @Override
        public void onResults(Bundle results) {
            listening = false;
            ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            float[] conf = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
            String text = (list != null && !list.isEmpty()) ? list.get(0) : "";
            float c = (conf != null && conf.length > 0) ? conf[0] : -1f;
            speechEvent("final", text, 0, c);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            ArrayList<String> list = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (list != null && !list.isEmpty() && list.get(0) != null && !list.get(0).isEmpty()) {
                speechEvent("partial", list.get(0), 0, 0f);
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    };

    private void startRecognition(String lang) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            speechEvent("error", null, SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS, 0f);
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            speechEvent("error", null, -1, 0f);
            return;
        }
        if (ttsReady) tts.stop();
        // A fresh recognizer each time avoids "busy" errors on many phones.
        if (recognizer != null) {
            recognizer.destroy();
        }
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(listener);

        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
        listening = true;
        recognizer.startListening(i);
    }

    private void cancelRecognition() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
        listening = false;
    }

    /* ---------------- Text to speech ---------------- */

    private void speakNow(String text, String lang, float rate, String id) {
        if (!ttsReady || text == null || text.trim().isEmpty()) {
            ttsEvent("done", id);
            return;
        }
        if (listening) cancelRecognition();
        int r = TextToSpeech.LANG_NOT_SUPPORTED;
        try {
            r = tts.setLanguage(Locale.forLanguageTag(lang == null || lang.isEmpty() ? "en-IN" : lang));
        } catch (Exception ignored) {
        }
        if (r < 0) tts.setLanguage(Locale.US);
        tts.setSpeechRate(rate > 0.3f && rate < 3f ? rate : 1f);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id);
    }

    /* ---------------- Bridge exposed to JavaScript as window.Android ---------------- */

    private class Bridge {
        @JavascriptInterface
        public boolean hasMic() {
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestMic() {
            main.post(() -> requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC));
        }

        @JavascriptInterface
        public boolean speechAvailable() {
            return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
        }

        @JavascriptInterface
        public void startListening(final String lang) {
            main.post(() -> startRecognition(lang == null || lang.isEmpty() ? "en-IN" : lang));
        }

        @JavascriptInterface
        public void stopListening() {
            main.post(() -> {
                if (recognizer != null && listening) recognizer.stopListening();
            });
        }

        @JavascriptInterface
        public void cancelListening() {
            main.post(MainActivity.this::cancelRecognition);
        }

        @JavascriptInterface
        public boolean ttsReady() {
            return ttsReady;
        }

        @JavascriptInterface
        public void speak(final String text, final String lang, final float rate, final String id) {
            main.post(() -> speakNow(text, lang, rate, id));
        }

        @JavascriptInterface
        public void stopSpeaking() {
            main.post(() -> {
                if (ttsReady) tts.stop();
            });
        }

        @JavascriptInterface
        public void setReminder(final int hour, final int minute, final boolean on) {
            main.post(() -> {
                ReminderReceiver.save(MainActivity.this, hour, minute, on);
                ReminderReceiver.schedule(MainActivity.this);
                if (on && Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
                }
            });
        }

        @JavascriptInterface
        public String version() {
            return "1.0";
        }
    }

    /* ---------------- Lifecycle ---------------- */

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_MIC) {
            boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            js("window.onMicPermission&&window.onMicPermission(" + ok + ")");
        }
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.onAndroidBack&&window.onAndroidBack())?'y':'n'", value -> {
            if (!"\"y\"".equals(value)) finish();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        cancelRecognition();
        if (ttsReady) tts.stop();
        js("window.onAppPause&&window.onAppPause()");
    }

    @Override
    protected void onResume() {
        super.onResume();
        js("window.onAppResume&&window.onAppResume()");
    }

    @Override
    protected void onDestroy() {
        cancelRecognition();
        if (tts != null) tts.shutdown();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
