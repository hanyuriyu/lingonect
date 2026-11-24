package com.lingonect.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
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
  private static final int MAX_SHARED_CHARS = 5000;

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

  private static Intent toShareLinkIntent(Intent intent) {
    if (intent == null) return null;
    // Reopening the app from Recents replays the original intent; don't
    // insert the same text again.
    if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;

    CharSequence text = null;
    String action = intent.getAction();
    if (Intent.ACTION_SEND.equals(action)) {
      text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
    } else if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
      text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
    }
    if (text == null) return null;

    String value = text.toString().trim();
    if (value.isEmpty()) return null;
    if (value.length() > MAX_SHARED_CHARS) value = value.substring(0, MAX_SHARED_CHARS);

    Uri link = new Uri.Builder()
      .scheme("com.lingonect.app")
      .authority("share")
      .appendQueryParameter("text", value)
      .appendQueryParameter("id", UUID.randomUUID().toString())
      .build();
    return new Intent(Intent.ACTION_VIEW, link);
  }
}
