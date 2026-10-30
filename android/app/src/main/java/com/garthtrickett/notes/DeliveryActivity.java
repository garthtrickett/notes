package com.garthtrickett.notes;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.Collections;

public class DeliveryActivity extends Activity {
    private TextView status,folder;
    private EditText password;
    private CheckBox automatic,wifi;
    private Button fetch,save;
    private LinearLayout recent;
    private boolean visible;
    private final DeliveryRunner.Observer observer=(text,running)-> {
        status.setText(text);fetch.setEnabled(!running);save.setEnabled(!running);
        if(!running)loadHistory();
    };
    private int dp(int value) { return (int)(getResources().getDisplayMetrics().density*value+0.5f); }
    private TextView label(String text,int sp) {
        TextView view=new TextView(this);view.setText(text);view.setTextSize(sp);view.setPadding(0,dp(10),0,dp(6));return view;
    }
    private Button button(String text,LinearLayout parent,View.OnClickListener click) {
        Button view=new Button(this);view.setText(text);view.setOnClickListener(click);parent.addView(view);return view;
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        ScrollView scroll=new ScrollView(this);LinearLayout body=new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);body.setPadding(dp(20),dp(24),dp(20),dp(24));scroll.addView(body);setContentView(scroll);
        button("Back to Notes",body,v->finish());
        body.addView(label("Media downloads",26));
        body.addView(label("Prepared audio and videos, saved for offline use. The server copy is removed after verified delivery.",16));
        status=label("Loading downloads…",16);status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);body.addView(status);
        fetch=button("Fetch now",body,v-> { try { DeliveryJobs.fetch(this); } catch(Exception error) { status.setText(error.getMessage()); } });
        button("Pause current transfer",body,v->DeliveryJobs.stop(this));
        folder=label("Uses your selected phone-media folder.",14);body.addView(folder);
        button("Choose phone-media folder",body,v-> {
            if(DeliveryRunner.running()) { status.setText("Pause downloads before changing folders.");return; }
            Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            startActivityForResult(pick,91);
        });
        body.addView(label("Delivery settings",20));
        body.addView(label("Contabo media account · "+DeliveryProfile.HOST,14));
        password=new EditText(this);password.setSingleLine(true);password.setHint("Media password — leave blank to keep saved password");
        password.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        body.addView(password);
        DeliveryProfile profile=new DeliveryProfile(this);
        automatic=new CheckBox(this);automatic.setText("Automatically check about every 15 minutes");automatic.setChecked(profile.automatic());body.addView(automatic);
        wifi=new CheckBox(this);wifi.setText("Use unmetered connections only (usually Wi-Fi)");wifi.setChecked(profile.wifiOnly());body.addView(wifi);
        save=button("Save delivery settings",body,v-> {
            String secret=password.getText().toString();boolean auto=automatic.isChecked(),unmetered=wifi.isChecked();
            save.setEnabled(false);
            DeliveryRunner.FILES.execute(()-> {
                String message;
                try { new DeliveryProfile(this).save(secret,auto,unmetered);DeliveryJobs.periodic(this);message="Delivery settings saved."; }
                catch(Exception error) { message=error.getMessage(); }
                String result=message;
                runOnUiThread(()-> { save.setEnabled(!DeliveryRunner.running());password.setText("");status.setText(result); });
            });
        });
        body.addView(label("Android may delay background checks. Fetch now requests an immediate transfer. Downloads never start playback.",14));
        body.addView(label("Recent deliveries",20));recent=new LinearLayout(this);recent.setOrientation(LinearLayout.VERTICAL);body.addView(recent);
    }
    @Override protected void onStart() { super.onStart();visible=true;DeliveryRunner.observe(observer); }
    @Override protected void onStop() { visible=false;DeliveryRunner.forget(observer);super.onStop(); }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request!=91||result!=RESULT_OK||data==null||data.getData()==null)return;
        if(DeliveryRunner.running()) { status.setText("Pause downloads, then choose the folder again.");return; }
        int flags=data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        AudioRuntime.get(this).library.bind(data.getData(),flags,(op,durable,failure)-> {
            status.setText(failure==null?"Phone-media folder selected.":failure.getMessage());loadHistory();
        });
    }
    private void loadHistory() {
        DeliveryRunner.FILES.execute(()-> {
            try {
                DeliveryState state=new DeliveryState(getFilesDir());
                ArrayList<DeliveryState.Entry> entries=new ArrayList<>(state.entries.values());Collections.reverse(entries);
                String root=new AudioSpikeJournal(getFilesDir()).root();
                runOnUiThread(()-> {
                    if(!visible)return;
                    folder.setText(root.isEmpty()?"Choose your existing phone-media folder before fetching.":"Downloads use your selected phone-media folder.");
                    recent.removeAllViews();int count=0;
                    for(DeliveryState.Entry entry:entries) {
                        if(count++>=40)break;
                        recent.addView(label(entry.item.path+"\n"+("ACKED".equals(entry.phase)?"Saved · Server copy removed":"LOCAL".equals(entry.phase)?"Saved · Server cleanup pending":"Download incomplete"),14));
                        if(!entry.document.isEmpty())button("Open download",recent,v->open(entry));
                    }
                    if(entries.isEmpty())recent.addView(label("No deliveries yet.",14));
                });
            } catch(Exception error) { runOnUiThread(()-> { if(visible)status.setText("Could not read download history. Reopen Downloads to retry."); }); }
        });
    }
    private void open(DeliveryState.Entry entry) {
        try {
            Uri tree=Uri.parse(entry.root),uri=Uri.parse(entry.document);
            if(!AudioDocuments.AUTHORITY.equals(uri.getAuthority())||!DocumentsContract.isChildDocument(getContentResolver(),
                DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree)),uri))throw new java.io.IOException();
            String path=entry.item.path.toLowerCase(java.util.Locale.ROOT);
            String mime=path.matches(".*\\.(mp4|mkv|webm)$")?"video/*":path.endsWith(".srt")||path.endsWith(".txt")||path.endsWith(".vtt")?"text/plain":"audio/*";
            startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch(Exception error) { status.setText("This download is unavailable, or no installed player can open it. Opus, MP3 and M4B recordings also appear in Audio."); }
    }
}
