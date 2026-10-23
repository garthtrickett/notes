package com.garthtrickett.notes;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.EnumSet;
import java.util.List;
import java.util.UUID;
import net.schmizz.sshj.SSHClient;
import net.schmizz.sshj.sftp.OpenMode;
import net.schmizz.sshj.sftp.RemoteFile;
import net.schmizz.sshj.sftp.SFTPClient;
import net.schmizz.sshj.sftp.SFTPException;
import net.schmizz.sshj.sftp.Response;
import org.json.JSONObject;

final class DeliveryRemote implements Closeable {
    private final SSHClient ssh;
    private final SFTPClient sftp;
    DeliveryRemote(String password) throws IOException {
        DeliveryCrypto.install();ssh=new SSHClient();
        ssh.setConnectTimeout(20000); ssh.setTimeout(20000);
        ssh.addHostKeyVerifier(net.schmizz.sshj.transport.verification.FingerprintVerifier.getInstance(DeliveryProfile.FINGERPRINT));
        try {
            ssh.connect(DeliveryProfile.HOST,22); ssh.authPassword(DeliveryProfile.USER,password);
            sftp=ssh.newSFTPClient();
        } catch(IOException|RuntimeException error) { ssh.close(); throw new IOException("Could not connect to the media server. Check connection and password.",error); }
    }
    private String text(String path,int limit) throws IOException {
        try(RemoteFile file=sftp.open(path,EnumSet.of(OpenMode.READ))) {
            ByteArrayOutputStream out=new ByteArrayOutputStream(); byte[] buffer=new byte[32768]; long at=0;
            int n;
            while((n=file.read(at,buffer,0,buffer.length))!=-1) {
                if(n==0) throw new IOException("Server response stopped making progress.");
                if(out.size()+n>limit) throw new IOException("Server response exceeds its size limit.");
                out.write(buffer,0,n);at+=n;
            }
            return out.toString("UTF-8");
        }
    }
    List<DeliveryItem> manifest() throws Exception { return DeliveryItem.manifest(text("/inbox/manifest.json",2*1024*1024)); }
    RemoteFile open(DeliveryItem item) throws IOException {
        RemoteFile result=sftp.open("/inbox/payloads/"+item.id+"/content",EnumSet.of(OpenMode.READ));
        if(result.length()!=item.size) { result.close(); throw new IOException("The server file changed. Its original has been retained."); }
        return result;
    }
    boolean acknowledged(DeliveryItem item) throws Exception {
        String value;
        try { value=text("/inbox/acks/"+item.id+".json",4096); }
        catch(SFTPException missing) { if(missing.getStatusCode()==Response.StatusCode.NO_SUCH_FILE) return false; throw missing; }
        JSONObject ack=new JSONObject(value);
        if(DeliveryItem.number(ack,"schema")!=1 || !item.id.equals(DeliveryItem.text(ack,"id")) ||
            item.size!=DeliveryItem.number(ack,"size") || !item.sha256.equals(DeliveryItem.text(ack,"sha256")) ||
            !"removed".equals(DeliveryItem.text(ack,"status"))) throw new IOException("Invalid server cleanup acknowledgement.");
        return true;
    }
    void receipt(DeliveryItem item) throws Exception {
        byte[] bytes=item.json().put("schema",1).put("status","stored").toString().getBytes(StandardCharsets.UTF_8);
        String target="/inbox/receipts/"+item.id+".json";
        String temp="/inbox/receipts/."+item.id+"-"+UUID.randomUUID()+".tmp";
        try(RemoteFile file=sftp.open(temp,EnumSet.of(OpenMode.WRITE,OpenMode.CREAT,OpenMode.EXCL))) { file.write(0,bytes,0,bytes.length); }
        try { sftp.rename(temp,target); }
        catch(SFTPException exists) {
            // A previous identical receipt may still await server reconciliation.
            JSONObject prior=new JSONObject(text(target,4096));
            if(!item.id.equals(prior.optString("id")) || !item.sha256.equals(prior.optString("sha256")) ||
                item.size!=DeliveryItem.number(prior,"size") || !"stored".equals(prior.optString("status"))) throw exists;
            sftp.rm(temp);
        }
    }
    @Override public void close() throws IOException { try { sftp.close(); } finally { ssh.close(); } }
}
