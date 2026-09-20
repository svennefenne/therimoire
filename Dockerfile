# Stage 1: Build frontend
# Pinned to BUILDPLATFORM: the Vite bundle is architecture-independent, so on a
# multi-arch build this stage runs once natively instead of once per target
# platform (the arm64 pass would otherwise run the whole build under QEMU).
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Python dependencies (compilers live here, not in the runtime image)
FROM python:3.12-slim AS backend-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
# Strip debug symbols from the compiled extensions (pymupdf, uvloop, cryptography
# and friends ship them unstripped). --strip-unneeded leaves the dynamic symbols
# needed for linking, so this is a pure size win: ~40 MB off the runtime image.
# `strip` comes from binutils, already present as a dependency of gcc/g++ above.
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt \
    && find /install -name '*.so*' -type f -exec strip --strip-unneeded {} + || true \
    && rm -rf /install/lib/python3.12/site-packages/pymupdf/mupdf-devel \
    && find /install -name '__pycache__' -type d -prune -exec rm -rf {} +

# Stage 3: Build a purpose-restricted ffmpeg for animated-map thumbnails and
# mp3 -> chaptered m4b audiobook conversion
#
# Animated battlemaps (.webm/.mp4) need exactly one decoded frame, which Pillow
# then resizes like any other thumbnail, and converting an mp3 audiobook to a
# chaptered .m4b needs an mp3 decoder, the native AAC encoder, and the mp4/m4b
# muxer. Every off-the-shelf way to get any of this is wildly out of proportion
# to what it's used for: imageio-ffmpeg bundles a 76 MB static binary,
# `apt-get install ffmpeg` pulls 430 MB across 202 packages, and PyAV lands at
# 115 MB — almost all of it codecs and a codec/X11 dependency chain this image
# spends real effort elsewhere avoiding.
#
# Configuring ffmpeg down to exactly the decoders/encoders/muxers those two
# features can plausibly use gives a ~6 MB binary that still links only
# libc/libm/libz — all already in the runtime — so it adds no packages and no
# shared libraries at all. The two features share one binary rather than each
# getting their own build: they overlap on zlib/swscale/swresample already,
# and a second copy of the same object files would just be dead weight.
#
# --enable-zlib is not optional despite nothing here compressing video: the PNG
# *encoder* needs it, and without it the build silently produces a binary that
# demuxes and decodes correctly, then dies with "Unknown encoder 'png'".
#
# --enable-swresample and the aformat/aresample filters exist for exactly one
# reason: joining several mp3s whose sample rate or channel count don't quite
# agree (a common real-world case for audiobooks ripped chapter-by-chapter
# over time) needs the concat filter's inputs normalised first, or ffmpeg
# refuses to concatenate them at all.
#
# The muxer is named "ipod", not "mp4" — cosmetic-looking, but load-bearing:
# ffmpeg's own extension-to-muxer table only maps ".m4b" to the "ipod" muxer
# (mp4's own extensions field is just "mp4"), so naming the wrong one here
# would silently produce a file ffmpeg itself can't auto-detect an output
# format for from a .m4b filename. Enabling it also registers the plain "mov"
# muxer for free (same object file, no extra size) — harmless, and not worth
# fighting configure's dependency resolution to avoid.
#
# The "ffmetadata" *muxer* (as opposed to the demuxer above, which feeds our
# own hand-written chapter list into the encode) closes a second, separate
# gap: indexer/audio_chapters.py reads chapters back out of any M4A/M4B by
# shelling out to `ffmpeg -i <file> -f ffmetadata -`, i.e. dumping the
# container's chapter atoms as ffmetadata text rather than parsing the MP4
# box structure by hand (mutagen has no API for it). That dump target is the
# muxer, not the demuxer, and until now it was never enabled, so this build
# could WRITE working chapters into a freshly-converted .m4b but not READ
# them back out again — every audiobook converted in this image would land
# in the library with an empty chapter list even though the file itself was
# fine. Enabling it costs nothing extra (ffmetadata's muxer and demuxer are
# the same small object file) and makes both directions symmetric.
FROM debian:bookworm-slim AS ffmpeg-builder

ARG FFMPEG_VERSION=7.0.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    yasm \
    nasm \
    pkg-config \
    curl \
    ca-certificates \
    xz-utils \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /ffmpeg
RUN curl -fsSL "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    | tar xJ --strip-components=1

