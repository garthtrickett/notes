package com.garthtrickett.notes;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpdatePlugin.class);
        registerPlugin(BeeperPlugin.class);
        registerPlugin(AlarmPlugin.class);
        registerPlugin(AudioPlugin.class);
        registerPlugin(PhotoPlugin.class);
        registerPlugin(LookupPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        // A launcher error view cannot receive the widget's own buttons.
        // Opening Notes offers an independent route to publish a fresh view.
        UrgeWidget.refresh(getApplicationContext());
    }
}
