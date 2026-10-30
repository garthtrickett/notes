These are synthetic five-second mono sine tones generated for the Notes storage
and playback qualification. They contain no user recordings or speech.

| File | Container / codec | Tone / sample rate | SHA-256 |
| --- | --- | --- | --- |
| notes-audio-storage-test.opus | Ogg / Opus | 440 Hz / 48 kHz | 524f6a15b9bb88db8c759d08c248c8fa6c5f772cd310aa9f20be2dd60f1b10f5 |
| notes-audio-storage-test.m4b | MP4 / AAC | 660 Hz / 44.1 kHz | 152edae6de91f04edf087ddbb326702d519187c550fce68e3c32fea50c3d2e39 |
| notes-audio-storage-test.mp3 | MP3 / MPEG Layer III | 880 Hz / 44.1 kHz | 31b5f10d1212f1dedc2e3d2b72cfcabd5dae0c176c47421451b80cc30e255e4c |

All three tones carry the title metadata `Notes audio storage test`, with no artist.
Host extractor tests establish audio tracks, duration and this real metadata;
decoder support and audible output still require real-phone testing.
