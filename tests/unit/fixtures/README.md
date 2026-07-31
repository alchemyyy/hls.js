# fMP4 opening-PTS collision fixture

These files came from a real FFmpeg 8.1.2 fMP4 HLS output. The captured media
segment was the fourth segment in a VOD playlist, at cumulative playlist time
18.477 seconds.

The initialization segment is unchanged. The media fixture keeps the original
`styp`, `sidx`, and `moof` boxes. To remove encoded media while retaining the
captured timing topology, every video `trun` sample-size field was set to zero
and the `mdat` was replaced with an empty eight-byte box. Durations, flags,
decode times, composition offsets, box ordering, and data offsets are unchanged.

Original SHA-256 values:

```text
init.mp4         190bbf22990ca45a41cf7bc1b0ea02605926e1d343104c9fd530677e4398433c
segment-003.mp4  c89ecce43e81f90b15adbc4d2e963508147f5f17d3c9149f436092bd04abf596
```

Minimized fragment SHA-256:

```text
f9bff2b7ff28dc231355b3c0b84a327f5e39414aa085fb9ae89f77a6f431f827
```

The opening video sample has DTS 294288 and CTO 2672, placing it at PTS
296960, where it collides with the next sample. The playlist and edit-list
timeline places it at PTS 298304, requiring CTO 4016.
