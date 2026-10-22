# Audio implementation and acceptance evidence

The full outcome remains `PLAN-AUDIO.md`: see local recordings, background
playback, durable bookmarks/Done marks, and physical deletion without server
deletion or restoration. No phone gate has passed yet.

## Storage spike — 22 October 2026

The Android Settings screen has an **Audio storage test** entry. This diagnostic
uses the local documents provider and persists a tree grant. Enumeration and
hashing run on a bounded native worker, separate from the WebView. Enumeration
allows only completed `.opus` and `.m4b` files under `youtube/`, `podcasts/`, and
`audiobooks/`. It displays at most 100 ordinary files plus the two test specimens.
This is not yet the library or a claim of playback support.

Deletion is limited in native code to these synthetic, disposable test copies:

- `youtube/notes-audio-storage-test.opus`: five-second tone, Ogg/Opus, mono 48 kHz.
- `audiobooks/notes-audio-storage-test.m4b`: five-second tone, MP4/AAC, mono 44.1 kHz.

Preparing deletion fingerprints one file without writing a deletion intent.
Confirmation writes and fsyncs the exact identity, rehashes it, checks the write
grant, deletes through SAF, verifies absence by successfully listing its parent,
and saves the outcome before acknowledging it. Recovery observes the saved
identity; it never automatically replays deletion. If a test copy returns,
Refresh reports it. Only one test deletion is tracked at a time: run the complete
rescan/reconnect/restart sequence on one specimen before testing the other.

This experiment does not change Syncthing settings or ignore patterns, delete
server files, or start playback. A pending deletion blocks switching roots until
it is reconciled. A corrupt or future journal disables deletion and retains its
original file. Its native journal is `audio-storage-spike.json` in app-private
storage; it is diagnostic state, not the final player-state schema.

### Observed environment

- App source starts at the reviewed plan commit `6dc1f26`.
- Server share: send-only, Ignore Delete false, filesystem watcher enabled,
  rescan interval 300 seconds; observed via its local Syncthing API.
- Phone Syncthing folder type, Ignore Delete, ignore patterns, Android version,
  provider grants and lifecycle behaviour remain **unverified**.
- No phone is attached to the host's ADB server. Phone steps require the user.
- Web validation: `bun test` **816 pass, 0 fail**, `bun run check` and
  `bun run build` pass. Native unit tests pass (15 tests, including existing
  alarms). `cd android && ./gradlew testReleaseUnitTest assembleRelease
  --no-daemon --max-workers=2` passes and produces the unsigned local release APK.
  The initial local packaging attempt failed because the existing
  release signing config was assigned without a local keystore. The conditional
  assignment is corrected and revalidated. CI retains the
  original release keystore and mandatory signature verification.
- A host APK build proves compilation only; installed-device behaviour is
  recorded separately below.

### Phone storage procedure

1. Install the signed Notes update through the existing update banner. Do not
   uninstall Notes or clear app data. Open Settings → Audio storage test.
2. Cancel folder selection once; check that Notes still works. Reopen the test,
   select the **phone-media folder on local storage**, and allow its grant.
   Report the Android/build line, whether access is read/write, and whether both
   disposable files appear. Check that the ordinary listing excludes video,
   partials, hidden files and Syncthing conflicts. Private titles need not be shared.
3. In phone Syncthing, inspect Phone media's Folder Type, Ignore Delete and
   ignore patterns. Record these without device IDs or private content. Do not
   change the settings, use Override Changes, or use Revert Local Changes.
4. Prepare deletion of the Opus test copy, cancel, and check it is still present.
   Prepare again and confirm; report **Verified absent from the phone folder**.
   Verify in the phone's file manager that the test file is gone. The operator
   separately checks the server specimen's SHA-256 and unrelated server files.
