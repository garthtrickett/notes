package com.garthtrickett.notes;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Private PackageInstaller callback, independent of the WebView's lifetime. */
public class UpdateInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            SelfUpdate.result(context, intent);
        }
    }
}
