# Native SFTP media delivery

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
