package com.garthtrickett.notes;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
