package com.garthtrickett.notes;

import static org.junit.Assert.*;

import android.content.Context;
import android.os.Looper;
import android.view.ContextThemeWrapper;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.RemoteViews;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
public class WidgetBackgroundInflationTest {
    private Context context;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("urge-widget", Context.MODE_PRIVATE).edit().clear().commit();
    }

    // Pixel Launcher inflates RemoteViews on a worker without a Looper. The
    // framework's Material button animator must not run while constructing a
    // disabled button there (observed on Pixel 7a, Android 17/API 37).
    private void onLauncherWorker(Runnable assertion) throws Exception {
        FutureTask<Void> task = new FutureTask<>(() -> {
            assertNull(Looper.myLooper());
            assertion.run();
            return null;
        });
        Thread worker = new Thread(task, "widget-inflation-without-looper");
        worker.setDaemon(true);
        worker.start();
        try {
            task.get(10, TimeUnit.SECONDS);
        } finally {
            worker.interrupt();
        }
    }

    private void assertNoButtonAnimators(View root) {
        for (int id : new int[] {R.id.urge_eating, R.id.urge_lookup, R.id.urge_jot,
                R.id.urge_resist, R.id.urge_undo}) {
            View button = root.findViewById(id);
            assertNotNull(button);
            assertNull("Widget buttons must be safe to inflate off the UI thread",
                button.getStateListAnimator());
        }
    }

    @Test public void initialLayoutInflatesWithoutLooperWithUndoDisabled() throws Exception {
        onLauncherWorker(() -> {
            Context host = new ContextThemeWrapper(context,
                android.R.style.Theme_Material_Light_NoActionBar);
            View root = LayoutInflater.from(host).inflate(R.layout.urge_widget,
                new FrameLayout(host), false);
            assertNoButtonAnimators(root);
            assertFalse(root.findViewById(R.id.urge_undo).isEnabled());
        });
    }

    @Test public void publishedViewsInflateWithoutLooperForBothUndoStates() throws Exception {
        for (int count : new int[] {0, 1}) {
            if (count == 1) UrgeCounter.adjust(context, System.currentTimeMillis(), 1);
            RemoteViews published = UrgeWidget.views(context, 42);
            boolean undoEnabled = count > 0;
            onLauncherWorker(() -> {
                Context host = new ContextThemeWrapper(context,
                    android.R.style.Theme_Material_Light_NoActionBar);
                View root = published.apply(host, new FrameLayout(host));
                assertNoButtonAnimators(root);
                assertEquals(undoEnabled, root.findViewById(R.id.urge_undo).isEnabled());
                assertTrue(root.findViewById(R.id.urge_lookup).hasOnClickListeners());
                assertTrue(root.findViewById(R.id.urge_jot).hasOnClickListeners());
                assertTrue(root.findViewById(R.id.urge_header).hasOnClickListeners());
                assertNotNull(root.findViewById(R.id.urge_sync));
            });
        }
    }
}
