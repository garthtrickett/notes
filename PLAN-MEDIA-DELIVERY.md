# Native HTTPS media delivery

## Immediate media-ready wake-up — 5 November 2026

The user wants a download to start when a file is ready, without a tap or
waiting for the periodic check. Use Firebase project `notes-512403`, sender
`103880188180`, only to carry a generic media-ready hint. Media, credentials,
resume and receipt cleanup remain on the existing authenticated Contabo HTTPS
path. Register the native token through that same authenticated boundary; keep
server credentials off the phone and all tokens out of logs and JavaScript.

The receiver validates the sender/event and uses the actual received priority.
A HIGH hint starts a visible bounded data-sync service when the saved network
policy allows. Other hints or platform/network restrictions use a constrained
ordinary job. Do not label it user-initiated. Preserve automatic-off, Wi-Fi-only,
partial files, history, hashes, server originals and the periodic fallback.
Hints received while busy must not be discarded. No automatic playback.

Immediate is best effort: Android, offline/force-stop, notifications and network
constraints can delay starts. A signed release requires the chosen Firebase app
configuration. Live registration, push reception while closed/asleep and actual
saved receipts require separate phone qualification; prepared code and host
tests do not establish that behavior.

## HTTPS transport — 5 November 2026

The user now authorizes HTTPS directly on Contabo, replacing SFTP in Fetch
media. The existing manifest, immutable IDs, local SAF partials/history,
SHA-256 verification and receipt reconciler are shared across the migration.
An update resumes existing SFTP partials through HTTP byte ranges, with the
same selected folder, Keystore-encrypted password and scheduling settings.

The fixed endpoint is `https://84.247.159.188/notes-media/v1/`. Only the bundled
private server certificate is trusted for this connection, using platform
PKIX and hostname verification. Its key remains on Contabo. Credentials never
follow redirects. No global trust configuration or other app networking is
changed. Certificate renewal/rotation requires preserving the pinned identity
or shipping a successor trust anchor before changing the server certificate.

Authenticated GET manifest/payload/ack and POST receipt are the entire API.
Payload responses must have the expected length and SHA-256 ETag. Resuming
requires HTTP 206 and the exact Content-Range; a server ignoring Range is
rejected before appending. Empty/already-complete partials proceed to existing
local verification. Responses are uncompressed and bounded metadata stays
native. No media uses Railway, GitHub, JavaScript or an unauthenticated URL.

Only the existing host receipt worker deletes originals after validating the
phone's stored receipt against the registry and payload. Downloads, aborts,
HTTP errors and rejected receipts do not authorize cleanup. Repeated/lost
receipt/ack responses remain idempotent. The old jailed SFTP endpoint stays
available for older installed versions during rollout; updated Notes uses
HTTPS without silently falling back to SFTP.

Required checks: real TLS trust/hostname/auth rejection; full/range downloads,
ignored/invalid range and changed identity; exact payload hash; old partial
resume; receipt replay and cleanup only after commit; unchanged existing native
regressions and signed upgrade identity. Device speed, interruption/resume and
background operation require separate phone evidence after installation.

## Original SFTP implementation (historical)

User authorized native SFTP delivery on 24 October 2026, replacing the proposed
HTTPS service. One phone, existing Contabo host and jailed SFTP account.

## Behaviour

Audio → Fetch media opens an in-app native delivery screen. Configure the
existing server/password once, reuse the selected local phone-media folder,
fetch now, optionally check every 15 minutes, show progress/retry/cleanup state.
Completed Opus/M4B files use the existing player. Other delivered formats can
open in an installed player; this change does not claim new codec qualification.

All bytes stay native. No media enters GitHub, JavaScript, app backup or logs.
Credentials use Android Keystore encryption in app-private preferences. Pin the
server's existing ED25519 fingerprint; never accept an arbitrary changed key.

## Protocol and integrity

Use a separate `/inbox` bind mount in the existing SFTP jail so FolderSync's
`/media` pair cannot consume or delete native test/download files. Host publisher
assigns immutable IDs, SHA-256, length and relative destination names. It makes
complete payloads readable and publishes the manifest atomically. Payloads are
read-only to the SFTP account; only the receipts directory is writable.

Phone downloads to an owned hidden partial within the selected SAF tree,
resumes by byte offset, verifies exact length/hash, publishes to the final
relative destination without overwriting different existing bytes, persists
the local result, then uploads a matching receipt atomically. A host worker
validates that receipt and the immutable payload before deleting only that
payload; it retains an idempotent acknowledgement. Receipt retries never imply
another download, and a user-deleted delivered download is not fetched again.

Native JobScheduler handles bounded resumable automatic work; Android 14+
user-started transfers use user-initiated jobs with a progress notification.
Older versions use a user-started data-sync service. Jobs and state are separate
from vault/alarm work and from audio bookmarks. Opening or downloading never
starts playback. Cancellation, network loss, low storage, folder changes and
process death retain server originals until a verified local commit.

## Required evidence

- Server tests: untrusted paths/receipts, hash mismatch, repeated/lost receipts,
  publication and cleanup interruption; unrelated media untouched.
- Native tests: manifest bounds, resume/checksum, pending receipt recovery,
  same-name conflicts, SAF grant/root changes, worker scheduling/notification.
- Existing web/native regressions and release packaging; unchanged signer and
  preserved alarms/widget/audio/update behaviour.
- Actual phone: configure, fetch/play ordinary Opus/M4B, verify server cleanup,
  interrupt/resume and confirm a scheduled closed-app fetch. Report unexecuted
  phone checks as unverified, never passing from a host test alone.

No HTTPS server, Railway deployment, new agent, new persistent goal, root access
on the phone or change to the paused Syncthing share is required.

## Host qualification (24 October)

The live isolated SFTP probe verified pin matching/rejection, jail isolation,
read-only payload access, exact bytes/hash, repeated receipts and cleanup acks.
A setgid inheritance bug was caught and fixed before phone publication.
Automatic directory setup must not chmod a setgid group the process does not
belong to. SSHJ uses a separate provider alias for bundled cryptography so it
cannot accidentally bind to Android's reduced provider named BC; the platform
provider is preserved. This is host evidence; phone runtime qualification remains
required. Existing app regression suites and signed-release checks are recorded
in the release handoff, not inferred from this plan.
