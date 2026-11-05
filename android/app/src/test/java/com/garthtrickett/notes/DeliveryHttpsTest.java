package com.garthtrickett.notes;

import static org.junit.Assert.*;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=36)
public class DeliveryHttpsTest {
    private static final String ID="a".repeat(32),HASH="b".repeat(64);
    private static final byte[] BYTES="0123456789".getBytes(StandardCharsets.UTF_8);
    private DeliveryItem item;
    private DeliveryHttpsFixture server;
    private String certificate,endpoint;
    private DeliveryRemote remote;
    private final AtomicInteger requests=new AtomicInteger();

    private String resource(String name) throws Exception {
        try(InputStream in=getClass().getResourceAsStream("/https/"+name)) {
            return new String(in.readAllBytes(),StandardCharsets.US_ASCII);
        }
    }
    @Before public void start() throws Exception {
        item=new DeliveryItem(ID,"japanese/Test.mp3",10,HASH);
        certificate=resource("test-only-cert.pem");
        X509Certificate cert=(X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(
            new java.io.ByteArrayInputStream(certificate.getBytes(StandardCharsets.US_ASCII)));
        String key=resource("test-only-key.pem").replaceAll("-----[^-]+-----|\\s","");
        KeyStore store=KeyStore.getInstance("PKCS12");store.load(null,null);
        store.setKeyEntry("test",KeyFactory.getInstance("EC").generatePrivate(
            new PKCS8EncodedKeySpec(Base64.getDecoder().decode(key))),new char[0],new java.security.cert.Certificate[]{cert});
        KeyManagerFactory keys=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());keys.init(store,new char[0]);
        SSLContext tls=SSLContext.getInstance("TLS");tls.init(keys.getKeyManagers(),null,null);
        server=new DeliveryHttpsFixture(tls);server.start();
        endpoint="https://127.0.0.1:"+server.getAddress().getPort()+"/notes-media/v1/";
        remote=new DeliveryRemote(endpoint,"test-only",DeliveryTls.factory(certificate));
    }
    @After public void stop() throws Exception { if(remote!=null)remote.close();if(server!=null)server.close(); }
    @Test public void pushRegistrationUsesPinnedAuthenticatedPostWithoutMediaOrSecretInPayload() throws Exception {
        AtomicInteger calls=new AtomicInteger();
        server.createContext("/notes-media/v1/push-registration",exchange-> {
            assertEquals("POST",exchange.getRequestMethod());
            assertEquals("Basic "+Base64.getEncoder().encodeToString("media-phone:test-only".getBytes(StandardCharsets.UTF_8)),
                exchange.getRequestHeaders().getFirst("Authorization"));
            JSONObject value=new JSONObject(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
            assertEquals(3,value.length());assertEquals(1,value.getInt("schema"));
            assertEquals("test-only-token:1234567890",value.getString("token"));
            assertEquals(calls.getAndIncrement()==0,value.getBoolean("enabled"));
            respond(exchange,204,new byte[0]);
        });
        remote.registerPush("test-only-token:1234567890",true);
        remote.registerPush("test-only-token:1234567890",false);
        assertEquals(2,calls.get());
        assertThrows(Exception.class,()->remote.registerPush("bad\ntoken",true));
        assertEquals(2,calls.get());
    }
    private void respond(DeliveryHttpsFixture.Request exchange,int status,byte[] body) throws java.io.IOException {
        exchange.sendResponseHeaders(status,status==204?-1:body.length);
        try(java.io.OutputStream out=exchange.getResponseBody()) { if(status!=204)out.write(body); }
    }
    private void payload(int status,String range,String etag,String encoding) {
        server.createContext("/notes-media/v1/payloads/"+ID,exchange-> {
            requests.incrementAndGet();
            assertEquals("Basic "+Base64.getEncoder().encodeToString("media-phone:test-only".getBytes(StandardCharsets.UTF_8)),
                exchange.getRequestHeaders().getFirst("Authorization"));
            assertEquals("\""+HASH+"\"",exchange.getRequestHeaders().getFirst("If-Match"));
            String resume=exchange.getRequestHeaders().getFirst("Range");
            assertEquals(range==null?null:"bytes=4-",resume);
            exchange.getResponseHeaders().set("ETag",etag);
            if(range!=null)exchange.getResponseHeaders().set("Content-Range",range);
            if(encoding!=null)exchange.getResponseHeaders().set("Content-Encoding",encoding);
            respond(exchange,status,range==null?BYTES:java.util.Arrays.copyOfRange(BYTES,4,10));
        });
    }
    @Test public void wholeFileAndIdentityHeaders() throws Exception {
        payload(200,null,"\""+HASH+"\"",null);
        try(InputStream in=remote.open(item,0)) { assertArrayEquals(BYTES,in.readAllBytes()); }
        assertEquals(1,requests.get());
    }
    @Test public void resumesOnlyExactSuffix() throws Exception {
        payload(206,"bytes 4-9/10","\""+HASH+"\"",null);
        try(InputStream in=remote.open(item,4)) { assertEquals("456789",new String(in.readAllBytes())); }
    }
    @Test public void rangeIgnoredDoesNotAppendWholeFile() {
        payload(200,"bytes 4-9/10","\""+HASH+"\"",null);
        assertThrows(Exception.class,()->remote.open(item,4));
    }
    @Test public void wrongRangeDoesNotAppendDifferentBytes() {
        payload(206,"bytes 3-8/10","\""+HASH+"\"",null);
        assertThrows(Exception.class,()->remote.open(item,4));
    }
    @Test public void wrongIdentityRejected() {
        payload(200,null,"\"wrong\"",null);
        assertThrows(Exception.class,()->remote.open(item,0));
    }
    @Test public void compressedResponseRejected() {
        payload(200,null,"\""+HASH+"\"","gzip");
        assertThrows(Exception.class,()->remote.open(item,0));
    }
    @Test public void alreadyCompleteDoesNotRequestUnsatisfiableRange() throws Exception {
        try(InputStream in=remote.open(item,10)) { assertEquals(-1,in.read()); }
        assertEquals(0,requests.get());
    }
    @Test public void redirectIsNeverFollowedWithCredentials() {
        server.createContext("/notes-media/v1/manifest",exchange-> {
            exchange.getResponseHeaders().set("Location",endpoint+"elsewhere");respond(exchange,302,new byte[0]);
        });
        server.createContext("/notes-media/v1/elsewhere",exchange->requests.incrementAndGet());
        assertThrows(Exception.class,()->remote.manifest());assertEquals(0,requests.get());
    }
    @Test public void otherCertificateAndWrongHostnameAreRejected() throws Exception {
        server.createContext("/notes-media/v1/manifest",exchange->{ requests.incrementAndGet();respond(exchange,200,"{}".getBytes()); });
        try(DeliveryRemote other=new DeliveryRemote(endpoint,"test-only",DeliveryTls.factory())) {
            assertThrows(Exception.class,()->other.manifest());
        }
        try(DeliveryRemote wrongHost=new DeliveryRemote(endpoint.replace("127.0.0.1","localhost"),"test-only",DeliveryTls.factory(certificate))) {
            assertThrows(Exception.class,()->wrongHost.manifest());
        }
        assertEquals(0,requests.get());
    }
    @Test public void receiptAndDelayedAckKeepExistingIdentity() throws Exception {
        server.createContext("/notes-media/v1/receipts/"+ID,exchange-> {
            try {
                JSONObject sent=new JSONObject(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
                assertEquals("POST",exchange.getRequestMethod());assertEquals("stored",sent.getString("status"));
                assertTrue(item.same(DeliveryItem.parse(sent)));requests.incrementAndGet();respond(exchange,204,new byte[0]);
            } catch(Exception error) { throw new RuntimeException(error); }
        });
        AtomicInteger polls=new AtomicInteger();
        server.createContext("/notes-media/v1/acks/"+ID,exchange-> {
            try { respond(exchange,polls.getAndIncrement()==0?404:200,
                item.json().put("schema",1).put("status","removed").toString().getBytes(StandardCharsets.UTF_8)); }
            catch(Exception error) { throw new RuntimeException(error); }
        });
        assertFalse(remote.acknowledged(item));remote.receipt(item);assertTrue(remote.acknowledged(item));assertEquals(1,requests.get());
    }
    @Test public void closePreventsNewRequests() {
        remote.close();assertThrows(Exception.class,()->remote.manifest());assertEquals(0,requests.get());
    }
    @Test public void manifestUsesExistingValidatedIdentities() throws Exception {
        server.createContext("/notes-media/v1/manifest",exchange->respond(exchange,200,
            ("{\"schema\":1,\"items\":["+item.json()+"]}").getBytes(StandardCharsets.UTF_8)));
        assertTrue(item.same(remote.manifest().get(0)));
    }
    @Test public void wrongPasswordExplainsHowToRecover() {
        server.createContext("/notes-media/v1/manifest",exchange->respond(exchange,401,new byte[0]));
        assertTrue(assertThrows(Exception.class,()->remote.manifest()).getMessage().contains("password rejected"));
    }
    @Test public void wrongLengthIsRejectedBeforeAppending() {
        server.createContext("/notes-media/v1/payloads/"+ID,exchange-> {
            exchange.getResponseHeaders().set("ETag","\""+HASH+"\"");respond(exchange,200,new byte[9]);
        });
        assertThrows(Exception.class,()->remote.open(item,0));
    }
    @Test public void cleanupAckMustMatchTheSavedFile() {
        server.createContext("/notes-media/v1/acks/"+ID,exchange->respond(exchange,200,
            item.json().put("schema",1).put("status","removed").put("size",9).toString().getBytes(StandardCharsets.UTF_8)));
        assertThrows(Exception.class,()->remote.acknowledged(item));
    }
}
