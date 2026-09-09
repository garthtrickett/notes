package com.garthtrickett.notes;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

// The last step of self-update: hand a downloaded APK to the system installer.
// Three calls, each doing one thing. Installing from an unknown source needs
// the user's explicit opt-in, so the middle call opens the settings page that
// holds the toggle — there is no silent path and this does not try to find one.
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {

    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean allowed =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            getContext().getPackageManager().canRequestPackageInstalls();
        JSObject result = new JSObject();
        result.put("allowed", allowed);
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("install needs a path");
            return;
        }
        Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            new File(path)
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION
        );
        getContext().startActivity(intent);
        call.resolve();
    }
}
