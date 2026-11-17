package com.garthtrickett.notes;

import static org.junit.Assert.*;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.content.Context;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.util.ArrayList;
import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class VaultWatchTest {
    public static class Controlled extends VaultWatch {
        final List<VaultSyncSession.Listener> requests = new ArrayList<>();
        volatile int fallback, finished;
        @Override protected VaultSyncSession.Handle requestFullSync(Context context, VaultSyncSession.Listener listener) {
            requests.add(listener); return null;
        }
        @Override protected void readAlarms(Context context, long now) { fallback++; }
        @Override protected void completed(JobParameters params) { finished++; }
    }
    @Test public void successfulFullSyncFinishesWithoutRunningAlarmFallback() {
        var controller = Robolectric.buildService(Controlled.class).create();
        Controlled job = controller.get();
        assertTrue(job.onStartJob(null));
        assertEquals(1, job.requests.size());
        assertEquals(0, job.finished);
        job.requests.get(0).finished(true);
        assertEquals(1, job.finished);
        assertEquals(0, job.fallback);
        controller.destroy();
    }
    @Test public void failedFullSyncRunsExistingAlarmReaderBeforeFinishing() throws Exception {
        var controller = Robolectric.buildService(Controlled.class).create();
        Controlled job = controller.get();
        job.onStartJob(null);
        job.requests.get(0).finished(false);
        VaultSyncSessionTest.await(() -> job.finished == 1);
        assertEquals(1, job.fallback);
        controller.destroy();
    }
    @Test public void cancelledJobIgnoresLateCompletionAndCannotFinishItsSuccessor() {
        var controller = Robolectric.buildService(Controlled.class).create();
        Controlled job = controller.get();
        job.onStartJob(null);
        assertFalse(job.onStartJob(null));
        assertTrue(job.onStopJob(null));
        job.onStartJob(null);
        job.requests.get(0).finished(true);
        assertEquals(0, job.finished);
        job.requests.get(1).finished(true);
        assertEquals(1, job.finished);
        controller.destroy();
    }
    @Test public void keepsOnePersistedFifteenMinuteNetworkJobAcrossRestore() {
        Context context = RuntimeEnvironment.getApplication();
        VaultWatch.configure(context, "synthetic", "vault", "main", "synthetic-not-a-credential");
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        JobInfo first = scheduler.getPendingJob(4711);
        assertNotNull(first);
        assertTrue(first.isPeriodic());
        assertTrue(first.isPersisted());
        assertEquals(15 * 60 * 1000L, first.getIntervalMillis());
        assertEquals(JobInfo.NETWORK_TYPE_ANY, first.getNetworkType());
        assertEquals(VaultWatch.class.getName(), first.getService().getClassName());
        VaultWatch.restore(context);
        assertEquals(1, scheduler.getAllPendingJobs().size());
        assertSame(first, scheduler.getPendingJob(4711));
    }
}
