package com.garthtrickett.notes;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/** Trust only this private media endpoint, using the platform's PKIX verifier. */
final class DeliveryTls {
    static final String CERTIFICATE="-----BEGIN CERTIFICATE-----\n"+
        "MIIBxjCCAWygAwIBAgIUNTnw5WSIiLaSLDtcTCS7bsMBhSswCgYIKoZIzj0EAwIw\n"+
        "HjEcMBoGA1UEAwwTTm90ZXMgQ29udGFibyBtZWRpYTAeFw0yNjExMDUwODI5MzJa\n"+
        "Fw0zMTExMDQwODI5MzJaMB4xHDAaBgNVBAMME05vdGVzIENvbnRhYm8gbWVkaWEw\n"+
        "WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASIpZY54O4u9RPgPEyWSUCHZI4Vzr+a\n"+
        "P2M9F6yefHPvD5YBK4mLUQeoXzm7cp5l8isBbmnb1Zxhxjl/z8doOhtGo4GHMIGE\n"+
        "MB0GA1UdDgQWBBSXMjhHHNi9KssMWWDMPAsWNysDLjAfBgNVHSMEGDAWgBSXMjhH\n"+
        "HNi9KssMWWDMPAsWNysDLjAPBgNVHREECDAGhwRU95+8MAwGA1UdEwEB/wQCMAAw\n"+
        "DgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMAoGCCqGSM49BAMC\n"+
        "A0gAMEUCIQCFT/wiepVITHolCEdDuU3RC91UvzK5Oio8SZvmTFcvHgIgc4UgzF59\n"+
        "H/Ks5NOFRaVb8Tsz9uNecH9KYpLEbrPTous=\n-----END CERTIFICATE-----\n";

    static SSLSocketFactory factory() throws IOException { return factory(CERTIFICATE); }
    static SSLSocketFactory factory(String pem) throws IOException {
        try {
            X509Certificate certificate=(X509Certificate)CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(pem.getBytes(StandardCharsets.US_ASCII)));
            certificate.checkValidity();
            KeyStore store=KeyStore.getInstance(KeyStore.getDefaultType());store.load(null,null);
            store.setCertificateEntry("notes-media",certificate);
            TrustManagerFactory trust=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());trust.init(store);
            SSLContext context=SSLContext.getInstance("TLS");context.init(null,trust.getTrustManagers(),null);
            return context.getSocketFactory();
        } catch(Exception error) { throw new IOException("Could not validate the media server certificate. Check the phone date or update Notes.",error); }
    }
}
