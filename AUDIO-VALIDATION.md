# Audio implementation and acceptance evidence

The full outcome remains `PLAN-AUDIO.md`: see local recordings, background
playback, durable bookmarks/Done marks, and physical deletion without server
deletion or restoration. Initial phone access is confirmed; reboot, playback and
deletion acceptance gates remain open.

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
- Phone: Android 17 (API 37), Notes 1.0.59, local read/write grant and 27 audio
  files confirmed by screenshot. Syncthing folder type, Ignore Delete, ignore
  patterns and lifecycle behaviour remain **unverified**.
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
| Server originals and unrelated files remain unchanged | Private SHA-256 baseline of 76 pre-existing files recorded; after-deletion comparison pending |
| Opus/M4B locked-screen playback and headset controls | Native spike built and host-tested; actual phone pending |
| Native checkpoints, marks, explicit cold resume, alarm coexistence | Implemented in native spike; host durability/cold-start tests pass; actual phone pending |
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
- The release identifies the exact merged source. Installation and initial
  access are confirmed below. Synthetic specimens are ready on the server; delivery was
  pending at the initial server observation because the phone was disconnected.

### Phone observation received

On 22 October the user initially reported that both formats appear. Their
subsequent screenshot directly confirms **Android 17 (API 37), Notes 1.0.59,
read/write grant, and 27 Opus/M4B files enumerated**. It shows ordinary recordings
where the named disposable specimens and their buttons would appear first.
Visibility of the two specifically named test copies is therefore **not yet
verified**; ordinary format visibility must not be substituted for specimen
delivery. The server still holds both test copies with their original SHA-256
values. The user subsequently opened Syncthing and reported it connected; the
server API independently confirms that connection and active transfer. At
04:43 UTC the server index reported both exact named specimens available on the
phone, rather than temporary files, while other media was still transferring.
The user has been asked to Refresh Notes and confirm those exact names and their
controls. Phone visibility remains unverified until that reply; no deletion has
been requested or acknowledged.
Cancellation, byte removal, rescan/reconnect/restart/reboot behaviour, and the
phone's Syncthing configuration remain unverified. Private media titles in the
screenshot are not copied into this public repository.

## Delivered playback diagnostic

