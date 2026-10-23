package com.garthtrickett.notes;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.RemoteViews;
import android.widget.Toast;

/** Home screen: Widgets > Notes > Back to my day. No configuration or login.
 * Taps are handled natively, including when the Notes WebView isn't running.
 * Today's optional count and eating toggle stay in private app preferences;
 * neither is synced to the vault. Normal Android app backups may include those preferences.
 * No alarm or polling service is created. Android refreshes idle widgets on its
 * own schedule (which may lag midnight); every tap uses the current Bali day. */
public class UrgeWidget extends AppWidgetProvider {
    static final String RESIST = "com.garthtrickett.notes.urge.RESIST";
    static final String UNDO = "com.garthtrickett.notes.urge.UNDO";

    static final String TOGGLE_EATING = "com.garthtrickett.notes.urge.TOGGLE_EATING";

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (RESIST.equals(action) || UNDO.equals(action) || TOGGLE_EATING.equals(action)) {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            // Ignore PendingIntents left over from a removed widget.
            int source = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,
                AppWidgetManager.INVALID_APPWIDGET_ID);
            boolean exists = false;
            for (int id : manager.getAppWidgetIds(new ComponentName(context, UrgeWidget.class))) {
                if (source == id) exists = true;
            }
            if (!exists) return;
            if (TOGGLE_EATING.equals(action)) {
                UrgeCounter.toggleEating(context);
            } else {
                UrgeCounter.adjust(context, System.currentTimeMillis(), RESIST.equals(action) ? 1 : -1);
                Toast.makeText(context, RESIST.equals(action) ? R.string.urge_widget_noted
                    : R.string.urge_widget_undone, Toast.LENGTH_SHORT).show();
            }
            refresh(context);
        } else if (Intent.ACTION_DATE_CHANGED.equals(action) || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            refresh(context);
        } else {
            super.onReceive(context, intent);
        }
    }

    static void refresh(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, UrgeWidget.class));
            new UrgeWidget().onUpdate(context, manager, ids);
        } catch (RuntimeException refused) {
            // Widget service recovery is optional; it must not prevent Notes
            // opening. Keep the failure available in local Android diagnostics.
            Log.w("UrgeWidget", "Could not refresh home-screen widgets", refused);
        }
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager,
            int id, Bundle options) {
        onUpdate(context, manager, new int[] {id});
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            try {
                manager.updateAppWidget(id, views(context, id));
            } catch (RuntimeException refused) {
                // A broken or removed instance must not block the other copies.
                Log.w("UrgeWidget", "Could not update a home-screen widget", refused);
            }
        }
    }

    // A complete snapshot, including every action, so a launcher can rebuild
    // from an error placeholder or after losing its previous view hierarchy.
    static RemoteViews views(Context context, int id) {
        int count = UrgeCounter.today(context, System.currentTimeMillis());
        boolean eating = UrgeCounter.isEating(context);
        RemoteViews views;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                int version = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionCode;
                // Public API 31: an explicit root ID participates in the
                // launcher's recycling check. Change it between APKs so an
                // old resource hierarchy is not reused after an upgrade.
                int rootId = Math.max(1, version & 0x00ffffff);
                views = new RemoteViews(context.getPackageName(), R.layout.urge_widget, rootId);
            } catch (PackageManager.NameNotFoundException missing) {
                throw new IllegalStateException("Notes package is unavailable", missing);
            }
        } else {
            views = new RemoteViews(context.getPackageName(), R.layout.urge_widget);
        }
        views.setTextViewText(R.id.urge_resist, count == 0
            ? context.getString(R.string.urge_widget_resist)
            : context.getString(R.string.urge_widget_resist_count, count));
        views.setContentDescription(R.id.urge_resist, context.getString(R.string.urge_widget_resist_description)
            + ". " + (count == 0 ? context.getString(R.string.urge_widget_no_count)
            : context.getResources().getQuantityString(R.plurals.urge_widget_count, count, count)));
        views.setTextViewText(R.id.urge_eating, context.getString(eating
            ? R.string.urge_widget_eating_on : R.string.urge_widget_eating_off));
        views.setContentDescription(R.id.urge_eating, context.getString(eating
            ? R.string.urge_widget_eating_finish : R.string.urge_widget_eating_start));
        views.setInt(R.id.urge_eating, "setBackgroundResource", eating
            ? R.drawable.urge_widget_eating_on : R.drawable.urge_widget_eating_off);
        views.setTextColor(R.id.urge_eating, android.graphics.Color.parseColor(eating ? "#FFFFFF" : "#193B32"));
        views.setOnClickPendingIntent(R.id.urge_eating, click(context, id, TOGGLE_EATING));
        views.setBoolean(R.id.urge_undo, "setEnabled", count > 0);
        views.setOnClickPendingIntent(R.id.urge_resist, click(context, id, RESIST));
        // Direct activity PendingIntent: Android 12+ forbids launching UI
        // through a broadcast trampoline. Keep the existing Notes task alone.
        Intent capture = new Intent(context, LookupActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        views.setOnClickPendingIntent(R.id.urge_lookup, PendingIntent.getActivity(context, id, capture,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        Intent jot = new Intent(context, JotActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        views.setOnClickPendingIntent(R.id.urge_jot, PendingIntent.getActivity(context, id, jot,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        views.setOnClickPendingIntent(R.id.urge_undo, click(context, id, UNDO));
        return views;
    }

    private static PendingIntent click(Context context, int id, String action) {
        Intent intent = new Intent(context, UrgeWidget.class).setAction(action)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        return PendingIntent.getBroadcast(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
