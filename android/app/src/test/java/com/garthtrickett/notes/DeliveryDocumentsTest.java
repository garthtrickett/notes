package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.content.*;
import android.content.pm.ProviderInfo;
import android.database.*;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.*;
import java.nio.file.Files;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowContentResolver;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=36)
public class DeliveryDocumentsTest {
    private Context context;
    private Provider provider;
    private DeliveryDocuments docs;
    private DeliveryState.Entry entry;
    public static class Provider extends ContentProvider {
        File base;long available=1024*1024*1024L;
        boolean deny,duplicate;
        public boolean onCreate() { return true; }
        public String getType(Uri uri) { return "application/octet-stream"; }
        public Uri insert(Uri u,ContentValues v) { throw new UnsupportedOperationException(); }
        public int update(Uri u,ContentValues v,String w,String[] a) { throw new UnsupportedOperationException(); }
        public int delete(Uri u,String w,String[] a) { throw new UnsupportedOperationException(); }
        File path(String id) { if(!id.equals("root")&&!id.startsWith("root/"))throw new SecurityException();return new File(base,id); }
        Uri uri(String id,Uri parent) { return DocumentsContract.buildDocumentUriUsingTree(parent,id); }
        @Override public Bundle call(String method,String arg,Bundle extras) {
            if(deny)throw new SecurityException("revoked");
            Uri u=extras.getParcelable("uri",Uri.class);String id=DocumentsContract.getDocumentId(u);Bundle out=new Bundle();
            if(method.equals("android:isChildDocument")) {
                Uri child=extras.getParcelable("android.content.extra.TARGET_URI",Uri.class);
                out.putBoolean("result",DocumentsContract.getDocumentId(child).startsWith(id+"/"));
            } else if(method.equals("android:createDocument")) {
                String name=extras.getString(Document.COLUMN_DISPLAY_NAME),mime=extras.getString(Document.COLUMN_MIME_TYPE);
                File made=path(id+"/"+name);
                try { if(Document.MIME_TYPE_DIR.equals(mime))assertTrue(made.mkdir());else assertTrue(made.createNewFile()); }
                catch(IOException e) { throw new RuntimeException(e); }
                out.putParcelable("uri",uri(id+"/"+name,u));
            } else if(method.equals("android:renameDocument")) {
                String name=extras.getString(Document.COLUMN_DISPLAY_NAME);File old=path(id),next=new File(old.getParentFile(),name);
                if(next.exists())throw new IllegalStateException("will not overwrite");
                assertTrue(old.renameTo(next));out.putParcelable("uri",uri(id.substring(0,id.lastIndexOf('/')+1)+name,u));
            } else if(method.equals("android:deleteDocument"))assertTrue(path(id).delete());
            else throw new UnsupportedOperationException(method);
            return out;
        }
        @Override public Cursor query(Uri u,String[] projection,String s,String[] a,String sort) {
            if(deny)throw new SecurityException("revoked");
            MatrixCursor result=new MatrixCursor(projection);
            if(u.getPath().equals("/root")) { result.addRow(new Object[]{"root",available});return result; }
            String id=DocumentsContract.getDocumentId(u);
            File[] files=u.getPathSegments().contains("children")?path(id).listFiles():new File[]{path(id)};
            if(files!=null)for(File file:files)if(file.exists()) {
                Object[] values=new Object[projection.length];
                String child=u.getPathSegments().contains("children")?id+"/"+file.getName():id;
                for(int i=0;i<values.length;i++)values[i]=switch(projection[i]) {
                    case Document.COLUMN_DOCUMENT_ID -> child;
                    case Document.COLUMN_DISPLAY_NAME -> file.getName();
                    case Document.COLUMN_SIZE -> file.length();
                    case Document.COLUMN_MIME_TYPE -> file.isDirectory()?Document.MIME_TYPE_DIR:"application/octet-stream";
                    default -> 0;
                };
                result.addRow(values);if(duplicate)result.addRow(values);
            }
            return result;
        }
    }
    @Before public void setup() throws Exception {
        context=RuntimeEnvironment.getApplication();provider=new Provider();provider.base=Files.createTempDirectory(context.getCacheDir().toPath(),"delivery-docs").toFile();
        new File(provider.base,"root").mkdir();
        ProviderInfo info=new ProviderInfo();info.authority=AudioDocuments.AUTHORITY;info.exported=true;info.grantUriPermissions=true;
        provider.attachInfo(context,info);ShadowContentResolver.registerProviderInternal(info.authority,provider);
        Uri tree=DocumentsContract.buildTreeDocumentUri(info.authority,"root");
        context.getContentResolver().takePersistableUriPermission(tree,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        docs=new DeliveryDocuments(context.getContentResolver(),tree.toString(),()->false);
        String hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(new byte[]{1,2,3}));
        entry=new DeliveryState.Entry(new DeliveryItem("a".repeat(32),"youtube/Test.opus",3,hash),tree.toString());
    }
    private DeliveryDocuments.File partial(byte[] bytes) throws Exception {
        DeliveryDocuments.File temp=docs.temporary(entry);entry.temporary=temp.uri.toString();File file=provider.path(DocumentsContract.getDocumentId(temp.uri));Files.write(file.toPath(),bytes);
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(temp.uri,()-> { try { return new FileInputStream(file); } catch(IOException e) { throw new RuntimeException(e); } });
        return temp;
    }
    @Test public void createsOwnedTemporaryUnderSelectedTreeAndOnlyResetsThatFile() throws Exception {
        DeliveryDocuments.File temp=partial(new byte[]{3,2,1});
        File other=new File(provider.base,"root/youtube/Other.opus");Files.write(other.toPath(),new byte[]{9});
        assertThrows(DeliveryDocuments.ChecksumFailure.class,()->docs.commit(entry));docs.discardTemporary(entry);
        assertFalse(provider.path(DocumentsContract.getDocumentId(temp.uri)).exists());assertTrue(other.exists());
    }
    @Test public void conflictingFinalIsNeverOverwritten() throws Exception {
        partial(new byte[]{1,2,3});File finalFile=new File(provider.base,"root/youtube/Test.opus");Files.write(finalFile.toPath(),new byte[]{9,9});
        assertThrows(IOException.class,()->docs.commit(entry));assertArrayEquals(new byte[]{9,9},Files.readAllBytes(finalFile.toPath()));
    }
    @Test public void lowSpaceAmbiguousProviderAndCancellationRefuseWrites() throws Exception {
        provider.available=0;assertThrows(IOException.class,()->docs.spaceFor(3));
        partial(new byte[]{1});provider.duplicate=true;assertThrows(IOException.class,()->docs.temporary(entry));provider.duplicate=false;
        DeliveryDocuments cancelled=new DeliveryDocuments(context.getContentResolver(),entry.root,()->true);assertThrows(IOException.class,()->cancelled.temporary(entry));
        provider.deny=true;assertThrows(SecurityException.class,()->docs.existing(entry.item));
    }
    @Test public void savedJapaneseMp3AppearsInAudioOnlyAfterVerifiedPublication() throws Exception {
        byte[] bytes;
        try(InputStream source=getClass().getResourceAsStream("/audio/notes-audio-storage-test.mp3")) {
            assertNotNull(source);bytes=source.readAllBytes();
        }
        String path="japanese/lessons/日本語.MP3";
        String hash=java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        entry=new DeliveryState.Entry(new DeliveryItem("a".repeat(32),path,bytes.length,hash),entry.root);
        partial(bytes);
        Uri saved=DocumentsContract.buildDocumentUriUsingTree(Uri.parse(entry.root),"root/"+path);
        Shadows.shadowOf(context.getContentResolver()).registerInputStreamSupplier(saved,()-> {
            try { return new FileInputStream(new File(provider.base,"root/"+path)); }
            catch(IOException error) { throw new RuntimeException(error); }
        });
        Files.write(new File(provider.base,"root/japanese/lessons/lesson.mp3.part").toPath(),bytes);
        Files.write(new File(provider.base,"root/japanese/lessons/transcript.md").toPath(),
            "Lesson notes".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        AudioDocuments library=AudioDocuments.library(context.getContentResolver(),entry.root,null);
        assertTrue(library.list().isEmpty());
        docs.commit(entry);
        java.util.List<AudioDocuments.Entry> listed=library.list();
        assertEquals(1,listed.size());assertEquals(path,listed.get(0).path);
        assertEquals(bytes.length,listed.get(0).size);
    }
}
