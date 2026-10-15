# macOS render tuning: preliminary M4 Max results

Hardware encoding accelerates the final compression stage. Source decoding,
browser compositing and frame capture can still dominate total export time.
Increasing the number of concurrent render tabs can make those stages slower.

## Observed workload

Measured on an Apple M4 Max (16 CPU cores, 64 GiB RAM), OpenChatCut's
`b3747ca6` checkout, Remotion 4.0.509, with VideoToolbox H.264 at 80 Mbps.
Two short 3840×2160/60 video-only test timelines used different 4K/59.94 HEVC
clips at roughly 100 Mbps, with playback rates of 1.494 and 1.579. They had no
titles, effects or audible audio. Source files were read from an external
volume. The serve bundle was prepared before timing; each measurement includes
browser setup, frame rendering and final encoding.

| Test segment | Render workers | Wall time |
| --- | ---: | ---: |
| A: 120 output frames | 13 (automatic on this machine) | 14.03 s; repeat 11.69 s |
| A | 8 | 9.41 s |
| A | 4 | 8.39 s |
| B: 180 output frames | 13 | 13.02 s |
| B | 4 | 9.62 s; repeat 9.56 s |

Four workers reduced elapsed time by about 26–28% versus the warm 13-worker
measurements. All test exports reported Apple VideoToolbox. Segment A retained
120 frames at each worker count, with identical decoded frame hashes after
scaling to 960×540 for comparison. This is a timing/consistency check, not a
lossless-quality claim or a measured speedup for an entire project.

A later check of the same segments included one and two workers:

| Test segment | 1 worker | 2 workers | 4 workers |
| --- | ---: | ---: | ---: |
| A | 12.62 s | 10.25 s | 9.92 s |
| B | 15.30 s | 11.74 s | 11.38 s |

One worker was slower in both cases. Two and four were close (about 3% apart),
and the four-worker timings varied between rounds. Four is a provisional local
choice, not proof of a universal optimum. A full 3,701-frame, 61.68-second edit
with music and a credit overlay rendered with four workers in 241.30 seconds;
there is no precisely timed full-project baseline here for a speedup claim.

## Test your own project

1. Keep the codec, output resolution, frame rate, bitrate, media and selected
   timeline range constant. Use representative motion and any effects you use.
2. Compare the automatic worker count with 4 and 8. For a source checkout,
   start the server with `OPENCHATCUT_RENDER_CONCURRENCY=4 npm run dev`.
   Stop the existing development server first; an already-running process will
   not pick up a new environment variable. An isolated profile's saved
   `settings.env` overrides a shell value, if that key is already saved there.
3. Measure more than once, alternate the order, and avoid competing renders.
   Keep cold bundle generation separate from render timing.
4. Check frame count, representative frames and audio before keeping the setting.
   Remove the override and restart to restore automatic selection.

## Further testing needed

These are short samples from one machine and a narrow video workload. Longer
timelines, effects, titles, transitions, audio, different storage, memory
pressure and other Apple Silicon models can change the best worker count.
Windows and Linux were not benchmarked. This finding does not justify capping
all Macs at four workers, and no platform's automatic default is changed here.

Remotion also recommends benchmarking concurrency because both excessive and
insufficient concurrency can reduce performance:
<https://www.remotion.dev/docs/performance#concurrency>.
