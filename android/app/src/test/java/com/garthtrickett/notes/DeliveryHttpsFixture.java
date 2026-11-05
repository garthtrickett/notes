package com.garthtrickett.notes;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.*;

/** A real TLS peer for transport tests; no JDK-only HTTP-server module needed. */
final class DeliveryHttpsFixture implements AutoCloseable {
    interface Handler { void handle(Request request) throws Exception; }
    static final class Headers extends TreeMap<String,String> {
        Headers() { super(String.CASE_INSENSITIVE_ORDER); }
        void set(String key,String value) { put(key,value); }
        String getFirst(String key) { return get(key); }
    }
    static final class Request {
        private final InputStream in;
        private final OutputStream out;
        private final String method,path;
        private final Headers headers=new Headers(),response=new Headers();
        Request(SSLSocket socket) throws IOException {
            in=socket.getInputStream();out=socket.getOutputStream();
            String[] line=line(in).split(" ");
            if(line.length!=3)throw new IOException("Incomplete test request");
            method=line[0];path=line[1];
            String header;
            while(!(header=line(in)).isEmpty()) {
                int colon=header.indexOf(':');
                if(colon<0)throw new IOException("Invalid test request header");
                headers.put(header.substring(0,colon),header.substring(colon+1).trim());
            }
        }
        private static String line(InputStream in) throws IOException {
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();int c;
            while((c=in.read())!=-1&&c!='\n') { if(c!='\r')bytes.write(c);if(bytes.size()>8192)throw new IOException("Long test header"); }
            if(c==-1)throw new EOFException();
            return bytes.toString("US-ASCII");
        }
        String getRequestMethod() { return method; }
        Headers getRequestHeaders() { return headers; }
        Headers getResponseHeaders() { return response; }
        InputStream getRequestBody() throws IOException {
            int length=Integer.parseInt(headers.getOrDefault("Content-Length","0"));
            byte[] body=new byte[length];int at=0;
            // Do not issue a zero-length SSL read: older host Conscrypt waits
            // for another TLS record there, unlike ordinary InputStreams.
            while(at<length) {
                int n=in.read(body,at,length-at);
                if(n<=0)throw new EOFException("Incomplete test body");
                at+=n;
            }
            return new ByteArrayInputStream(body);
        }
        OutputStream getResponseBody() { return out; }
        void sendResponseHeaders(int status,long length) throws IOException {
            StringBuilder text=new StringBuilder("HTTP/1.1 "+status+" Test\r\nConnection: close\r\nContent-Length: "+Math.max(0,length)+"\r\n");
            response.forEach((key,value)->text.append(key).append(": ").append(value).append("\r\n"));
            out.write(text.append("\r\n").toString().getBytes(StandardCharsets.US_ASCII));out.flush();
        }
    }
    private final SSLServerSocket listener;
    private final Map<String,Handler> handlers=new ConcurrentHashMap<>();
    private final Thread thread;
    private volatile Throwable failure;
    DeliveryHttpsFixture(SSLContext context) throws IOException {
        listener=(SSLServerSocket)context.getServerSocketFactory().createServerSocket();
        listener.bind(new InetSocketAddress("127.0.0.1",0));
        thread=new Thread(()-> {
            while(!listener.isClosed()) {
                try(SSLSocket socket=(SSLSocket)listener.accept()) {
                    socket.setSoTimeout(3000);socket.startHandshake();
                    Request request=new Request(socket);
                    Handler handler=handlers.get(request.path);
                    if(handler==null)request.sendResponseHeaders(404,0);else handler.handle(request);
                } catch(SSLException expectedHandshakeRejection) {
                    // Negative trust/hostname tests intentionally abort the handshake.
                } catch(EOFException expectedClosedPeer) {
                } catch(IOException error) { if(!listener.isClosed())failure=error; }
                catch(Throwable error) { failure=error; }
            }
        },"notes-https-test-peer");
    }
    InetSocketAddress getAddress() { return (InetSocketAddress)listener.getLocalSocketAddress(); }
    void createContext(String path,Handler handler) { handlers.put(path,handler); }
    void start() { thread.start(); }
    @Override public void close() throws Exception {
        listener.close();thread.join(5000);
        if(thread.isAlive())throw new AssertionError("Test TLS peer did not stop");
        if(failure!=null)throw new AssertionError("Test TLS peer failed",failure);
    }
}
