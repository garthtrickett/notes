package com.garthtrickett.notes;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import org.junit.Test;

public class DeliveryTransferTest {
    private static final class Fixture implements DeliveryTransfer.Remote,DeliveryTransfer.Local,DeliveryTransfer.Journal {
        final byte[] bytes="verified media".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        ByteArrayOutputStream temp=new ByteArrayOutputStream();
        byte[] saved;
        String phase="PARTIAL";
        boolean failSave,failVerify,failReceipt,ack,shortRead,extraByte;
        int opens,receipts,verifications;
        long offset=-1;
        public InputStream open(long from) {
            opens++;offset=from;
            byte[] body=Arrays.copyOfRange(bytes,(int)from,bytes.length-(shortRead?1:0));
            if(extraByte)body=Arrays.copyOf(body,body.length+1);
            return new ByteArrayInputStream(body);
        }
        public boolean acknowledged() { return ack; }
        public void receipt() throws Exception { assertEquals("LOCAL",phase);assertArrayEquals(bytes,saved);receipts++;if(failReceipt)throw new IOException("lost response"); }
        public boolean alreadySaved() { return saved!=null; }
        public long offset() { return temp.size(); }
        public OutputStream append(long from) { return temp; }
        public void publishVerified() throws Exception {
            if(failVerify)throw new IOException("bad hash");
            assertArrayEquals(bytes,temp.toByteArray());saved=temp.toByteArray();
        }
        public void verifySaved() throws Exception { verifications++;if(failVerify||!Arrays.equals(bytes,saved))throw new IOException("missing or changed"); }
        public String phase() { return phase; }
        public void save(String next) throws Exception { if(failSave)throw new IOException("disk full");phase=next; }
        void run() throws Exception { DeliveryTransfer.run(bytes.length,this,this,this,n->{}); }
    }
    @Test public void verifiedDurablePhoneCommitPrecedesReceipt() throws Exception {
        Fixture f=new Fixture();f.run();assertEquals("LOCAL",f.phase);assertEquals(1,f.receipts);assertArrayEquals(f.bytes,f.saved);
        f.ack=true;f.run();assertEquals("ACKED",f.phase);assertEquals(1,f.opens);assertEquals(1,f.receipts);
    }
    @Test public void interruptedShortReadResumesAtExactOffsetWithoutReceipt() throws Exception {
        Fixture f=new Fixture();f.shortRead=true;assertThrows(IOException.class,f::run);
        assertNull(f.saved);assertEquals(0,f.receipts);assertEquals("PARTIAL",f.phase);
        int count=f.temp.size();f.shortRead=false;f.run();assertEquals(count,f.offset);assertEquals(1,f.receipts);
    }
    @Test public void wrongHashOrUnexpectedBytesCannotPublishOrAcknowledge() throws Exception {
        Fixture f=new Fixture();f.failVerify=true;assertThrows(IOException.class,f::run);assertNull(f.saved);assertEquals(0,f.receipts);
        Fixture extra=new Fixture();extra.extraByte=true;assertThrows(IOException.class,extra::run);assertNull(extra.saved);assertEquals(0,extra.receipts);
    }
    @Test public void failedCheckpointCannotAuthorizeRemoteCleanup() throws Exception {
        Fixture f=new Fixture();f.failSave=true;assertThrows(IOException.class,f::run);assertArrayEquals(f.bytes,f.saved);assertEquals(0,f.receipts);
        // A cold retry discovers the exact already-saved file instead of copying it again.
        f.failSave=false;f.run();assertEquals(1,f.opens);assertEquals(1,f.receipts);
    }
    @Test public void lostReceiptResponseRetriesWithoutRedownloading() throws Exception {
        Fixture f=new Fixture();f.failReceipt=true;assertThrows(IOException.class,f::run);assertEquals("LOCAL",f.phase);
        f.failReceipt=false;f.run();assertEquals(1,f.opens);assertEquals(2,f.receipts);
    }
    @Test public void deletedOrChangedPhoneFileBeforeReceiptRetainsServerOriginal() throws Exception {
        Fixture f=new Fixture();f.phase="LOCAL";f.saved="replacement".getBytes();assertThrows(IOException.class,f::run);assertEquals(0,f.receipts);assertEquals(0,f.opens);
    }
    @Test public void completedAckNeverRestoresUserDeletedDownloads() throws Exception {
        Fixture f=new Fixture();f.phase="ACKED";f.run();assertEquals(0,f.opens);assertEquals(0,f.receipts);assertEquals(0,f.verifications);
    }
    @Test public void existingServerAckReconcilesLostResponseEvenIfUserLaterDeletedPhoneFile() throws Exception {
        Fixture f=new Fixture();f.phase="LOCAL";f.ack=true;f.run();assertEquals("ACKED",f.phase);assertEquals(0,f.receipts);assertEquals(0,f.opens);
    }
    @Test public void cancellationBeforeReceiptLeavesVerifiedCopyAndServerOriginal() throws Exception {
        Fixture f=new Fixture();
        assertThrows(IOException.class,()->DeliveryTransfer.run(f.bytes.length,f,f,f,n->{ if(f.saved!=null)throw new IOException("cancelled"); }));
        assertEquals("LOCAL",f.phase);assertEquals(0,f.receipts);assertArrayEquals(f.bytes,f.saved);
    }
}
