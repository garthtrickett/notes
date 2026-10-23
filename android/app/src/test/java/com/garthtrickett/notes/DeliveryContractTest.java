package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.content.Context;
import android.util.AtomicFile;
import java.io.File;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=36)
public class DeliveryContractTest {
    private static final String ID="a".repeat(32),HASH="b".repeat(64);
    private static final String ROOT="content://com.android.externalstorage.documents/tree/primary%3Aphone-media";
    @Test public void isolatedSftpProviderDoesNotReplaceAndroidsNamedProvider() throws Exception {
        java.security.Provider original=java.security.Security.getProvider("BC");
        DeliveryCrypto.install();assertSame(original,java.security.Security.getProvider("BC"));
        assertEquals(DeliveryCrypto.NAME,net.schmizz.sshj.common.SecurityUtils.getSecurityProvider());
        assertEquals(DeliveryCrypto.NAME,javax.crypto.Cipher.getInstance("AES/GCM/NoPadding",DeliveryCrypto.NAME).getProvider().getName());
        assertNotNull(java.security.KeyFactory.getInstance("Ed25519",DeliveryCrypto.NAME));
    }
    @Test public void manifestRejectsTraversalDuplicateIdentityAndWrongTypes() throws Exception {
        DeliveryItem item=new DeliveryItem(ID,"youtube/Channel - Title.opus",42,HASH);
        String record=item.json().toString();
        assertEquals(1,DeliveryItem.manifest("{\"schema\":1,\"items\":["+record+"]}").size());
        assertThrows(Exception.class,()->DeliveryItem.manifest("{\"schema\":1,\"items\":["+record+","+record+"]}"));
        for(String path:new String[]{"youtube/../private.opus","video/.hidden.mp4","/youtube/test.opus","youtube/a\\b.opus","unknown/a.opus"})
            assertThrows(Exception.class,()->new DeliveryItem(ID,path,1,HASH));
        JSONObject wrong=item.json().put("size","42");assertThrows(Exception.class,()->DeliveryItem.parse(wrong));
        assertThrows(Exception.class,()->DeliveryItem.manifest("{\"schema\":true,\"items\":[]}"));
        assertTrue(DeliveryItem.path("video/Series/Episode 1.mkv"));
    }
    @Test public void durableHistorySurvivesColdOpenAndCorruptionIsNotOverwritten() throws Exception {
        File directory=new File(RuntimeEnvironment.getApplication().getCacheDir(),"delivery-journal");directory.mkdirs();
        File target=new File(directory,"media-delivery.json");target.delete();
        DeliveryState state=new DeliveryState(directory);
        DeliveryState.Entry entry=new DeliveryState.Entry(new DeliveryItem(ID,"audiobooks/Test.m4b",8,HASH),ROOT);
        entry.phase="ACKED";entry.document=ROOT+"/document/primary%3Aphone-media%2Faudiobooks%2FTest.m4b";
        state.entries.put(ID,entry);state.save();
        DeliveryState cold=new DeliveryState(directory);assertEquals("ACKED",cold.entries.get(ID).phase);
        AudioAtomicFiles.write(new AtomicFile(target),"damaged".getBytes());
        assertThrows(java.io.IOException.class,()->new DeliveryState(directory));
        assertEquals("damaged",new String(AudioAtomicFiles.read(new AtomicFile(target))));
    }
    @Test public void automaticSchedulingPreservesExistingIntervalAndStopsWhenDisabled() throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        DeliveryProfile profile=new DeliveryProfile(context);
        profile.prefs.edit().putString("secret","encrypted-placeholder").putBoolean("automatic",true).putBoolean("wifiOnly",true).commit();
        DeliveryJobs.periodic(context);
        android.app.job.JobScheduler scheduler=context.getSystemService(android.app.job.JobScheduler.class);
        android.app.job.JobInfo before=scheduler.getPendingJob(DeliveryJobs.AUTOMATIC);
        assertNotNull(before);assertTrue(before.isPersisted());assertEquals(15*60*1000,before.getIntervalMillis());
        assertEquals(android.app.job.JobInfo.NETWORK_TYPE_UNMETERED,before.getNetworkType());
        DeliveryJobs.periodic(context);assertEquals(before,scheduler.getPendingJob(DeliveryJobs.AUTOMATIC));
        profile.prefs.edit().putBoolean("automatic",false).commit();DeliveryJobs.periodic(context);assertNull(scheduler.getPendingJob(DeliveryJobs.AUTOMATIC));
    }
}
