package com.garthtrickett.notes;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.function.BooleanSupplier;

// Only the selected local SAF tree, never paths supplied by a bridge or a server URI.
final class DeliveryDocuments {
    private final ContentResolver resolver;
    final Uri tree, root;
    private final BooleanSupplier cancelled;
    static final class File {
        final Uri uri;
        final long size;
        final String mime;
        File(Uri uri,long size,String mime) { this.uri=uri;this.size=size;this.mime=mime; }
    }
    DeliveryDocuments(ContentResolver resolver,String binding,BooleanSupplier cancelled) throws IOException {
        this.resolver=resolver;this.cancelled=cancelled;
        AudioDocuments access=new AudioDocuments(resolver,binding,null);
        if(!access.hasGrant(true)) throw new IOException("Choose phone-media again to allow saving downloads.");
        tree=access.tree;root=access.root;
    }
    void check() throws IOException { if(cancelled.getAsBoolean()||Thread.currentThread().isInterrupted()) throw new IOException("Download paused; its server copy is retained."); }
    private File child(Uri parent,String name) throws IOException {
        check();
        Uri listing=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getDocumentId(parent));
        File found=null;
        try(Cursor cursor=resolver.query(listing,new String[]{Document.COLUMN_DOCUMENT_ID,Document.COLUMN_DISPLAY_NAME,Document.COLUMN_SIZE,Document.COLUMN_MIME_TYPE},null,null,null)) {
            if(cursor==null) throw new IOException("The phone folder could not be listed. No missing file is assumed.");
            while(cursor.moveToNext()) if(name.equals(cursor.getString(1))) {
                if(found!=null) throw new IOException("The phone folder has ambiguous duplicate names.");
                Uri uri=DocumentsContract.buildDocumentUriUsingTree(tree,cursor.getString(0));
                if(!DocumentsContract.isChildDocument(resolver,root,uri)) throw new IOException("File outside selected phone folder.");
                found=new File(uri,cursor.isNull(2)?-1:cursor.getLong(2),cursor.getString(3));
            }
        }
        return found;
    }
    private Uri parent(DeliveryItem item,boolean create) throws IOException {
        Uri current=root;
        String[] parts=item.path.split("/");
        for(int i=0;i<parts.length-1;i++) {
            File next=child(current,parts[i]);
            if(next==null) {
                if(!create) return null;
                Uri made=DocumentsContract.createDocument(resolver,current,Document.MIME_TYPE_DIR,parts[i]);
                if(made==null) throw new IOException("Could not create the download folder.");
                next=child(current,parts[i]);
            }
            if(next==null||!Document.MIME_TYPE_DIR.equals(next.mime)) throw new IOException("A download folder is unavailable or occupied by a file.");
            current=next.uri;
        }
        return current;
    }
    File existing(DeliveryItem item) throws IOException {
        Uri p=parent(item,false);return p==null?null:child(p,item.path.substring(item.path.lastIndexOf('/')+1));
    }
    File temporary(DeliveryState.Entry entry) throws IOException {
        Uri parent=parent(entry.item,true);
        String name=".notes-download-"+entry.item.id+".part";
        File file=child(parent,name);
        if(file==null) {
            Uri created=DocumentsContract.createDocument(resolver,parent,"application/octet-stream",name);
            if(created==null) throw new IOException("Could not create a temporary download.");
            file=child(parent,name);
        }
        if(file==null || Document.MIME_TYPE_DIR.equals(file.mime)) throw new IOException("Temporary download is unavailable.");
        if(!entry.temporary.isEmpty() && !entry.temporary.equals(file.uri.toString()))
            throw new IOException("The temporary download was replaced. Its server original is retained.");
        return file;
    }
    void spaceFor(long remaining) throws IOException {
        // The local provider can report the backing volume without guessing /storage paths.
        String selected=DocumentsContract.getTreeDocumentId(tree);
        try(Cursor cursor=resolver.query(DocumentsContract.buildRootsUri(AudioDocuments.AUTHORITY),
                new String[]{DocumentsContract.Root.COLUMN_DOCUMENT_ID,DocumentsContract.Root.COLUMN_AVAILABLE_BYTES},null,null,null)) {
            if(cursor==null)return;
            while(cursor.moveToNext()) {
                String id=cursor.getString(0);
                if(id!=null && (selected.equals(id)||selected.startsWith(id.endsWith(":")?id:id+"/")) && !cursor.isNull(1)) {
                    long available=cursor.getLong(1);
                    if(available>=0 && remaining>Math.max(0,available-16*1024*1024L))
                        throw new IOException("Not enough phone storage. Free space, then Fetch now to resume. Server copies are retained.");
                }
            }
        } catch(SecurityException unavailable) { /* Actual writes still fail closed if this optional metadata is unavailable. */ }
    }
    void discardTemporary(DeliveryState.Entry entry) throws IOException {
        if(entry.temporary.isEmpty())return;
        Uri parent=parent(entry.item,false);
        File file=parent==null?null:child(parent,".notes-download-"+entry.item.id+".part");
        if(file!=null && file.uri.toString().equals(entry.temporary)) {
            if(!DocumentsContract.deleteDocument(resolver,file.uri))throw new IOException("Could not reset the damaged temporary download.");
        }
        entry.temporary="";
    }
    static final class ChecksumFailure extends IOException {
        ChecksumFailure() { super("Download checksum failed. Its temporary copy was reset; Fetch now to retry. Server original retained."); }
    }
    String hash(File file) throws Exception {
        check();MessageDigest digest=MessageDigest.getInstance("SHA-256");long count=0;
        try(InputStream in=resolver.openInputStream(file.uri)) {
            if(in==null) throw new IOException("The phone could not open its downloaded file.");
            byte[] buffer=new byte[65536];int n;
            while((n=in.read(buffer))!=-1) { check();digest.update(buffer,0,n);count+=n; }
        }
        if(file.size>=0 && count!=file.size) throw new IOException("The phone download changed during verification.");
        StringBuilder result=new StringBuilder();for(byte b:digest.digest())result.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        return result.toString();
    }
    ParcelFileDescriptor.AutoCloseOutputStream output(File temp,long offset) throws IOException {
        ParcelFileDescriptor fd=resolver.openFileDescriptor(temp.uri,"rw");
        if(fd==null) throw new IOException("The phone could not open its temporary download.");
        ParcelFileDescriptor.AutoCloseOutputStream out=new ParcelFileDescriptor.AutoCloseOutputStream(fd);
        try { if(out.getChannel().size()!=offset) throw new IOException("Download size changed; retry after refreshing."); out.getChannel().position(offset);return out; }
        catch(IOException error) { out.close();throw error; }
    }
    File commit(DeliveryState.Entry entry) throws Exception {
        DeliveryItem item=entry.item;
        File present=existing(item);
        if(present!=null) {
            if(present.size!=item.size||!hash(present).equals(item.sha256)) throw new IOException("A different file already has this name. It has been kept.");
            return present;
        }
        File temp=temporary(entry);
        if(temp.size!=item.size||!hash(temp).equals(item.sha256)) throw new ChecksumFailure();
        check();
        Uri renamed=DocumentsContract.renameDocument(resolver,temp.uri,item.path.substring(item.path.lastIndexOf('/')+1));
        if(renamed==null) throw new IOException("The phone could not finish saving this download.");
        File result=existing(item);
        if(result==null||result.size!=item.size||!hash(result).equals(item.sha256)) throw new IOException("Saved phone file could not be verified; the server original is retained.");
        return result;
    }
}
