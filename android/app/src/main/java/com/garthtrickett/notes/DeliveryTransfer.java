package com.garthtrickett.notes;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

// Download transaction shared by production I/O and failure/recovery tests.
final class DeliveryTransfer {
    interface Remote {
        InputStream open(long offset) throws Exception;
        boolean acknowledged() throws Exception;
        void receipt() throws Exception;
    }
    interface Local {
        boolean alreadySaved() throws Exception;
        long offset() throws Exception;
        OutputStream append(long offset) throws Exception;
        void publishVerified() throws Exception;
        void verifySaved() throws Exception;
    }
    interface Journal {
        String phase();
        void save(String phase) throws Exception;
    }
    interface Progress { void check(long bytes) throws Exception; }
    static void run(long size,Remote remote,Local local,Journal journal,Progress progress) throws Exception {
        if("ACKED".equals(journal.phase())) return;
        if("PARTIAL".equals(journal.phase())) {
            if(!local.alreadySaved()) {
                long at=local.offset();
                if(at<0||at>size) throw new IOException("Temporary download has an invalid size. Server original retained.");
                progress.check(at);
                try(InputStream in=remote.open(at);OutputStream out=local.append(at)) {
                    byte[] buffer=new byte[65536];int n;
                    while((n=in.read(buffer))!=-1) {
                        progress.check(at);
                        if(n==0) throw new IOException("Download stopped making progress.");
                        if(n>size-at) throw new IOException("The server sent a different file size. Its original is retained.");
                        out.write(buffer,0,n);at+=n;
                    }
                    out.flush();
                }
                if(at!=size) throw new IOException("Download interrupted; retry will resume it.");
                progress.check(at);
                local.publishVerified();
            }
            // Durable commit precedes every remote acknowledgement.
            journal.save("LOCAL");
        }
        progress.check(size);
        if(remote.acknowledged()) { journal.save("ACKED");return; }
        local.verifySaved();
        remote.receipt();
        if(remote.acknowledged()) journal.save("ACKED");
    }
}