# vp8/vp9 cover .webm, h264/hevc cover .mp4, av1 is the emerging third; mjpeg and
# rawvideo are cheap insurance for oddly-muxed exports. matroska and mov are the
# only two containers those ship in. mp3/mpegaudio/ffmetadata/ipod and the aac
# encoder are audiobook conversion's half — see the stage comment above. The
# ffmetadata *muxer* (added alongside its demuxer) is what lets the indexer
# read chapters back out of any M4A/M4B, ours or a pre-existing one.
#
# The aac *decoder*, the silencedetect filter, the null muxer, and pcm_s16le/
# wav round out a third feature: services/audiobook_chapter_detect.py listens
# for spoken "Chapter N" markers in an audiobook that has no chapter data of
# any kind (see that module's docstring). Until now this build could read an
# M4A/M4B's container-level metadata but never decode its actual audio —
# reasonable when nothing needed to listen to the file, but detection has to:
# silencedetect finds the pauses that plausibly mark a chapter break, reported
# through stderr against a discarded `-f null` output (the muxer that writes
# nothing at all — needed here since this build has no real "junk" format to
# point a real-output-discarding pass at otherwise), and each candidate is
# then decoded to a short mono 16kHz PCM WAV snippet (pcm_s16le + the wav
# muxer) for an offline speech-to-text pass (see the vosk-model stage below).
# Same reasoning as everything else in this build: cheap to add (aac's
# decoder shares most of its tables with the encoder already compiled in) and
# keeps this a single self-contained binary rather than reaching for a
# second, general-purpose ffmpeg.
RUN ./configure \
        --disable-everything \
        --disable-autodetect \
        --disable-doc \
        --disable-network \
        --disable-debug \
        --disable-programs \
        --enable-ffmpeg \
        --enable-zlib \
        --enable-swscale \
        --enable-swresample \
        --enable-decoder=vp8,vp9,h264,hevc,av1,mjpeg,rawvideo,mp3,aac \
        --enable-demuxer=matroska,mov,mp3,ffmetadata \
        --enable-parser=vp8,vp9,h264,hevc,av1,mjpeg,mpegaudio,aac \
        --enable-muxer=image2,image2pipe,ipod,ffmetadata,wav,null \
        --enable-encoder=png,mjpeg,aac,pcm_s16le \
        --enable-protocol=file,pipe \
        --enable-filter=scale,null,concat,aformat,aresample,silencedetect \
    && make -j"$(nproc)" \
    && strip ffmpeg

# Stage 3b: Vosk speech-recognition model for spoken chapter-marker detection
#
# services/audiobook_chapter_detect.py only ever transcribes a few seconds of
# audio at a time, around a detected silence gap — never the whole book — so
# a small, CPU-only model is enough. The "small" English model (~40 MB
# compressed) trades some accuracy on unusual phrasing for a fraction of the
# footprint of a general-purpose model like Whisper, which would need
# PyTorch or CTranslate2 on top of a larger model just to run on CPU.
# Downloaded once at build time and baked into the image so a freshly
# started container has no network dependency at runtime, same as the
# ffmpeg binary above.
FROM debian:bookworm-slim AS vosk-model

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /model
RUN curl -fsSL -o model.zip \
        https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip \
    && unzip -q model.zip \
    && rm model.zip

# Stage 4: Runtime base shared by both variants (no build toolchain)
FROM python:3.12-slim AS runtime-base

WORKDIR /app

# `unar` (RAR extraction for .cbr cover thumbnails) is installed per final stage
# rather than here — see the comment on the slim stage for why.

# Bring in the pre-built Python packages from the builder stage.
COPY --from=backend-builder /install /usr/local

# The purpose-built ffmpeg used for animated-map thumbnails and mp3 -> m4b
# audiobook conversion. Path matches FFMPEG_BINARY in both
# backend/indexer/video_frames.py and backend/services/audiobook_convert.py;
# both modules degrade gracefully if it is ever absent (no thumbnail; a clear
# "rebuild the image" error on conversion), so this stays a single
# self-contained file rather than something either feature hard-depends on.
COPY --from=ffmpeg-builder /ffmpeg/ffmpeg /usr/local/bin/ffmpeg

# Bundled Vosk model for spoken chapter-marker detection (see the vosk-model
# stage comment above). Path matches VOSK_MODEL_PATH in
# backend/services/audiobook_chapter_detect.py; that module degrades to a
# clear "rebuild the image" error if it's ever absent, same as the ffmpeg
# binary above.
COPY --from=vosk-model /model/vosk-model-small-en-us-0.15 /app/models/vosk-model-small-en-us-0.15

COPY backend/ ./backend/
COPY alembic.ini ./alembic.ini
# Read and parsed at runtime by /api/changelog for the About dialog.
COPY CHANGELOG.md ./CHANGELOG.md
# Fallback version source when the image is built without --build-arg
# APP_VERSION (the released images always pass it).
COPY VERSION ./VERSION
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

RUN mkdir -p /data /library

# Empty by default so an image built without --build-arg falls through to the
# VERSION file copied above rather than reporting a literal "dev".
ARG APP_VERSION=""
ARG COMMIT_HASH="dev"
ENV APP_VERSION=${APP_VERSION}
ENV COMMIT_HASH=${COMMIT_HASH}
ENV PYTHONUNBUFFERED=1

EXPOSE 9481

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9481/api/health', timeout=4).status == 200 else 1)" || exit 1

ENV WORKERS=2
CMD ["sh", "-c", "exec python -m uvicorn backend.main:app --host 0.0.0.0 --port 9481 --workers ${WORKERS}"]

# Stage 5a: Slim variant — no OCR engine. Grimoire degrades gracefully: image-only
# PDFs stay excluded from full-text search, exactly as before OCR was added. Built
# with `--target slim` and published under the `-slim` tag family.
FROM runtime-base AS slim