5. Rescan on the phone and server; reconnect Syncthing; restart the phone's
   Syncthing app; reboot the phone. After each step, use Refresh in the diagnostic
   and check the file manager. The test copy must stay absent and Notes must
   retain access after reboot. Report any return or access error exactly.
6. Repeat the complete sequence for the M4B test copy. Exercise permission
   revocation/reselection and verify existing notes and alarms still work.

If deletion returns a file or affects another device's bytes, do not proceed
to the full library UI. Investigate an exact per-file phone-side exclusion and
document and test a successor integration before implementing it.

## Gate ledger

| Gate | Current evidence |
| --- | --- |
| Storage access survives reboot | Pending actual phone |
| Deletion survives rescan/reconnect/app restart/phone reboot | Pending actual phone, both specimens |
| Server originals and unrelated files remain unchanged | Baseline/after comparison pending |
| Opus/M4B locked-screen playback and headset controls | Not implemented/tested yet |
| Native checkpoints, marks, explicit cold resume, alarm coexistence | Not implemented/tested yet |
| Full Audio UI and offline journey | Awaiting spike gates |
| Automated regression and exact signed build | Record checks/build per delivered increment |
| Complete phone acceptance and one-week usability trial | Pending; full goal remains active |

## Delivered storage diagnostic

- [PR #1](https://github.com/garthtrickett/notes/pull/1) merged as
  `b5b64c7803a77480ab4d65eb684f0a7ab0057b92`.
- [Signed build 59](https://github.com/garthtrickett/notes/actions/runs/39717716028)
  passed, including the native unit tests, signing and publication steps.
- APK: `com.garthtrickett.notes`, versionCode **59**, versionName **1.0.59**;
  certificate SHA-256 matches the prior published build 58.
- APK SHA-256: `c2693b40eadf7e51d1f9bebc0de78fdcca61e8c1c112e31c484e5b2b2cf464be`.
- The release identifies the exact merged source. Installation and phone tests
  remain unverified. Synthetic specimens are ready on the server; delivery was
  pending at the initial server observation because the phone was disconnected.

### Phone observation received

On 22 October the user initially reported that both formats appear. Their
subsequent screenshot directly confirms **Android 17 (API 37), Notes 1.0.59,
read/write grant, and 27 Opus/M4B files enumerated**. It shows ordinary recordings
where the named disposable specimens and their buttons would appear first.
Visibility of the two specifically named test copies is therefore **not yet
verified**; ordinary format visibility must not be substituted for specimen
delivery. The server still holds both test copies with their original SHA-256
values, and its API reports the phone disconnected at this observation.
The next step is to reconnect phone Syncthing, refresh Notes, and establish
visibility of the named specimens before requesting their deletion.
Cancellation, byte removal, rescan/reconnect/restart/reboot behaviour, and the
phone's Syncthing configuration remain unverified. Private media titles in the
screenshot are not copied into this public repository.

## Playback/durability spike in progress

The next branch has a native listening transition core, an immutable ledger of
known file versions and deletion intents, and a checkpoint writer retaining the
prior validated version. Corrupt-primary recovery is explicit, reports possible
loss of newer bookmarks/marks and preserves the damaged original before restore.
Unknown schemas cannot fall back and overwrite a newer app's state. An uncertain
write faults the writer until disk is reopened, so a retry cannot blindly erase
an intent whose commit status was unclear.

All **34 native JVM tests** pass, including the 15 tests in build 59. These include
fault-injected persistence coordination and schema validation. The Android atomic
file driver, actual process death and device power/lifecycle behaviour still need
device qualification. The new core is not yet connected to Media3, the plugin,
or a UI and does not yet provide playback or saved listening marks in the app.

The web seam also has tested snapshot-ordering functions: callbacks cannot
establish a new epoch, stale roots/revisions are refused, and a handshake
reconciles updates received between subscription and the initial snapshot.
The seven focused audio tests and TypeScript check pass. Wiring and testing the
actual native subscription lifecycle remain part of the playback spike.
