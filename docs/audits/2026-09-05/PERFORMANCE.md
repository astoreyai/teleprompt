# Read-only workload measurements

The matched pair compares installed 1.0.3 with the 1.1.0 candidate whose application archive is `918e5a1428b426d8a247dcbcdea4c159b3ca4e0c423c19d6a14689eacc811e9c`. This candidate predates the final startup and document-delivery corrections. Measurements belong to this exact archive and must not be relabeled as measurements of a later build.

Both runs used identical real input bytes, mtimes, settings, and workload code: the installed TypeScript implementation (9,112,572 bytes), its declaration file (588,085 bytes), and the repository README and security policy. Source files remained unchanged. The workload repeatedly selected/reloaded files, changed layout, played and sought, then confirmed selection and settings after restart. These are file-reading measurements, not comparisons with the earlier editor/paste workload.

| Measurement | Installed 1.0.3 | Read-only candidate |
| --- | ---: | ---: |
| Requested workload | 300 seconds | 300 seconds |
| Complete cycles | 203 | 197 |
| Peak private process-tree memory | 2.069 GiB | 1.502 GiB |
| Median private memory, last 60 seconds of sampling | 1.002 GiB | 0.910 GiB |
| Median cycle | 194 ms | 194 ms |
| 95th-percentile cycle | 3.682 s | 3.900 s |
| Slowest cycle | 4.209 s | 5.546 s |

Peak memory decreased 27.4%; the final-minute median decreased 9.2%. These single paired observations establish neither a latency improvement nor leak freedom. The final minute still revisits the large file. Samples do not identify the active file, so they cannot establish small-file memory stability after five minutes. A separate controlled large-to-small test observed 788.3 MiB on 1.0.3 versus 177.7 MiB on the first read-only candidate; the restored-file case remained approximately 221 MiB. Those transition checks are separate from this workload.

The sampler reads `/proc/PID/smaps_rollup` across descendants from every process thread. Private memory avoids double-counting shared pages, unlike summed RSS. Sampling starts after launch and ends before shutdown/restart. Tests used isolated Xvfb with hardware acceleration disabled; these are not measurements of the user's physical compositor or GPU. The historical 7.2 GiB summed-RSS result came from pathological editor automation and is not a comparable measure of private memory in normal reading.

[Machine-readable results](evidence/read-only-comparison.json) include input hashes, exact archive identities, timing windows, and aggregate measurements. Raw local process samples remain under `.release-local/readonly-stress-*-5min.json`. README and SECURITY were updated after this paired run to document the new product contract; their current bytes therefore differ from these recorded input revisions.

Further memory reduction for very large active scripts remains a performance opportunity. This release's bounded operator preview and removed editor/voice paths do not make full overlay layout memory-free, and the parser watchdog does not cap renderer memory.
