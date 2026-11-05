package com.garthtrickett.notes;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Durable token registration; separate from media bytes and the downloader lock. */
public class DeliveryRegistration extends JobService {
    static final int JOB=4816;
    private static final ExecutorService IO=Executors.newSingleThreadExecutor(r->new Thread(r,"notes-push-registration"));
    private final Handler main=new Handler(Looper.getMainLooper());
    private JobParameters active;

    static void settingsChanged(Context context) {
        new DeliveryProfile(context).prefs.edit().putBoolean("pushRegistrationPending",true).commit();
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        if(scheduler!=null)scheduler.cancel(JOB);
        retry(context); // A corrected password/setting need not wait for old backoff.
    }
    static void retry(Context context) {
        DeliveryProfile profile=new DeliveryProfile(context);
        if(!profile.configured()||profile.prefs.getString("pushToken","").isEmpty()||
            !profile.prefs.getBoolean("pushRegistrationPending",false))return;
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        if(scheduler==null)return;
        if(scheduler.getPendingJob(JOB)!=null)return;
        if(scheduler.schedule(new JobInfo.Builder(JOB,new ComponentName(context,DeliveryRegistration.class))
            .setPersisted(true).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build())!=JobScheduler.RESULT_SUCCESS)
            DeliveryPush.status(context,"Android delayed immediate-download registration. Reopen Fetch media to retry.");
    }
    @Override public boolean onStartJob(JobParameters params) {
        DeliveryProfile profile=new DeliveryProfile(this);
        String token=profile.prefs.getString("pushToken","");
        if(!profile.configured()||!profile.prefs.getBoolean("pushRegistrationPending",false)||token.isEmpty())return false;
        active=params;
        long revision=profile.prefs.getLong("pushRevision",0);
        boolean automatic=profile.automatic(),notifications=DeliveryJobs.notificationsEnabled(this);
        IO.execute(()-> {
            boolean success;
            try(DeliveryRemote remote=new DeliveryRemote(profile.password())) {
                remote.registerPush(token,automatic&&notifications);success=true;
            } catch(Exception failure) { success=false; }
            boolean accepted=success;
            main.post(()-> {
                if(active!=params)return;
                active=null;
                boolean changed=revision!=profile.prefs.getLong("pushRevision",0)
                    ||automatic!=profile.automatic()||notifications!=DeliveryJobs.notificationsEnabled(this);
                if(accepted&&!changed)profile.prefs.edit().putBoolean("pushRegistrationPending",false).commit();
                DeliveryPush.status(this,!accepted?
                    "Could not connect immediate downloads. Android will retry; periodic checks and Fetch now still work.":
                    !automatic?"Automatic downloads are off.":!notifications?
                    "Enable Notes media download notifications for immediate starts.":
                    "Immediate-download registration saved. Android may delay a push; periodic checks remain a fallback.");
                jobFinished(params,!accepted||changed);
            });
        });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) {
        if(active==params)active=null;
        // An interrupted or failed POST never clears the durable retry flag.
        return true;
    }
}
