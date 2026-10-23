package com.garthtrickett.notes;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

public class DeliveryJob extends JobService {
    private JobParameters active;
    private final Handler main=new Handler(Looper.getMainLooper());
    @Override public boolean onStartJob(JobParameters params) {
        if(DeliveryRunner.running())return false;
        active=params;
        boolean manual=params.getJobId()==DeliveryJobs.MANUAL;
        if(manual&&Build.VERSION.SDK_INT>=34)setNotification(params,DeliveryJobs.NOTIFICATION,
            DeliveryJobs.notification(this,"Connecting to media inbox…"),JOB_END_NOTIFICATION_POLICY_REMOVE);
        DeliveryRunner.start(this,manual,text->main.post(()-> {
            if(active==params&&manual&&Build.VERSION.SDK_INT>=34)setNotification(params,DeliveryJobs.NOTIFICATION,
                DeliveryJobs.notification(this,text),JOB_END_NOTIFICATION_POLICY_REMOVE);
        }),()-> { if(active==params) { active=null;jobFinished(params,false); } });
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) {
        if(active==params) { active=null;DeliveryRunner.cancel(); }
        return params.getJobId()==DeliveryJobs.AUTOMATIC;
    }
}
