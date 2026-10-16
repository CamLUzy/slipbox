"""The soundtrack of the product video, synthesized from scratch (no samples, no licences).

D major, 96 BPM, D – A/C# – Bm – G: a soft pad, piano-like arpeggios, a gentle beat while the
AI and sync parts play, swells into each scene change (the times match index.html) and a
long final chord.   python3 scripts/promo/music.py build/music.wav
"""
import sys
import wave

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
LENGTH = 60.0
BEAT = 60 / 96
BAR = 4 * BEAT
SCENES = [4.6, 10.2, 17.0, 23.6, 37.0, 46.2, 52.6]  # scene changes in index.html
N = int(SR * LENGTH)
rng = np.random.default_rng(7)

left = np.zeros(N)
right = np.zeros(N)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def add(sig, start, gain=1.0, pan=0.0):
    i = int(start * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    left[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    right[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))


def lowpass(x, hz):
    return sosfilt(butter(2, hz, 'low', fs=SR, output='sos'), x)


def highpass(x, hz):
    return sosfilt(butter(2, hz, 'high', fs=SR, output='sos'), x)


def env(n, attack, release, total):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(attack, 1e-4))
    return e * np.clip((total - t) / release, 0, 1)


def pad(notes, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for m in notes:
        f = midi(m)
        for det in (-0.12, 0.0, 0.12):  # three slightly detuned voices
            ph = rng.uniform(0, 2 * np.pi)
            for h in range(1, 7):
                x += np.sin(2 * np.pi * f * h * (1 + det / 100) * t + ph * h) / h ** 1.6
    x = lowpass(x, 1800) * env(n, 1.2, 1.4, dur)
    return x / (len(notes) * 9)


def pluck(m, dur=1.6):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = midi(m)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) * np.exp(-t * 6) + 0.12 * np.sin(6 * np.pi * f * t) * np.exp(-t * 9)
    return x * np.exp(-t * 3.2) * np.minimum(1, t / 0.004)


def bell(m, dur=3.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = midi(m)
    x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 3) + 0.1 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 6)
    return x * np.exp(-t * 1.4) * np.minimum(1, t / 0.003)


def bass(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = midi(m)
    x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return x * env(n, 0.01, 0.25, dur) * np.exp(-t * 0.8)


def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 42 + 80 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def hat():
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    return highpass(rng.standard_normal(n), 7000) * np.exp(-t * 70)


def swell(at, length=1.4):
    """Filtered noise rising into a scene change, with a soft low hit on it."""
    n = int(length * SR)
    t = np.arange(n) / SR
    x = lowpass(highpass(rng.standard_normal(n), 300), 5000) * (t / length) ** 2.5
    add(x, at - length, 0.07)
    m = int(1.6 * SR)
    tt = np.arange(m) / SR
    add(np.sin(2 * np.pi * 55 * tt) * np.exp(-tt * 3) * np.minimum(1, tt / 0.01), at, 0.22)


CHORDS = [  # (pad notes, arpeggio notes, bass root)
    ([62, 66, 69, 74], [62, 69, 74, 78, 81, 78, 74, 69], 38),   # D
    ([61, 64, 69, 73], [61, 69, 73, 76, 81, 76, 73, 69], 37),   # A/C#
    ([59, 62, 66, 71], [59, 66, 71, 74, 78, 74, 71, 66], 35),   # Bm
    ([59, 62, 67, 71], [55, 62, 67, 71, 74, 71, 67, 62], 31),   # G
]

final = 52.6
bars = int(final // BAR) + 1
for b in range(bars):
    start = b * BAR
    padn, arp, root = CHORDS[b % 4]
    end = min(start + BAR, final)
    add(pad(padn, end - start + 1.2), start, 0.55 if start < 10 else 0.42)
    for i in range(8):  # eighth notes
        t = start + i * BEAT / 2
        if t >= final or t < 4.6:
            continue
        loud = 0.07 if t < 10.2 else 0.1
        add(pluck(arp[i] + (12 if 23.6 <= t < 46.2 and i % 2 else 0)), t, loud * (1.0 if i % 2 == 0 else 0.75), -0.35 if i % 2 else 0.35)
    if start >= 10.2:
        for k in (0, 2):
            if start + k * BEAT < final:
                add(bass(root, BEAT * 2), start + k * BEAT, 0.28)

for t in np.arange(0.6, 4.6, BEAT * 2):  # sparse bells over the title
    add(bell([74, 81, 78, 86][int(t / (BEAT * 2)) % 4]), t, 0.05, 0.3)

for i in range(int((46.2 - 23.6) / BEAT) + 1):  # the beat under AI and sync
    t = 23.6 + i * BEAT
    if t < 46.2:
        add(kick(), t, 0.32)
        add(hat(), t + BEAT / 2, 0.05, 0.25)

for s in SCENES:
    swell(s)

# the last chord: D major, wide, with bells
add(pad([50, 57, 62, 66, 69, 74], 7.4), final, 0.7)
add(bass(38, 6.5), final, 0.35)
for i, m in enumerate([74, 78, 81, 86]):
    add(bell(m, 5.0), final + 0.12 * i, 0.06, -0.3 + 0.2 * i)

# a little room
def room(x):
    """Convolution with decaying noise: a different one per channel for width."""
    ir_t = np.arange(int(1.8 * SR)) / SR
    ir = rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 3.2)
    wet = fftconvolve(x, ir / np.sqrt(np.sum(ir ** 2)))[:N]
    return x + 0.3 * wet * np.max(np.abs(x)) / (np.max(np.abs(wet)) + 1e-9)


mix_l, mix_r = room(left), room(right)

out = np.stack([mix_l, mix_r], axis=1)
t = np.arange(N) / SR
fade = np.minimum(1, t / 0.4) * np.clip((LENGTH - t) / 2.0, 0, 1)
out *= fade[:, None]
out = np.tanh(out / np.max(np.abs(out)) * 1.4) / np.tanh(1.4) * 0.89  # gentle limiter, peak ≈ -1 dB

with wave.open(sys.argv[1] if len(sys.argv) > 1 else 'music.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((out * 32767).astype('<i2').tobytes())
print('music: %.1fs' % LENGTH)
