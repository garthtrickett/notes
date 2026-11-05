package com.garthtrickett.notes;

import android.content.Context;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.Map;

/** Push is a wake-up hint. Only the authenticated manifest selects downloads. */
final class DeliveryPush {
    static final String SENDER="103880188180";
    interface Launcher { void start(boolean high) throws Exception; }

    static String status(Context context) {
        return new DeliveryProfile(context).prefs.getString("pushStatus","Connecting automatic downloads…");
    }
    static void status(Context context,String text) {
        new DeliveryProfile(context).prefs.edit().putString("pushStatus",text).apply();
    }
    static void configure(Context context) {
        Context app=context.getApplicationContext();
        if(!new DeliveryProfile(app).configured())return;
        try {
            if(FirebaseApp.initializeApp(app)==null) {
                status(app,"Immediate downloads need Firebase setup. Periodic checks and Fetch now still work.");
                return;
            }
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task-> {
                if(task.isSuccessful())token(app,task.getResult());
                else status(app,"Could not register immediate downloads. Periodic checks and Fetch now still work.");
            });
        } catch(Exception failure) {
            status(app,"Could not register immediate downloads. Periodic checks and Fetch now still work.");
        }
    }
    static synchronized void token(Context context,String token) {
        if(token==null||!token.matches("[A-Za-z0-9:_.-]{20,2048}"))return;
        DeliveryProfile profile=new DeliveryProfile(context);
        // Commit before leaving the short FCM callback. JobScheduler, rather
        // than an unowned callback thread, holds the authenticated network work.
        boolean saved=profile.prefs.edit().putString("pushToken",token)
            .putLong("pushRevision",profile.prefs.getLong("pushRevision",0)+1)
            .putBoolean("pushRegistrationPending",true).commit();
        if(saved)DeliveryRegistration.retry(context);
    }
    static boolean accept(Context context,String sender,Map<String,String> data,boolean high,Launcher launcher) {
        DeliveryProfile profile=new DeliveryProfile(context);
        if(!profile.configured()||!profile.automatic()||!SENDER.equals(sender)||
            !"1".equals(data.get("schema"))||!"media-ready".equals(data.get("event"))||
            data.get("generation")==null||!data.get("generation").matches("[0-9a-f]{64}"))return false;
        try { launcher.start(high);return true; }
        catch(Exception failure) {
            DeliveryRunner.message("Automatic start was delayed. Periodic checks and Fetch now remain available.");
            return false;
        }
    }
}
