package com.garthtrickett.notes;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class DeliveryMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) { DeliveryPush.token(this,token); }
    @Override public void onMessageReceived(RemoteMessage message) {
        DeliveryPush.accept(this,message.getFrom(),message.getData(),
            message.getPriority()==RemoteMessage.PRIORITY_HIGH,high->DeliveryJobs.push(this,high));
    }
    @Override public void onDeletedMessages() {
        // Missed/coalesced hints do not select paths or erase download history.
        try { DeliveryJobs.push(this,false); } catch(Exception ignored) { }
    }
}