- [PR #2](https://github.com/garthtrickett/notes/pull/2) merged as
  `e8ceb87e2c5c3e2bb5b58f5723dd75e0276ff45e`.
- [Signed build 60](https://github.com/garthtrickett/notes/actions/runs/39723311880)
  passed native tests, signing and rolling-release publication after a runner
  queue delay. The downloaded APK was separately checked against the release's
  source/version, package identity and original signing certificate.
- APK: `com.garthtrickett.notes`, versionCode **60**, versionName **1.0.60**.
- APK SHA-256: `629afee69c736b6e1f73b77c323f48a49806509dbd45513dc756a9881841a2a3`.
- The user has been asked to install this update and test an ordinary Opus file
  with the phone locked. Installation and playback are **not yet confirmed**.

## Playback/durability spike — source and host evidence

The playback branch has a native listening transition core, an immutable ledger of
known file versions and deletion intents, and a checkpoint writer retaining the
prior validated version. Corrupt-primary recovery is explicit, reports possible
loss of newer bookmarks/marks and preserves the damaged original before restore.
Unknown schemas cannot fall back and overwrite a newer app's state. An uncertain
write faults the writer until disk is reopened, so a retry cannot blindly erase
an intent whose commit status was unclear.

One Media3 `MediaSessionService` now owns the player independently of Activities
and the WebView. The native **Audio playback test** screen opens from the storage
test. It provides local Opus/M4B selection, explicit Play/resume, Pause, seek,
Done/Unplayed, saved history and explicit prior-checkpoint recovery. It does not
enable deletion of ordinary recordings or implement the final Audio mode.

Media3 exoplayer/session/inspector are aligned at **1.11.1**. Playback preparation
identifies the file, probes local metadata, then re-identifies before committing
the listening state. Hash/probe work is cancellable and separate from the single
checkpoint writer. Checkpoints run every 15 seconds during playback and on
pause/seek/end/item change. Cold service creation never loads a saved playlist or
starts foreground playback. Session callbacks refuse caller-supplied media IDs
and URIs. Notes alarms explicitly pause an existing player before posting their
notification; alarm scheduling and sound settings are unchanged.

All **44 native tests** pass, including the 15 tests in build 59. Coverage includes
fault-injected persistence coordination, schema validation, stale catalogue
capabilities, replacement versions, Android AtomicFile reopen/recovery, and
Media3 cold-service startup with saved progress and a forged preparation intent.
Android-framework tests use Robolectric 4.16.1 at API 36; these are not evidence
of API 37 phone playback. The local release APK compiles successfully.
Actual process death, codecs, lock/headset controls, focus, alarm sound and
device power/lifecycle behaviour still require qualification on the phone.

The web seam also has tested snapshot-ordering functions: callbacks cannot
establish a new epoch, stale roots/revisions are refused, and a handshake
reconciles updates received between subscription and the initial snapshot.
The complete web suite passes **822 tests**, TypeScript check and Vite build.
Wiring and testing the actual native/JavaScript subscription lifecycle and full
SAM Audio UI remain outstanding.

### Additional host extractor qualification

The follow-up `audio-probe-qualification` branch adds the two synthetic tones as
test resources and exercises the actual Media3 Inspector against local files.
The complete native suite passes **47 tests, 0 failures**: both Ogg/Opus and
MP4/AAC-in-M4B expose audio tracks, approximately five-second durations and their
embedded title, without inventing an author. Pre-cancelled preparation refuses
to open a file. These tests do not qualify audio decoders or audible output.

The first attempt used Robolectric's legacy Looper simulation and timed out;
the instrumentation-style threading mode permits the real extractor threads.
The next run exposed an incorrect test expectation for filename fallback: both
fixtures contain real title metadata. Correcting that expectation yielded the
47-test pass. No production playback code changed for these checks. The new
tests are additional to the 44 tests in the source of build 60.

### Native snapshot connection follow-up

The `audio-native-bridge` branch now exposes native snapshot/refresh methods and
an `audioState` subscription. It sends metadata, history and player position with
the native epoch/root-generation/revision stamp; provider grants, document IDs,
fingerprints and audio bytes remain native. Connecting reads saved state without
scanning or starting playback. WebView teardown removes the native subscriber
without owning or stopping the media service. No ordinary-file deletion or full
Audio UI is enabled by this branch.

Host evidence: the complete web suite passes 836 tests, TypeScript check and
build; the native suite passes 51 tests and release APK packaging. New tests cover
subscription-before-handshake ordering, epoch/root changes, same-process
reconnection, failed/malformed messages, listener ownership, cancellation during
registration/handshake and unsupported browsers. Android tests exercise the
actual serializer and plugin lifetime against an empty Media3 service, not
audible background playback. A shared JSON snapshot fixture additionally checks
that the native serializer and web parser agree on the wire contract.
The shared-fixture assertions pass in a focused native follow-up; the final web
typecheck/build passes after fixing a test-only expected-value type annotation.
This branch is not in build 60; command wiring and full UI remain outstanding.

### Playback phone procedure for signed build 60

1. Open Settings → Audio storage test → Audio playback test. Pick a local Opus
   recording and tap Play. Lock the phone, use its media notification and headset
   Play/Pause, and unplug headphones. Report whether playback/control/pause work.
2. Seek, pause, leave and reopen the screen. Check the saved bookmark. Mark Done,
   then Play again (zero); mark Unplayed (paused at zero). No next item should
   start at natural end. Repeat with the M4B audiobook.
3. While playing, use Notes normally, recreate the Activity and swipe Notes from
   Recents. Separately force-stop Notes and reopen: nothing should autoplay;
   explicit Play must resume the last saved checkpoint (up to 15 seconds lost).
4. Ring a Notes alarm during playback: it must pause audio and remain audible.
   Check existing note editing, sync and reminders. Record the exact app build.

This procedure does not substitute for the separate storage/Syncthing deletion
gate or the final full-library acceptance and one-week trial.
