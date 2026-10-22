package com.garthtrickett.notes;

import android.content.Context;
import android.content.SharedPreferences;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** One optional count for today, shared by all copies of the home-screen widget.
 * No history, streak, account access or vault writes. The day follows the Bali
 * inbox reminder even if the phone is temporarily using another time zone. */
final class UrgeCounter {
    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("urge-widget", Context.MODE_PRIVATE);
    }

    private static String day(long now) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Makassar"));
        return format.format(new Date(now));
    }

    static int today(Context context, long now) {
        SharedPreferences prefs = preferences(context);
        return day(now).equals(prefs.getString("day", ""))
            ? Math.max(0, prefs.getInt("count", 0)) : 0;
    }

    static synchronized void adjust(Context context, long now, int delta) {
        int count = today(context, now);
        int next = (int) Math.max(0L, Math.min(Integer.MAX_VALUE, (long) count + delta));
        preferences(context).edit().putString("day", day(now)).putInt("count", next).apply();
    }
}
