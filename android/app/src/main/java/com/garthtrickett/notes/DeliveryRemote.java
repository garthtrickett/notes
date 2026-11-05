package com.garthtrickett.notes;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import android.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;
import org.json.JSONObject;

/** HTTPS transport. DeliveryTransfer owns local commit, resume offsets and receipts. */
final class DeliveryRemote implements Closeable {
    private final String endpoint,authorization;
    private final SSLSocketFactory tls;
    private final Set<HttpsURLConnection> active=ConcurrentHashMap.newKeySet();
    private volatile boolean closed;

    DeliveryRemote(String password) throws IOException {
        this("https://"+DeliveryProfile.HOST+"/notes-media/v1/",password,DeliveryTls.factory());
    }
    DeliveryRemote(String endpoint,String password,SSLSocketFactory tls) {
        this.endpoint=endpoint;this.tls=tls;
        authorization="Basic "+Base64.encodeToString(
            (DeliveryProfile.USER+":"+password).getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP);
    }
    private HttpsURLConnection request(String path) throws IOException {
        HttpsURLConnection connection=(HttpsURLConnection)new URL(endpoint+path).openConnection();
        connection.setSSLSocketFactory(tls);
        // Keep platform hostname validation. Never redirect credentials.
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(20000);connection.setReadTimeout(30000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Authorization",authorization);
        connection.setRequestProperty("Accept-Encoding","identity");
        active.add(connection);
        if(closed) { release(connection);throw new IOException("Downloads paused."); }
        return connection;
    }
    private void release(HttpsURLConnection connection) { active.remove(connection);connection.disconnect(); }
    private IOException failure(int status) {
        return new IOException(status==401?"Media password rejected. Re-enter it in delivery settings.":
            "Media server returned HTTP "+status+". Retry; server originals are retained.");
    }
    private String text(String path,int limit,boolean missingAllowed) throws IOException {
        HttpsURLConnection connection=request(path);
        try {
            int status=connection.getResponseCode();
            if(status==404&&missingAllowed)return null;
            if(status!=200)throw failure(status);
            try(InputStream in=connection.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()) {
                byte[] buffer=new byte[8192];int n;
                while((n=in.read(buffer))!=-1) {
                    if(n==0||out.size()+n>limit)throw new IOException("Invalid media server response size.");
                    out.write(buffer,0,n);
                }
                return out.toString("UTF-8");
            }
        } finally { release(connection); }
    }
    List<DeliveryItem> manifest() throws Exception { return DeliveryItem.manifest(text("manifest",2*1024*1024,false)); }

    InputStream open(DeliveryItem item,long offset) throws IOException {
        if(offset<0||offset>item.size)throw new IOException("Invalid download resume offset.");
        if(offset==item.size)return new ByteArrayInputStream(new byte[0]);
        HttpsURLConnection connection=request("payloads/"+item.id);
        try {
            connection.setRequestProperty("If-Match","\""+item.sha256+"\"");
            if(offset>0)connection.setRequestProperty("Range","bytes="+offset+"-");
            int status=connection.getResponseCode();
            if(status!=(offset>0?206:200))throw failure(status);
            String range=connection.getHeaderField("Content-Range");
            String encoding=connection.getHeaderField("Content-Encoding");
            if(connection.getContentLengthLong()!=item.size-offset ||
                !(("\""+item.sha256+"\"").equals(connection.getHeaderField("ETag"))) ||
                (encoding!=null&&!"identity".equalsIgnoreCase(encoding)) ||
                (offset==0?range!=null:!("bytes "+offset+"-"+(item.size-1)+"/"+item.size).equals(range)))
                throw new IOException("Invalid download range or identity. Server original retained.");
            return new FilterInputStream(connection.getInputStream()) {
                @Override public void close() throws IOException { try { super.close(); } finally { release(connection); } }
            };
        } catch(IOException|RuntimeException failure) { release(connection);throw failure; }
    }
    boolean acknowledged(DeliveryItem item) throws Exception {
        String value=text("acks/"+item.id,4096,true);
        if(value==null)return false;
        JSONObject ack=new JSONObject(value);
        if(DeliveryItem.number(ack,"schema")!=1 || !item.id.equals(DeliveryItem.text(ack,"id")) ||
            item.size!=DeliveryItem.number(ack,"size") || !item.sha256.equals(DeliveryItem.text(ack,"sha256")) ||
            !"removed".equals(DeliveryItem.text(ack,"status"))) throw new IOException("Invalid server cleanup acknowledgement.");
        return true;
    }
    void receipt(DeliveryItem item) throws Exception {
        byte[] bytes=item.json().put("schema",1).put("status","stored").toString().getBytes(StandardCharsets.UTF_8);
        post("receipts/"+item.id,bytes);
    }
    void registerPush(String token,boolean enabled) throws Exception {
        if(token==null||!token.matches("[A-Za-z0-9:_.-]{20,2048}"))throw new IOException("Invalid push registration.");
        byte[] bytes=new JSONObject().put("schema",1).put("token",token).put("enabled",enabled)
            .toString().getBytes(StandardCharsets.UTF_8);
        post("push-registration",bytes);
    }
    private void post(String path,byte[] bytes) throws IOException {
        HttpsURLConnection connection=request(path);
        try {
            connection.setRequestMethod("POST");connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type","application/json");
            connection.setFixedLengthStreamingMode(bytes.length);
            try(java.io.OutputStream out=connection.getOutputStream()) { out.write(bytes); }
            int status=connection.getResponseCode();
            if(status!=204)throw failure(status);
        } finally { release(connection); }
    }
    @Override public void close() { closed=true;for(HttpsURLConnection connection:active)release(connection); }
}
