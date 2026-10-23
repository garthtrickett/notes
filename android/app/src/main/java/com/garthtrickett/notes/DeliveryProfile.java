package com.garthtrickett.notes;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.IOException;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.charset.StandardCharsets;

final class DeliveryProfile {
    static final String HOST="84.247.159.188", USER="media-phone";
    static final String FINGERPRINT="SHA256:w9MCJ3q6PPzMPJNYJMv0+yQC68yGGkH8Lcg4iWr9b08";
    private static final String ALIAS="notes-media-delivery";
    final SharedPreferences prefs;
    DeliveryProfile(Context context) { prefs=context.getSharedPreferences("notes.media.delivery",Context.MODE_PRIVATE); }
    boolean configured() { return prefs.contains("secret"); }
    boolean automatic() { return prefs.getBoolean("automatic",true); }
    boolean wifiOnly() { return prefs.getBoolean("wifiOnly",true); }
    private SecretKey key() throws Exception {
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (!keys.containsAlias(ALIAS)) {
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey)keys.getKey(ALIAS,null);
    }
    void save(String password, boolean automatic, boolean wifiOnly) throws IOException {
        try {
            SharedPreferences.Editor edit=prefs.edit().putBoolean("automatic",automatic).putBoolean("wifiOnly",wifiOnly);
            if (!password.isEmpty()) {
                Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,key());
                edit.putString("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP));
                edit.putString("secret",Base64.encodeToString(cipher.doFinal(password.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));
            } else if (!configured()) throw new IOException("Enter the media account password first.");
            if (!edit.commit()) throw new IOException("Could not save delivery settings.");
        } catch(IOException error) { throw error; }
        catch(Exception error) { throw new IOException("Could not protect the media password on this phone.",error); }
    }
    String password() throws IOException {
        try {
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(prefs.getString("iv",""),Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(prefs.getString("secret",""),Base64.NO_WRAP)),StandardCharsets.UTF_8);
        } catch(Exception error) { throw new IOException("Re-enter the media password in Downloads settings.",error); }
    }
}
