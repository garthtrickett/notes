package com.garthtrickett.notes;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Which lines of a note want an alarm, read on the phone while the app is
// closed (VaultWatch). The app's own reader is src/tasks.ts + src/reminders.ts
// + alarmsWanted in src/notify.ts; this is a second copy of that rule, because
// a background job cannot run the app's JavaScript.
//
// A copy is a liability, so it is held to the app's answers by a shared
// fixture (src/alarm-lines.fixture.json): the app's test pins what the app
// decides, AlarmLinesTest asserts this decides the same — ids included. And it
// is never the last word: the next time the app runs, its sync replaces the
// whole set, so any line read differently here is corrected then.
//
// Plain Java with no Android imports, so it runs as an ordinary unit test.
final class AlarmLines {
    private AlarmLines() {}

    static final class Found {
        final int id;
        final long at;
        final String title;
        final String path;
        final boolean repeat;

        Found(int id, long at, String title, String path, boolean repeat) {
            this.id = id;
            this.at = at;
            this.title = title;
            this.path = path;
            this.repeat = repeat;
        }
    }

    private static final String DAY =
        "(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
    private static final String RULE =
        "day|weekday|week|month|year|\\d+\\s+(?:days?|weeks?|months?)|" + DAY + "(?:," + DAY + ")*";

    // reminders.ts PATTERN, character for character.
    private static final Pattern STAMP = Pattern.compile(
        "(?:^|\\s)@(\\d{4})-(\\d{2})-(\\d{2})(?:\\s+(\\d{2}):(\\d{2}))?(!?)(?:\\s+every\\s+(" + RULE + "))?(?=\\s|$)",
        Pattern.CASE_INSENSITIVE);

    // A GFM task: a list marker, then a box. What follows the box is the line
    // the app reads the stamp and title out of.
    private static final Pattern TASK =
        Pattern.compile("^\\s*(?:[-*+]|\\d{1,9}[.)])\\s+\\[([ xX])\\](.*)$");

    private static final Pattern FENCE = Pattern.compile("^ {0,3}(```|~~~)");

    private static final int DEFAULT_HOUR = 9;
    private static final int TASK_ID_FLOOR = 1000;
    private static final long TASK_ID_CEILING = 2_000_000_000L;

    // alarmsWanted: open, flagged, and still to come.
    static List<Found> wanted(String body, String path, long now) {
        List<Found> found = new ArrayList<>();
        String fence = null;
        for (String line : body.split("\n", -1)) {
            Matcher f = FENCE.matcher(line);
            if (f.find()) {
                String mark = f.group(1);
                if (fence == null) fence = mark;
                else if (fence.equals(mark)) fence = null;
                continue;
            }
            if (fence != null) continue;
            Matcher task = TASK.matcher(line);
            if (!task.matches()) continue;
            if (!" ".equals(task.group(1))) continue;
            String raw = task.group(2);
            Matcher stamp = STAMP.matcher(raw);
            if (!stamp.find()) continue;
            if (!"!".equals(stamp.group(6))) continue;
            Long at = instant(stamp);
            if (at == null || at <= now) continue;
            String title = (raw.substring(0, stamp.start()) + raw.substring(stamp.end()))
                .replaceAll("\\s{2,}", " ").trim();
            found.add(new Found(id(path, title), at, title, path, stamp.group(7) != null));
        }
        return found;
    }

    // Local time, and an impossible date is no date — the app asks Date what
    // it made of 2026-02-31 for the same reason this turns leniency off.
    private static Long instant(Matcher m) {
        int y = Integer.parseInt(m.group(1));
        int mo = Integer.parseInt(m.group(2));
        int d = Integer.parseInt(m.group(3));
        int hh = m.group(4) == null ? DEFAULT_HOUR : Integer.parseInt(m.group(4));
        int mm = m.group(5) == null ? 0 : Integer.parseInt(m.group(5));
        Calendar c = new GregorianCalendar();
        c.setLenient(false);
        c.clear();
        c.set(y, mo - 1, d, hh, mm, 0);
        try {
            return c.getTimeInMillis();
        } catch (IllegalArgumentException impossible) {
            return null;
        }
    }

    // notify.ts reminderId: FNV-1a over the code points of path, NUL, title,
    // in 32-bit arithmetic. The abs is taken in long because Java's
    // Math.abs(Integer.MIN_VALUE) stays negative where JavaScript's does not.
    static int id(String path, String title) {
        int h = (int) 2166136261L;
        int[] points = (path + "\u0000" + title).codePoints().toArray();
        for (int cp : points) {
            h ^= cp;
            h *= 16777619;
        }
        return (int) (TASK_ID_FLOOR + (Math.abs((long) h) % (TASK_ID_CEILING - TASK_ID_FLOOR)));
    }
}
