package com.lingonect.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;

public class MainActivity extends BridgeActivity {

  // "Share to Lingonect": text shared from another app (Share sheet,
  // ACTION_SEND) or picked from the text-selection menu (ACTION_PROCESS_TEXT)
  // is turned into an internal link,
  //   com.lingonect.app://share?text=<text>&id=<unique id>
  // and handed on as an ordinary ACTION_VIEW intent. The stock App plugin then
  // delivers it to the web page as appUrlOpen / getLaunchUrl, where
  // app-native.js puts the text into the Engines input box. iOS does the same
  // from its Share Extension, so both apps share one web-side handler.
  //
  // A shared image (a screenshot, a photo) is copied into the app's cache,
  // under shared-image/, and its path is passed instead:
  //   com.lingonect.app://share?image=<path>&id=<unique id>
  // The Engines page loads that copy and reads the text out of it. Only the
  // newest shared image is kept; each share clears the folder first.
  private static final String TAG = "LingonectShare";
  private static final int MAX_SHARED_CHARS = 5000;
  private static final long MAX_IMAGE_BYTES = 30L * 1024 * 1024;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    // A fresh launch only: after a process restart the original share was
    // already delivered, and re-inserting it would overwrite the user's edits.
    if (savedInstanceState == null) {
      Intent shared = toShareLinkIntent(getIntent());
      if (shared != null) setIntent(shared);
    }
    super.onCreate(savedInstanceState);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    Intent shared = toShareLinkIntent(intent);
    super.onNewIntent(shared != null ? shared : intent);
  }

  private Intent toShareLinkIntent(Intent intent) {
    if (intent == null) return null;
    // Reopening the app from Recents replays the original intent; don't
    // insert the same text again.
    if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;

    String action = intent.getAction();
    String type = intent.getType();
    if (Intent.ACTION_SEND.equals(action) && type != null && type.startsWith("image/")) {
      String path = saveSharedImage(intent);
      if (path == null) return null;
      return linkIntent("image", path);
    }

    CharSequence text = null;
    if (Intent.ACTION_SEND.equals(action)) {
      text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
    } else if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
      text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
    }
    if (text == null) return null;

    String value = text.toString().trim();
    if (value.isEmpty()) return null;
    if (value.length() > MAX_SHARED_CHARS) value = value.substring(0, MAX_SHARED_CHARS);
    return linkIntent("text", value);
  }

  private static Intent linkIntent(String key, String value) {
    Uri link = new Uri.Builder()
      .scheme("com.lingonect.app")
      .authority("share")
      .appendQueryParameter(key, value)
      .appendQueryParameter("id", UUID.randomUUID().toString())
      .build();
    return new Intent(Intent.ACTION_VIEW, link);
  }

  // Copies the shared image into cache/shared-image/<uuid>.<ext> and returns
  // its absolute path, or null if it can't be read.
  @SuppressWarnings("deprecation")
  private String saveSharedImage(Intent intent) {
    Uri uri;
    if (Build.VERSION.SDK_INT >= 33) {
      uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
    } else {
      uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }
    if (uri == null) return null;

    File dir = new File(getCacheDir(), "shared-image");
    if (!dir.isDirectory() && !dir.mkdirs()) return null;
    File[] old = dir.listFiles();
    if (old != null) for (File f : old) f.delete();

    String ext = "image/png".equals(intent.getType()) ? "png" : "jpg";
    File out = new File(dir, UUID.randomUUID().toString() + "." + ext);
    try (InputStream in = getContentResolver().openInputStream(uri);
         OutputStream os = new FileOutputStream(out)) {
      if (in == null) return null;
      byte[] buf = new byte[64 * 1024];
      long total = 0;
      int n;
      while ((n = in.read(buf)) != -1) {
        total += n;
        if (total > MAX_IMAGE_BYTES) throw new java.io.IOException("Shared image too large");
        os.write(buf, 0, n);
      }
    } catch (Exception e) {
      Log.w(TAG, "Couldn't copy the shared image", e);
      out.delete();
      return null;
    }
    return out.getAbsolutePath();
  }
}
