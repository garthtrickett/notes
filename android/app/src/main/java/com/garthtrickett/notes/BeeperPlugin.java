package com.garthtrickett.notes;

import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Beeper, through the ContentProvider its Android app exposes.
//
// Not an HTTP API, which is why none of this can live in the web layer: a
// ContentResolver query is Android IPC between two installed apps, and the
// WebView has no way to make one. The same reason UpdatePlugin exists.
//
// Two calls, because the provider offers two things: list the chats, and post
// a message to one. It does not expose message bodies, so nothing here can
// read a conversation even if it wanted to — outbound only is a property of
// the API, not a policy decided here.
//
// Both the permissions and the <queries> entry in the manifest are load
// bearing. Without the permissions the resolver throws SecurityException;
// without <queries>, Android 11+ package visibility hides the provider
// entirely and the query returns null, which looks identical to Beeper not
// being installed.
@CapacitorPlugin(name = "Beeper")
public class BeeperPlugin extends Plugin {

    private static final Uri CHATS = Uri.parse("content://com.beeper.api/chats?limit=100");

    @PluginMethod
    public void chats(PluginCall call) {
        try {
            Cursor cursor = getContext().getContentResolver().query(CHATS, null, null, null, null);
            if (cursor == null) {
                call.reject("Beeper did not answer. Is it installed and signed in?");
                return;
            }
            JSArray chats = new JSArray();
            try {
                int roomId = cursor.getColumnIndex("roomId");
                int title = cursor.getColumnIndex("title");
                int protocol = cursor.getColumnIndex("protocol");
                while (cursor.moveToNext()) {
                    String id = roomId >= 0 ? cursor.getString(roomId) : null;
                    // A chat with no room id cannot be sent to, so it is not a
                    // chat as far as this is concerned.
                    if (id == null) continue;
                    JSObject chat = new JSObject();
                    chat.put("roomId", id);
                    chat.put("title", title >= 0 ? cursor.getString(title) : "Unknown chat");
                    chat.put("network", protocol >= 0 ? cursor.getString(protocol) : null);
                    chats.put(chat);
                }
            } finally {
                cursor.close();
            }
            JSObject result = new JSObject();
            result.put("chats", chats);
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("Beeper refused access. Is it installed, and this build permitted?");
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Could not read Beeper chats." : e.getMessage());
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        String roomId = call.getString("roomId");
        String text = call.getString("text");
        if (roomId == null || roomId.isEmpty()) {
            call.reject("No chat to send to.");
            return;
        }
        if (text == null || text.isEmpty()) {
            call.reject("Nothing to send.");
            return;
        }
        try {
            // Both values ride in the query string, encoded, which is the shape
            // the provider expects. The ContentValues is required and empty.
            Uri uri = Uri.parse(
                "content://com.beeper.api/messages?roomId=" +
                Uri.encode(roomId) +
                "&text=" +
                Uri.encode(text)
            );
            Uri posted = getContext().getContentResolver().insert(uri, new ContentValues());
            if (posted == null) {
                call.reject("Beeper accepted the call but sent nothing.");
                return;
            }
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Beeper refused access. Is it installed, and this build permitted?");
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "Could not send through Beeper." : e.getMessage());
        }
    }
}
