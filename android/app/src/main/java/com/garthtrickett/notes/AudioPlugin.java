package com.garthtrickett.notes;

import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Audio")
public class AudioPlugin extends Plugin {
    @PluginMethod public void openStorageTest(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(getContext(), AudioStorageTestActivity.class));
            call.resolve();
        } catch (Exception error) { call.reject("Could not open the audio storage test.", error); }
    }
}
