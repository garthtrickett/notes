package com.garthtrickett.notes;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import net.schmizz.sshj.sftp.RemoteFile;

final class DeliveryRunner {
    interface RunnableCheck { void run() throws Exception; }
    interface Observer { void changed(String status,boolean running); }
    static final ExecutorService FILES=Executors.newSingleThreadExecutor(r->new Thread(r,"notes-delivery"));
    private static final AtomicBoolean running=new AtomicBoolean();
    private static final Handler main=new Handler(Looper.getMainLooper());
    private static final List<Observer> observers=new ArrayList<>();
    private static volatile boolean cancelled;
    private static volatile String status="Fetch prepared audio and videos from your media inbox.";
    private static volatile DeliveryRemote connection;
    static void observe(Observer observer) { observers.add(observer);observer.changed(status,running.get()); }
    static void forget(Observer observer) { observers.remove(observer); }
    static boolean running() { return running.get(); }
    static void message(String text) {
        status=text;
        main.post(()-> { for(Observer o:new ArrayList<>(observers))o.changed(status,running.get()); });
    }
    static void cancel() {
        cancelled=true;
        // Closing the active SSH socket also wakes a stalled read promptly.
        DeliveryRemote remote=connection;
        if(remote!=null) FILE_CLOSE.execute(()-> { try { remote.close(); } catch(Exception ignored) {} });
    }
    private static final ExecutorService FILE_CLOSE=Executors.newSingleThreadExecutor(r->new Thread(r,"notes-delivery-close"));
    static void start(Context context,boolean manual,java.util.function.Consumer<String> progress,Runnable finished) {
        if(!running.compareAndSet(false,true)) { finished.run();return; }
        cancelled=false;
        Context app=context.getApplicationContext();
        message("Connecting to media inbox…");
        FILES.execute(()-> {
            try { run(app,manual,progress); }
            catch(Exception failure) {
                message(cancelled?"Downloads paused. Tap Fetch now to resume.":
                    (failure instanceof IOException?failure.getMessage():"Could not complete media delivery. Retry; server originals are retained."));
            } finally {
                connection=null;running.set(false);
                main.post(()-> { for(Observer o:new ArrayList<>(observers))o.changed(status,false);finished.run(); });
            }
        });
    }
    private static void run(Context context,boolean manual,java.util.function.Consumer<String> progress) throws Exception {
        DeliveryProfile profile=new DeliveryProfile(context);
        String root=new AudioSpikeJournal(context.getFilesDir()).root();
        if(root.isEmpty()) throw new IOException("Choose your phone-media folder in Audio first.");
        long deadline=System.nanoTime()+(manual?60L:7L)*60*1000000000;
        java.util.function.BooleanSupplier stopped=()->cancelled||System.nanoTime()>deadline;
        DeliveryDocuments docs=new DeliveryDocuments(context.getContentResolver(),root,stopped);
        DeliveryState state=new DeliveryState(context.getFilesDir());
        DeliveryJobs.checkNetwork(context,profile.wifiOnly());
        try(DeliveryRemote remote=new DeliveryRemote(profile.password())) {
            connection=remote;
            List<DeliveryItem> pending=remote.manifest();
            for(DeliveryItem item:pending) {
                DeliveryState.Entry entry=state.entries.get(item.id);
                if(entry==null) { state.entries.put(item.id,new DeliveryState.Entry(item,root));state.save(); }
                else if(!entry.item.same(item)) throw new IOException("The server changed an existing delivery identity; original downloads retained.");
            }
            for(DeliveryState.Entry entry:state.entries.values()) {
                if("ACKED".equals(entry.phase)) continue;
                if(!entry.root.equals(root)) throw new IOException("Return to the previous phone-media folder to finish its pending deliveries.");
                DeliveryItem item=entry.item;
                final long[] last={0},lastRootCheck={0};
                RunnableCheck rootCheck=()-> {
                    docs.check();DeliveryJobs.checkNetwork(context,profile.wifiOnly());
                    if(!root.equals(new AudioSpikeJournal(context.getFilesDir()).root()))
                        throw new IOException("The selected phone folder changed. Server copies are retained.");
                };
                DeliveryTransfer.run(item.size,new DeliveryTransfer.Remote() {
                    public InputStream open(long offset) throws Exception {
                        RemoteFile file=remote.open(item);
                        return new FilterInputStream(file.new ReadAheadRemoteFileInputStream(8,offset)) {
                            @Override public void close() throws IOException { try { super.close(); } finally { file.close(); } }
                        };
                    }
                    public boolean acknowledged() throws Exception { return remote.acknowledged(item); }
                    public void receipt() throws Exception { rootCheck.run();remote.receipt(item); }
                },new DeliveryTransfer.Local() {
                    public boolean alreadySaved() throws Exception {
                        DeliveryDocuments.File file=docs.existing(item);
                        if(file==null) return false;
                        if(file.size!=item.size||!docs.hash(file).equals(item.sha256)) throw new IOException("A different file already has this name. It has been kept: "+item.path);
                        entry.document=file.uri.toString();return true;
                    }
                    public long offset() throws Exception {
                        DeliveryDocuments.File file=docs.temporary(entry);
                        entry.temporary=file.uri.toString();state.save();
                        if(file.size<0||file.size>item.size) { docs.discardTemporary(entry);state.save();throw new IOException("Invalid temporary size was reset. Fetch now to retry."); }
                        docs.spaceFor(item.size-file.size);return file.size;
                    }
                    public OutputStream append(long offset) throws Exception {
                        android.os.ParcelFileDescriptor.AutoCloseOutputStream output=docs.output(docs.temporary(entry),offset);
                        return new java.io.FilterOutputStream(output) {
                            @Override public void write(byte[] bytes,int off,int length) throws IOException { out.write(bytes,off,length); }
                            @Override public void close() throws IOException {
                                try { output.flush();output.getFD().sync(); } finally { output.close(); }
                            }
                        };
                    }
                    public void publishVerified() throws Exception {
                        rootCheck.run();
                        try { entry.document=docs.commit(entry).uri.toString(); }
                        catch(DeliveryDocuments.ChecksumFailure invalid) { docs.discardTemporary(entry);state.save();throw invalid; }
                    }
                    public void verifySaved() throws Exception {
                        rootCheck.run();
                        DeliveryDocuments.File file=docs.existing(item);
                        if(file==null||file.size!=item.size||!docs.hash(file).equals(item.sha256)) throw new IOException("The saved phone download is unavailable or changed. Its server copy is retained.");
                        if(!entry.temporary.isEmpty()) { docs.discardTemporary(entry);state.save(); }
                    }
                },new DeliveryTransfer.Journal() {
                    public String phase() { return entry.phase; }
                    public void save(String phase) throws Exception { entry.phase=phase;state.save(); }
                },bytes-> {
                    docs.check();
                    if(System.nanoTime()-lastRootCheck[0]>500000000L) { rootCheck.run();lastRootCheck[0]=System.nanoTime(); }
                    if(System.nanoTime()-last[0]>500000000L) {
                        last[0]=System.nanoTime();
                        String text=item.path+"\n"+(item.size==0?100:bytes*100/item.size)+"%";
                        message(text);progress.accept(text);
                    }
                });
                message("Saved on phone: "+item.path+("ACKED".equals(entry.phase)?"\nServer copy removed.":"\nServer cleanup pending."));
                main.post(()->AudioRuntime.get(context).refresh());
            }
            // Reconcile cleanup separately; never download again because an ack was delayed.
            for(int attempt=0;attempt<15&&!stopped.getAsBoolean();attempt++) {
                int waiting=0;
                for(DeliveryState.Entry entry:state.entries.values()) if("LOCAL".equals(entry.phase)) {
                    if(remote.acknowledged(entry.item)) { entry.phase="ACKED";state.save(); }
                    else waiting++;
                }
                if(waiting==0) break;
                message("Downloads saved. Waiting for server cleanup…");
                Thread.sleep(5000);
            }
            int waiting=0,total=0;
            for(DeliveryState.Entry entry:state.entries.values()) {
                if("LOCAL".equals(entry.phase))waiting++;
                if("ACKED".equals(entry.phase))total++;
            }
            message(waiting>0?"Downloads saved. Server cleanup pending; the next fetch will check it.":pending.isEmpty()&&total==0?"No new media waiting.":"Downloads ready. Server copies cleared.\n"+total+" delivered files.");
        }
    }
}