# `unar` provides RAR extraction for rarfile (used to render .cbr cover
# thumbnails); without it .cbr archives are still served, just without a cover.
# It is the only tool in Debian main that can actually decompress RAR:
# p7zip-full parses RAR headers but fails to extract ("Unsupported Method" —
# the codec is in the non-free p7zip-rar), and bsdtar handles RAR5 but exits 1
# on solid RAR3, a common CBR layout.
#
# Everything after the install undoes the damage its dependency chain does:
# gnustep-base-runtime hard-Depends on graphviz, which drags in the AV1/HEIF
# codecs, X11 and pango, and gnustep-common pulls perl. None of it appears in
# `ldd $(which unar)`. gnustep does shell out to dpkg-architecture for one
# constant string, so that is replaced with a shell stub before perl goes.
#
# This has to be one RUN, and it has to be per final stage:
#   * install and purge in separate layers leaves the removed files in the
#     lower layer, so the image does not actually shrink (~50 MB).
#   * --force-depends leaves the dpkg database inconsistent, so any later
#     apt-get install in the same image refuses to run — which rules out
#     sharing this in runtime-base ahead of the OCR stage's tesseract install.
RUN apt-get update && apt-get install -y --no-install-recommends unar \
    && ARCH="$(dpkg-architecture -qDEB_HOST_MULTIARCH)" \
    && dpkg --remove --force-depends \
        graphviz libgvc6 libgvpr2 libcdt5 libcgraph6 libpathplan4 liblab-gamut1 \
        libann0 libgts-0.7-5t64 \
        libaom3 libsvtav1enc2 librav1e0.7 libdav1d7 libgav1-1 libavif16 libheif1 \
        libheif-plugin-dav1d libheif-plugin-libde265 libde265-0 libyuv0 \
        binutils binutils-common binutils-aarch64-linux-gnu binutils-x86-64-linux-gnu \
        libbinutils libgprofng0 libctf0 libctf-nobfd0 libsframe1 \
        libgd3 libxpm4 libxaw7 libxmu6 libxt6t64 libsm6 libice6 \
        perl perl-modules-5.40 libperl5.40 libgdbm-compat4t64 dpkg-dev libdpkg-perl \
        2>/dev/null || true \
    && rm -rf /usr/share/perl /usr/share/perl5 /usr/lib/*/perl \
    && printf '#!/bin/sh\necho "%s"\n' "$ARCH" > /usr/bin/dpkg-architecture \
    && chmod +x /usr/bin/dpkg-architecture \
    && rm -rf /var/lib/apt/lists/*

# Stage 5b: Default variant — bundles Tesseract + English language data so image-only
# PDFs are OCR'd into the full-text index out of the box. Extra languages can be added
# at runtime by mounting tessdata and setting OCR_LANGUAGES (see README); no rebuild
# required. This is the last stage, so a plain `docker build` (no --target) yields it.
FROM runtime-base AS ocr

# Same unar install + dependency purge as the slim stage (see the comment there
# for why it is one RUN and repeated per stage), with tesseract added to the
# same apt transaction so it lands before the dpkg database is made
# inconsistent.
#
# osd.traineddata (10.5 MB — larger than the English data itself) is only read
# for orientation/script detection, i.e. image_to_osd() or --psm 0. Grimoire
# only ever calls image_to_string() with an explicit lang, so it is never
# loaded. Mounting your own tessdata for OCR_LANGUAGES is unaffected.
RUN apt-get update && apt-get install -y --no-install-recommends \
        unar \
        tesseract-ocr \
        tesseract-ocr-eng \
    && ARCH="$(dpkg-architecture -qDEB_HOST_MULTIARCH)" \
    && rm -f /usr/share/tesseract-ocr/*/tessdata/osd.traineddata \
    && dpkg --remove --force-depends \
        graphviz libgvc6 libgvpr2 libcdt5 libcgraph6 libpathplan4 liblab-gamut1 \
        libann0 libgts-0.7-5t64 \
        libaom3 libsvtav1enc2 librav1e0.7 libdav1d7 libgav1-1 libavif16 libheif1 \
        libheif-plugin-dav1d libheif-plugin-libde265 libde265-0 libyuv0 \
        binutils binutils-common binutils-aarch64-linux-gnu binutils-x86-64-linux-gnu \
        libbinutils libgprofng0 libctf0 libctf-nobfd0 libsframe1 \
        libgd3 libxpm4 libxaw7 libxmu6 libxt6t64 libsm6 libice6 \
        perl perl-modules-5.40 libperl5.40 libgdbm-compat4t64 dpkg-dev libdpkg-perl \
        2>/dev/null || true \
    && rm -rf /usr/share/perl /usr/share/perl5 /usr/lib/*/perl \
    && printf '#!/bin/sh\necho "%s"\n' "$ARCH" > /usr/bin/dpkg-architecture \
    && chmod +x /usr/bin/dpkg-architecture \
    && rm -rf /var/lib/apt/lists/*
