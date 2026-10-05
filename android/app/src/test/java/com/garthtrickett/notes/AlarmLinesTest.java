package com.garthtrickett.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

// The phone's background reader must decide what the app decides. Both read
// src/alarm-lines.fixture.json; src/alarm-lines.test.ts pins the app's
// answers, and this asserts AlarmLines gives the same ones — ids included,
// because a different id is a duplicate alarm until the app next runs.
//
// org.json is a stub in local unit tests, so the fixture is read by the small
// parser at the bottom rather than by a new dependency.
public class AlarmLinesTest {

    @Test
    @SuppressWarnings("unchecked")
    public void readsEveryFixtureCaseTheWayTheAppDoes() throws IOException {
        Map<String, Object> fixture = (Map<String, Object>) new Json(read()).value();
        long now = wallToMillis((String) fixture.get("now"));
        List<Object> cases = (List<Object>) fixture.get("cases");
        assertTrue("the fixture lost its cases", cases.size() >= 13);
        for (Object raw : cases) {
            Map<String, Object> c = (Map<String, Object>) raw;
            String name = (String) c.get("name");
            List<String> expected = new ArrayList<>();
            for (Object e : (List<Object>) c.get("expected")) {
                Map<String, Object> m = (Map<String, Object>) e;
                expected.add(describe(((Number) m.get("id")).intValue(), (String) m.get("at"),
                    (String) m.get("title"), (Boolean) m.get("repeat")));
            }
            List<String> actual = new ArrayList<>();
            for (AlarmLines.Found f : AlarmLines.wanted((String) c.get("body"), (String) c.get("path"), now)) {
                actual.add(describe(f.id, millisToWall(f.at), f.title, f.repeat));
            }
            assertEquals(name, expected, actual);
        }
    }

    @Test
    public void idMatchesTheAppsHashForAKnownTask() {
        // Taken from the fixture's first case, so a broken hash names itself
        // here rather than as a list mismatch.
        assertEquals(id("dump/2026-10-05.md", "Tell Vins I've deployed to prod"),
            AlarmLines.id("dump/2026-10-05.md", "Tell Vins I've deployed to prod"));
    }

    @SuppressWarnings("unchecked")
    private static int id(String path, String title) {
        try {
            Map<String, Object> fixture = (Map<String, Object>) new Json(read()).value();
            for (Object raw : (List<Object>) fixture.get("cases")) {
                for (Object e : (List<Object>) ((Map<String, Object>) raw).get("expected")) {
                    Map<String, Object> m = (Map<String, Object>) e;
                    if (title.equals(m.get("title"))) return ((Number) m.get("id")).intValue();
                }
            }
        } catch (IOException ignored) {
            // Falls through to the failure below.
        }
        throw new AssertionError("no fixture entry for " + path + " / " + title);
    }

    private static String describe(int id, String at, String title, boolean repeat) {
        return id + " " + at + " " + title + (repeat ? " (repeat)" : "");
    }

    private static String read() throws IOException {
        // Gradle runs unit tests from the module directory, android/app.
        Path path = Paths.get("..", "..", "src", "alarm-lines.fixture.json");
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }

    private static long wallToMillis(String wall) {
        Calendar c = new GregorianCalendar();
        c.clear();
        c.set(Integer.parseInt(wall.substring(0, 4)), Integer.parseInt(wall.substring(5, 7)) - 1,
            Integer.parseInt(wall.substring(8, 10)), Integer.parseInt(wall.substring(11, 13)),
            Integer.parseInt(wall.substring(14, 16)), 0);
        return c.getTimeInMillis();
    }

    private static String millisToWall(long at) {
        Calendar c = new GregorianCalendar();
        c.setTimeInMillis(at);
        return String.format("%04d-%02d-%02dT%02d:%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1,
            c.get(Calendar.DAY_OF_MONTH), c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));
    }

    // Enough JSON for the fixture: objects, arrays, strings with escapes,
    // numbers, booleans and null.
    private static final class Json {
        private final String s;
        private int i;

        Json(String s) {
            this.s = s;
        }

        Object value() {
            skip();
            char c = s.charAt(i);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new LinkedHashMap<>();
            i++;
            skip();
            if (s.charAt(i) == '}') { i++; return map; }
            while (true) {
                skip();
                String key = string();
                skip();
                i++; // :
                map.put(key, value());
                skip();
                if (s.charAt(i++) == '}') return map;
            }
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            i++;
            skip();
            if (s.charAt(i) == ']') { i++; return list; }
            while (true) {
                list.add(value());
                skip();
                if (s.charAt(i++) == ']') return list;
            }
        }

        private String string() {
            StringBuilder b = new StringBuilder();
            i++;
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c != '\\') { b.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': b.append('\n'); break;
                    case 't': b.append('\t'); break;
                    case 'r': b.append('\r'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: b.append(e);
                }
            }
        }

        private Number number() {
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(start, i);
            if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
            return Long.parseLong(n);
        }

        private void skip() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }
    }
}
