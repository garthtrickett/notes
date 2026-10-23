package com.garthtrickett.notes;

import java.security.Provider;
import java.security.Security;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import net.schmizz.sshj.common.SecurityUtils;

// Android already has a reduced provider named BC. Do not replace it, or let
// SSHJ accidentally select it instead of the library version bundled here.
final class DeliveryCrypto {
    static final String NAME="NotesSftpBC";
    static synchronized void install() {
        if(Security.getProvider(NAME)==null) {
            Provider isolated=new Provider(NAME,1.84,"Notes SFTP cryptography") {};
            new BouncyCastleProvider().forEach((key,value)-> {
                if(!key.toString().startsWith("Provider.id "))isolated.put(key,value);
            });
            Security.addProvider(isolated);
        }
        SecurityUtils.setSecurityProvider(NAME);
    }
}
