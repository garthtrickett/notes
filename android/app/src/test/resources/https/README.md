These are disposable **test-only** TLS credentials for the loopback HTTPS peer.
The private key is intentionally public and must never be used for deployment.
The certificate identifies 127.0.0.1; tests also reject it for localhost and
reject it when only the production media certificate is trusted.

The actual Contabo private key is outside this repository. Only its public
certificate is bundled in DeliveryTls for this one endpoint.
