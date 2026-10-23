package com.garthtrickett.notes;

import android.util.AtomicFile;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// Accessed only by the delivery executor. Never shares audio's checkpoint writer.
final class DeliveryState {
    static final class Entry {
        final DeliveryItem item;
        final String root;
        String phase = "PARTIAL", temporary = "", document = "";
        Entry(DeliveryItem item, String root) { this.item=item; this.root=root; }
        JSONObject json() throws JSONException {
            return item.json().put("root",root).put("phase",phase).put("temporary",temporary).put("document",document);
        }
    }
    final Map<String, Entry> entries = new LinkedHashMap<>();
    private final AtomicFile file;
    private boolean faulted;
    DeliveryState(File directory) throws IOException {
        file = new AtomicFile(new File(directory,"media-delivery.json"));
        byte[] bytes = AudioAtomicFiles.read(file);
        if (bytes == null) return;
        try {
            if (bytes.length > 8 * 1024 * 1024) throw new JSONException("Delivery state too large");
            JSONObject value=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
            if (DeliveryItem.number(value,"schema")!=1) throw new JSONException("Unsupported delivery state");
            JSONArray list=value.getJSONArray("entries");
            for(int i=0;i<list.length();i++) {
                JSONObject j=list.getJSONObject(i);
                Entry e=new Entry(DeliveryItem.parse(j),DeliveryItem.text(j,"root"));
                e.phase=DeliveryItem.text(j,"phase"); e.temporary=DeliveryItem.text(j,"temporary"); e.document=DeliveryItem.text(j,"document");
                if (!java.util.Arrays.asList("PARTIAL","LOCAL","ACKED").contains(e.phase) || entries.put(e.item.id,e)!=null)
                    throw new JSONException("Invalid delivery checkpoint");
            }
        } catch(JSONException error) { throw new IOException("Download state could not be read. Original state retained; server cleanup is disabled.",error); }
    }
    void save() throws IOException {
        if (faulted) throw new IOException("Reopen downloads after the failed save. No delivery receipt was authorized.");
        try {
            JSONArray list=new JSONArray();
            for(Entry e:entries.values()) list.put(e.json());
            AudioAtomicFiles.write(file,new JSONObject().put("schema",1).put("entries",list).toString().getBytes(StandardCharsets.UTF_8));
        } catch(Exception error) { faulted=true; throw new IOException("Download checkpoint could not be saved. Server copies are retained.",error); }
    }
}
